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
