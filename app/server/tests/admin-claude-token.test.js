// 意圖：Claude 憑證有兩把——主憑證（平時跑任務）與備用憑證（另一份訂閱，主帳號撞用量閘門時頂上）。
// 兩把都必須「先驗證再存」，且 token 不論明文密文都不得回流前端；備援開關預設關閉，
// 沒開就是過去的行為（撞門檻即暫停推進）。
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 0 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/git', () => ({ createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ runClaude: jest.fn().mockResolvedValue({ text: 'ok' }) }));
jest.mock('../lib/codex-app-server', () => ({
  accountStatus: jest.fn().mockResolvedValue({ configured: false, auth_mode: null, pending_login: null }),
  startDeviceLogin: jest.fn().mockResolvedValue({ login_id: 'login-1', verification_url: 'https://auth.openai.com/codex/device', user_code: 'ABCD-1234', state: 'pending' }),
  logout: jest.fn().mockResolvedValue(undefined)
}));

process.env.JWT_SECRET = 'test-admin-token';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, adminToken, userToken, runClaude;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ runClaude } = require('../pipeline/claude-runner'));

  const { createApp } = require('../index');
  app = createApp();

  const adminRes = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'admin1234', display_name: 'Admin'
  });
  adminToken = adminRes.body.token;

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('regular', $1, 'Regular', 'user')", [hash]
  );
  const userRes = await request(app).post('/api/auth/login').send({ username: 'regular', password: 'pass1234' });
  userToken = userRes.body.token;
});
afterAll(() => dbModule._setPoolForTesting(null));

beforeEach(async () => {
  runClaude.mockReset();
  runClaude.mockResolvedValue({ text: 'ok' });
  await dbModule.query(
    `UPDATE teams_settings SET claude_oauth_token_enc = NULL, claude_oauth_token_backup_enc = NULL,
     usage_gate_fallback_enabled = false WHERE id = 1`
  );
});

const asAdmin = req => req.set('Authorization', `Bearer ${adminToken}`);

test('GET 一次回兩把憑證的設定狀態與備援開關（前端只打一支）', async () => {
  const res = await asAdmin(request(app).get('/api/admin/claude-token'));
  expect(res.status).toBe(200);
  expect(res.body.configured).toBe(false);
  expect(res.body.backup_configured).toBe(false);
  expect(res.body.fallback_enabled).toBe(false);
});

test('Codex 訂閱登入端點只限管理員，裝置碼不含任何長效憑證', async () => {
  const subscription = require('../lib/codex-app-server');
  const status = await asAdmin(request(app).get('/api/admin/codex-subscription'));
  expect(status.body).toMatchObject({ configured: false });
  const login = await asAdmin(request(app).post('/api/admin/codex-subscription/device-login')).send({});
  expect(login.body).toMatchObject({ verification_url: 'https://auth.openai.com/codex/device', user_code: 'ABCD-1234' });
  expect(JSON.stringify(login.body)).not.toContain('token');
  expect(subscription.startDeviceLogin).toHaveBeenCalled();
  expect((await request(app).get('/api/admin/codex-subscription').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
  expect((await asAdmin(request(app).delete('/api/admin/codex-subscription'))).status).toBe(200);
  expect(subscription.logout).toHaveBeenCalled();
});

test('存備用憑證 → 先驗證再存，狀態轉為已設定，且回應不得帶出 token', async () => {
  const res = await asAdmin(request(app).post('/api/admin/claude-token/backup')).send({ token: 'sk-ant-oat01-backup' });
  expect(res.status).toBe(200);
  expect(runClaude).toHaveBeenCalled();
  // 驗證必須用候選 token，不是快取裡的舊值——否則換帳號等於沒驗
  expect(runClaude.mock.calls[0][1].env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-backup');
  expect(JSON.stringify(res.body)).not.toContain('sk-ant-oat01-backup');

  const get = await asAdmin(request(app).get('/api/admin/claude-token'));
  expect(get.body.backup_configured).toBe(true);
  expect(get.body.configured).toBe(false);   // 主憑證不受影響
});

test('備用 token 認證失敗 → 400 且不存（貼錯當場擋下）', async () => {
  const err = new Error('Invalid API key');
  err.claudeStatus = 'auth';
  runClaude.mockRejectedValue(err);
  const res = await asAdmin(request(app).post('/api/admin/claude-token/backup')).send({ token: 'bad' });
  expect(res.status).toBe(400);
  const { rows } = await dbModule.query('SELECT claude_oauth_token_backup_enc FROM teams_settings WHERE id = 1');
  expect(rows[0].claude_oauth_token_backup_enc).toBe(null);
});

// 非認證失敗（API 過載）仍然存：一次 529 就把管理員鎖在外面是更糟的失敗模式
test('備用 token 驗證遇到非認證錯誤 → 仍儲存並回 warning', async () => {
  runClaude.mockRejectedValue(new Error('529 overloaded'));
  const res = await asAdmin(request(app).post('/api/admin/claude-token/backup')).send({ token: 'sk-ant-oat01-b' });
  expect(res.status).toBe(200);
  expect(res.body.warning).toMatch(/529/);
  const { rows } = await dbModule.query('SELECT claude_oauth_token_backup_enc FROM teams_settings WHERE id = 1');
  expect(rows[0].claude_oauth_token_backup_enc).not.toBe(null);
});

test('刪備用憑證 → 只清備用，主憑證留著', async () => {
  await asAdmin(request(app).post('/api/admin/claude-token')).send({ token: 'primary-tok' });
  await asAdmin(request(app).post('/api/admin/claude-token/backup')).send({ token: 'backup-tok' });
  const res = await asAdmin(request(app).delete('/api/admin/claude-token/backup'));
  expect(res.status).toBe(200);
  const get = await asAdmin(request(app).get('/api/admin/claude-token'));
  expect(get.body.backup_configured).toBe(false);
  expect(get.body.configured).toBe(true);
});

test('備援開關可開可關', async () => {
  const on = await asAdmin(request(app).put('/api/admin/claude-fallback')).send({ enabled: true });
  expect(on.status).toBe(200);
  expect((await asAdmin(request(app).get('/api/admin/claude-token'))).body.fallback_enabled).toBe(true);

  await asAdmin(request(app).put('/api/admin/claude-fallback')).send({ enabled: false });
  expect((await asAdmin(request(app).get('/api/admin/claude-token'))).body.fallback_enabled).toBe(false);
});

test('非 admin 一律擋下（憑證是全平台共用的，不能讓一般使用者換掉）', async () => {
  const post = await request(app).post('/api/admin/claude-token/backup')
    .set('Authorization', `Bearer ${userToken}`).send({ token: 'x' });
  expect(post.status).toBe(403);
  const put = await request(app).put('/api/admin/claude-fallback')
    .set('Authorization', `Bearer ${userToken}`).send({ enabled: true });
  expect(put.status).toBe(403);
});
