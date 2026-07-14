process.env.JWT_SECRET = 'test-wiki-ai';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');

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
  const res = await request(app).get('/ai/wiki/pages?project=hungjou');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.pages.map(p => p.slug).sort()).toEqual(['overview', 'sale']);
  expect(res.body.pages[0].content).toBeUndefined();
});

test('GET /ai/wiki/page 回單頁 content（loopback）', async () => {
  const res = await request(app).get('/ai/wiki/page?project=hungjou&slug=sale');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.content).toBe('銷售內容');
});

test('GET /ai/wiki/page 找不到 slug 回 ok:false', async () => {
  const res = await request(app).get('/ai/wiki/page?project=hungjou&slug=nope');
  expect(res.body.ok).toBe(false);
});

test('loopbackOnly 擋非本機來源（沿用 db-query-routes 的中介層）', () => {
  const { loopbackOnly } = require('../db-query-routes');
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  loopbackOnly({ socket: { remoteAddress: '8.8.8.8' } }, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
});
