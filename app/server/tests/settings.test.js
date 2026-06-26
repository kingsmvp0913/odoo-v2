const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-settings-secret';

let app, dbModule, adminToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  // 建立 admin 取得 token
  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'password123', display_name: '管理員'
  });
  adminToken = res.body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('GET /api/settings → 401 without token', async () => {
  const res = await request(app).get('/api/settings');
  expect(res.status).toBe(401);
});

test('GET /api/settings → returns default settings', async () => {
  const res = await request(app).get('/api/settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('sync_interval');
  expect(res.body).toHaveProperty('odoo_settings');
});

test('PUT /api/settings → updates sync_interval and odoo_settings', async () => {
  const res = await request(app).put('/api/settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ sync_interval: 30, odoo_settings: { odoo_url: 'https://example.com', odoo_db: 'test' } });
  expect(res.status).toBe(200);
});

test('GET /api/settings → reflects updated values', async () => {
  const res = await request(app).get('/api/settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.sync_interval).toBe(30);
  expect(res.body.odoo_settings.odoo_url).toBe('https://example.com');
});

test('PUT /api/settings → rejects sync_interval < 5', async () => {
  const res = await request(app).put('/api/settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ sync_interval: 2 });
  expect(res.status).toBe(400);
});
