/**
 * auth.test.js — Auth routes tests using pg-mem (no real PostgreSQL needed)
 *
 * TDD: tests written before implementation.
 * All 9 original test cases preserved; SQLite replaced with pg-mem.
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

// Must set env vars BEFORE requiring any module
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let app;
let dbModule;

beforeAll(async () => {
  // Build pg-mem pool
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  // Inject pool before requiring modules
  dbModule = require('../db');
  dbModule._setPoolForTesting(pool);

  // Run migration so tables exist
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();
});

afterAll(async () => {
  dbModule._setPoolForTesting(null);
});

let adminToken;

test('GET /api/setup/status → needsSetup: true initially', async () => {
  const res = await request(app).get('/api/setup/status');
  expect(res.status).toBe(200);
  expect(res.body.needsSetup).toBe(true);
});

test('POST /api/auth/setup → creates admin, returns token', async () => {
  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'password123', display_name: '管理員'
  });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeDefined();
  adminToken = res.body.token;
});

test('POST /api/auth/setup → 403 after first admin', async () => {
  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin2', password: 'password123', display_name: '管理員2'
  });
  expect(res.status).toBe(403);
});

test('GET /api/setup/status → needsSetup: false after setup', async () => {
  const res = await request(app).get('/api/setup/status');
  expect(res.body.needsSetup).toBe(false);
});

test('POST /api/auth/login → valid credentials return token + user', async () => {
  const res = await request(app).post('/api/auth/login').send({
    username: 'admin', password: 'password123'
  });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeDefined();
  expect(res.body.user.role).toBe('admin');
  expect(res.body.user.password_hash).toBeUndefined();
});

test('POST /api/auth/login → 401 on wrong password', async () => {
  const res = await request(app).post('/api/auth/login').send({
    username: 'admin', password: 'wrong'
  });
  expect(res.status).toBe(401);
});

test('GET /api/auth/me → returns user with valid token', async () => {
  const res = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.username).toBe('admin');
  expect(res.body.password_hash).toBeUndefined();
});

test('GET /api/auth/me → 401 without token', async () => {
  const res = await request(app).get('/api/auth/me');
  expect(res.status).toBe(401);
});

test('GET /api/auth/me → 401 with invalid token', async () => {
  const res = await request(app).get('/api/auth/me')
    .set('Authorization', 'Bearer invalid.token.here');
  expect(res.status).toBe(401);
});

// --- 主題 E-2：系統不再持有使用者可還原密碼（password_enc 一律不寫，E2E 改用每專案測試帳號）---

test('setup 建管理員不寫 password_enc（不再持有可還原密碼）', async () => {
  const { rows: [u] } = await dbModule.query("SELECT password_enc FROM users WHERE username='admin'");
  expect(u.password_enc).toBeNull();
});

test('改密碼成功但不寫 password_enc', async () => {
  const res = await request(app).put('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ current_password: 'password123', new_password: 'newpassword456' });
  expect(res.status).toBe(200);
  const { rows: [u] } = await dbModule.query("SELECT password_enc FROM users WHERE username='admin'");
  expect(u.password_enc).toBeNull();
  // 還原，避免影響其他測試
  await request(app).put('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ current_password: 'newpassword456', new_password: 'password123' });
});

test('登入成功不補寫 password_enc', async () => {
  const { hashPassword } = require('../password');
  const h = await hashPassword('backfillpass');
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('bf', $1, 'BF')", [h]
  );
  const res = await request(app).post('/api/auth/login').send({ username: 'bf', password: 'backfillpass' });
  expect(res.status).toBe(200);
  const after = await dbModule.query("SELECT password_enc FROM users WHERE username='bf'");
  expect(after.rows[0].password_enc).toBeNull();
});

// --- 自助註冊 ＋ 待審核閘門 ---

// 意圖：自助註冊建 pending 帳號（role=user、approved=false），回 token 供本次精靈設定憑證用。
// approved 唯一在此設 false——其餘建立路徑（setup/admin/直接 INSERT）預設 true，安全模型只擋自助註冊。
test('POST /api/auth/register → 建 pending user、回 token', async () => {
  const res = await request(app).post('/api/auth/register').send({
    username: 'newbie', password: 'password123', display_name: '新人'
  });
  expect(res.status).toBe(201);
  expect(res.body.token).toBeDefined();
  const { rows: [u] } = await dbModule.query("SELECT role, approved FROM users WHERE username='newbie'");
  expect(u.role).toBe('user');
  expect(u.approved).toBe(false);
});

test('POST /api/auth/register → 帳號重複 409', async () => {
  const res = await request(app).post('/api/auth/register').send({
    username: 'newbie', password: 'password123', display_name: '新人2'
  });
  expect(res.status).toBe(409);
});

test('POST /api/auth/register → 密碼<8 → 400', async () => {
  const res = await request(app).post('/api/auth/register').send({
    username: 'shorty', password: 'abc', display_name: 'S'
  });
  expect(res.status).toBe(400);
});

// 意圖：pending 帳號密碼對也不得登入（管理員核准前）。
test('POST /api/auth/login → 未核准帳號 403 pendingApproval', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: 'newbie', password: 'password123' });
  expect(res.status).toBe(403);
  expect(res.body.pendingApproval).toBe(true);
});

// 意圖：未核准閘門——pending token 只准碰 auth/settings，碰工作台 API 一律 403 pendingApproval。
test('未核准閘門：pending token 打工作台 API → 403；打 settings → 放行（非閘門 403）', async () => {
  // 拿 pending 帳號的 register token
  const reg = await request(app).post('/api/auth/register').send({
    username: 'pend2', password: 'password123', display_name: 'P2'
  });
  const pendToken = reg.body.token;

  const blocked = await request(app).get('/api/tasks').set('Authorization', `Bearer ${pendToken}`);
  expect(blocked.status).toBe(403);
  expect(blocked.body.pendingApproval).toBe(true);

  // settings 白名單：閘門放行（route 自身因缺 body 回 400，證明不是被閘門 403 擋）
  const passed = await request(app).post('/api/settings/verify-odoo').set('Authorization', `Bearer ${pendToken}`).send({});
  expect(passed.status).not.toBe(403);
});

// 意圖：已核准（admin）token 不被閘門擋。
test('未核准閘門：admin token 打工作台 API 不被擋（非 403 pendingApproval）', async () => {
  const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${adminToken}`);
  expect(res.body.pendingApproval).toBeUndefined();
  expect(res.status).not.toBe(403);
});

// 意圖：/me 要回 approved 供前端導向（pending→精靈/等待頁）。
test('GET /api/auth/me → 含 approved', async () => {
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  expect(res.body.approved).toBe(true);
});
