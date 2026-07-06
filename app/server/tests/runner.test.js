const path = require('path');
const { newDb } = require('pg-mem');

jest.mock('../pipeline/analysis', () => ({
  analyzeTask: jest.fn()
}));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn().mockResolvedValue(undefined),
  checkoutDefault: jest.fn().mockResolvedValue(undefined),
  runDeploy: jest.fn().mockResolvedValue(undefined),
  addWorktree: jest.fn().mockResolvedValue(undefined),
  removeWorktree: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../notify', () => ({
  emitToUser: jest.fn(),
  emitAll: jest.fn(),
  setIo: jest.fn()
}));
jest.mock('../pipeline/cs-agent', () => ({
  runCsAgent: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/qa-agent', () => ({
  runQaAgent: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/deploy-testing', () => ({
  runDeployTesting: jest.fn().mockResolvedValue(undefined)
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
  require('../pipeline/git').addWorktree.mockReset();
  require('../pipeline/git').removeWorktree.mockReset();
  // 預設回傳 Promise（mockReset 會清掉 jest.mock 設的 resolved 值）
  require('../pipeline/git').addWorktree.mockResolvedValue(undefined);
  require('../pipeline/git').removeWorktree.mockResolvedValue(undefined);
  require('../notify').emitToUser.mockReset();
  require('../pipeline/cs-agent').runCsAgent.mockReset();
  require('../pipeline/cs-agent').runCsAgent.mockResolvedValue(undefined);
  require('../pipeline/qa-agent').runQaAgent.mockReset();
  require('../pipeline/qa-agent').runQaAgent.mockResolvedValue(undefined);
  require('../pipeline/deploy-testing').runDeployTesting.mockReset();
  require('../pipeline/deploy-testing').runDeployTesting.mockResolvedValue(undefined);
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

test('branch_pending project task creates one worktree per repo from testing', async () => {
  const { addWorktree } = require('../pipeline/git');
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('P1','17.0','p1') RETURNING id"
  );
  await dbModule.query(
    `INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status)
     VALUES ($1,'main','u','/repos/p1/main',true,'done'),($1,'hr','u','/repos/p1/hr',false,'done')`,
    [proj.id]
  );
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id)
     VALUES ($1,'task_odoo_wt1','odoo','T','c','branch_pending',$2) RETURNING id`,
    [userId, proj.id]
  );

  await runnerModule.runPipeline(userId);

  // 每個 repo 各建一個 worktree；branch=task/<id>，base=testing；路徑相異＝並行隔離的意圖
  expect(addWorktree).toHaveBeenCalledTimes(2);
  const calls = addWorktree.mock.calls;
  expect(new Set(calls.map(c => c[1])).size).toBe(2);
  for (const c of calls) {
    expect(c[2]).toBe('task/task_odoo_wt1');
    expect(c[3]).toBe('testing');
    expect(c[1]).toContain(path.join('.worktrees', 'task_odoo_wt1'));
  }

  const { rows } = await dbModule.query('SELECT status, git_branch FROM tasks WHERE id=$1', [t.id]);
  expect(rows[0].status).toBe('coding_running');
  expect(rows[0].git_branch).toBe('task/task_odoo_wt1');
});

test('branch_pending rolls back worktrees and stops task when add fails', async () => {
  const { addWorktree, removeWorktree } = require('../pipeline/git');
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('P2','17.0','p2') RETURNING id"
  );
  await dbModule.query(
    `INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status)
     VALUES ($1,'main','u','/repos/p2/main',true,'done'),($1,'hr','u','/repos/p2/hr',false,'done')`,
    [proj.id]
  );
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id)
     VALUES ($1,'task_odoo_wt2','odoo','T','c','branch_pending',$2) RETURNING id`,
    [userId, proj.id]
  );
  // 第一個 repo 成功，第二個失敗 → 應回滾第一個並把任務標 stopped
  addWorktree.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("branch already exists"));

  await runnerModule.runPipeline(userId);

  expect(removeWorktree).toHaveBeenCalledTimes(1);  // 回滾已建的那一個
  const { rows } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(rows[0].status).toBe('stopped');
  expect(rows[0].blocker_content).toContain('worktree');
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

test('runPipeline 用 cs-agent 處理 new 狀態任務', async () => {
  const { runCsAgent } = require('../pipeline/cs-agent');
  const taskId = await insertTask('new');
  await runnerModule.runPipeline(userId);
  expect(runCsAgent).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

test('runPipeline 把 confirm_answered 接回 analysis_running（帶答案重跑）', async () => {
  const taskId = await insertTask('confirm_answered');
  await runnerModule.runPipeline(userId);
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('analysis_running');
});

test('runPipeline 不推進 review_pending（人工觸點，非 runnable）', async () => {
  const taskId = await insertTask('review_pending');
  await runnerModule.runPipeline(userId);
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('review_pending');
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

test('runPipeline 用 qa-agent 處理 qa_running 任務', async () => {
  const { runQaAgent } = require('../pipeline/qa-agent');
  const taskId = await insertTask('qa_running');
  await runnerModule.runPipeline(userId);
  expect(runQaAgent).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

test('runPipeline 用 deploy-testing 處理 deploy_testing 任務', async () => {
  const { runDeployTesting } = require('../pipeline/deploy-testing');
  const taskId = await insertTask('deploy_testing');
  await runnerModule.runPipeline(userId);
  expect(runDeployTesting).toHaveBeenCalledWith(taskId, userId, expect.anything());
});
