// 意圖：admin 一鍵健檢 API（建 run/背景觸發/查歷史與明細）＋admin-gate（子專案 2）。
const request = require('supertest');
const { newDb } = require('pg-mem');

const mockRun = jest.fn().mockResolvedValue(undefined);
jest.mock('../pipeline/health-check-runner', () => ({ runHealthCheck: mockRun }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn(), getInflightTaskIds: () => [], getInflightInfo: () => [], abortTask: jest.fn(), whenIdle: jest.fn()
}));
process.env.JWT_SECRET = 'test-hc-routes';

let app, dbModule, adminToken, userToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
  const setup = await request(app).post('/api/auth/setup').send({ username: 'admin1', password: 'pass1234', display_name: 'A' });
  adminToken = setup.body.token;
  await request(app).post('/api/admin/users').set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'bob', password: 'pass1234', display_name: 'B', role: 'user' });
  const login = await request(app).post('/api/auth/login').send({ username: 'bob', password: 'pass1234' });
  userToken = login.body.token;
}, 30000);
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(() => mockRun.mockClear());

test('401 未帶 token / 403 非 admin', async () => {
  expect((await request(app).post('/api/admin/health-check')).status).toBe(401);
  expect((await request(app).post('/api/admin/health-check').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
});

test('POST → 建 run(running)、回 runId、背景觸發 runHealthCheck', async () => {
  const res = await request(app).post('/api/admin/health-check').set('Authorization', `Bearer ${adminToken}`).send({ windowDays: 14 });
  expect(res.status).toBe(200);
  expect(typeof res.body.runId).toBe('number');
  const { rows: [r] } = await dbModule.query('SELECT status, window_days FROM health_check_runs WHERE id=$1', [res.body.runId]);
  expect(r.status).toBe('running');
  expect(r.window_days).toBe(14);
  expect(mockRun).toHaveBeenCalledWith(res.body.runId, expect.objectContaining({ windowDays: 14 }));
});

test('GET list 回近筆含 findings_count；GET :id 回 run+findings', async () => {
  const { rows: [run] } = await dbModule.query("INSERT INTO health_check_runs (status, window_days) VALUES ('done',30) RETURNING id");
  await dbModule.query("INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity) VALUES ($1,'qa','d','ok')", [run.id]);

  const list = await request(app).get('/api/admin/health-check').set('Authorization', `Bearer ${adminToken}`);
  expect(list.status).toBe(200);
  const item = list.body.find(x => x.id === run.id);
  expect(item.findings_count).toBe(1);

  const detail = await request(app).get(`/api/admin/health-check/${run.id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(detail.body.run.id).toBe(run.id);
  expect(detail.body.findings[0].agent_name).toBe('qa');
});
