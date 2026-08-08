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

// 「先刪後插」中途斷掉時，留下的是帶著**新** hash 的半套資料。舊的判準是「有任一列 hash 對得上
// 就算已索引」，於是這頁從此永遠不再重算——夜間 sweep 也一樣跳過，那半頁內容永久搜不到。
test('半套資料不得被當成已索引：塊數對不上就要重建', async () => {
  await dbModule.query(
    "UPDATE wiki_pages SET content='# 過帳流程\n先確認庫別再過帳，才會產生這筆庫存異動。\n# 領料規則\n領料單一定要綁工單，否則不會扣掉庫存數量。' WHERE id=$1",
    [pageId]);
  expect(await idx.indexWikiPage(pageId)).toBe(2);
  // 模擬半套：留一列（hash 是最新的），另一列不見了
  await dbModule.query('DELETE FROM embedding_chunks WHERE wiki_page_id=$1 AND chunk_index=1', [pageId]);
  expect(await idx.indexWikiPage(pageId)).toBe(2);          // 必須重建，不能回 0
  const { rows } = await dbModule.query(
    'SELECT chunk_index FROM embedding_chunks WHERE wiki_page_id=$1 ORDER BY chunk_index', [pageId]);
  expect(rows.map(r => r.chunk_index)).toEqual([0, 1]);
});

// 沒有交易時，中途失敗留下的就是上面那種半套資料（而且帶新 hash），而並行的兩次 enqueue 會
// 各刪各插。⚠ pg-mem 的 ROLLBACK 不還原資料（實測：同一條 client 上 BEGIN→DELETE→INSERT→ROLLBACK
// 之後資料仍是新的），所以「回滾後的內容」在這裡驗不出來；依既有慣例不為了測試改寫正式 SQL，
// 改驗真正決定成敗的那件事：DELETE 與 INSERT 必須跑在 withTransaction 借到的同一條 client 上
//（散在池子上時每句各自 autocommit，等於根本沒有交易——見 db.js withTransaction 的註解），
// 且失敗時要發出 ROLLBACK。
test('替換是一個交易：DELETE 與 INSERT 同一條 client，中途失敗要 ROLLBACK', async () => {
  await idx.indexWikiPage(pageId);
  await dbModule.query("UPDATE wiki_pages SET content='# 甲\n這一段是為了觸發重算而改寫的內容，夠長才會成塊。\n# 乙\n第二段同樣要夠長，這樣才會切出第二塊來。' WHERE id=$1", [pageId]);

  const realPool = dbModule.getPool();
  const log = [];
  dbModule._setPoolForTesting({
    query: (...a) => { log.push(['pool', String(a[0])]); return realPool.query(...a); },
    connect: async () => {
      const c = await realPool.connect();
      return { query: (...a) => { log.push(['client', String(a[0])]); return c.query(...a); }, release: () => c.release() };
    },
  });
  const realEncode = emb.encodeVector;
  let n = 0;
  emb.encodeVector = (v) => { if (++n === 2) throw new Error('寫到第二塊時斷了'); return realEncode(v); };  // DELETE 與第一筆 INSERT 都已經跑過
  try {
    await expect(idx.indexWikiPage(pageId)).rejects.toThrow(/第二塊/);
  } finally { emb.encodeVector = realEncode; dbModule._setPoolForTesting(realPool); }

  const onClient = log.filter(([w]) => w === 'client').map(([, sql]) => sql);
  expect(onClient[0]).toMatch(/BEGIN/);
  expect(onClient.some(s => /DELETE FROM embedding_chunks/.test(s))).toBe(true);
  expect(onClient.some(s => /INSERT INTO embedding_chunks/.test(s))).toBe(true);
  expect(onClient[onClient.length - 1]).toMatch(/ROLLBACK/);
  // 一句都不准落在池子上：那是「BEGIN 在連線 A、DELETE 在 B」的老毛病
  expect(log.some(([w, s]) => w === 'pool' && /(DELETE|INSERT INTO) *embedding_chunks/.test(s))).toBe(false);

  await dbModule.query('DELETE FROM embedding_chunks WHERE wiki_page_id=$1', [pageId]);   // pg-mem 沒還原，手動收拾
  expect(await idx.indexWikiPage(pageId)).toBe(2);           // 失敗之後下一次還救得回來
});

// 並行 enqueue 同一頁時，交易擋得住半套但擋不住重複（兩邊各刪各插）。唯一擋得住的是 DB 約束，
// 而它必須是 partial——兩個來源欄位必有一個是 NULL，UNIQUE 對含 NULL 的列不去重。
test('同一來源的同一個 chunk_index 不得有兩列', async () => {
  await idx.indexWikiPage(pageId);
  const { rows: [c] } = await dbModule.query(
    'SELECT * FROM embedding_chunks WHERE wiki_page_id=$1 AND chunk_index=0', [pageId]);
  await expect(dbModule.query(
    `INSERT INTO embedding_chunks (project_id, wiki_page_id, chunk_index, content, vector, model_id, source_hash)
     VALUES ($1,$2,0,'重複的塊',$3,$4,$5)`,
    [projectId, pageId, c.vector, c.model_id, c.source_hash])).rejects.toThrow();
});

