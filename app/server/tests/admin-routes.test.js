const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 0 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
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
