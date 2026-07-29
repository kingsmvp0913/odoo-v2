// 意圖：管理員在網頁換 Claude 帳號——貼 token → 先驗證 → 加密存 → 快取失效（不必重啟 server）。
// 三件事必須被鎖住：①祕密不得回流前端 ②貼錯／過期當場擋下 ③服務不穩時不得把管理員鎖在外面。
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 0 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined),
  getInflightInfo: jest.fn(), abortTask: jest.fn()
}));
jest.mock('../pipeline/claude-runner', () => ({
  runClaude: jest.fn(),
  mcpConfigPath: jest.fn(() => 'none.json'),
  abortError: jest.fn(),
  stopReason: jest.fn(),
}));

process.env.JWT_SECRET = 'test-claude-token';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, adminToken, userToken, runClaude, claudeAuth;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();
  ({ runClaude } = require('../pipeline/claude-runner'));
  claudeAuth = require('../lib/claude-auth');

  const adminRes = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'admin1234', display_name: 'Admin'
  });
  adminToken = adminRes.body.token;

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

beforeEach(async () => {
  runClaude.mockReset();
  await dbModule.query('UPDATE teams_settings SET claude_oauth_token_enc = NULL WHERE id = 1').catch(() => {});
  delete process.env.ANTHROPIC_API_KEY;
  claudeAuth._setForTesting(null);
});

const asAdmin = req => req.set('Authorization', `Bearer ${adminToken}`);

test('一般使用者存取 → 403（憑證屬全平台設定，只有管理員能改）', async () => {
  const res = await request(app).get('/api/admin/claude-token').set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});

test('POST 驗證通過 → 加密存檔、快取立即換新（不必重啟 server）', async () => {
  runClaude.mockResolvedValue({ text: 'ok', usage: null, durationMs: 10 });
  const res = await asAdmin(request(app).post('/api/admin/claude-token')).send({ token: 'sk-oat-good' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true });

  const { rows } = await dbModule.query('SELECT claude_oauth_token_enc FROM teams_settings WHERE id = 1');
  expect(rows[0].claude_oauth_token_enc).toBeTruthy();
  expect(rows[0].claude_oauth_token_enc).not.toContain('sk-oat-good'); // 必須是密文
  expect(require('../lib/crypto').decrypt(rows[0].claude_oauth_token_enc)).toBe('sk-oat-good');
  // 存檔後不重啟即生效：快取已被 reset 成新值
  expect(claudeAuth.getClaudeAuthEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-oat-good' });
});

// 驗證是用「候選 token」而非快取裡的舊 token，否則永遠在驗舊帳號、換帳號等於沒驗
test('POST 驗證時把候選 token 以 env 傳給子行程', async () => {
  runClaude.mockResolvedValue({ text: 'ok' });
  await asAdmin(request(app).post('/api/admin/claude-token')).send({ token: 'sk-oat-candidate' });
  expect(runClaude).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-oat-candidate' } })
  );
});

test('POST 認證失敗 → 400 不存，DB 維持原值', async () => {
  await asAdmin(request(app).post('/api/admin/claude-token')).send({ token: 'sk-oat-old' });
  runClaude.mockReset();
  runClaude.mockRejectedValue(Object.assign(new Error('Claude CLI 未登入或認證失效：Not logged in'), { claudeStatus: 'auth' }));

  const res = await asAdmin(request(app).post('/api/admin/claude-token')).send({ token: 'sk-oat-bad' });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/無效或已過期/);

  const { rows } = await dbModule.query('SELECT claude_oauth_token_enc FROM teams_settings WHERE id = 1');
  expect(require('../lib/crypto').decrypt(rows[0].claude_oauth_token_enc)).toBe('sk-oat-old'); // 舊值沒被動到
});

// 換 token 的時機往往正是服務不穩的時候：一次 529 不該把管理員鎖在外面
test('POST 非認證失敗（API 過載）→ 仍存檔，但回 warning 據實說明沒驗成功', async () => {
  runClaude.mockRejectedValue(Object.assign(new Error('API Error: 529 overloaded_error'), { claudeStatus: 'error' }));
  const res = await asAdmin(request(app).post('/api/admin/claude-token')).send({ token: 'sk-oat-unverified' });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.warning).toMatch(/529/);
  expect(claudeAuth.getClaudeAuthEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-oat-unverified' });
});

test('POST 空 token → 400，且不呼叫驗證（不白燒一次 claude）', async () => {
  const res = await asAdmin(request(app).post('/api/admin/claude-token')).send({ token: '  ' });
  expect(res.status).toBe(400);
  expect(runClaude).not.toHaveBeenCalled();
});

// 祕密不外流：GET 只回布林，回應中不得出現 token 明文或密文欄位（比照 db-query-routes 的守法）
test('GET 只回 configured／shadowed_by，不含 token 明文或 _enc 欄', async () => {
  runClaude.mockResolvedValue({ text: 'ok' });
  await asAdmin(request(app).post('/api/admin/claude-token')).send({ token: 'sk-oat-secret' });

  const res = await asAdmin(request(app).get('/api/admin/claude-token'));
  expect(res.status).toBe(200);
  expect(res.body.configured).toBe(true);
  expect(res.body.claude_oauth_token_enc).toBeUndefined();
  expect(JSON.stringify(res.body)).not.toContain('sk-oat-secret');
});

test('GET 未設定 → configured=false', async () => {
  const res = await asAdmin(request(app).get('/api/admin/claude-token'));
  expect(res.body.configured).toBe(false);
});

// 官方優先序：ANTHROPIC_API_KEY 蓋過 CLAUDE_CODE_OAUTH_TOKEN。不回報就會變成「設了卻沒生效」的無解客訴
test('GET 環境有 ANTHROPIC_API_KEY → shadowed_by 回報該變數名', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
  const res = await asAdmin(request(app).get('/api/admin/claude-token'));
  expect(res.body.shadowed_by).toBe('ANTHROPIC_API_KEY');
});

test('DELETE → 清空欄位並讓快取退回未設定（pipeline 改用本機憑證檔）', async () => {
  runClaude.mockResolvedValue({ text: 'ok' });
  await asAdmin(request(app).post('/api/admin/claude-token')).send({ token: 'sk-oat-tmp' });

  const res = await asAdmin(request(app).delete('/api/admin/claude-token'));
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT claude_oauth_token_enc FROM teams_settings WHERE id = 1');
  expect(rows[0].claude_oauth_token_enc).toBe(null);
  expect(claudeAuth.getClaudeAuthEnv()).toEqual({});
});
