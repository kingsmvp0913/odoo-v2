const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('../pipeline/usage-gate', () => ({
  getGateState: jest.fn().mockResolvedValue({ enabled: true, blocked: true, reason: { window: '5h', current: 92, threshold: 90 } })
}));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 0 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn()
}));

process.env.JWT_SECRET = 'test-usage-gate-status';

let app, dbModule, adminToken, userToken, companyAdminToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  const adminRes = await request(app).post('/api/auth/setup').send({
    username: 'admin_ugs', password: 'admin1234', display_name: 'Admin UGS'
  });
  adminToken = adminRes.body.token;

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('user_ugs', $1, 'User UGS', 'user')",
    [hash]
  );
  const userRes = await request(app).post('/api/auth/login').send({
    username: 'user_ugs', password: 'pass1234'
  });
  userToken = userRes.body.token;

  // 公司管理員（租戶端管理角色）——今日裁決把閘門狀態收成平台管理員限定，這個角色是本分支
  // 才新增的，補一組 fixture 確認它跟一般使用者一樣被擋在外。
  const { rows: [co] } = await dbModule.query(
    "INSERT INTO companies (name, is_active) VALUES ('用量閘門測試公司', true) RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('ca_ugs', $1, 'CA UGS', 'company_admin', $2)",
    [hash, co.id]
  );
  companyAdminToken = (await request(app).post('/api/auth/login')
    .send({ username: 'ca_ugs', password: 'pass1234' })).body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('admin → 200 回 getGateState', async () => {
  const res = await request(app).get('/api/usage-gate/status').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.blocked).toBe(true);
  expect(res.body.reason.window).toBe('5h');
});

test('非 admin → 403', async () => {
  const res = await request(app).get('/api/usage-gate/status').set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});

// 意圖：閘門狀態屬平台自身的內部營運資訊——公司管理員雖是租戶端的管理角色，仍只是「客戶」，
// 這支是平台管理員限定工具，403 是合法的兩種情形之一。
test('公司管理員（租戶端管理角色，非平台管理員）→ 403', async () => {
  const res = await request(app).get('/api/usage-gate/status').set('Authorization', `Bearer ${companyAdminToken}`);
  expect(res.status).toBe(403);
});
