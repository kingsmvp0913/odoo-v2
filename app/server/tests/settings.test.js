const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-settings-secret';
// 明確設定：密碼欄位的加解密靠它，跑在別支測試之後才「剛好有值」會讓本檔行為不確定
process.env.APP_SECRET = process.env.APP_SECRET || 'test-settings-app-secret';

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

// 意圖：odoo_password／service_password 原本明碼存 DB，與同一張表已加密的 github_pat_enc 兩套標準。
// 收斂成加密存放，但**只在進出 DB 那一刻轉換**——settings 頁是「載入整包→存檔時原樣鋪回」，
// GET 一旦不回密碼，使用者存一次設定就會把自己的密碼清空。所以這條要同時鎖住兩件事：
// DB 裡不是明碼、而 API 仍回明碼。
test('密碼欄位：DB 存密文，GET /api/settings 與 /api/auth/me 仍回明碼', async () => {
  await request(app).put('/api/settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ odoo_settings: { odoo_url: 'https://erp.test', odoo_username: 'alice', odoo_password: 'secret-pw', service_password: 'svc-pw' } });

  const { rows } = await dbModule.query("SELECT odoo_settings FROM users WHERE username = 'admin'");
  const stored = typeof rows[0].odoo_settings === 'string' ? JSON.parse(rows[0].odoo_settings) : rows[0].odoo_settings;
  expect(stored.odoo_password).not.toBe('secret-pw');      // DB 不得留明碼
  expect(stored.service_password).not.toBe('svc-pw');
  expect(stored.odoo_username).toBe('alice');              // 非祕密欄位不得被動到（誤加密 username 會讓同步連不上）

  const res = await request(app).get('/api/settings').set('Authorization', `Bearer ${adminToken}`);
  expect(res.body.odoo_settings.odoo_password).toBe('secret-pw');
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  expect(me.body.odoo_settings.odoo_password).toBe('secret-pw');
});

// theme／views 是 read-modify-write：直接從 DB 讀出整包（密文）再寫回。若寫入端不認得「已是密文」
// 而再加密一層，解密端只解一次 → 拿到的仍是密文，同步會靜默失敗且看起來像密碼填錯。
test('改 theme 後密碼仍解得回來（read-modify-write 不得把密文再加密一層）', async () => {
  await request(app).put('/api/settings/theme')
    .set('Authorization', `Bearer ${adminToken}`).send({ theme: 'dark' });

  const res = await request(app).get('/api/settings').set('Authorization', `Bearer ${adminToken}`);
  expect(res.body.odoo_settings.theme).toBe('dark');
  expect(res.body.odoo_settings.odoo_password).toBe('secret-pw');
});
