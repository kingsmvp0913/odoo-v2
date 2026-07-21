const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 0 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn()
}));

process.env.JWT_SECRET = 'test-admin';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, adminToken, userToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  // First user via setup becomes admin
  const adminRes = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'admin1234', display_name: 'Admin'
  });
  adminToken = adminRes.body.token;

  // Insert a non-admin user
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('regular', $1, 'Regular', 'user')",
    [hash]
  );
  const userRes = await request(app).post('/api/auth/login').send({
    username: 'regular', password: 'pass1234'
  });
  userToken = userRes.body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

let createdConfigId;
let createdMapId;

// --- users：建立時寫入 E2E 憑證 password_enc ---

test('POST /api/admin/users → 建立使用者並寫入可解回原密碼的 password_enc', async () => {
  const { decrypt } = require('../lib/crypto');
  const res = await request(app).post('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'e2euser', password: 'e2epass123', display_name: 'E2E', role: 'user' });
  expect(res.status).toBe(201);
  const { rows: [u] } = await dbModule.query("SELECT password_enc FROM users WHERE username='e2euser'");
  expect(decrypt(u.password_enc)).toBe('e2epass123');
});

// 意圖：管理員核准 pending 帳號後即可登入（自助註冊審核閘門的收尾）。
test('PUT /api/admin/users/:id approved=true → pending 帳號可登入', async () => {
  await request(app).post('/api/auth/register').send({ username: 'wait1', password: 'password123', display_name: 'W1' });
  const before = await request(app).post('/api/auth/login').send({ username: 'wait1', password: 'password123' });
  expect(before.status).toBe(403);

  const { rows: [u] } = await dbModule.query("SELECT id FROM users WHERE username='wait1'");
  const upd = await request(app).put(`/api/admin/users/${u.id}`)
    .set('Authorization', `Bearer ${adminToken}`).send({ approved: true });
  expect(upd.status).toBe(200);
  expect(upd.body.approved).toBe(true);

  const after = await request(app).post('/api/auth/login').send({ username: 'wait1', password: 'password123' });
  expect(after.status).toBe(200);
});

// 意圖：刪除帳號前必須先清該使用者所有參照（tasks 及其子表、sessions、loop_counter），
// 否則 tasks_user_id_fkey 等外鍵會擋下刪除。這是「沒辦法刪除會員」回報的核心。
test('DELETE /api/admin/users/:id → 連帶清任務與子表後成功刪除', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('todelete', $1, 'ToDelete', 'user') RETURNING id",
    [hash]
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status) VALUES ($1, 'T-1', 'manual', 'new') RETURNING id",
    [u.id]
  );
  await dbModule.query("INSERT INTO task_events (task_id, content) VALUES ($1, 'e')", [t.id]);
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', 'l')", [t.id]);
  await dbModule.query("INSERT INTO task_messages (task_id, content, occurred_at) VALUES ($1, 'm', NOW())", [t.id]);
  await dbModule.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, 'h', NOW())", [u.id]);
  await dbModule.query("INSERT INTO loop_counter (user_id) VALUES ($1)", [u.id]);

  const res = await request(app).delete(`/api/admin/users/${u.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);

  const { rows: gone } = await dbModule.query('SELECT id FROM users WHERE id = $1', [u.id]);
  expect(gone.length).toBe(0);
  const { rows: tasksGone } = await dbModule.query('SELECT id FROM tasks WHERE user_id = $1', [u.id]);
  expect(tasksGone.length).toBe(0);
});

// --- 固定 E2E 測試帳號（唯讀）---

test('GET /api/admin/e2e-account → 回固定帳密 auto_test_user', async () => {
  const res = await request(app).get('/api/admin/e2e-account')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.login).toBe('auto_test_user');
  expect(res.body.password).toBe('auto_test_user');
});

test('GET /api/admin/e2e-account → 403 for non-admin', async () => {
  const res = await request(app).get('/api/admin/e2e-account')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});

// --- version-configs ---

test('GET /api/admin/version-configs → 403 for non-admin', async () => {
  const res = await request(app).get('/api/admin/version-configs')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});

test('GET /api/admin/version-configs → 401 without token', async () => {
  const res = await request(app).get('/api/admin/version-configs');
  expect(res.status).toBe(401);
});

test('GET /api/admin/version-configs → 200 empty list for admin', async () => {
  const res = await request(app).get('/api/admin/version-configs')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

test('POST /api/admin/version-configs → 400 missing required fields', async () => {
  const res = await request(app).post('/api/admin/version-configs')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ odoo_version: '16.0' });
  expect(res.status).toBe(400);
});

test('POST /api/admin/version-configs → creates config', async () => {
  const res = await request(app).post('/api/admin/version-configs')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ odoo_version: '17.0', python_bin: '/usr/bin/python3', venv_base_path: '/opt/venvs', odoo_bin_path: '/opt/odoo/odoo-bin' });
  expect(res.status).toBe(201);
  expect(res.body.odoo_version).toBe('17.0');
  createdConfigId = res.body.id;
});

test('PUT /api/admin/version-configs/:id → updates notes', async () => {
  const res = await request(app).put(`/api/admin/version-configs/${createdConfigId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ notes: 'Production version' });
  expect(res.status).toBe(200);
  expect(res.body.notes).toBe('Production version');
});

test('DELETE /api/admin/version-configs/:id → deletes config', async () => {
  const res = await request(app).delete(`/api/admin/version-configs/${createdConfigId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

test('DELETE /api/admin/version-configs/:id → 404 after deletion', async () => {
  const res = await request(app).delete(`/api/admin/version-configs/${createdConfigId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
});

// --- project-maps ---

test('POST /api/admin/project-maps → creates map', async () => {
  const res = await request(app).post('/api/admin/project-maps')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_name: 'MyOdoo', odoo_version: '17.0', project_dir: '/opt/myodoo' });
  expect(res.status).toBe(201);
  expect(res.body.project_name).toBe('MyOdoo');
  createdMapId = res.body.id;
});

test('GET /api/admin/project-maps → lists maps', async () => {
  const res = await request(app).get('/api/admin/project-maps')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBeGreaterThan(0);
});

test('DELETE /api/admin/project-maps/:id → deletes map', async () => {
  const res = await request(app).delete(`/api/admin/project-maps/${createdMapId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});
