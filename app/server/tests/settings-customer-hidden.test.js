/**
 * settings-customer-hidden.test.js — 客戶看不到 Odoo 帳密與同步設定（規格 §8 P2）
 *
 * 那是我們用來連客戶系統的憑證，不是客戶自己的東西。
 * 顯示名稱、密碼、個人 GIT 三項客戶照樣要能改——收太多會讓客戶連改密碼都做不到。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-sch-jwt';
process.env.APP_SECRET = 'test-sch-secret';

let app, dbModule, adminToken, custToken, internalToken;

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

  const coInternal = (await one(
    'INSERT INTO companies (name, is_active, is_internal) VALUES ($1,true,true) RETURNING id', ['內部'])).id;
  const coCust = (await one(
    'INSERT INTO companies (name, is_active) VALUES ($1,true) RETURNING id', ['甲客戶'])).id;

  const mkUser = async (username, companyId) => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id, approved) VALUES ($1,$2,$1,$3,$4,true)',
      [username, hash, 'user', companyId]);
    return (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
  };
  internalToken = await mkUser('inside', coInternal);
  custToken = await mkUser('cust', coCust);
});

afterAll(() => dbModule._setPoolForTesting(null));

test('客戶讀設定：回應裡沒有 Odoo／eService 相關欄位', async () => {
  const res = await request(app).get('/api/settings').set(as(custToken));
  expect(res.status).toBe(200);
  const body = JSON.stringify(res.body);
  expect(body).not.toContain('odoo_username');
  expect(body).not.toContain('service_username');
  expect(res.body.sync_interval).toBeUndefined();
});

test('客戶寫 Odoo 設定：被忽略，DB 沒有被寫進去', async () => {
  await request(app).put('/api/settings').set(as(custToken))
    .send({ odoo_settings: { odoo_username: 'sneaky', odoo_password: 'x' }, sync_interval: 5 });
  const row = await one('SELECT odoo_settings, sync_interval FROM users WHERE username=$1', ['cust']);
  const s = typeof row.odoo_settings === 'string' ? JSON.parse(row.odoo_settings || '{}') : (row.odoo_settings || {});
  expect(s.odoo_username).toBeUndefined();
});

test('客戶呼叫驗證 Odoo 帳密 → 404（這個功能對他不存在）', async () => {
  expect((await request(app).post('/api/settings/verify-odoo').set(as(custToken)).send({})).status).toBe(404);
});

test('客戶呼叫驗證 eService → 404', async () => {
  expect((await request(app).post('/api/settings/verify-service').set(as(custToken)).send({})).status).toBe(404);
});

test('客戶照樣能設個人 GitHub PAT（收太多會讓他連自己的憑證都設不了）', async () => {
  const res = await request(app).post('/api/settings/github-pat').set(as(custToken))
    .send({ pat: 'ghp_customer', login: 'cust-bot' });
  expect(res.status).not.toBe(404);
  expect(res.status).not.toBe(403);
});

test('客戶照樣能改主題（純 UI 偏好，與租戶無關）', async () => {
  expect((await request(app).put('/api/settings/theme').set(as(custToken)).send({ theme: 'dark' })).status).toBe(200);
});

test('內部公司的人完全不受影響——這一關對現在平台上的人必須零改變', async () => {
  const res = await request(app).get('/api/settings').set(as(internalToken));
  expect(res.status).toBe(200);
  expect((await request(app).post('/api/settings/verify-odoo').set(as(internalToken)).send({})).status).not.toBe(404);
});

test('平台管理員（沒有公司）不受影響', async () => {
  expect((await request(app).get('/api/settings').set(as(adminToken))).status).toBe(200);
  expect((await request(app).post('/api/settings/verify-odoo').set(as(adminToken)).send({})).status).not.toBe(404);
});

test('白名單方向：odoo_settings 裡「未來才會出現」的陌生鍵，客戶預設看不到——防的是有人加新欄位卻忘了回頭補這道過濾', async () => {
  // 直接寫 DB 模擬「以後某功能往 odoo_settings 加了一個新欄位」，而完全沒人碰過 settings.js 的過濾清單。
  await dbModule.query('UPDATE users SET odoo_settings = $2 WHERE username = $1',
    ['cust', JSON.stringify({ theme: 'light', a_field_nobody_whitelisted_yet: 'leak-me' })]);
  const res = await request(app).get('/api/settings').set(as(custToken));
  expect(res.status).toBe(200);
  // 白名單的話，沒被明確列進 CUSTOMER_SETTINGS_WHITELIST 的鍵一律不回——即使它跟 Odoo/eService 毫無關係。
  expect(res.body.odoo_settings.a_field_nobody_whitelisted_yet).toBeUndefined();
  expect(res.body.odoo_settings.theme).toBe('light');   // 白名單內的鍵照樣要回，不能連 UI 偏好一起誤殺
});
