/**
 * exam-feature-gate.test.js — 考試端點依公司功能開關放行（規格 §5.3、2026-09-21 使用者裁決）
 *
 * 為什麼：24 支考試端點原本只要求「有登入」，客戶公司一旦存在就摸得到內部題庫。
 * 沒開這個功能的公司一律看到 404——不是 403，403 等於告訴對方「這個功能存在」。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-examgate-jwt';
process.env.APP_SECRET = 'test-examgate-secret';

let app, dbModule, adminToken, onToken, offToken, internalToken;

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

  const mkCo = async (name, features) => (await one(
    'INSERT INTO companies (name, is_active, features) VALUES ($1, true, $2) RETURNING id',
    [name, JSON.stringify(features)]
  )).id;
  const coOn = await mkCo('有考試的公司', { exam: true });
  const coOff = await mkCo('沒考試的公司', { exam: false });
  // 內部公司 fixture 比照 company-features.test.js：is_internal=true，不設 features。
  const coInternal = (await one(
    'INSERT INTO companies (name, is_active, is_internal) VALUES ($1, true, true) RETURNING id', ['內部']
  )).id;

  const mkUser = async (username, companyId) => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id, approved) VALUES ($1,$2,$1,$3,$4,true)',
      [username, hash, 'user', companyId]
    );
    return (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
  };
  onToken = await mkUser('exam-on', coOn);
  offToken = await mkUser('exam-off', coOff);
  // 遷移後的多數情況：一般使用者掛在內部公司底下（7 個一般使用者有 6 個是這種）。
  internalToken = await mkUser('exam-internal', coInternal);
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('沒開考試功能的公司', () => {
  test('讀題庫清單 → 404', async () => {
    expect((await request(app).get('/api/exam/banks').set(as(offToken))).status).toBe(404);
  });
  test('開新考試 → 404（寫入端點也要擋，只擋讀的等於沒擋）', async () => {
    expect((await request(app).post('/api/exam/banks').set(as(offToken))
      .send({ label: 'x', odoo_version: '17' })).status).toBe(404);
  });
  test('觸發 AI 判題 → 404（這支會燒錢，最該擋）', async () => {
    expect((await request(app).post('/api/exam/run').set(as(offToken)).send({ bankId: 1 })).status).toBe(404);
  });
  test('拿上傳用的共用 token → 404（拿得到就能繞過所有 verifyToken 的檢查）', async () => {
    expect((await request(app).post('/api/exam/upload-token').set(as(offToken))).status).toBe(404);
  });
});

describe('開了考試功能的公司', () => {
  test('讀題庫清單 → 不是 404（功能開關放行，後面照原本的邏輯走）', async () => {
    expect((await request(app).get('/api/exam/banks').set(as(onToken))).status).not.toBe(404);
  });
});

describe('平台管理員（沒有公司）', () => {
  test('照常可用——沒有公司一律當成全開，寫反會把管理員自己鎖死', async () => {
    expect((await request(app).get('/api/exam/banks').set(as(adminToken))).status).not.toBe(404);
  });
});

describe('內部公司的一般使用者', () => {
  test('照常可用——遷移之後 7 個一般使用者有 6 個是這一種，這支壞掉代表同事當天不能考試', async () => {
    expect((await request(app).get('/api/exam/banks').set(as(internalToken))).status).not.toBe(404);
  });
});
