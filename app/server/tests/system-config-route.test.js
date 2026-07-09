process.env.JWT_SECRET = 'test-system-config';
const { newDb } = require('pg-mem');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let dbModule, app, token;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name) VALUES ('sc','h','SC') RETURNING id");
  token = jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const { createApp } = require('../index');
  app = createApp();
});
afterAll(() => dbModule._setPoolForTesting(null));
const auth = () => ({ Authorization: `Bearer ${token}` });

test('GET /api/system/config → writeback_odoo_notes 預設 false', async () => {
  const res = await request(app).get('/api/system/config').set(auth());
  expect(res.status).toBe(200);
  expect(res.body.writeback_odoo_notes).toBe(false);
});

test('GET /api/system/config → writeback_odoo_notes 開啟後回傳 true', async () => {
  await dbModule.query(
    `INSERT INTO teams_settings (id, writeback_odoo_notes) VALUES (1, true)
     ON CONFLICT (id) DO UPDATE SET writeback_odoo_notes = true`
  );
  const res = await request(app).get('/api/system/config').set(auth());
  expect(res.status).toBe(200);
  expect(res.body.writeback_odoo_notes).toBe(true);
});
