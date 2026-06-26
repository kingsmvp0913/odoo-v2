const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 2 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(),
  runDeploy: jest.fn()
}));

process.env.JWT_SECRET = 'test-pipeline-secret';

let app, dbModule, adminToken, userId;

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
  adminToken = res.body.token;

  const me = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  userId = me.body.id;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('POST /api/pipeline/run → 401 without token', async () => {
  const res = await request(app).post('/api/pipeline/run');
  expect(res.status).toBe(401);
});

test('POST /api/pipeline/run → calls runPipeline and returns processed count', async () => {
  const res = await request(app).post('/api/pipeline/run')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.processed).toBe(2);
  const { runPipeline } = require('../pipeline/runner');
  expect(runPipeline).toHaveBeenCalledWith(userId);
});

test('POST /api/tasks/:id/approve → 400 for non-final_pending task', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1, 'task_odoo_approve_test', 'odoo', 'Test', 'analysis_running') RETURNING id",
    [userId]
  );
  const taskId = rows[0].id;

  const res = await request(app).post(`/api/tasks/${taskId}/approve`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(400);

  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('POST /api/tasks/:id/approve → 404 for non-existent task', async () => {
  const res = await request(app).post('/api/tasks/999999/approve')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
});

test('POST /api/tasks/:id/approve → advances final_pending to branch_pending', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1, 'task_odoo_approve_ok', 'odoo', 'Test', 'final_pending') RETURNING id",
    [userId]
  );
  const taskId = rows[0].id;

  const res = await request(app).post(`/api/tasks/${taskId}/approve`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);

  const { rows: updated } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(updated[0].status).toBe('branch_pending');

  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id = $1', [taskId]);
  expect(logs.length).toBe(1);
  expect(logs[0].content).toBe('審核通過，開始實作');

  await dbModule.query('DELETE FROM task_logs WHERE task_id = $1', [taskId]);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});
