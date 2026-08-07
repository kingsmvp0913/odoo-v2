// 建索引與記憶體快取：embedding_chunks 的唯一寫入口，也是檢索時的讀取口。
//
// 進度刻意只放記憶體（規格 §3 原寫「進度落 DB」）：實測全庫 83 頁約 300 塊、全量重建
// 10–20 秒，落 DB 是為了讓進度撐過 server 重啟——20 秒的工作沒有這個需求，多一張表反而
// 多一處要維護。真的長到分鐘級時再補不遲。

const crypto = require('crypto');
const { query } = require('../db');
const emb = require('./embedding');
const { chunkWikiPage, chunkAnalysisYaml } = require('./embedding-chunk');

// projectId -> [{ chunkId, wikiPageId, taskId, vec }]
// 只裝當前模型的向量：換模型時整包重載（見 loadCache）。快取結構本身不存 model_id，
// 所以過濾必須發生在載入那一刻，否則 db.js 那條「查詢必須過濾 model_id」在這條路徑上等於沒做。
const cache = new Map();
let cacheLoaded = false;
let progress = null;   // { total, done, startedAt, finishedAt, error }

const sourceHash = (text) => crypto.createHash('sha256').update(text).digest('hex');

function cacheBucket(projectId) {
  if (!cache.has(projectId)) cache.set(projectId, []);
  return cache.get(projectId);
}

