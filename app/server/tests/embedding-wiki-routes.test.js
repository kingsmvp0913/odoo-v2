// 意圖：平台 UI 上「人工」動 wiki 的那三條路徑（新增／編輯／刪除）與語意索引的接點。
// 九個 enqueue 觸發點全都掛在 pipeline 內，人工這兩條原本一個都沒接——手寫的排障結論、
// 人工補的段落，語意腿一律搜不到，要等夜間 sweep 才補得回來（而 sweep 本身也有游標問題）。
// 刪除那條反過來：DB 靠 CASCADE 清乾淨了，記憶體快取卻沒有移除路徑。
// 另外釘住 init 的守衛：那條路徑會用骨架覆寫累積下來的內容，且不可逆。
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ processed: 0 }), resetLoopCounter: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/git', () => ({ createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn() }));

process.env.JWT_SECRET = 'test-wiki-enqueue';
const emb = require('../lib/embedding');
const idx = require('../lib/embedding-index');

// 測試不得載入真實模型（130 MB ＋ 網路相依）。向量由文字決定才有鑑別力。
const fakeVec = (text) => {
  const v = new Float32Array(4);
  for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i) % 7;
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
};

let app, dbModule, token, projectId;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
  const userRes = await request(app).post('/api/auth/setup').send({ username: 'embuser', password: 'pass1234', display_name: 'Emb' });
  token = userRes.body.token;
  const projRes = await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'EmbProj', odoo_version: '17.0' });
  projectId = projRes.body.id;
  emb._setEmbedderForTesting(texts => texts.map(fakeVec));
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); emb._setEmbedderForTesting(null); idx._resetForTesting(); });

const auth = (r) => r.set('Authorization', `Bearer ${token}`);
const chunksOf = async (pageId) => (await dbModule.query(
  'SELECT content FROM embedding_chunks WHERE wiki_page_id=$1 ORDER BY chunk_index', [pageId])).rows;
// enqueue 是刻意的 fire-and-forget（索引失敗不該讓存檔失敗），所以這裡只能輪詢等它落地
const waitFor = async (fn) => {
  for (let i = 0; i < 30; i++) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 5));
  }
  return false;
};

test('人工新增的頁要進語意索引（不能只等夜間 sweep）', async () => {
  const res = await auth(request(app).post(`/api/projects/${projectId}/wiki`))
    .send({ slug: 'manual-note', title: '人工註記', content: '# 出貨規則\n這一段是人在平台上手打的，語意腿一樣要找得到。' });
  expect(res.status).toBe(201);
  expect(await waitFor(async () => (await chunksOf(res.body.id)).length > 0)).toBe(true);
});

test('人工編輯後索引要跟著換，舊內容不得留在索引裡', async () => {
  const { rows: [page] } = await dbModule.query(
    "SELECT id FROM wiki_pages WHERE project_id=$1 AND slug='manual-note'", [projectId]);
  await auth(request(app).put(`/api/projects/${projectId}/wiki/manual-note`))
    .send({ content: '# 出貨規則\n整段改寫過了，舊的那段敘述已經不存在於這一頁。' });
  expect(await waitFor(async () => (await chunksOf(page.id)).some(c => c.content.includes('整段改寫過了')))).toBe(true);
  expect((await chunksOf(page.id)).some(c => c.content.includes('人在平台上手打的'))).toBe(false);
});

// 留在快取裡的塊照樣佔掉語意腿前 30 名的名額，但回頭查頁已經查無、被靜靜丟掉——
// 症狀是「命中數量對得上、內容卻少一半」。
test('人工刪除後，快取裡的塊要跟著清掉', async () => {
  const { rows: [page] } = await dbModule.query(
    "SELECT id FROM wiki_pages WHERE project_id=$1 AND slug='manual-note'", [projectId]);
  await idx.loadCache();
  const qv = fakeVec('query: 出貨規則');
  expect(idx.searchProject(projectId, qv).some(h => h.wikiPageId === page.id)).toBe(true);

  const res = await auth(request(app).delete(`/api/projects/${projectId}/wiki/manual-note`));
  expect(res.status).toBe(200);
  expect(idx.searchProject(projectId, qv).some(h => h.wikiPageId === page.id)).toBe(false);
});

// initProjectWiki 走 _upsertNode 的 ON CONFLICT DO UPDATE：對已有內容的專案再按一次，
// 排障結論與人工補的段落會被骨架整個蓋掉，而且沒有備份、救不回來。
test('已經有 wiki 的專案不得再 init，內容不可被骨架覆寫', async () => {
  await dbModule.query(
    `INSERT INTO wiki_pages (project_id,slug,title,node_type,content)
     VALUES ($1,'overview','專案概論','overview','# 累積了很久的內容')`, [projectId]);
  const res = await auth(request(app).post(`/api/projects/${projectId}/wiki/init`));
  expect(res.status).toBe(409);
  const { rows: [page] } = await dbModule.query(
    "SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='overview'", [projectId]);
  expect(page.content).toBe('# 累積了很久的內容');
});
