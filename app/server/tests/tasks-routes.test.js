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

// 健檢 U2：全歸零會讓「繼續」一鍵繳械所有重試上限（任務 52 無限循環的直接機制）。
// 新意圖：只歸零與續跑關卡對應的那一顆，其餘關卡的累計保留。
test('POST /api/tasks/:id/resolve-blocker 無 resume_status → 回 new 且計數器全數保留', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, qa_retry_count, deploy_retry_count, pw_retry_count, blocker_content)
     VALUES ($1,'task_resolve','odoo','R','stopped',3,2,1,'boom') RETURNING id`,
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/resolve-blocker`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ resolution: '已排除' });
  expect(res.status).toBe(200);
  const { rows: [after] } = await dbModule.query(
    'SELECT status, qa_retry_count, deploy_retry_count, pw_retry_count FROM tasks WHERE id=$1', [t.id]
  );
  expect(after.status).toBe('new');
  expect(after.qa_retry_count).toBe(3);
  expect(after.deploy_retry_count).toBe(2);
  expect(after.pw_retry_count).toBe(1);
});

test('resolve-blocker 從 deploy_testing 續跑 → 只歸零 deploy 計數器，qa/pw 累計保留', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, resume_status, qa_retry_count, deploy_retry_count, pw_retry_count, blocker_content)
     VALUES ($1,'task_resolve_dp','odoo','R','stopped','deploy_testing',2,3,1,'boom') RETURNING id`,
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/resolve-blocker`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ resolution: '已修好測試環境' });
  expect(res.status).toBe(200);
  const { rows: [after] } = await dbModule.query(
    'SELECT status, qa_retry_count, deploy_retry_count, pw_retry_count FROM tasks WHERE id=$1', [t.id]
  );
  expect(after.status).toBe('deploy_testing');
  expect(after.deploy_retry_count).toBe(0); // 使用者聲稱已處理，此關卡重新取得完整重試額度
  expect(after.qa_retry_count).toBe(2);     // 其他關卡的歷史不因此消失
  expect(after.pw_retry_count).toBe(1);
});

test('resolve-blocker 有 resume_status → 回到中斷的那一關（而非 new）', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, resume_status, blocker_content)
     VALUES ($1,'task_resume','odoo','R','stopped','coding_running','boom') RETURNING id`,
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/resolve-blocker`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ resolution: '繼續' });
  expect(res.status).toBe(200);
  const { rows: [after] } = await dbModule.query(
    'SELECT status, resume_status, blocker_content FROM tasks WHERE id=$1', [t.id]
  );
  expect(after.status).toBe('coding_running');  // 回到中斷處，非 new
  expect(after.resume_status).toBeNull();        // 用完清除
  expect(after.blocker_content).toBeNull();
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

// 意圖：手動新增的任務要以 'new' 進入 pipeline（由 triage 接手），source 標記為 manual
test('POST /api/tasks → 建立手動任務，status=new / source=manual', async () => {
  const res = await request(app).post('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title: '手動任務', original_text: '需求描述' });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('new');
  expect(res.body.source).toBe('manual');
  expect(res.body.task_id).toMatch(/^manual_/);

  // 確實寫入且可被列出
  const detail = await request(app).get(`/api/tasks/${res.body.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(detail.body.task.title).toBe('手動任務');
  expect(detail.body.task.original_text).toBe('需求描述');
});

test('POST /api/tasks → 缺標題回 400', async () => {
  const res = await request(app).post('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ original_text: '沒有標題' });
  expect(res.status).toBe(400);
});

test('POST /api/tasks → 401 無 token', async () => {
  const res = await request(app).post('/api/tasks').send({ title: 'x' });
  expect(res.status).toBe(401);
});
