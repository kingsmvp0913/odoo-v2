// 意圖：管理員在網頁貼 context7 API key——貼 key → 先驗證 → 加密存 → 快取失效（不必重啟 server）。
// 比照 claude-token 三件事：①祕密不得回流前端 ②貼錯當場擋下 ③服務不穩時不得把管理員鎖在外面。
// 這把 key 存在的理由：無 key 走匿名額度，配額用盡時 MCP 不報錯，各關會靜默改用 WebSearch
// 抓 Odoo 原始碼（慢、不準、不記帳），完全沒有告警——所以「貼錯了卻存進去」等同沒設。
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

process.env.JWT_SECRET = 'test-context7-key';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, adminToken, userToken, context7Auth, fetchSpy;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();
  context7Auth = require('../lib/context7-auth');

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
  // 驗證會打真的 context7：一律攔下，否則測試依賴外網且會消耗真實配額
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });
  await dbModule.query('UPDATE teams_settings SET context7_api_key_enc = NULL WHERE id = 1').catch(() => {});
  context7Auth._setForTesting(null);
});

afterEach(() => { fetchSpy.mockRestore(); });

const asAdmin = req => req.set('Authorization', `Bearer ${adminToken}`);

test('一般使用者存取 → 403（key 屬全平台設定，只有管理員能改）', async () => {
  const res = await request(app).get('/api/admin/context7-key').set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});

test('POST 驗證通過 → 加密存檔、快取立即換新（不必重啟 server）', async () => {
  const res = await asAdmin(request(app).post('/api/admin/context7-key')).send({ key: 'ctx7-good' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true });

  const { rows } = await dbModule.query('SELECT context7_api_key_enc FROM teams_settings WHERE id = 1');
  expect(rows[0].context7_api_key_enc).toBeTruthy();
  expect(rows[0].context7_api_key_enc).not.toContain('ctx7-good'); // 必須是密文
  expect(require('../lib/crypto').decrypt(rows[0].context7_api_key_enc)).toBe('ctx7-good');
  // 存檔後不重啟即生效
  expect(context7Auth.getContext7ApiKey()).toBe('ctx7-good');
});

// 驗證要用「候選 key」而非快取裡的舊值，否則換 key 等於沒驗
test('POST 驗證時以候選 key 打 context7 的搜尋端點', async () => {
  await asAdmin(request(app).post('/api/admin/context7-key')).send({ key: 'ctx7-candidate' });
  expect(fetchSpy).toHaveBeenCalledWith(
    expect.stringContaining('context7.com/api/v2/libs/search'),
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer ctx7-candidate' }) })
  );
});

test('POST key 無效（401）→ 400 不存，DB 維持原值', async () => {
  await asAdmin(request(app).post('/api/admin/context7-key')).send({ key: 'ctx7-old' });
  fetchSpy.mockResolvedValue({ ok: false, status: 401 });

  const res = await asAdmin(request(app).post('/api/admin/context7-key')).send({ key: 'ctx7-bad' });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/無效或已被停用/);

  const { rows } = await dbModule.query('SELECT context7_api_key_enc FROM teams_settings WHERE id = 1');
  expect(require('../lib/crypto').decrypt(rows[0].context7_api_key_enc)).toBe('ctx7-old'); // 舊值沒被動到
});

// 換 key 的時機往往正是服務不穩的時候：一次 503 或斷線不該把管理員鎖在外面
test('POST 網路不通 → 仍存檔，但回 warning 據實說明沒驗成功', async () => {
  fetchSpy.mockRejectedValue(new Error('fetch failed'));
  const res = await asAdmin(request(app).post('/api/admin/context7-key')).send({ key: 'ctx7-unverified' });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.warning).toMatch(/fetch failed/);
  expect(context7Auth.getContext7ApiKey()).toBe('ctx7-unverified');
});

test('POST 空 key → 400，且不打 context7（不白費一次請求）', async () => {
  const res = await asAdmin(request(app).post('/api/admin/context7-key')).send({ key: '  ' });
  expect(res.status).toBe(400);
  expect(fetchSpy).not.toHaveBeenCalled();
});

// 祕密不外流：GET 只回布林
test('GET 只回 configured，不含 key 明文或 _enc 欄', async () => {
  await asAdmin(request(app).post('/api/admin/context7-key')).send({ key: 'ctx7-secret' });

  const res = await asAdmin(request(app).get('/api/admin/context7-key'));
  expect(res.status).toBe(200);
  expect(res.body.configured).toBe(true);
  expect(res.body.context7_api_key_enc).toBeUndefined();
  expect(JSON.stringify(res.body)).not.toContain('ctx7-secret');
});

test('GET 未設定 → configured=false', async () => {
  const res = await asAdmin(request(app).get('/api/admin/context7-key'));
  expect(res.body.configured).toBe(false);
});

test('DELETE → 清空欄位並讓快取退回未設定（pipeline 改走匿名額度）', async () => {
  await asAdmin(request(app).post('/api/admin/context7-key')).send({ key: 'ctx7-tmp' });

  const res = await asAdmin(request(app).delete('/api/admin/context7-key'));
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT context7_api_key_enc FROM teams_settings WHERE id = 1');
  expect(rows[0].context7_api_key_enc).toBe(null);
  expect(context7Auth.getContext7ApiKey()).toBe(null);
});
