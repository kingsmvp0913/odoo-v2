// 意圖：odooGlossary skill 原本借 platformDB 的 query.js 直連平台 DB，容器裡沒有 DATABASE_URL 也不該有。
// 改打 /ai/glossary：術語表是公開的 Odoo 字串，任何 scope 都能查；但它只准查術語，不是通用 SQL 入口。
process.env.APP_SECRET = 'test-ai-platform-routes';
process.env.JWT_SECRET = 'test-ai-platform-routes-jwt';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const { AI_TOKEN_HEADER } = require('../lib/ai-token');
const rt = require('../lib/agent-run-token');

let dbModule, app;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query(`INSERT INTO exam_glossary (odoo_version, term_en, term_zh, hit_count) VALUES
    ('19','Sales Order','銷售訂單',36), ('19','Sales Order','銷售單',2), ('19','Delivery Orders','交貨單',20), ('17','Sales Order','銷售訂單',30)`);
  app = express();
  app.use((req, _res, next) => { req.aidevVia = 'socket'; next(); });
  app.use(express.json());
  require('../ai-platform-routes').registerRoutes(app);
});
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(() => rt._resetRunsForTesting());
const tok = (scope, pid = null) => rt.issueRunToken({ scope, projectId: pid, ttlMs: 60000 }).token;

test('精確查英文，依 hit_count 由高到低、只回指定版本', async () => {
  const res = await request(app).get('/ai/glossary?version=19&term=Sales%20Order').set(AI_TOKEN_HEADER, tok('project-3', 3));
  expect(res.status).toBe(200);
  expect(res.body.terms).toEqual([
    { term_en: 'Sales Order', term_zh: '銷售訂單', hit_count: 36 },
    { term_en: 'Sales Order', term_zh: '銷售單', hit_count: 2 },
  ]);
});

test('模糊查英文不分大小寫', async () => {
  const res = await request(app).get('/ai/glossary?version=19&q=delivery').set(AI_TOKEN_HEADER, tok('internal-fix'));
  expect(res.body.terms.map(t => t.term_zh)).toEqual(['交貨單']);
});

test('反查中文', async () => {
  const res = await request(app).get(`/ai/glossary?version=19&zh=${encodeURIComponent('交貨')}`).set(AI_TOKEN_HEADER, tok('internal-audit'));
  expect(res.body.terms.map(t => t.term_en)).toEqual(['Delivery Orders']);
});

test('缺參數 → ok:false 並說明', async () => {
  const res = await request(app).get('/ai/glossary?version=19').set(AI_TOKEN_HEADER, tok('internal-audit'));
  expect(res.body.ok).toBe(false);
  expect(res.body.error).toMatch(/term|q|zh/);
});

test('none scope（分類器類）查不到 → 403', async () => {
  const res = await request(app).get('/ai/glossary?version=19&q=order').set(AI_TOKEN_HEADER, tok('none'));
  expect(res.status).toBe(403);
});

describe('/ai/platform/query', () => {
  const routes = require('../ai-platform-routes');
  let lastSql;
  beforeAll(() => {
    routes._setReadonlyRunnerForTesting(async (sql) => {
      lastSql = sql;
      if (/password_hash/.test(sql)) throw new Error('permission denied for table users');
      return { columns: ['n'], rows: [{ n: 3 }], row_count: 1, truncated: false };
    });
  });
  afterAll(() => routes._setReadonlyRunnerForTesting(null));

  test('internal-audit 可查', async () => {
    const res = await request(app).post('/ai/platform/query').set(AI_TOKEN_HEADER, tok('internal-audit')).send({ sql: 'SELECT COUNT(*) n FROM tasks' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, columns: ['n'], rows: [{ n: 3 }], row_count: 1, truncated: false });
    expect(lastSql).toBe('SELECT COUNT(*) n FROM tasks');
  });

  test.each([['project-3', 3], ['internal-fix', null], ['none', null]])('%s → 403（R6-A）', async (scope, pid) => {
    lastSql = undefined;
    const res = await request(app).post('/ai/platform/query').set(AI_TOKEN_HEADER, tok(scope, pid)).send({ sql: 'SELECT 1' });
    expect(res.status).toBe(403);
    expect(lastSql).toBeUndefined();
  });

  test('非唯讀語句 → 400，不送進 DB', async () => {
    lastSql = undefined;
    const res = await request(app).post('/ai/platform/query').set(AI_TOKEN_HEADER, tok('internal-audit')).send({ sql: 'UPDATE users SET role=1' });
    expect(res.status).toBe(400);
    expect(lastSql).toBeUndefined();
  });

  test('權限不足的錯誤原樣回給 agent（它才知道那欄不能讀）', async () => {
    const res = await request(app).post('/ai/platform/query').set(AI_TOKEN_HEADER, tok('internal-audit')).send({ sql: 'SELECT password_hash FROM users' });
    expect(res.body).toEqual({ ok: false, error: expect.stringMatching(/permission denied/) });
  });
});
