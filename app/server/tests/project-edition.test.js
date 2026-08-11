// 意圖：edition 只有兩個合法值，寫進去的怪值會在「建置測試區」那一刻才炸（而且訊息指不向這裡）。
// 故值域在 API 邊界就擋掉；同時確認預設是 community——沒明講的專案不該被當企業版去要求來源。
const { newDb } = require('pg-mem');
const request = require('supertest');

process.env.JWT_SECRET = 'test-edition';

let dbModule, app, adminToken, userToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
  const { hashPassword } = require('../password');
  const pw = await hashPassword('pw');
  await dbModule.query("INSERT INTO users (username, password_hash, display_name, role) VALUES ('adm',$1,'A','admin')", [pw]);
  await dbModule.query("INSERT INTO users (username, password_hash, display_name, role) VALUES ('usr',$1,'U','user')", [pw]);
  adminToken = (await request(app).post('/api/auth/login').send({ username: 'adm', password: 'pw' })).body.token;
  userToken = (await request(app).post('/api/auth/login').send({ username: 'usr', password: 'pw' })).body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

const admin = () => ({ Authorization: `Bearer ${adminToken}` });

test('建立專案未指定 edition → community（既有行為不變）', async () => {
  const res = await request(app).post('/api/projects').set(admin())
    .send({ name: 'e-default', folder_name: 'e-default', odoo_version: '17.0' });
  expect(res.status).toBe(201);
  expect(res.body.edition).toBe('community');
});

test('建立專案可指定 enterprise', async () => {
  const res = await request(app).post('/api/projects').set(admin())
    .send({ name: 'e-ent', folder_name: 'e-ent', odoo_version: '17.0', edition: 'enterprise' });
  expect(res.status).toBe(201);
  expect(res.body.edition).toBe('enterprise');
});

test('建立專案帶非法 edition → 400 且不建立', async () => {
  const res = await request(app).post('/api/projects').set(admin())
    .send({ name: 'e-bad', folder_name: 'e-bad', odoo_version: '17.0', edition: 'ultimate' });
  expect(res.status).toBe(400);
  const { rows } = await dbModule.query("SELECT 1 FROM projects WHERE name='e-bad'");
  expect(rows).toHaveLength(0);
});

test('PATCH 可切換 edition', async () => {
  const created = await request(app).post('/api/projects').set(admin())
    .send({ name: 'e-switch', folder_name: 'e-switch', odoo_version: '17.0' });
  const res = await request(app).patch(`/api/projects/${created.body.id}`).set(admin())
    .send({ edition: 'enterprise' });
  expect(res.status).toBe(200);
  expect(res.body.edition).toBe('enterprise');
});

test('PATCH 帶非法 edition → 400 且原值不變', async () => {
  const created = await request(app).post('/api/projects').set(admin())
    .send({ name: 'e-keep', folder_name: 'e-keep', odoo_version: '17.0', edition: 'enterprise' });
  const res = await request(app).patch(`/api/projects/${created.body.id}`).set(admin())
    .send({ edition: '' });
  expect(res.status).toBe(400);
  const { rows: [p] } = await dbModule.query('SELECT edition FROM projects WHERE id=$1', [created.body.id]);
  expect(p.edition).toBe('enterprise');
});

// 意圖：切 edition 會改變測試區掛什麼 addons，屬於環境層級決定，沿用既有 PATCH 的管理員限定。
test('一般使用者 PATCH edition → 403', async () => {
  const created = await request(app).post('/api/projects').set(admin())
    .send({ name: 'e-perm', folder_name: 'e-perm', odoo_version: '17.0' });
  const res = await request(app).patch(`/api/projects/${created.body.id}`)
    .set({ Authorization: `Bearer ${userToken}` }).send({ edition: 'enterprise' });
  expect(res.status).toBe(403);
});
