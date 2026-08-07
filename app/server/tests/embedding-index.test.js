const { newDb } = require('pg-mem');
const emb = require('../lib/embedding');
const idx = require('../lib/embedding-index');

// 測試一律用 stub，不載入真實模型（130 MB ＋ 網路相依）。向量由文字決定，這樣才有鑑別力——
// 全部回同一個向量的話，「同頁取最佳塊」「不灌票」那幾條等於沒測。
let embedCalls = 0;
const fakeVec = (text) => {
  const v = new Float32Array(4);
  for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i) % 7;
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
};

let dbModule, projectId, pageId, taskId;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  emb._setEmbedderForTesting((texts) => { embedCalls += texts.length; return texts.map(fakeVec); });

  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name,folder_name,odoo_version) VALUES ('鴻久','hungjou','17.0') RETURNING id");
  projectId = p.id;
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('t','x','測試') RETURNING id");
  const { rows: [w] } = await dbModule.query(
    `INSERT INTO wiki_pages (project_id,slug,title,node_type,content) VALUES
     ($1,'ts-stock','庫別卡控','troubleshooting',
      '# 過帳流程\n先確認庫別再過帳，過帳後才會產生 stock move 這筆異動。\n# 領料規則\n領料單一定要綁工單，否則不會扣掉庫存數量。') RETURNING id`,
    [projectId]);
  pageId = w.id;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id,task_id,source,title,project_id,analysis_yaml)
     VALUES ($1,'T-1','web','維修單加保固欄位',$2,
       'summary:\n  在維修單上加一個保固到期日欄位供客服查詢。\nmodels:\n  - name: idx.hj.order\n') RETURNING id`,
    [u.id, projectId]);
  taskId = t.id;
});
afterAll(() => { dbModule._setPoolForTesting(null); emb._setEmbedderForTesting(null); idx._resetForTesting(); });

test('首次索引 wiki 頁：切出的每一塊都落 DB，帶當前 model_id', async () => {
  const n = await idx.indexWikiPage(pageId);
  expect(n).toBe(2);                                   // 兩個標題 → 兩塊
  const { rows } = await dbModule.query(
    'SELECT chunk_index, model_id, source_hash FROM embedding_chunks WHERE wiki_page_id=$1 ORDER BY chunk_index', [pageId]);
  expect(rows.map(r => r.chunk_index)).toEqual([0, 1]);
  expect(rows[0].model_id).toBe(emb.MODEL_ID);
  expect(rows[0].source_hash).toBe(rows[1].source_hash); // 同一來源共用一個 hash
});

// 重算要跑推論，是整條流程最貴的一步。比對 hash 而不是 updated_at——後者會因無關欄位變動
// 而更新（例如只改了 description 以外的欄位），造成整頁白算一次。
test('內容沒變時不重算：一次推論都不該發生', async () => {
  const before = embedCalls;
  const n = await idx.indexWikiPage(pageId);
  expect(n).toBe(0);
  expect(embedCalls).toBe(before);
});

// 這是「先刪後插」存在的唯一理由，也是最容易漏掉的一步：只覆寫不刪的話，尾巴那些舊塊
// 會永遠留在索引裡，讓搜尋撈出已經被刪掉的內容——而且不會報錯，看起來就像模型效果不好。
test('內容改短後，多出來的舊 chunk 必須消失', async () => {
  await dbModule.query(
    "UPDATE wiki_pages SET content='# 過帳流程\n只剩這一段了，領料規則那一節已經被刪掉囉。' WHERE id=$1", [pageId]);
  const n = await idx.indexWikiPage(pageId);
  expect(n).toBe(1);
  const { rows } = await dbModule.query(
    'SELECT content FROM embedding_chunks WHERE wiki_page_id=$1', [pageId]);
  expect(rows).toHaveLength(1);
  expect(rows.some(r => r.content.includes('領料單一定要綁工單'))).toBe(false); // 舊塊不得殘留
});

test('索引任務規格：按 YAML 頂層 key 切塊', async () => {
  const n = await idx.indexTask(taskId);
  expect(n).toBe(2);
  const { rows } = await dbModule.query(
    'SELECT content FROM embedding_chunks WHERE task_id=$1 ORDER BY chunk_index', [taskId]);
  expect(rows[0].content).toContain('保固到期日欄位');
  expect(rows[1].content).toContain('idx.hj.order');
});

// 檢索一律 WHERE project_id=$1。這既是效能前提，也是資料邊界——別家客戶的排障結論
// 不能因為語意相近就被撈到另一個專案的 agent 面前。
test('searchProject 只回本專案，且同一來源只佔一個名次（長頁面不得因塊多而灌票）', async () => {
  await idx.loadCache();
  const qv = fakeVec('query: 庫存');
  const hits = idx.searchProject(projectId, qv);
  const pageHits = hits.filter(h => h.wikiPageId === pageId);
  expect(pageHits).toHaveLength(1);                     // 同一頁多塊命中時只留最好的那一塊
  expect(hits.every(h => h.score <= 1.0001)).toBe(true);
  expect(idx.searchProject(999999, qv)).toEqual([]);    // 別的專案：查無
});

// FK 帶 CASCADE 的理由：其他表靠呼叫端逐表手動 DELETE（三份清單，見 db.js 的 user_inbox 註解），
// 漏補任何一處的症狀是「刪頁／刪任務／刪專案直接失敗」。已實測 pg-mem 確實執行 CASCADE。
test('來源被刪除 → 對應的 chunk 自動清乾淨，不留孤兒', async () => {
  await idx.indexWikiPage(pageId);
  await dbModule.query('DELETE FROM wiki_pages WHERE id=$1', [pageId]);
  const { rows } = await dbModule.query('SELECT id FROM embedding_chunks WHERE wiki_page_id=$1', [pageId]);
  expect(rows).toHaveLength(0);
});

test('專案被刪除 → 該專案所有 chunk 一併清掉', async () => {
  await idx.indexTask(taskId);
  await dbModule.query('DELETE FROM tasks WHERE project_id=$1', [projectId]);
  await dbModule.query('DELETE FROM projects WHERE id=$1', [projectId]);
  const { rows } = await dbModule.query('SELECT id FROM embedding_chunks WHERE project_id=$1', [projectId]);
  expect(rows).toHaveLength(0);
});
