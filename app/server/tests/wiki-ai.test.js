process.env.JWT_SECRET = 'test-wiki-ai';
process.env.APP_SECRET = 'test-wiki-ai-secret';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const { aiToken, AI_TOKEN_HEADER, aiEndpointGuard } = require('../lib/ai-token');

// 意圖：chat 子行程（headless、cwd=odoo-v2）不預載 wiki，改按需自取。
// 這組 loopback 端點是它取 wiki 的唯一路徑——驗「索引不外洩 content」「單頁可取」「非本機擋下」。
let dbModule, app, projectId;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name,folder_name,odoo_version) VALUES ('鴻久','hungjou','17.0') RETURNING id");
  projectId = p.id;
  await dbModule.query(
    "INSERT INTO wiki_pages (project_id,slug,title,node_type,content) VALUES ($1,'overview','總覽','overview','總覽內容'),($1,'sale','銷售','module','銷售內容')",
    [projectId]);
  const a = express(); a.use(express.json());
  require('../wiki-routes').registerRoutes(a);
  app = a;
});
afterAll(() => dbModule._setPoolForTesting(null));

test('GET /ai/wiki/pages 回索引、不含 content（loopback）', async () => {
  const res = await request(app).get('/ai/wiki/pages?project=hungjou').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.pages.map(p => p.slug).sort()).toEqual(['overview', 'sale']);
  expect(res.body.pages[0].content).toBeUndefined();
});

test('GET /ai/wiki/pages 依 name 也可查（chat 執行時傳的是 projects.name，非 folder_name）', async () => {
  const res = await request(app).get('/ai/wiki/pages').set(AI_TOKEN_HEADER, aiToken()).query({ project: '鴻久' });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.pages.map(p => p.slug).sort()).toEqual(['overview', 'sale']);
});

test('GET /ai/wiki/page 回單頁 content（loopback）', async () => {
  const res = await request(app).get('/ai/wiki/page?project=hungjou&slug=sale').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.content).toBe('銷售內容');
});

test('GET /ai/wiki/page 找不到 slug 回 ok:false', async () => {
  const res = await request(app).get('/ai/wiki/page?project=hungjou&slug=nope').set(AI_TOKEN_HEADER, aiToken());
  expect(res.body.ok).toBe(false);
});

test('守衛擋非本機來源（沿用 lib/ai-token 的中介層）', () => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  aiEndpointGuard({ socket: { remoteAddress: '8.8.8.8' }, headers: {} }, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
});

// wiki 內容是 library agent 從客戶 repo 摘出來的，外洩面不輸 DB 那兩支；
// 來源檢查一旦因 nginx 搬家而失效，通行碼是唯一還站著的門。
test('本機來源但沒帶通行碼 → 仍然擋下', async () => {
  const res = await request(app).get('/ai/wiki/pages?project=hungjou');
  expect(res.status).toBe(403);
});

// --- 全文搜尋：補掉「只能按標題挑頁」的缺口 ---
// 意圖：舊行為只有 pages（回 slug/title）與 page（取單頁），agent 想找「以前遇過這問題嗎」
// 只能靠標題猜。wiki 一多就必漏，而且漏了沒有訊號——端點回 200，agent 當成「沒有相關記載」。
test('GET /ai/wiki/search 命中 content 內文（標題對不上也找得到）', async () => {
  await dbModule.query(
    `INSERT INTO wiki_pages (project_id,slug,title,node_type,content,description)
     VALUES ($1,'ts-nas','排程結論','troubleshooting','判定缺檔的條件是 attachment 為空','NAS 補寫判定缺檔的實際條件')`,
    [projectId]);
  const res = await request(app).get('/ai/wiki/search?project=hungjou&q=attachment').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.hits.map(h => h.slug)).toContain('ts-nas'); // 關鍵字只在 content 裡
  expect(res.body.hits[0].content).toBeUndefined();           // 不回全文，否則一次搜尋灌爆 context
  expect(res.body.hits[0].description).toBeTruthy();          // 但要回 description 供判斷相關性
});

// 排障結論優先排前面：agent 問「以前遇過嗎」時，前人的結論比正典文件有用。
test('GET /ai/wiki/search troubleshooting 排在一般頁之前', async () => {
  await dbModule.query(
    `INSERT INTO wiki_pages (project_id,slug,title,node_type,content)
     VALUES ($1,'mod-nas','NAS 模組','module','NAS 相關說明')`,
    [projectId]);
  const res = await request(app).get('/ai/wiki/search?project=hungjou&q=nas').set(AI_TOKEN_HEADER, aiToken());
  expect(res.body.hits.length).toBeGreaterThanOrEqual(2);
  expect(res.body.hits[0].node_type).toBe('troubleshooting');
});

test('GET /ai/wiki/search 缺 q → ok:false（不回整包 wiki）', async () => {
  const res = await request(app).get('/ai/wiki/search?project=hungjou').set(AI_TOKEN_HEADER, aiToken());
  expect(res.body.ok).toBe(false);
});

test('GET /ai/wiki/search 沒帶通行碼 → 擋下（與其他 /ai/* 一致）', async () => {
  const res = await request(app).get('/ai/wiki/search?project=hungjou&q=nas');
  expect(res.status).toBe(403);
});

// description 是 agent「決定要不要打開這一頁」的依據，必須跟著清單一起回。
test('GET /ai/wiki/pages 一併回 description', async () => {
  const res = await request(app).get('/ai/wiki/pages?project=hungjou').set(AI_TOKEN_HEADER, aiToken());
  const ts = res.body.pages.find(p => p.slug === 'ts-nas');
  expect(ts.description).toBe('NAS 補寫判定缺檔的實際條件');
});
