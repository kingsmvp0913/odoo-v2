const { newDb } = require('pg-mem');
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
let dbModule, enterClarifyGate, userId, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  ({ rows: [{ id: userId }] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('vr',$1,'V') RETURNING id", [hash]));
  ({ rows: [{ id: projectId }] } = await dbModule.query(
    "INSERT INTO projects (name,odoo_version) VALUES ('VP','17.0') RETURNING id"));
  ({ enterClarifyGate } = require('../pipeline/verdict-router'));
});
afterAll(() => dbModule._setPoolForTesting(null));

let seq = 0;
async function makeTask() {
  seq++;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id,task_id,source,title,status,project_id)
     VALUES ($1,$2,'odoo','T','qa_running',$3) RETURNING id`, [userId, `vr_${seq}`, projectId]);
  return t.id;
}

test('進 clarify gate：狀態、resume_status、問題寫入 log', async () => {
  const id = await makeTask();
  await enterClarifyGate(id, userId, { questions: ['A 該用單價還小計?', 'B 要不要含稅?'], codeFeedback: '欄位漏加' });
  const { rows: [t] } = await dbModule.query('SELECT status, resume_status, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('clarify_pending');
  expect(t.resume_status).toBe('coding_running');
  expect(t.retry_feedback).toContain('欄位漏加');
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [id]);
  expect(logs.some(l => l.content.includes('需要你裁決') && l.content.includes('A 該用單價還小計?') && l.content.includes('B 要不要含稅?'))).toBe(true);
});

test('無 codeFeedback → retry_feedback 為 null', async () => {
  const id = await makeTask();
  await enterClarifyGate(id, userId, { questions: ['只有規格問題'] });
  const { rows: [t] } = await dbModule.query('SELECT retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.retry_feedback).toBeNull();
});