test('索引任務規格：按 YAML 頂層 key 切塊', async () => {
  const n = await idx.indexTask(taskId);
  expect(n).toBe(2);
  const { rows } = await dbModule.query(
    'SELECT content FROM embedding_chunks WHERE task_id=$1 ORDER BY chunk_index', [taskId]);
  expect(rows[0].content).toContain('保固到期日欄位');
  expect(rows[1].content).toContain('idx.hj.order');
});

// 固定 `ORDER BY id LIMIT 200` 等於永遠只掃最舊的那批：超過之後新增的內容，一旦觸發點漏掛
// 就再也補不回來——而這裡是那九個觸發點唯一的安全網。用 limit=1 模擬「批次遠小於總量」。
test('sweepStale 逐輪推進：後面的頁也輪得到，不是永遠只掃最舊的那批', async () => {
  const ids = [];
  for (const s of ['sw-a', 'sw-b', 'sw-c']) {
    const { rows: [r] } = await dbModule.query(
      `INSERT INTO wiki_pages (project_id,slug,title,node_type,content)
       VALUES ($1,$2,$2,'module','# 說明\n這是掃描測試用的內容，要夠長才會被切成一塊。') RETURNING id`,
      [projectId, s]);
    ids.push(r.id);
  }
  const indexed = async (id) => (await dbModule.query(
    'SELECT id FROM embedding_chunks WHERE wiki_page_id=$1', [id])).rows.length > 0;
  for (let i = 0; i < 10 && !(await indexed(ids[2])); i++) await idx.sweepStale(1);
  expect(await indexed(ids[2])).toBe(true);
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

// DB 那側靠 CASCADE 清乾淨，但記憶體快取沒有任何移除路徑。留著的塊照樣參與排序、照樣佔掉
// 前 30 名的名額，而呼叫端拿 wikiPageId 回頭查頁已經查無，結果被靜靜丟掉——症狀是
//「命中數量對得上、內容卻少一半」，看起來像模型變差，其實是刪掉的頁還在裡面。
test('來源刪除後，快取裡的塊要跟著消失（否則佔著名額卻查不到內容）', async () => {
  const { rows: [p] } = await dbModule.query(
    `INSERT INTO wiki_pages (project_id,slug,title,node_type,content)
     VALUES ($1,'del-me','待刪頁','module','# 說明\n這一頁等一下會被刪掉，內容要夠長才會成塊。') RETURNING id`,
    [projectId]);
  await idx.indexWikiPage(p.id);
  await idx.loadCache();
  const qv = fakeVec('query: 庫存');
  expect(idx.searchProject(projectId, qv).some(h => h.wikiPageId === p.id)).toBe(true);

  await dbModule.query('DELETE FROM wiki_pages WHERE id=$1', [p.id]);
  idx.invalidate({ wikiPageId: p.id });
  expect(idx.searchProject(projectId, qv).some(h => h.wikiPageId === p.id)).toBe(false);
});

// 刪專案時逐頁逐任務呼叫 invalidate 是上千次的無謂比對，而且呼叫端（project-routes 的刪除交易）
// 手上只有 projectId——它根本不知道底下有哪些頁。整包丟掉才是這條路徑實際做得到的事。
test('刪專案 → 整個專案的快取一次清掉', async () => {
  await idx.indexWikiPage(pageId);
  await idx.loadCache();
  const qv = fakeVec('query: 庫存');
  expect(idx.searchProject(projectId, qv).length).toBeGreaterThan(0);

  idx.invalidate({ projectId });
  expect(idx.searchProject(projectId, qv)).toEqual([]);
});

// invalidate 本身正確不代表有人叫它。DB 的 CASCADE 會讓「刪完之後查 embedding_chunks 是空的」
// 這類測試照樣綠，而記憶體快取的殘留只在跑著的 server 上看得到——重啟就消失，所以連人工實測
// 都未必抓得到。三個刪除路徑各鎖一次，用原始碼靜態斷言（route 層 pg-mem 測試看不到記憶體快取）。
describe('刪除路徑要記得清快取', () => {
  const fs = require('fs');
  const srcOf = (f) => fs.readFileSync(require.resolve(`../${f}`), 'utf8');

  test('刪單張任務', () => {
    const src = srcOf('tasks-routes.js');
    const i = src.indexOf("DELETE FROM tasks WHERE id = $1");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 300)).toContain('invalidateEmbedding({ taskId:');
  });

  test('批次刪任務', () => {
    const src = srcOf('tasks-routes.js');
    const i = src.indexOf("DELETE FROM tasks WHERE id = ANY($1::int[])");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 300)).toContain('invalidateEmbedding({ taskId:');
  });

  test('刪專案', () => {
    const src = srcOf('project-routes.js');
    const i = src.indexOf("DELETE FROM projects WHERE id = $1");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 600)).toContain("invalidate({ projectId:");
  });
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
