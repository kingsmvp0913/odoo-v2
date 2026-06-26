const { newDb } = require('pg-mem');

const mockCallClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ callClaude: mockCallClaude }));

let dbModule, analysisModule;
let userId, taskId;

const VALID_YAML_MODE_A = `case_id: "task_odoo_9001"
module: purchase
odoo_version: "17.0"
project_name: odoo17_hungjou
execution_mode: MODE_A
summary: 修正採購單問題
requirements:
  - 修正 XYZ
low_confidence: false
clarification_channel:
  questions: []
  user_answer: ""`;

const VALID_YAML_MODE_B = `case_id: "task_odoo_9002"
module: stock
odoo_version: "17.0"
project_name: null
execution_mode: MODE_B
summary: 庫存複雜調整
requirements:
  - 修正庫存
low_confidence: false
clarification_channel:
  questions: []
  user_answer: ""`;

const YAML_WITH_QUESTIONS = `case_id: "task_odoo_9003"
module: sale
odoo_version: "17.0"
project_name: null
execution_mode: MODE_A
summary: 需確認的任務
requirements: []
low_confidence: false
clarification_channel:
  questions:
    - 請確認欄位格式？
  user_answer: ""`;

const YAML_LOW_CONFIDENCE = `case_id: "task_odoo_9004"
module: account
odoo_version: "17.0"
project_name: null
execution_mode: MODE_A
summary: 不確定的任務
requirements: []
low_confidence: true
clarification_channel:
  questions: []
  user_answer: ""`;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: users } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('atest', $1, 'A', 'user') RETURNING id",
    [hash]
  );
  userId = users[0].id;

  analysisModule = require('../pipeline/analysis');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status) VALUES ($1, $2, 'odoo', 'Test', '---id---\n9001\n---title---\nTest Task', 'analysis_running') RETURNING id",
    [userId, `task_odoo_${Date.now()}`]
  );
  taskId = rows[0].id;
  mockCallClaude.mockReset();
});

afterEach(async () => {
  await dbModule.query('DELETE FROM task_logs WHERE task_id = $1', [taskId]);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('analyzeTask MODE_A → next_status branch_pending, analysis_yaml saved', async () => {
  mockCallClaude.mockResolvedValue(VALID_YAML_MODE_A);

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('branch_pending');
  expect(result.analysis_yaml).toContain('execution_mode: MODE_A');

  const { rows } = await dbModule.query('SELECT status, analysis_yaml FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('branch_pending');
  expect(rows[0].analysis_yaml).toContain('MODE_A');
});

test('analyzeTask MODE_B → next_status final_pending', async () => {
  mockCallClaude.mockResolvedValue(VALID_YAML_MODE_B);

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('final_pending');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('final_pending');
});

test('analyzeTask with questions → next_status confirm_pending', async () => {
  mockCallClaude.mockResolvedValue(YAML_WITH_QUESTIONS);

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('confirm_pending');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('confirm_pending');
});

test('analyzeTask low_confidence → next_status confirm_pending', async () => {
  mockCallClaude.mockResolvedValue(YAML_LOW_CONFIDENCE);

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('confirm_pending');
});

test('analyzeTask invalid YAML → stopped with blocker', async () => {
  mockCallClaude.mockResolvedValue('this is not yaml: [broken');

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('stopped');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');
});

test('analyzeTask API error → resets to analysis_running and rethrows', async () => {
  mockCallClaude.mockRejectedValue(new Error('Rate limit'));

  await expect(analysisModule.analyzeTask(taskId)).rejects.toThrow('Rate limit');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('analysis_running');
});
