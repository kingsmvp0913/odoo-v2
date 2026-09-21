/**
 * auth-register-closed.test.js — 關閉自助註冊（規格 §8 P3）
 *
 * 多租戶之後帳號一律由平台管理員或公司管理員建立。
 * 最重要的一支是最後那個：關掉註冊不可以連帶把「全新安裝建第一個管理員」也關掉，
 * 否則下一個重裝平台的人會進不去，而且要很久才會發現原因在這裡。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-reg-jwt';
process.env.APP_SECRET = 'test-reg-secret';

let app, dbModule;

beforeEach(async () => {
  jest.resetModules();
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
});

afterEach(() => dbModule._setPoolForTesting(null));

test('全新安裝：第一個管理員照樣建得出來（這支壞掉會讓人裝不起平台）', async () => {
  const res = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '平台管理員' });
  // setup 成功一律回 200（既有行為，見 auth.test.js:50），brief 原稿誤植 201，這裡照實際行為修正。
  expect(res.status).toBe(200);
  expect(res.body.token).toBeTruthy();
});

test('建過之後 setup 就鎖死（既有行為，不可因本關改動而變）', async () => {
  // 兩次呼叫都要帶齊 display_name——setup 的「表非空即 403」檢查排在欄位驗證之前，
  // 若第一次呼叫缺 display_name 會在插入使用者前就被 400 擋下，表仍是空的，
  // 第二次就測不到「已建立過」這個情境（brief 原稿漏帶，這裡補上，斷言本身沒有動）。
  await request(app).post('/api/auth/setup').send({ username: 'admin', password: 'password123', display_name: '平台管理員' });
  const res = await request(app).post('/api/auth/setup').send({ username: 'admin2', password: 'password123', display_name: '第二個' });
  expect(res.status).toBe(403);
});

test('自助註冊一律拒絕，且沒有建出帳號', async () => {
  await request(app).post('/api/auth/setup').send({ username: 'admin', password: 'password123' });
  const res = await request(app).post('/api/auth/register')
    .send({ username: 'selfserve', password: 'password123' });
  expect(res.status).toBe(403);
  expect(res.body.token).toBeUndefined();
  const { rows } = await dbModule.query('SELECT 1 FROM users WHERE username = $1', ['selfserve']);
  expect(rows.length).toBe(0);
});

test('表還是空的時候註冊也一樣拒絕（不可以留一條「趁還沒人就註冊」的路）', async () => {
  const res = await request(app).post('/api/auth/register')
    .send({ username: 'first', password: 'password123' });
  expect(res.status).toBe(403);
});
