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

// --- E2E 憑證 password_enc（可逆加密供 Playwright 登入測試區）---
const { decrypt } = require('../lib/crypto');

test('setup 建管理員時寫入可解回原密碼的 password_enc', async () => {
  const { rows: [u] } = await dbModule.query("SELECT password_enc FROM users WHERE username='admin'");
  expect(u.password_enc).toBeTruthy();
  expect(decrypt(u.password_enc)).toBe('password123');
});

test('改密碼同步更新 password_enc', async () => {
  const res = await request(app).put('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ current_password: 'password123', new_password: 'newpassword456' });
  expect(res.status).toBe(200);
  const { rows: [u] } = await dbModule.query("SELECT password_enc FROM users WHERE username='admin'");
  expect(decrypt(u.password_enc)).toBe('newpassword456');
  // 還原，避免影響其他測試
  await request(app).put('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ current_password: 'newpassword456', new_password: 'password123' });
});

test('既有無 password_enc 的使用者登入成功時補寫', async () => {
  const { hashPassword } = require('../password');
  const h = await hashPassword('backfillpass');
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('bf', $1, 'BF')", [h]
  );
  // 登入前 password_enc 為 null
  const before = await dbModule.query("SELECT password_enc FROM users WHERE username='bf'");
  expect(before.rows[0].password_enc).toBeNull();

  const res = await request(app).post('/api/auth/login').send({ username: 'bf', password: 'backfillpass' });
  expect(res.status).toBe(200);

  const after = await dbModule.query("SELECT password_enc FROM users WHERE username='bf'");
  expect(decrypt(after.rows[0].password_enc)).toBe('backfillpass');
});
