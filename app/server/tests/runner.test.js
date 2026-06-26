const { newDb } = require('pg-mem');

jest.mock('../pipeline/analysis', () => ({
  analyzeTask: jest.fn()
}));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn().mockResolvedValue(undefined),
  checkoutDefault: jest.fn().mockResolvedValue(undefined),
  runDeploy: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../notify', () => ({
  emitToUser: jest.fn(),
  emitAll: jest.fn(),
  setIo: jest.fn()
}));

let dbModule, runnerModule;
let userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, odoo_settings) VALUES ('runner', $1, 'R', 'user', $2) RETURNING id",
    [hash, JSON.stringify({ git_repo_path: '/repo', deploy_cmd: '' })]
  );
  userId = rows[0].id;

  runnerModule = require('../pipeline/runner');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  require('../pipeline/analysis').analyzeTask.mockReset();
  require('../pipeline/git').createBranch.mockReset();
  require('../pipeline/git').checkoutDefault.mockReset();
  require('../pipeline/git').runDeploy.mockReset();
  require('../notify').emitToUser.mockReset();
  await runnerModule.resetLoopCounter(userId);
  await dbModule.query('DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [userId]);
  await dbModule.query('DELETE FROM tasks WHERE user_id = $1', [userId]);
});

async function insertTask(status, suffix = Date.now()) {
  const { rows } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1, $2, 'odoo', 'Test', 'content', $3) RETURNING id`,
    [userId, `task_odoo_${suffix}`, status]
  );
  return rows[0].id;
}

test('runPipeline advances analysis_running task via analyzeTask', async () => {
  const { analyzeTask } = require('../pipeline/analysis');
  analyzeTask.mockResolvedValue({ next_status: 'branch_pending', analysis_yaml: 'yaml' });

  const taskId = await insertTask('analysis_running');
  const result = await runnerModule.runPipeline(userId);
  expect(result.processed).toBe(1);
  expect(analyzeTask).toHaveBeenCalledWith(taskId, expect.anything());
});

test('runPipeline creates branch for branch_pending task', async () => {
  const { createBranch } = require('../pipeline/git');
  createBranch.mockResolvedValue(undefined);

  const taskId = await insertTask('branch_pending');
  await runnerModule.runPipeline(userId);

  expect(createBranch).toHaveBeenCalledWith('/repo', expect.stringContaining('task/task_odoo'));

  const { rows } = await dbModule.query('SELECT status, git_branch FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('coding_running');
  expect(rows[0].git_branch).toContain('task/');
});

test('runPipeline skips branch creation when git_repo_path not set', async () => {
  await dbModule.query(
    "UPDATE users SET odoo_settings = $2 WHERE id = $1",
    [userId, JSON.stringify({ git_repo_path: '', deploy_cmd: '' })]
  );

  const { createBranch } = require('../pipeline/git');
  const taskId = await insertTask('branch_pending');
  await runnerModule.runPipeline(userId);

  expect(createBranch).not.toHaveBeenCalled();

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('coding_running');

  // Restore
  await dbModule.query(
    "UPDATE users SET odoo_settings = $2 WHERE id = $1",
    [userId, JSON.stringify({ git_repo_path: '/repo', deploy_cmd: '' })]
  );
});

test('runPipeline advances deploy_pending to wiki_updating', async () => {
  const { runDeploy } = require('../pipeline/git');
  runDeploy.mockResolvedValue(undefined);

  const taskId = await insertTask('deploy_pending');
  await runnerModule.runPipeline(userId);

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('wiki_updating');
});

test('runPipeline emits warn toast after loop limit exceeded', async () => {
  const { analyzeTask } = require('../pipeline/analysis');
  analyzeTask.mockResolvedValue({ next_status: 'branch_pending', analysis_yaml: '' });

  // Run pipeline 7 times; each time insert a new analysis_running task
  for (let i = 0; i < 7; i++) {
    await insertTask('analysis_running', Date.now() + i);
    await runnerModule.runPipeline(userId);
  }

  const { emitToUser } = require('../notify');
  const toastCalls = emitToUser.mock.calls.filter(c => c[1] === 'notify:toast');
  expect(toastCalls.length).toBeGreaterThan(0);
  expect(toastCalls[toastCalls.length - 1][2].level).toBe('warn');
});

test('resetLoopCounter allows processing to resume', async () => {
  const { analyzeTask } = require('../pipeline/analysis');
  analyzeTask.mockResolvedValue({ next_status: 'branch_pending', analysis_yaml: '' });

  // Hit the loop limit
  for (let i = 0; i < 7; i++) {
    await insertTask('analysis_running', Date.now() + i * 100);
    await runnerModule.runPipeline(userId);
  }

  await runnerModule.resetLoopCounter(userId);

  analyzeTask.mockResolvedValue({ next_status: 'branch_pending', analysis_yaml: '' });
  await insertTask('analysis_running', Date.now() + 9999);
  const result = await runnerModule.runPipeline(userId);
  expect(result.processed).toBeGreaterThanOrEqual(1);
});

test('runPipeline handles deploy error → status deploy_fixing', async () => {
  const { runDeploy } = require('../pipeline/git');
  runDeploy.mockRejectedValue(new Error('deploy script failed'));

  const taskId = await insertTask('deploy_pending');
  await runnerModule.runPipeline(userId);

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('deploy_fixing');
});
