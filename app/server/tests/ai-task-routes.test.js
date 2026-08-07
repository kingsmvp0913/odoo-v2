// 意圖：歷史任務的語意檢索端點。鎖四件會壞掉業務語意的事——
// (1) 兩階段：similar 只回摘要，全文要另外取。一次把三份完整規格灌進 agent 的 context，
//     省下的思考時間全賠在 token 上（wiki 那套端點的既有原則，這裡照抄）；
// (2) 索引未就緒不能假裝「沒有相似任務」——那會讓 agent 得出「這是全新需求」的錯誤結論，
//     跟 /ai/wiki/search 回空陣列的老坑一模一樣，所以要有 ready:false 的訊號；
// (3) 資料邊界：一律 WHERE project_id=$1，取全文那支也不例外（agent 手上的 id 不可信）；
// (4) 摘要取 analysis.yaml 的 summary 欄，但那是 AI 產出的——欄位缺漏或整份 YAML 壞掉時
//     要退回純文字摘要，不能整個空掉（空摘要等於逼 agent 每張都打開全文）。
process.env.JWT_SECRET = 'test-ai-task';
process.env.APP_SECRET = 'test-ai-task-secret';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const { aiToken, AI_TOKEN_HEADER } = require('../lib/ai-token');

const emb = require('../lib/embedding');
const idx = require('../lib/embedding-index');

// 詞袋當座標系（同 wiki-search-hybrid.test.js）：測試絕不載入真實模型。
const VOCAB = ['庫存', '過帳', '維修', '銷售', '報價'];
function bagOfWords(text) {
  const v = new Float32Array(VOCAB.length);
  VOCAB.forEach((w, i) => { if (text.includes(w)) v[i] = 1; });
  const norm = Math.hypot(...v) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

let dbModule, app, projectId, otherProjectId, stockTaskId, brokenTaskId, secretTaskId;

async function newTask(pid, userId, taskId, title, analysisYaml) {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (project_id, user_id, source, task_id, title, analysis_yaml, status)
     VALUES ($1,$2,'manual',$3,$4,$5,'done') RETURNING id`,
    [pid, userId, taskId, title, analysisYaml]);
  return t.id;
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('aitask','x','A') RETURNING id");
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name,folder_name,odoo_version) VALUES ('鴻久','hungjou','17.0') RETURNING id");
  projectId = p.id;
  // 另一個專案，它的 name 正好等於本專案的 folder_name——撞號時不得混到別人的規格
  const { rows: [o] } = await dbModule.query(
    "INSERT INTO projects (name,folder_name,odoo_version) VALUES ('hungjou','other-folder','17.0') RETURNING id");
  otherProjectId = o.id;

  // fixture 的每一段都要超過切塊的 MIN_BODY（20 字），否則會被當成「只有標題、內容還沒寫」丟掉，
  // 索引裡一塊都沒有，測試就變成在驗「查無」而不是在驗檢索。
  stockTaskId = await newTask(projectId, u.id, 'T-1', '庫存異動單',
    'summary: 維修單過帳時要連動扣庫存，過帳後由系統自動產生庫存異動\n'
    + 'requirements:\n  - 維修單過帳後產生對應的 stock move，數量取自維修用料明細');
  brokenTaskId = await newTask(projectId, u.id, 'T-2', '報價單備註',
    '這不是合法的 YAML: [未閉合的中括號\n  銷售報價單要能帶備註欄位，列印時一併輸出到 PDF');
  secretTaskId = await newTask(otherProjectId, u.id, 'T-9', '別家的規格',
    'summary: 別家的庫存規格，過帳與庫存異動的處理方式與本專案完全不同');

  emb._setEmbedderForTesting(texts => texts.map(t => bagOfWords(t)));
  idx._resetForTesting();
  for (const id of [stockTaskId, brokenTaskId, secretTaskId]) await idx.indexTask(id);
  await idx.loadCache();

  const a = express(); a.use(express.json());
  require('../ai-task-routes').registerRoutes(a);
  app = a;
});
afterAll(() => { emb._resetForTesting(); idx._resetForTesting(); dbModule._setPoolForTesting(null); });

const similar = (q, extra = {}) => request(app).get('/ai/tasks/similar')
  .query({ project: 'hungjou', q, ...extra }).set(AI_TOKEN_HEADER, aiToken());

test('找得到語意相近的歷史任務，且只回摘要不回 analysis_yaml 全文', async () => {
  const res = await similar('過帳');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const hit = res.body.tasks.find(t => t.id === stockTaskId);
  expect(hit).toBeTruthy();
  expect(hit.summary).toContain('維修單過帳');       // 取 analysis.yaml 的 summary 欄
  expect(hit.analysis_yaml).toBeUndefined();         // 全文要另外取，否則一次灌爆 context
});

// AI 產的 YAML 壞掉是常態不是例外。整個空掉等於逼 agent 每一張都去取全文，兩階段就白設計了。
test('analysis_yaml 解析不了 → 摘要退回純文字，不是空字串', async () => {
  const res = await similar('報價');
  const hit = res.body.tasks.find(t => t.id === brokenTaskId);
  expect(hit).toBeTruthy();
  expect(hit.summary.length).toBeGreaterThan(0);
});

// 資料邊界：撞號的專案名不得讓別家的規格漏出來（wiki 端點踩過同一個坑）。
test('不得撈到另一個專案的任務（folder_name 與 name 撞號）', async () => {
  const res = await similar('庫存');
  expect(res.body.tasks.map(t => t.id)).not.toContain(secretTaskId);
});

test('limit 生效且有上限（agent 傳大數不得把整包規格拖出來）', async () => {
  const res = await similar('庫存 過帳 維修 銷售 報價', { limit: 1 });
  expect(res.body.tasks).toHaveLength(1);
});

test('缺 q → ok:false', async () => {
  const res = await request(app).get('/ai/tasks/similar').query({ project: 'hungjou' })
    .set(AI_TOKEN_HEADER, aiToken());
  expect(res.body.ok).toBe(false);
});

test('沒帶通行碼 → 擋下（與其他 /ai/* 一致）', async () => {
  const res = await request(app).get('/ai/tasks/similar?project=hungjou&q=庫存');
  expect(res.status).toBe(403);
});

describe('取單張規格全文', () => {
  test('回 analysis_yaml 全文', async () => {
    const res = await request(app).get('/ai/tasks/spec')
      .query({ project: 'hungjou', task: stockTaskId }).set(AI_TOKEN_HEADER, aiToken());
    expect(res.body.ok).toBe(true);
    expect(res.body.analysis_yaml).toContain('stock move');
  });

  // 端點不能假設呼叫端沒換過 id：跨專案讀規格會直接打破資料邊界。
  test('別的專案的任務 id → 查無', async () => {
    const res = await request(app).get('/ai/tasks/spec')
      .query({ project: 'hungjou', task: secretTaskId }).set(AI_TOKEN_HEADER, aiToken());
    expect(res.body.ok).toBe(false);
  });
});

// 索引沒就緒時回空清單是對的，但必須帶得出訊號——否則 agent 讀成「沒有相似的歷史任務」，
// 跟改動前 /ai/wiki/search 回空陣列害人瞎猜是同一個病。
test('索引未就緒 → tasks 空但 ready:false，不是靜默的空清單', async () => {
  emb._resetForTesting();
  idx._resetForTesting();
  const res = await similar('庫存');
  expect(res.body.ok).toBe(true);
  expect(res.body.tasks).toEqual([]);
  expect(res.body.ready).toBe(false);
  expect(res.body.note).toBeTruthy();
});
