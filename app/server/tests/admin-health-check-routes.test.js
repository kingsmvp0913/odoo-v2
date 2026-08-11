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

test('GET 健檢路由 401 未帶 token / 403 非 admin', async () => {
  expect((await request(app).get('/api/admin/health-check')).status).toBe(401);
  expect((await request(app).get('/api/admin/health-check').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
  expect((await request(app).get('/api/admin/health-check/1')).status).toBe(401);
  expect((await request(app).get('/api/admin/health-check/1').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
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

// 意圖：健檢改成每週自動跑之後，admin 無從得知下一次是什麼時候（畫面只有歷史）。
// 這條端點就是那個答案，且必須與 cron 的排程判斷同源——各算一份的話，改了間隔只會改到一邊。
describe('GET /api/admin/health-check-schedule', () => {
  beforeEach(() => dbModule.query('DELETE FROM health_check_runs'));

  test('401 未帶 token / 403 非 admin', async () => {
    expect((await request(app).get('/api/admin/health-check-schedule')).status).toBe(401);
    expect((await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
  });

  test('從沒跑過 → due，沒有可推算的下次時刻', async () => {
    const res = await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, running: false, due: true, lastRunAt: null, nextRunAt: null });
  });

  test('上次已完成 → 下次＝上次起算滿一個週期', async () => {
    await dbModule.query("INSERT INTO health_check_runs (status, window_days, created_at) VALUES ('done',30,NOW() - INTERVAL '2 days')");
    const res = await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.due).toBe(false);
    const gap = new Date(res.body.nextRunAt) - new Date(res.body.lastRunAt);
    expect(gap).toBe(res.body.intervalMs);
    expect(new Date(res.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  test('上次超過一個週期 → due（畫面顯示即將執行，而非過去的時刻）', async () => {
    await dbModule.query("INSERT INTO health_check_runs (status, window_days, created_at) VALUES ('done',30,NOW() - INTERVAL '8 days')");
    const res = await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.due).toBe(true);
  });

  test('上一輪還在跑 → running，不給下次時刻（等這輪落地才算得準）', async () => {
    await dbModule.query("INSERT INTO health_check_runs (status, window_days, created_at) VALUES ('running',30,NOW())");
    const res = await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body).toMatchObject({ running: true, due: false, nextRunAt: null });
  });
});
