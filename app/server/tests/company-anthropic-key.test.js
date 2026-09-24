// 意圖：客戶自帶 API key 的存檔端點。三件事錯了都不會報錯——
// ①把密文吐回畫面 ②內部公司存了一把永遠用不到的 key ③驗證驗到平台那把而不是候選那把。
// 第三件最陰險：換 key 等於沒驗，貼錯要等到下一張任務才炸。

const request = require('supertest');
const { newDb } = require('pg-mem');

let mockRunClaude;
jest.mock('../pipeline/claude-runner', () => ({
  ...jest.requireActual('../pipeline/claude-runner'),
  runClaude: (...a) => mockRunClaude(...a),
}));

process.env.JWT_SECRET = 'test-cokey-jwt';
process.env.APP_SECRET = 'test-cokey-secret';

let app, dbModule, adminToken, companyId, internalId;
const as = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  adminToken = (await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '平台管理員' })).body.token;

  companyId = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '客戶A' })).body.id;
  // is_internal 任何 API 都不可設定（欄位註解），只能直接寫 DB——這正是它存在的理由。
  const { rows: [i] } = await dbModule.query(
    "INSERT INTO companies (name, is_active, is_internal) VALUES ('內部', true, true) RETURNING id");
  internalId = i.id;
});

afterAll(() => dbModule._setPoolForTesting(null));

beforeEach(() => { mockRunClaude = async () => ({ ok: true }); });

const put = (id, body) =>
  request(app).put(`/api/admin/companies/${id}/anthropic-key`).set('Authorization', `Bearer ${adminToken}`).send(body);

test('存成功：回 ok，而且**不回 key、不回密文**', async () => {
  const res = await put(companyId, { api_key: 'sk-ant-real' });
  expect(res.status).toBe(200);
  const body = JSON.stringify(res.body);
  expect(`回應夾帶原文: ${body.includes('sk-ant-real')}`).toBe('回應夾帶原文: false');
  expect(`回應夾帶密文欄位: ${body.includes('anthropic_key_enc')}`).toBe('回應夾帶密文欄位: false');
});

// ⚠ 這條是最容易寫錯的：驗證若用資料庫裡的舊值，換 key 就等於沒驗。
test('驗證用的是「候選 key」本人，不是平台那把也不是舊值', async () => {
  let seen = null;
  mockRunClaude = async (_prompt, opts) => { seen = opts.env; return { ok: true }; };
  await put(companyId, { api_key: 'sk-ant-候選' });
  // 2026-09-24 起客戶存的是訂閱 token，變數名跟著換。寫錯的話會驗到平台那把而不是
  // 候選這把——等於沒驗，而且一定「通過」。
  expect(`候選憑證有傳進去: ${seen && seen.CLAUDE_CODE_OAUTH_TOKEN === 'sk-ant-候選'}`).toBe('候選憑證有傳進去: true');
});

test('key 無效 → 擋下，不存', async () => {
  mockRunClaude = async () => { const e = new Error('401 Unauthorized'); e.claudeStatus = 'auth'; throw e; };
  const res = await put(companyId, { api_key: 'sk-bad' });
  expect(res.status).toBe(400);
  const { rows } = await dbModule.query('SELECT anthropic_key_enc FROM companies WHERE id=$1', [companyId]);
  // 上一支測試存過一把好的，這裡要確認壞的沒有把它蓋掉
  expect(`壞 key 蓋掉好 key 了嗎: ${rows[0].anthropic_key_enc === null}`).toBe('壞 key 蓋掉好 key 了嗎: false');
});

// 錯誤政策照抄 saveClaudeToken：非認證失敗仍然存。理由是換 key 的時機往往正是服務不穩的
// 時候，一次 529 就把人鎖在外面是更糟的失敗模式——但要據實回報沒驗成功。
test('API 過載等非認證失敗 → 仍然存，但回報 warning', async () => {
  mockRunClaude = async () => { throw new Error('529 overloaded'); };
  const res = await put(companyId, { api_key: 'sk-ant-另一把' });
  expect(res.status).toBe(200);
  expect(`有回報沒驗成功: ${!!res.body.warning}`).toBe('有回報沒驗成功: true');
});

// 內部公司用平台訂閱付錢（companies.is_internal 的欄位註解）。存了也永遠不會被用到，
// 照存只會讓人以為設定生效了。
test('內部公司 → 擋下，不讓它存一把永遠用不到的 key', async () => {
  const res = await put(internalId, { api_key: 'sk-ant-x' });
  expect(res.status).toBe(400);
  expect(`訊息說得出原因: ${/平台的訂閱/.test(res.body.error || '')}`).toBe('訊息說得出原因: true');
});

test('沒貼 key → 400，且不會去跑驗證', async () => {
  let called = false;
  mockRunClaude = async () => { called = true; return {}; };
  const res = await put(companyId, {});
  expect(res.status).toBe(400);
  expect(`白跑了驗證嗎: ${called}`).toBe('白跑了驗證嗎: false');
});

test('清除之後列表的旗標變 false，而且列表永遠不回密文', async () => {
  await request(app).delete(`/api/admin/companies/${companyId}/anthropic-key`)
    .set('Authorization', `Bearer ${adminToken}`).expect(204);
  const res = await request(app).get('/api/admin/companies').set('Authorization', `Bearer ${adminToken}`);
  const row = (res.body || []).find((r) => r.id === companyId);
  expect(`旗標: ${row && row.has_anthropic_key}`).toBe('旗標: false');
  expect(`列表夾帶密文: ${JSON.stringify(res.body).includes('anthropic_key_enc')}`).toBe('列表夾帶密文: false');
});