// 先刪後插，同一個 transaction 語意內完成。不能 upsert：本表兩個來源欄位必有一個是 NULL，
// 而 UNIQUE 對含 NULL 的列不去重（PG 標準行為，pg-mem 一致），約束擋不住重複。只覆寫不刪的話，
// 內容改短後尾巴的舊 chunk 會永遠留著，讓搜尋撈出已刪掉的內容——而且不會報錯。
async function replaceChunks({ projectId, wikiPageId, taskId, chunks, hash }) {
  const col = wikiPageId ? 'wiki_page_id' : 'task_id';
  const srcId = wikiPageId || taskId;
  await query(`DELETE FROM embedding_chunks WHERE ${col}=$1`, [srcId]);

  const bucket = cacheBucket(projectId).filter(c => (wikiPageId ? c.wikiPageId !== wikiPageId : c.taskId !== taskId));
  if (!chunks.length) { cache.set(projectId, bucket); return 0; }

  const vectors = await emb.embedPassages(chunks.map(c => c.text));
  for (let i = 0; i < chunks.length; i++) {
    const { rows } = await query(
      `INSERT INTO embedding_chunks (project_id, wiki_page_id, task_id, chunk_index, content, vector, model_id, source_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [projectId, wikiPageId || null, taskId || null, chunks[i].chunkIndex,
       chunks[i].text, emb.encodeVector(vectors[i]), emb.MODEL_ID, hash]);
    bucket.push({ chunkId: rows[0].id, wikiPageId: wikiPageId || null, taskId: taskId || null, vec: vectors[i] });
  }
  cache.set(projectId, bucket);
  return chunks.length;
}

// 增量的判準是內容的 hash，不是 updated_at——後者會因為無關欄位變動而更新，造成無謂重算
//（而重算要跑推論，是這裡最貴的一步）。
async function isUnchanged(col, srcId, hash) {
  const { rows } = await query(
    `SELECT 1 FROM embedding_chunks WHERE ${col}=$1 AND source_hash=$2 AND model_id=$3 LIMIT 1`,
    [srcId, hash, emb.MODEL_ID]);
  return rows.length > 0;
}

async function indexWikiPage(wikiPageId) {
  const { rows } = await query(
    'SELECT id, project_id, title, COALESCE(description,\'\') AS description, content FROM wiki_pages WHERE id=$1',
    [wikiPageId]);
  if (!rows.length) return 0;
  const page = rows[0];
  const body = `${page.description}\n${page.content}`;
  const hash = sourceHash(`${page.title}\n${body}`);
  if (await isUnchanged('wiki_page_id', page.id, hash)) return 0;
  const chunks = chunkWikiPage({ title: page.title, content: body });
  return replaceChunks({ projectId: page.project_id, wikiPageId: page.id, chunks, hash });
}

async function indexTask(taskId) {
  const { rows } = await query(
    "SELECT id, project_id, COALESCE(title,'') AS title, analysis_yaml FROM tasks WHERE id=$1",
    [taskId]);
  if (!rows.length || !rows[0].project_id || !rows[0].analysis_yaml) return 0;
  const task = rows[0];
  const hash = sourceHash(`${task.title}\n${task.analysis_yaml}`);
  if (await isUnchanged('task_id', task.id, hash)) return 0;
  const chunks = chunkAnalysisYaml({ title: task.title || `任務 ${task.id}`, yaml: task.analysis_yaml });
  return replaceChunks({ projectId: task.project_id, taskId: task.id, chunks, hash });
}

// 九個觸發點（wiki 五處、analysis_yaml 四處）共用的入口，一律在來源寫入成功之後才呼叫。
// 三個刻意的取捨：
// 1) 未就緒就直接跳過，不排隊等模型載完——剛啟動的 server 與測試環境都屬這一類，在這裡排隊
//    等於把 130 MB 的模型載入綁進 pipeline 的關鍵路徑（測試更是連載都不該載）。
// 2) 不 await：索引是事後補得回來的東西，不該讓 wiki 寫入或 pipeline 因為它而失敗。
// 3) 上面兩條漏掉的，夜間 sweepStale 會靠 source_hash 對不上重算補回——所以跳過是安全的，
//    漏掉的代價只是「那頁到今晚為止搜不到」，不是永久失聯。
function enqueue({ wikiPageId, taskId }) {
  if (!emb.isReady()) return;
  const p = wikiPageId ? indexWikiPage(wikiPageId) : indexTask(taskId);
  p.catch(err => console.error('[EMBEDDING] 索引失敗：', err.message));
}

// 全量重建：管理頁那顆按鈕。內容沒變的來源會被 isUnchanged 擋掉，所以重跑第二次幾乎瞬間完成。
async function rebuildAll() {
  if (progress && !progress.finishedAt) return progress;   // 已經在跑就不疊加
  const { rows: pages } = await query('SELECT id FROM wiki_pages ORDER BY id');
  const { rows: tasks } = await query("SELECT id FROM tasks WHERE COALESCE(analysis_yaml,'')<>'' ORDER BY id");
  progress = { total: pages.length + tasks.length, done: 0, startedAt: Date.now(), finishedAt: null, error: null };
  try {
    for (const p of pages) { await indexWikiPage(p.id); progress.done++; }
    for (const t of tasks) { await indexTask(t.id); progress.done++; }
  } catch (err) {
    progress.error = err.message;
  }
  progress.finishedAt = Date.now();
  return progress;
}

// 夜間補算：掃出「有來源、但索引缺了或 hash 對不上」的，補起來。這是所有觸發點的安全網——
// 觸發點有九處（wiki 五處、analysis_yaml 四處），漏掛任何一處的症狀是那條路徑寫進去的內容
// 永遠搜不到，而且沒有任何訊號。這一輪掃過去就會補上。
async function sweepStale(limit = 200) {
  const { rows: pages } = await query('SELECT id FROM wiki_pages ORDER BY id LIMIT $1', [limit]);
  const { rows: tasks } = await query(
    "SELECT id FROM tasks WHERE COALESCE(analysis_yaml,'')<>'' ORDER BY id LIMIT $1", [limit]);
  let n = 0;
  for (const p of pages) n += await indexWikiPage(p.id) ? 1 : 0;
  for (const t of tasks) n += await indexTask(t.id) ? 1 : 0;
  return n;
}

// server 啟動後背景載入。載完前檢索一律退回純 LIKE，不阻塞啟動。
async function loadCache() {
  const { rows } = await query(
    'SELECT id, project_id, wiki_page_id, task_id, vector FROM embedding_chunks WHERE model_id=$1',
    [emb.MODEL_ID]);
  cache.clear();
  for (const r of rows) {
    cacheBucket(r.project_id).push({
      chunkId: r.id, wikiPageId: r.wiki_page_id, taskId: r.task_id, vec: emb.decodeVector(r.vector),
    });
  }
  cacheLoaded = true;
  return rows.length;
}

// 檢索：對該專案的塊算相似度。同一來源有多塊命中時取最好的那一塊——不累加，否則長頁面
// 會因為塊多而灌票（規格 §2.6）。
// kind 一定要分：wiki 與 analysis_yaml 的塊共用同一個 bucket，不過濾的話搜 wiki 會撈到任務規格
// 的塊，而呼叫端拿 wikiPageId 去查頁只會得到 undefined——症狀是「命中數量對得上、內容卻少一半」。
function searchProject(projectId, queryVec, { limit = 30, kind = null } = {}) {
  const bucket = cache.get(projectId) || [];
  const best = new Map();
  for (const c of bucket) {
    if (kind === 'wiki' && !c.wikiPageId) continue;
    if (kind === 'task' && !c.taskId) continue;
    const key = c.wikiPageId ? `w${c.wikiPageId}` : `t${c.taskId}`;
    const score = emb.similarity(queryVec, c.vec);
    const prev = best.get(key);
    if (!prev || score > prev.score) best.set(key, { wikiPageId: c.wikiPageId, taskId: c.taskId, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

const isCacheLoaded = () => cacheLoaded;
const getIndexStatus = () => ({
  ...emb.getStatus(),
  cacheLoaded,
  cachedChunks: [...cache.values()].reduce((n, a) => n + a.length, 0),
  progress,
});

function _resetForTesting() { cache.clear(); cacheLoaded = false; progress = null; }

module.exports = {
  indexWikiPage, indexTask, enqueue, rebuildAll, sweepStale,
  loadCache, isCacheLoaded, searchProject, getIndexStatus, sourceHash,
  _resetForTesting,
};
