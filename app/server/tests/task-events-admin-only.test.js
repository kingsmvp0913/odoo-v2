/**
 * task-events-admin-only.test.js
 *
 * 2026-09-21 使用者裁決 D2「兩個都收」：GET /api/tasks/:id/events（執行歷程／終端機頁
 * 用的原始資料）前後端本來都對所有登入使用者開放，裁決後收斂為平台管理員限定。
 *
 * 這裡釘的是「看得到任務本人，但看不到執行歷程」→ 403（不是 404）：一般使用者的任務
 * 是他自己的，並沒有被隱藏；只是這個動作被禁止。fixture 形狀照 tenant-routes-scope.test.js
 * （公司 → 專案 → project_companies 綁定 → 使用者），不用 role: 'admin' 抄近路。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-events-admin-jwt';
process.env.APP_SECRET = 'test-events-admin-secret';

let app, dbModule;
let adminToken, userToken;
let taskId;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
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

  const companyId = (await one(
    'INSERT INTO companies (name, is_active) VALUES ($1, true) RETURNING id', ['甲公司']
  )).id;
  const projectId = (await one(
    "INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", ['甲的專案']
  )).id;
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2)', [projectId, companyId]);

  const hash = await bcrypt.hash('password123', 10);
  await dbModule.query(
    'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
    ['userA', hash, 'user', companyId]
  );
  userToken = (await request(app).post('/api/auth/login')
    .send({ username: 'userA', password: 'password123' })).body.token;

  const { rows: [u] } = await dbModule.query("SELECT id FROM users WHERE username = 'userA'");
  const task = await one(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'events-t1','manual','標題','new',$2) RETURNING id",
    [u.id, projectId]
  );
  taskId = task.id;

  await dbModule.query(
    "INSERT INTO task_events (task_id, content) VALUES ($1, 'hello')",
    [taskId]
  );
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('GET /api/tasks/:id/events（規格外補漏：D2 收斂為平台管理員限定）', () => {
  test('一般使用者打自己的任務 → 403（看得到任務本人，只是不能看執行歷程）', async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/events`).set(as(userToken));
    expect(res.status).toBe(403);
  });

  test('平台管理員 → 200，且能讀到事件內容', async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/events`).set(as(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(e => e.content === 'hello')).toBe(true);
  });
});
