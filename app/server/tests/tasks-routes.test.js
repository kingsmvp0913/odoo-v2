const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-tasks-secret';

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

  // Get userId
  const me = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  userId = me.body.id;

  // Insert test tasks directly
  await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1, 'task_odoo_1', 'odoo', 'Odoo Task 1', 'content 1', 'new'),
            ($1, 'task_odoo_2', 'odoo', 'Odoo Task 2', 'content 2', 'confirm_pending'),
            ($1, 'task_service_1', 'service', 'Service Task 1', 'content 3', 'analysis_running')`,
    [userId]
  );
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('GET /api/tasks → 401 without token', async () => {
  const res = await request(app).get('/api/tasks');
  expect(res.status).toBe(401);
});

test('GET /api/tasks → returns all 3 tasks', async () => {
  const res = await request(app).get('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body.length).toBe(3);
});

test('GET /api/tasks?needs_action=true → returns only confirm_pending task', async () => {
  const res = await request(app).get('/api/tasks?needs_action=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBe(1);
  expect(res.body[0].status).toBe('confirm_pending');
});

test('GET /api/tasks?source=service → returns only service task', async () => {
  const res = await request(app).get('/api/tasks?source=service')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBe(1);
  expect(res.body[0].source).toBe('service');
});

test('GET /api/tasks/:id → returns task detail with logs array', async () => {
  const listRes = await request(app).get('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`);
  const taskId = listRes.body[0].id;

  const res = await request(app).get(`/api/tasks/${taskId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('task');
  expect(res.body).toHaveProperty('logs');
  expect(Array.isArray(res.body.logs)).toBe(true);
});

test('GET /api/tasks/:id → 404 for non-existent task', async () => {
  const res = await request(app).get('/api/tasks/999999')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
});

test('POST /api/tasks/:id/answer → 400 for non-confirm_pending task', async () => {
  const listRes = await request(app).get('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`);
  const task = listRes.body.find(t => t.status === 'new');

  const res = await request(app).post(`/api/tasks/${task.id}/answer`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ user_answer: 'my answer' });
  expect(res.status).toBe(400);
});

test('POST /api/tasks/:id/answer → updates status to confirm_answered', async () => {
  const listRes = await request(app).get('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`);
  const task = listRes.body.find(t => t.status === 'confirm_pending');

  const res = await request(app).post(`/api/tasks/${task.id}/answer`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ user_answer: 'my answer' });
  expect(res.status).toBe(200);

  // Verify status updated
  const detail = await request(app).get(`/api/tasks/${task.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(detail.body.task.status).toBe('confirm_answered');
});
