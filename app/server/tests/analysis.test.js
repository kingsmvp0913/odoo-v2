const { newDb } = require('pg-mem');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));

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
  mockRunClaude.mockReset();
});

afterEach(async () => {
  await dbModule.query('DELETE FROM task_logs WHERE task_id = $1', [taskId]);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('analyzeTask MODE_A → next_status branch_pending, analysis_yaml saved', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>\n' + VALID_YAML_MODE_A + '\n</result>', usage: null, durationMs: null });

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('branch_pending');
  expect(result.analysis_yaml).toContain('execution_mode: MODE_A');

  const { rows } = await dbModule.query('SELECT status, analysis_yaml FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('branch_pending');
  expect(rows[0].analysis_yaml).toContain('MODE_A');
});

// 健檢 U14：final_pending 是死狀態（無 handler、無前端標籤、卡死不可見）。
// MODE_B＝「先確認再實作」，語意上就是等使用者確認 → 走活的 confirm_pending。
test('analyzeTask MODE_B → confirm_pending（先確認再實作，不得產出死狀態）', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>\n' + VALID_YAML_MODE_B + '\n</result>', usage: null, durationMs: null });

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('confirm_pending');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('confirm_pending');
});

test('analyzeTask with questions → next_status confirm_pending', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>\n' + YAML_WITH_QUESTIONS + '\n</result>', usage: null, durationMs: null });

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('confirm_pending');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('confirm_pending');
});

test('analyzeTask low_confidence → next_status confirm_pending', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>\n' + YAML_LOW_CONFIDENCE + '\n</result>', usage: null, durationMs: null });

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('confirm_pending');
});

test('analyzeTask invalid YAML → stopped with blocker', async () => {
  mockRunClaude.mockResolvedValue({ text: 'this is not yaml: [broken', usage: null, durationMs: null });

  const result = await analysisModule.analyzeTask(taskId);
  expect(result.next_status).toBe('stopped');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');
});

test('analyzeTask API error → resets to analysis_running and rethrows', async () => {
  mockRunClaude.mockRejectedValue(new Error('Rate limit'));

  await expect(analysisModule.analyzeTask(taskId)).rejects.toThrow('Rate limit');

  const { rows } = await dbModule.query('SELECT status, analysis_retry_count FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('analysis_running');
  expect(rows[0].analysis_retry_count).toBe(1); // 失敗計數，供上限兜底
});

// 意圖：analysis_running 是 runnable 狀態，API 失敗保留原狀會被 cron 每分鐘重派——
// 持久性故障（CLI 壞掉、credentials）不設上限＝無限重試、token 與機器空燒
test('analyzeTask API 連續失敗達上限 → stopped（不再無限重試）', async () => {
  mockRunClaude.mockRejectedValue(new Error('spawn claude ENOENT'));
  await dbModule.query('UPDATE tasks SET analysis_retry_count = 2 WHERE id = $1', [taskId]);

  const result = await analysisModule.analyzeTask(taskId); // 第 3 次：不再 rethrow，直接停
  expect(result.next_status).toBe('stopped');

  const { rows } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');
  expect(rows[0].blocker_content).toContain('分析連續 3 次執行失敗');
});

test('analyzeTask 手動暫停（aborted）→ 不計失敗、狀態原地', async () => {
  mockRunClaude.mockRejectedValue(Object.assign(new Error('手動暫停'), { aborted: true }));

  await expect(analysisModule.analyzeTask(taskId)).rejects.toThrow('手動暫停');

  const { rows } = await dbModule.query('SELECT status, analysis_retry_count FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('analysis_running');
  expect(rows[0].analysis_retry_count).toBe(0);
});

test('analyzeTask 成功 → analysis_retry_count 歸零（transient 自癒後不留殘帳）', async () => {
  await dbModule.query('UPDATE tasks SET analysis_retry_count = 2 WHERE id = $1', [taskId]);
  mockRunClaude.mockResolvedValue({ text: '<result>\n' + VALID_YAML_MODE_A + '\n</result>', usage: null, durationMs: null });

  await analysisModule.analyzeTask(taskId);

  const { rows } = await dbModule.query('SELECT analysis_retry_count FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].analysis_retry_count).toBe(0);
});
