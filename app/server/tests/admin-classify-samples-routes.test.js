// 意圖：admin 失敗分類樣本頁——GET 回判定分佈（verdict×agent_ok）、高頻真因（前 80 字聚合）、
// 近期樣本；window 以 days 過濾（預設 14、上限 90）；非 admin 一律 403。
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 0 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn()
}));

process.env.JWT_SECRET = 'test-admin-cs';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, adminToken, userToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

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
  const userRes = await request(app).post('/api/auth/login').send({ username: 'regular', password: 'pass1234' });
  userToken = userRes.body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

const admin = () => ({ Authorization: `Bearer ${adminToken}` });
const user = () => ({ Authorization: `Bearer ${userToken}` });

async function addSample(errText, verdict, agentOk) {
  await dbModule.query(
    'INSERT INTO classify_samples (task_id, error_text, verdict, agent_ok) VALUES ($1,$2,$3,$4)',
    ['T1', errText, verdict, agentOk]
  );
}

test('GET /api/admin/classify-samples：非 admin → 403', async () => {
  const res = await request(app).get('/api/admin/classify-samples').set(user());
  expect(res.status).toBe(403);
});

test('空表 → total 0、各聚合為空陣列', async () => {
  const res = await request(app).get('/api/admin/classify-samples').set(admin());
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(0);
  expect(res.body.byVerdict).toEqual([]);
  expect(res.body.topPatterns).toEqual([]);
  expect(res.body.recent).toEqual([]);
});

test('聚合：同一真因多筆 → 高頻 pattern 計數正確；判定分佈區分 agent_ok', async () => {
  // 同一句錯誤 3 筆（haiku 判 code）＋另一句 1 筆（沒判出、落預設 env）
  await addSample('weird novel error alpha', 'code', true);
  await addSample('weird novel error alpha', 'code', true);
  await addSample('weird novel error alpha', 'code', true);
  await addSample('some other mystery beta', 'env', false);

  const res = await request(app).get('/api/admin/classify-samples').set(admin());
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(4);

  // 高頻真因：alpha 出現 3 次應排最前
  expect(res.body.topPatterns[0].pattern).toContain('weird novel error alpha');
  expect(res.body.topPatterns[0].n).toBe(3);

  // 判定分佈：code+agent_ok=true 有 3，env+agent_ok=false 有 1
  const codeRow = res.body.byVerdict.find(r => r.verdict === 'code' && r.agent_ok === true);
  const envRow = res.body.byVerdict.find(r => r.verdict === 'env' && r.agent_ok === false);
  expect(codeRow.n).toBe(3);
  expect(envRow.n).toBe(1);

  // 近期樣本回得到內容
  expect(res.body.recent.length).toBe(4);
});

test('days 參數：超過上限被夾到 90（不報錯、正常回應）', async () => {
  const res = await request(app).get('/api/admin/classify-samples?days=99999').set(admin());
  expect(res.status).toBe(200);
  expect(res.body.days).toBe(90);
});
