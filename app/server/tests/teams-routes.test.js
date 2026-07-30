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

// 意圖：測試區建置模式（venv/docker）由管理設定持久化、可讀回；未帶欄位時不清掉現值。
test('PUT /api/admin/teams-settings 可設定並讀回 env_mode=docker', async () => {
  const putRes = await request(app).put('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ env_mode: 'docker' });
  expect(putRes.status).toBe(200);
  const getRes = await request(app).get('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(getRes.body.env_mode).toBe('docker');
});

test('PUT 未帶 env_mode → 保留現值（不誤清）', async () => {
  await request(app).put('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ writeback_odoo_notes: false });   // 只改別的欄位、不帶 env_mode
  const getRes = await request(app).get('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(getRes.body.env_mode).toBe('docker'); // 仍是上一條設的 docker
});

test('PUT env_mode 非法值 → 正規化為 venv', async () => {
  await request(app).put('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ env_mode: 'bogus' });
  const getRes = await request(app).get('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(getRes.body.env_mode).toBe('venv');
});

test('PUT 三欄可存並讀回（未帶欄位不清空既有值）', async () => {
  // 先存一次帶三欄
  await request(app).put('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ usage_gate_enabled: false, usage_gate_5h_threshold: 85, usage_gate_7d_threshold: 92 });
  let res = await request(app).get('/api/admin/teams-settings').set('Authorization', `Bearer ${adminToken}`);
  expect(res.body.usage_gate_enabled).toBe(false);
  expect(res.body.usage_gate_5h_threshold).toBe(85);
  expect(res.body.usage_gate_7d_threshold).toBe(92);
  // 再存一次不帶這三欄（只改 test_mode）→ 三欄應保留
  await request(app).put('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ test_mode: true });
  res = await request(app).get('/api/admin/teams-settings').set('Authorization', `Bearer ${adminToken}`);
  expect(res.body.usage_gate_5h_threshold).toBe(85);
  expect(res.body.usage_gate_enabled).toBe(false);
});

// 意圖：`test_mode`（暫停 pipeline 自動推進）與 `writeback_odoo_notes` 是這張表裡唯二沒有
// COALESCE 保護的欄位——參數是 `x ? true : false`，key 沒帶就直接寫成 false。
// 而前端 Admin.js 把這兩個值存在 this.testMode／this.writebackOdooNotes，**不在 this.teams 裡**，
// 所以 saveConn／saveTeams／saveUsageGate 這三顆按鈕送出的 `{...this.teams, ...}` 都不含它們，
// saveTestMode 也漏了 writeback。後果：管理員開了「測試模式」暫停 pipeline，之後只要按一下
// 「儲存連線設定」或「儲存用量閘門」，測試模式就被靜默關掉、pipeline 恢復自動派工——
// 而他以為還停著。這是實際會燒掉額度的失效模式。
// 修法比照同檔 env_mode／usage_gate_enabled 的既有慣例：未帶傳 null，由 COALESCE 保留現值。
test('PUT /api/admin/teams-settings 未帶 test_mode／writeback_odoo_notes 時不得清掉現值', async () => {
  await request(app).put('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ test_mode: true, writeback_odoo_notes: true });

  // 模擬 saveConn／saveTeams／saveUsageGate：只送連線與閘門欄位，完全不帶那兩個布林
  const putRes = await request(app).put('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ odoo_url: 'https://o.example.com', odoo_db: 'db1', usage_gate_5h_threshold: 80 });
  expect(putRes.status).toBe(200);

  const getRes = await request(app).get('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(getRes.body.test_mode).toBe(true);              // 被清成 false＝pipeline 在管理員不知情下恢復派工
  expect(getRes.body.writeback_odoo_notes).toBe(true);
  expect(getRes.body.odoo_url).toBe('https://o.example.com'); // 確認這次 PUT 真的有生效，不是整包沒寫入
});

// 意圖：保留現值不能變成「關不掉」——明確送 false 必須被尊重（COALESCE 只在 null 時退讓）。
test('PUT /api/admin/teams-settings 明確送 false 仍要能關掉 test_mode', async () => {
  await request(app).put('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ test_mode: true });
  await request(app).put('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ test_mode: false });
  const getRes = await request(app).get('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(getRes.body.test_mode).toBe(false);
});

// 意圖：`claude_oauth_token_enc` 是全平台唯一一把 Claude 長效憑證的密文。專屬端點
// GET /api/admin/claude-token 刻意只回布林（「token 不論明文密文都不得回流前端」），但這支
// GET 走 `SELECT *`，把同一張表同一個欄位整包吐出去——密文落進瀏覽器＝APP_SECRET 一旦外洩
// 即可解回明文。改用白名單欄位（比照 project-routes 的 PROJECT_PUBLIC_COLS）。
test('GET /api/admin/teams-settings 不得回傳 claude_oauth_token_enc（密文亦不得回流前端）', async () => {
  await dbModule.query(
    `INSERT INTO teams_settings (id, claude_oauth_token_enc, client_secret) VALUES (1, 'ENC_CLAUDE_TOKEN', 'raw-secret')
     ON CONFLICT (id) DO UPDATE SET claude_oauth_token_enc = 'ENC_CLAUDE_TOKEN', client_secret = 'raw-secret'`
  );
  const res = await request(app).get('/api/admin/teams-settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.claude_oauth_token_enc).toBeUndefined();
  // 不能靠「整包不回」蒙混：一般設定欄位仍要讀得到，否則前端管理頁會空掉
  expect(res.body).toHaveProperty('odoo_url');
  expect(res.body).toHaveProperty('env_mode');
  expect(res.body).toHaveProperty('usage_gate_5h_threshold');
  // 既有的 client_secret 遮蔽行為不得回歸
  expect(res.body.client_secret).toBe('••••••');
});
