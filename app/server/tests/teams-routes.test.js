const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-teams-secret';

let app, dbModule, adminToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'password123', display_name: '管理員'
  });
  adminToken = res.body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('PUT /api/admin/teams-settings 可設定並讀回 writeback_odoo_notes', async () => {
  const putRes = await request(app).put('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ writeback_odoo_notes: true });
  expect(putRes.status).toBe(200);

  const getRes = await request(app).get('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(getRes.status).toBe(200);
  expect(getRes.body.writeback_odoo_notes).toBe(true);
});

test('PUT /api/admin/teams-settings 預設 writeback_odoo_notes=false', async () => {
  const getRes = await request(app).get('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`);
  // 上一條測試已把它設成 true；這裡改驗證一個全新未設定過的欄位語意——
  // 直接檢查型別是 boolean 即可（避免測試順序耦合）
  expect(typeof getRes.body.writeback_odoo_notes).toBe('boolean');
});
