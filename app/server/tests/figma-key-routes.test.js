// 意圖：管理員在網頁貼 Figma personal access token——貼 token → 先驗證 → 加密存 → 快取失效（不必重啟）。
// 比照 context7 key 的三件事：①祕密不得回流前端 ②貼錯當場擋下 ③服務不穩時不得把管理員鎖在外面。
// 這把 token 存在的理由：Figma 官方 MCP 只認 OAuth（headless 授權不了）且讀取要 edit access
//（View seat 一律被拒），REST + PAT 是 pipeline 讀得到設計稿的唯一路徑——沒 token 就完全讀不到。
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

process.env.JWT_SECRET = 'test-figma-key';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, adminToken, userToken, figmaAuth, fetchSpy;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();
  figmaAuth = require('../lib/figma-auth');

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
  // 驗證會打真的 Figma：一律攔下，否則測試依賴外網
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });
  await dbModule.query('UPDATE teams_settings SET figma_api_key_enc = NULL WHERE id = 1').catch(() => {});
  figmaAuth._setForTesting(null);
});

afterEach(() => { fetchSpy.mockRestore(); });

const asAdmin = req => req.set('Authorization', `Bearer ${adminToken}`);

test('一般使用者存取 → 403（token 屬全平台設定，只有管理員能改）', async () => {
  const res = await request(app).get('/api/admin/figma-key').set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});

test('POST 驗證通過 → 加密存檔、快取立即換新（不必重啟 server）', async () => {
  const res = await asAdmin(request(app).post('/api/admin/figma-key')).send({ key: 'figd_good' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true });

  const { rows } = await dbModule.query('SELECT figma_api_key_enc FROM teams_settings WHERE id = 1');
  expect(rows[0].figma_api_key_enc).toBeTruthy();
  expect(rows[0].figma_api_key_enc).not.toContain('figd_good'); // 必須是密文
  expect(require('../lib/crypto').decrypt(rows[0].figma_api_key_enc)).toBe('figd_good');
  expect(figmaAuth.getFigmaApiKey()).toBe('figd_good');
});

// 驗證要用「候選 token」而非快取裡的舊值，否則換 token 等於沒驗
test('POST 驗證時以候選 token 打 /v1/me，且走 X-Figma-Token header', async () => {
  await asAdmin(request(app).post('/api/admin/figma-key')).send({ key: 'figd_candidate' });
  expect(fetchSpy).toHaveBeenCalledWith(
    expect.stringContaining('api.figma.com/v1/me'),
    expect.objectContaining({ headers: expect.objectContaining({ 'X-Figma-Token': 'figd_candidate' }) })
  );
});

test('POST token 無效（403）→ 400 不存，DB 維持原值', async () => {
  await asAdmin(request(app).post('/api/admin/figma-key')).send({ key: 'figd_old' });
  fetchSpy.mockResolvedValue({ ok: false, status: 403 });

  const res = await asAdmin(request(app).post('/api/admin/figma-key')).send({ key: 'figd_bad' });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/無效或已被撤銷/);

  const { rows } = await dbModule.query('SELECT figma_api_key_enc FROM teams_settings WHERE id = 1');
  expect(require('../lib/crypto').decrypt(rows[0].figma_api_key_enc)).toBe('figd_old'); // 舊值沒被動到
});

test('POST 網路不通 → 仍存檔，但回 warning 據實說明沒驗成功', async () => {
  fetchSpy.mockRejectedValue(new Error('fetch failed'));
  const res = await asAdmin(request(app).post('/api/admin/figma-key')).send({ key: 'figd_unverified' });
  expect(res.status).toBe(200);
  expect(res.body.warning).toMatch(/fetch failed/);
  expect(figmaAuth.getFigmaApiKey()).toBe('figd_unverified');
});

test('POST 空 token → 400，且不打 Figma（不白費一次請求）', async () => {
  const res = await asAdmin(request(app).post('/api/admin/figma-key')).send({ key: '  ' });
  expect(res.status).toBe(400);
  expect(fetchSpy).not.toHaveBeenCalled();
});

// 祕密不外流：GET 只回布林
test('GET 只回 configured，不含 token 明文或 _enc 欄', async () => {
  await asAdmin(request(app).post('/api/admin/figma-key')).send({ key: 'figd_secret' });

  const res = await asAdmin(request(app).get('/api/admin/figma-key'));
  expect(res.status).toBe(200);
  expect(res.body.configured).toBe(true);
  expect(res.body.figma_api_key_enc).toBeUndefined();
  expect(JSON.stringify(res.body)).not.toContain('figd_secret');
});

test('GET 未設定 → configured=false', async () => {
  const res = await asAdmin(request(app).get('/api/admin/figma-key'));
  expect(res.body.configured).toBe(false);
});

test('DELETE → 清空欄位並讓快取退回未設定（/ai/figma 隨即回 503）', async () => {
  await asAdmin(request(app).post('/api/admin/figma-key')).send({ key: 'figd_tmp' });

  const res = await asAdmin(request(app).delete('/api/admin/figma-key'));
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT figma_api_key_enc FROM teams_settings WHERE id = 1');
  expect(rows[0].figma_api_key_enc).toBe(null);
  expect(figmaAuth.getFigmaApiKey()).toBe(null);
});

// 正式機搬 DB 卻沒搬 APP_SECRET 時密文解不開——這裡若 throw，整台 server 起不來（載入在 index.js 啟動流程裡）
test('loadFigmaKey 遇到解不開的密文 → 不 throw，退成未設定', async () => {
  await dbModule.query("UPDATE teams_settings SET figma_api_key_enc = 'not-a-valid-ciphertext' WHERE id = 1");
  await expect(figmaAuth.loadFigmaKey()).resolves.toBeUndefined();
  expect(figmaAuth.getFigmaApiKey()).toBe(null);
});
