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

// 意圖：深色偏好寫入 odoo_settings.theme，且不得洗掉既有設定（read-modify-write 合併）
test('PUT /api/settings/theme → 存 dark 並保留既有 odoo_settings', async () => {
  const res = await request(app).put('/api/settings/theme')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ theme: 'dark' });
  expect(res.status).toBe(200);

  const get = await request(app).get('/api/settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(get.body.odoo_settings.theme).toBe('dark');
  // 前一個測試設定的 odoo_url 不能被洗掉
  expect(get.body.odoo_settings.odoo_url).toBe('https://example.com');
});

test('PUT /api/settings/theme → 非法值回 400', async () => {
  const res = await request(app).put('/api/settings/theme')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ theme: 'blue' });
  expect(res.status).toBe(400);
});

// 這條是事故的迴歸測試，不是形式測試：PUT /api/settings 是**整包覆寫**，具名 view 若圖省事走那支，
// 前面存好的 theme 與 odoo_url 會被靜默刪掉——本機 localStorage 還在，要換裝置或開無痕才發現。
// 所以下面驗的重點不是「view 存進去了」，而是「除了 saved_views 以外什麼都沒動」。
test('PUT /api/settings/views → 存 view 且不得洗掉 theme 與既有設定', async () => {
  const res = await request(app).put('/api/settings/views')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ saved_views: [{ name: '我的待審核', filters: { filter: 'review_pending' } }] });
  expect(res.status).toBe(200);

  const get = await request(app).get('/api/settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(get.body.odoo_settings.saved_views).toHaveLength(1);
  expect(get.body.odoo_settings.saved_views[0].name).toBe('我的待審核');
  expect(get.body.odoo_settings.saved_views[0].filters.filter).toBe('review_pending');
  expect(get.body.odoo_settings.theme).toBe('dark');                       // ← 本測試的重點
  expect(get.body.odoo_settings.odoo_url).toBe('https://example.com');     // ← 本測試的重點
});

test('PUT /api/settings/views → 非陣列回 400', async () => {
  const res = await request(app).put('/api/settings/views')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ saved_views: { name: '不是陣列' } });
  expect(res.status).toBe(400);
});

test('PUT /api/settings/views → 名稱空白回 400（存進去會讓側欄整排壞掉）', async () => {
  const res = await request(app).put('/api/settings/views')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ saved_views: [{ name: '   ', filters: {} }] });
  expect(res.status).toBe(400);
});

test('PUT /api/settings/views → 超過上限回 400（前端擋下只是提示，真防線在後端）', async () => {
  const res = await request(app).put('/api/settings/views')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ saved_views: Array.from({ length: 11 }, (_, i) => ({ name: `v${i}`, filters: {} })) });
  expect(res.status).toBe(400);
});

// 筆數擋了、單筆大小沒擋＝上限形同虛設：odoo_settings 每次 GET /api/settings 與 auth/me 都整包回
// 前端（auth/me 每次導覽都打），一筆塞爆就等於拖垮每一個請求。前端的 maxlength 只是提示。
test('PUT /api/settings/views → 名稱超長回 400', async () => {
  const res = await request(app).put('/api/settings/views')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ saved_views: [{ name: 'x'.repeat(21), filters: {} }] });
  expect(res.status).toBe(400);
});

test('PUT /api/settings/views → filters 過大回 400', async () => {
  const res = await request(app).put('/api/settings/views')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ saved_views: [{ name: '肥的', filters: { search: 'x'.repeat(600) } }] });
  expect(res.status).toBe(400);
});

// 擋過頭同樣是 bug：正常長度的組合必須存得進去，且沒有把先前的設定弄壞
test('PUT /api/settings/views → 正常長度照存（上限不得誤傷）', async () => {
  const res = await request(app).put('/api/settings/views')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ saved_views: [{ name: '二十個字剛剛好的組合名稱共二十字', filters: { filter: 'all', search: '關鍵字' } }] });
  expect(res.status).toBe(200);
  expect(res.body.saved_views[0].filters.search).toBe('關鍵字');
});

test('PUT /api/settings/views → 401 without token', async () => {
  const res = await request(app).put('/api/settings/views').send({ saved_views: [] });
  expect(res.status).toBe(401);
});
