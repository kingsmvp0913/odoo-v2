// GET /api/maintenance：維護中橫幅（前端）用的輕量旗標端點。
// ⚠ 不是把 GET /api/tasks 包一層 { tasks, maintenance }——/api/tasks 回裸陣列，
// 多處呼叫端用 `data.tasks || data` 兼容，包一層 blast radius 太大（見 task-3.2 controller ruling）。
const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-maintenance-endpoint';

let app, dbModule, userToken;

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
  userToken = res.body.token;
});

afterAll(() => {
  dbModule._setPoolForTesting(null);
});

test('非維護中回 false', async () => {
  const res = await request(app).get('/api/maintenance')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ maintenance: false });
});

test('維護中回 true', async () => {
  const { enterMaintenance, leaveMaintenance } = require('../pipeline/maintenance');
  await enterMaintenance(60000);
  try {
    const res = await request(app).get('/api/maintenance')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ maintenance: true });
  } finally {
    await leaveMaintenance();
  }
});

test('未帶 token 拒絕', async () => {
  const res = await request(app).get('/api/maintenance');
  expect(res.status).toBe(401);
});
