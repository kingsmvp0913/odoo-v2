/**
 * auth-me-tenant-fields.test.js — /api/auth/me 要吐出前端判斷身分所需的欄位（3b 前提）
 *
 * 前端沒有別的管道知道「我是不是內部人員」「我能不能用考試」。
 * features 必須回「有效值」：內部公司與平台管理員在後端是一律全開的，
 * 但他們的 companies.features 欄位是 NULL——直接吐原始值會讓前端把入口藏起來。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-me-jwt';
process.env.APP_SECRET = 'test-me-secret';

let app, dbModule, adminToken, internalToken, custOnToken, custOffToken;

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

  const mkCo = async (name, opts = {}) => (await one(
    'INSERT INTO companies (name, is_active, is_internal, features) VALUES ($1,true,$2,$3) RETURNING id',
    [name, !!opts.internal, opts.features === undefined ? null : JSON.stringify(opts.features)]
  )).id;
  const coInternal = await mkCo('內部', { internal: true });
  const coOn = await mkCo('有考試的客戶', { features: { exam: true } });
  const coOff = await mkCo('沒考試的客戶', { features: { exam: false } });

  const mkUser = async (username, companyId, role = 'user') => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      [username, hash, role, companyId]);
    return (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
  };
  internalToken = await mkUser('inside', coInternal);
  custOnToken = await mkUser('cust-on', coOn);
  custOffToken = await mkUser('cust-off', coOff);
});

afterAll(() => dbModule._setPoolForTesting(null));

test('內部公司的一般使用者：is_internal 為 true', async () => {
  const res = await request(app).get('/api/auth/me').set(as(internalToken));
  expect(res.status).toBe(200);
  expect(res.body.is_internal).toBe(true);
});

test('客戶公司的一般使用者：is_internal 為 false', async () => {
  expect((await request(app).get('/api/auth/me').set(as(custOnToken))).body.is_internal).toBe(false);
});

test('平台管理員沒有公司：is_internal 為 true（他們本來就是內部人員）', async () => {
  expect((await request(app).get('/api/auth/me').set(as(adminToken))).body.is_internal).toBe(true);
});

test('內部公司的 features 欄位是 NULL，但回傳的有效值必須全開', async () => {
  const res = await request(app).get('/api/auth/me').set(as(internalToken));
  expect(res.body.features.exam).toBe(true);
});

test('平台管理員同理全開', async () => {
  expect((await request(app).get('/api/auth/me').set(as(adminToken))).body.features.exam).toBe(true);
});

test('客戶公司開了考試 → true；沒開 → false', async () => {
  expect((await request(app).get('/api/auth/me').set(as(custOnToken))).body.features.exam).toBe(true);
  expect((await request(app).get('/api/auth/me').set(as(custOffToken))).body.features.exam).toBe(false);
});

test('回應不含密碼雜湊或任何密文（既有行為，不可因新增欄位而破壞）', async () => {
  const body = JSON.stringify((await request(app).get('/api/auth/me').set(as(internalToken))).body);
  expect(body).not.toContain('password_hash');
  expect(body).not.toContain('$2a$');
});
