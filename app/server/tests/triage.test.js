const { newDb } = require('pg-mem');

const mockCallClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ callClaude: mockCallClaude }));

let dbModule, triageModule;
let userId, taskId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  // Insert test user
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: users } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('triagetest', $1, '測試', 'user') RETURNING id",
    [hash]
  );
  userId = users[0].id;

  triageModule = require('../pipeline/triage');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  // Insert fresh task
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status) VALUES ($1, $2, 'odoo', 'Test Task', 'task content', 'new') RETURNING id",
    [userId, `task_odoo_triage_${Date.now()}`]
  );
  taskId = rows[0].id;
  mockCallClaude.mockReset();
});

afterEach(async () => {
  await dbModule.query('DELETE FROM task_logs WHERE task_id = $1', [taskId]);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('triageTask → analysis_running when triage says so', async () => {
  mockCallClaude.mockResolvedValue(JSON.stringify({ outcome: 'analysis_running', content: '需求清晰，開始分析' }));

  const result = await triageModule.triageTask(taskId);
  expect(result.outcome).toBe('analysis_running');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('analysis_running');
});

test('triageTask → answered when triage says so', async () => {
  mockCallClaude.mockResolvedValue(JSON.stringify({ outcome: 'answered', content: '這個問題的答案是...' }));

  const result = await triageModule.triageTask(taskId);
  expect(result.outcome).toBe('answered');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('answered');
});

test('triageTask → triage_blocked when triage says so', async () => {
  mockCallClaude.mockResolvedValue(JSON.stringify({ outcome: 'triage_blocked', content: '無法透過標準方式實現' }));

  const result = await triageModule.triageTask(taskId);
  expect(result.outcome).toBe('triage_blocked');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('triage_blocked');
});

test('triageTask → confirm_pending with clarification questions', async () => {
  mockCallClaude.mockResolvedValue(JSON.stringify({
    outcome: 'confirm_pending',
    content: '有幾個細節需要確認',
    clarification_questions: ['這個欄位要顯示什麼格式？', '是否要影響報表？']
  }));

  const result = await triageModule.triageTask(taskId);
  expect(result.outcome).toBe('confirm_pending');
  expect(result.clarification_questions).toHaveLength(2);

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('confirm_pending');
});

test('triageTask → triage_blocked when claude returns invalid JSON', async () => {
  mockCallClaude.mockResolvedValue('this is not valid JSON');

  const result = await triageModule.triageTask(taskId);
  expect(result.outcome).toBe('triage_blocked');
});

test('triageTask → resets to new and rethrows on API error', async () => {
  mockCallClaude.mockRejectedValue(new Error('Rate limit exceeded'));

  await expect(triageModule.triageTask(taskId)).rejects.toThrow('Rate limit exceeded');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('new');
});

test('triageNewTasks processes all new tasks for user', async () => {
  mockCallClaude.mockResolvedValue(JSON.stringify({ outcome: 'analysis_running', content: 'ok' }));

  // Insert another new task
  await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1, 'task_odoo_batch_2', 'odoo', 'Batch Task', 'new')",
    [userId]
  );

  await triageModule.triageNewTasks(userId);

  const { rows } = await dbModule.query(
    "SELECT status FROM tasks WHERE user_id = $1 AND task_id LIKE '%batch%'",
    [userId]
  );
  expect(rows[0].status).toBe('analysis_running');

  // cleanup
  await dbModule.query("DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE task_id LIKE '%batch%')");
  await dbModule.query("DELETE FROM tasks WHERE task_id LIKE '%batch%'");
});
