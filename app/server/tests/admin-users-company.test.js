/**
 * admin-users-company.test.js — 平台管理員建帳號要明確選公司（規格 §4.4、§5.3）
 *
 * 第 1 部留的暫時措施是「非管理員一律掛內部公司」。客戶公司存在之後，
 * 那個預設值會把客戶的新帳號掛進內部公司，那個人就看得到全部專案。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-auc-jwt';
process.env.APP_SECRET = 'test-auc-secret';

let app, dbModule, adminToken, coA;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
  adminToken = (await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '平台管理員' })).body.token;
  await dbModule.query('INSERT INTO companies (name, is_active, is_internal) VALUES ($1,true,true)', ['內部']);
  coA = (await one('INSERT INTO companies (name, is_active) VALUES ($1,true) RETURNING id', ['甲客戶'])).id;
});

afterAll(() => dbModule._setPoolForTesting(null));

test('建一般使用者要帶 company_id，沒帶 → 400（不再靜默掛內部公司）', async () => {
  const res = await request(app).post('/api/admin/users').set(as(adminToken))
    .send({ username: 'u1', password: 'password123', role: 'user' });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('公司');
});

test('帶了就掛在那家公司', async () => {
  const res = await request(app).post('/api/admin/users').set(as(adminToken))
    .send({ username: 'u2', password: 'password123', role: 'user', company_id: coA });
  expect(res.status).toBe(201);
  expect((await one('SELECT company_id FROM users WHERE username=$1', ['u2'])).company_id).toBe(coA);
});

test('建平台管理員不可以帶公司 → 400（規格 §4.4：admin 的 company_id 必須是 NULL）', async () => {
  const res = await request(app).post('/api/admin/users').set(as(adminToken))
    .send({ username: 'u3', password: 'password123', role: 'admin', company_id: coA });
  expect(res.status).toBe(400);
  expect(await one('SELECT 1 FROM users WHERE username=$1', ['u3'])).toBeUndefined();
});

test('建平台管理員不帶公司 → 201，company_id 是 NULL', async () => {
  const res = await request(app).post('/api/admin/users').set(as(adminToken))
    .send({ username: 'u4', password: 'password123', role: 'admin' });
  expect(res.status).toBe(201);
  expect((await one('SELECT company_id FROM users WHERE username=$1', ['u4'])).company_id).toBeNull();
});

test('不存在的公司 → 400', async () => {
  const res = await request(app).post('/api/admin/users').set(as(adminToken))
    .send({ username: 'u5', password: 'password123', role: 'user', company_id: 999999 });
  expect(res.status).toBe(400);
});

// 意圖（全跑修法波第 7 項）：PUT 這條 POST 已經做的檢查漏做了，帶不存在的 company_id
// 會撞 FK 變成一個看不出原因的 500，而不是講得清楚的 400。
test('PUT 帶不存在的公司 → 400，不是外鍵 500', async () => {
  const id = (await one('SELECT id FROM users WHERE username=$1', ['u2'])).id;
  const res = await request(app).put(`/api/admin/users/${id}`).set(as(adminToken))
    .send({ company_id: 999999 });
  expect(res.status).toBe(400);
});

test('改角色時公司要一起合法：把一般使用者升成 admin 但還掛著公司 → 400', async () => {
  const id = (await one('SELECT id FROM users WHERE username=$1', ['u2'])).id;
  const res = await request(app).put(`/api/admin/users/${id}`).set(as(adminToken)).send({ role: 'admin' });
  expect(res.status).toBe(400);
  expect((await one('SELECT role FROM users WHERE id=$1', [id])).role).toBe('user');
});

test('同時把角色改成 admin 並清掉公司 → 200', async () => {
  const id = (await one('SELECT id FROM users WHERE username=$1', ['u2'])).id;
  const res = await request(app).put(`/api/admin/users/${id}`).set(as(adminToken))
    .send({ role: 'admin', company_id: null });
  expect(res.status).toBe(200);
  const row = await one('SELECT role, company_id FROM users WHERE id=$1', [id]);
  expect(row.role).toBe('admin');
  expect(row.company_id).toBeNull();
});
