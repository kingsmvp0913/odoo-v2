// 意圖：review_pending 退回 → 任務回 coding 依原因修正、原因落 task_rejections（工作流程健檢子專案 1）。
process.env.JWT_SECRET = 'test-reject';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 }), getInflightTaskIds: () => [] }));

let dbModule, app, token, userId, taskDbId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name) VALUES ('rv','h','R') RETURNING id");
  userId = u.id;
  token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,odoo_version) VALUES ('P','17.0') RETURNING id");
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id, reentry_count) VALUES ($1,'task_odoo_1','odoo','T','review_pending',$2,0) RETURNING id",
    [userId, p.id]
  );
  taskDbId = t.id;
  const a = express(); a.use(express.json());
  require('../pipeline-routes').registerRoutes(a);
  app = a;
});
afterAll(() => dbModule._setPoolForTesting(null));
const auth = () => ({ Authorization: `Bearer ${token}` });

test('空白原因 → 400（狀態不變）', async () => {
  const res = await request(app).post(`/api/tasks/${taskDbId}/reject`).set(auth()).send({ reason: '   ' });
  expect(res.status).toBe(400);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskDbId]);
  expect(t.status).toBe('review_pending');
});

test('review_pending 退回 → reject_triage、原因帶入 feedback、reentry+1 不 stopped、落 task_rejections(new)', async () => {
  const res = await request(app).post(`/api/tasks/${taskDbId}/reject`).set(auth())
    .send({ reason: '備註欄位型別錯；審核清單想預設收合' });
  expect(res.status).toBe(200);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, reentry_count FROM tasks WHERE id=$1', [taskDbId]);
  expect(t.status).toBe('reject_triage');           // 進分診，不再直進 coding
  expect(t.retry_feedback).toContain('備註欄位型別錯');
  expect(t.reentry_count).toBe(1);                  // 只累加做統計
  const { rows: rej } = await dbModule.query('SELECT task_id, project_id, reason, status FROM task_rejections');
  expect(rej.length).toBe(1);
  expect(rej[0].task_id).toBe('task_odoo_1');       // 業務 id（穩定，硬刪不失真）
  expect(rej[0].status).toBe('new');
  const { rows: logRows } = await dbModule.query(
    "SELECT role, content FROM task_logs WHERE task_id=$1 ORDER BY id", [taskDbId]
  );
  expect(logRows.length).toBe(1);
  expect(logRows[0].role).toBe('system');
  expect(logRows[0].content).toContain('[人工退回]');
  expect(logRows[0].content).toContain('備註欄位型別錯');
});

test('非 review_pending（已被上題退回成 coding）→ 400', async () => {
  const res = await request(app).post(`/api/tasks/${taskDbId}/reject`).set(auth()).send({ reason: 'x' });
  expect(res.status).toBe(400);
});
