// 意圖：真的 route 檔掛在「模擬 socket」的 app 上，驗規格 §8.2 在實際端點成立：
// A 專案的通行證查 B 專案的連線／wiki／任務 → 403；不帶 project 列連線 → 只看得到本專案；
// internal scope 查客戶正式 DB → 403；互動式舊路徑（TCP）完全不受影響。
process.env.APP_SECRET = 'test-ai-scope-routes';
process.env.JWT_SECRET = 'test-ai-scope-routes-jwt';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const { AI_TOKEN_HEADER, aiToken } = require('../lib/ai-token');
const rt = require('../lib/agent-run-token');

const mockRunSelect = jest.fn();
jest.mock('../lib/ssh-sql', () => ({ runSelect: (...a) => mockRunSelect(...a) }));

let dbModule, socketApp, tcpApp, pA, pB, connA, connB;
function mount(app) {
  app.use(express.json());
  require('../db-query-routes').registerRoutes(app);
  require('../wiki-routes').registerRoutes(app);
  require('../ai-task-routes').registerRoutes(app);
  return app;
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const ins = async (name, folder) => (await dbModule.query(
    'INSERT INTO projects (name,folder_name,odoo_version) VALUES ($1,$2,$3) RETURNING id', [name, folder, '17.0'])).rows[0].id;
  pA = await ins('甲', 'scope_a'); pB = await ins('乙', 'scope_b');
  connA = (await dbModule.query("INSERT INTO db_connections (project_id,name,ssh_host,ssh_user,db_name) VALUES ($1,'ca','1.1.1.1','u','d') RETURNING id", [pA])).rows[0].id;
  connB = (await dbModule.query("INSERT INTO db_connections (project_id,name,ssh_host,ssh_user,db_name) VALUES ($1,'cb','1.1.1.2','u','d') RETURNING id", [pB])).rows[0].id;
  await dbModule.query("INSERT INTO wiki_pages (project_id, slug, title, node_type, content) VALUES ($1,'bpage','B 頁','overview','內容')", [pB]);
  const s = express();
  s.use((req, _res, next) => { req.aidevVia = 'socket'; next(); });
  socketApp = mount(s);
  tcpApp = mount(express());
});
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(() => { rt._resetRunsForTesting(); mockRunSelect.mockReset(); });

const tokFor = (scope, pid) => rt.issueRunToken({ scope, projectId: pid, ttlMs: 60000 }).token;

test('A 專案通行證用 B 的 connection_id 查 → 403，而且沒有真的連線', async () => {
  const res = await request(socketApp).post('/ai/db/query').set(AI_TOKEN_HEADER, tokFor(`project-${pA}`, pA))
    .send({ connection_id: connB, sql: 'SELECT 1' });
  expect(res.status).toBe(403);
  expect(mockRunSelect).not.toHaveBeenCalled();
});

test('A 專案通行證查自己的連線 → 放行', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, rows: [], row_count: 0 });
  const res = await request(socketApp).post('/ai/db/query').set(AI_TOKEN_HEADER, tokFor(`project-${pA}`, pA))
    .send({ connection_id: connA, sql: 'SELECT 1' });
  expect(res.status).toBe(200);
  expect(mockRunSelect).toHaveBeenCalledTimes(1);
});

test('/ai/db/log 用別專案連線 → 403', async () => {
  const res = await request(socketApp).post('/ai/db/log').set(AI_TOKEN_HEADER, tokFor(`project-${pA}`, pA))
    .send({ connection_id: connB, at: '2026-09-15 10:00' });
  expect(res.status).toBe(403);
});

test('不帶 project 列連線 → 只回本專案的', async () => {
  const res = await request(socketApp).get('/ai/db/connections').set(AI_TOKEN_HEADER, tokFor(`project-${pA}`, pA));
  expect(res.status).toBe(200);
  expect(res.body.connections.map(c => c.name)).toEqual(['ca']);
});

test('帶別專案的 project 參數列連線 → 403', async () => {
  const res = await request(socketApp).get('/ai/db/connections?project=scope_b').set(AI_TOKEN_HEADER, tokFor(`project-${pA}`, pA));
  expect(res.status).toBe(403);
});

test.each([
  ['/ai/wiki/pages?project=scope_b'],
  ['/ai/wiki/search?project=scope_b&q=內容'],
  ['/ai/wiki/page?project=scope_b&slug=bpage'],
  ['/ai/tasks/spec?project=scope_b&task=1'],
  ['/ai/tasks/similar?project=scope_b&q=x'],
])('A 專案通行證讀 B 專案 %s → 403', async (url) => {
  const res = await request(socketApp).get(url).set(AI_TOKEN_HEADER, tokFor(`project-${pA}`, pA));
  expect(res.status).toBe(403);
});

test('internal-audit 可讀任一專案 wiki；查客戶正式 DB → 403', async () => {
  const t = tokFor('internal-audit', null);
  expect((await request(socketApp).get('/ai/wiki/pages?project=scope_b').set(AI_TOKEN_HEADER, t)).status).toBe(200);
  expect((await request(socketApp).get('/ai/db/connections').set(AI_TOKEN_HEADER, t)).status).toBe(403);
});

test('internal-fix 讀 wiki → 403（只給術語表，計畫 X12）', async () => {
  const res = await request(socketApp).get('/ai/wiki/pages?project=scope_b').set(AI_TOKEN_HEADER, tokFor('internal-fix', null));
  expect(res.status).toBe(403);
});

test('互動式舊路徑不受影響：TCP＋全域通行碼列得到全部連線', async () => {
  const res = await request(tcpApp).get('/ai/db/connections').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(200);
  expect(res.body.connections.map(c => c.name).sort()).toEqual(['ca', 'cb']);
});
