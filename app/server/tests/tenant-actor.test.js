/**
 * tenant-actor.test.js — 每個請求一進來就知道「你是誰、屬於哪家公司、那家能不能用」（規格 §5.1）
 *
 * 兩個最容易做錯、做錯就出事的點：
 *  1. req.isAdmin 語意不能變。全平台至少 6 處自己查 role === 'admin'，
 *     verifyToken 改寫時若順手把公司管理員也算進 isAdmin，客戶就拿到平台權限。
 *  2. 沒有公司的人一律算可用。合併之後、遷移腳本跑之前，現有 6 個一般使用者
 *     company_id 還是 NULL；把「沒有公司」當成不可用，這 6 個人會全部被鎖在門外。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, adminToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  const res = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '管理員' });
  adminToken = res.body.token;
});

afterAll(() => dbModule._setPoolForTesting(null));

// 直接建帳號 + 登入拿 token（rules/testing 22：走真實授權路徑，不用私有 signer）
const makeUser = async (username, role, companyId) => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password123', 10);
  await dbModule.query(
    'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1, $2, $3, $4, $5)',
    [username, hash, username, role, companyId]
  );
  const res = await request(app).post('/api/auth/login').send({ username, password: 'password123' });
  return res.body.token;
};

const makeCompany = async (name, opts = {}) => {
  const { rows } = await dbModule.query(
    `INSERT INTO companies (name, is_active, is_internal, active_from, active_until)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, opts.isActive !== false, !!opts.isInternal, opts.activeFrom || null, opts.activeUntil || null]
  );
  return rows[0].id;
};

test('平台管理員：isAdmin 為 true、沒有公司、可用', async () => {
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.role).toBe('admin');
  expect(res.body.company_id).toBeNull();
  expect(res.body.company_usable).toBe(true);
});

test('公司管理員不是平台管理員（isAdmin 語意不能被改寫）', async () => {
  const cid = await makeCompany('甲公司');
  const token = await makeUser('ca1', 'company_admin', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.role).toBe('company_admin');
  expect(res.body.company_id).toBe(cid);
  expect(res.body.company_name).toBe('甲公司');
  expect(res.body.company_usable).toBe(true);
});

test('還沒掛公司的一般使用者仍然可用（遷移跑之前不能把人鎖在門外）', async () => {
  const token = await makeUser('legacy1', 'user', null);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.company_id).toBeNull();
  expect(res.body.company_usable).toBe(true);
});

test('公司被停用 → company_usable 是 false', async () => {
  const cid = await makeCompany('停用公司', { isActive: false });
  const token = await makeUser('off1', 'user', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.company_usable).toBe(false);
});

test('使用期間已過 → company_usable 是 false', async () => {
  const cid = await makeCompany('過期公司', { activeUntil: '2020-01-01T00:00:00Z' });
  const token = await makeUser('expired1', 'user', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.body.company_usable).toBe(false);
});

test('使用期間還沒開始 → company_usable 是 false', async () => {
  const cid = await makeCompany('未開始公司', { activeFrom: '2999-01-01T00:00:00Z' });
  const token = await makeUser('future1', 'user', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.body.company_usable).toBe(false);
});

test('使用期間兩端都是 NULL＝不限，算可用', async () => {
  const cid = await makeCompany('不限期間公司');
  const token = await makeUser('unlimited1', 'user', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.body.company_usable).toBe(true);
});
