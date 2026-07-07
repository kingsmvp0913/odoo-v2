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
  removeWorktree: jest.fn().mockResolvedValue(undefined),
  getMainBranch: jest.fn().mockResolvedValue('main')
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
jest.mock('../pipeline/playwright-agent', () => ({
  runPlaywrightAgent: jest.fn().mockResolvedValue(undefined)
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
  require('../pipeline/playwright-agent').runPlaywrightAgent.mockReset();
  require('../pipeline/playwright-agent').runPlaywrightAgent.mockResolvedValue(undefined);
  await runnerModule.resetLoopCounter(userId);
  await dbModule.query('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [userId]);
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

test('branch_pending project task creates one worktree per repo from main', async () => {
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

  // 每個 repo 各建一個 worktree；branch=task/<id>，base=main（乾淨基底）；路徑相異＝並行隔離的意圖
  expect(addWorktree).toHaveBeenCalledTimes(2);
  const calls = addWorktree.mock.calls;
  expect(new Set(calls.map(c => c[1])).size).toBe(2);
  for (const c of calls) {
    expect(c[2]).toBe('task/task_odoo_wt1');
    expect(c[3]).toBe('main');
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

test('processTask 分派前寫入階段標記 task_event（執行歷程可見「跑到哪」）', async () => {
  const taskId = await insertTask('qa_running');
  await runnerModule.runPipeline(userId);
  const { rows } = await dbModule.query(
    'SELECT content FROM task_events WHERE task_id = $1 ORDER BY id', [taskId]
  );
  expect(rows.length).toBeGreaterThan(0);
  // 標記以中文顯示（D：不影響 status 值，只影響歷程顯示文字）
  expect(rows.some(r => r.content.includes('▶') && r.content.includes('QA 審查中'))).toBe(true);
});

test('任務轉 stopped 時把阻塞原因寫進執行歷程', async () => {
  const { addWorktree } = require('../pipeline/git');
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('PS','17.0','ps') RETURNING id"
  );
  await dbModule.query(
    `INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status)
     VALUES ($1,'main','u','/repos/ps/main',true,'done')`, [proj.id]
  );
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id)
     VALUES ($1,'task_odoo_stopev','odoo','T','c','branch_pending',$2) RETURNING id`, [userId, proj.id]
  );
  addWorktree.mockRejectedValueOnce(new Error('boom worktree'));

  await runnerModule.runPipeline(userId);

  const { rows } = await dbModule.query('SELECT content FROM task_events WHERE task_id=$1 ORDER BY id', [t.id]);
  expect(rows.some(r => r.content.includes('❌ 失敗') && r.content.includes('worktree'))).toBe(true);
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

test('runPipeline 用 playwright-agent 處理 playwright_running 任務', async () => {
  const { runPlaywrightAgent } = require('../pipeline/playwright-agent');
  const taskId = await insertTask('playwright_running');
  await runnerModule.runPipeline(userId);
  expect(runPlaywrightAgent).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

// --- 健檢 U1 止血：cron fire-and-forget 併發互踩防護 ---
// 意圖：cron 每分鐘不 await 就觸發 runPipeline，長 coding 會讓多個實例疊加，
// 舊實例用過期 status 快照重複派工（最壞情況：砍掉進行中 coding 的 worktree）。

test('runPipeline 執行中時同 user 再呼叫直接跳過（cron tick 防重入）', async () => {
  const { runCsAgent } = require('../pipeline/cs-agent');
  let release, started;
  const startedP = new Promise(r => { started = r; });
  runCsAgent.mockImplementation(() => { started(); return new Promise(res => { release = res; }); });

  await insertTask('cs_running', 'reent1');
  const first = runnerModule.runPipeline(userId);   // 第一個 tick：cs handler 掛住不放
  await startedP;
  const second = await runnerModule.runPipeline(userId); // 下一個 tick 疊上來
  expect(second.processed).toBe(0);                 // 不得產生第二個並行實例

  release();
  await first;
  // 防重入解除後可正常再跑
  runCsAgent.mockResolvedValue(undefined);
  await insertTask('cs_running', 'reent2');
  const third = await runnerModule.runPipeline(userId);
  expect(third.processed).toBeGreaterThan(0);
});

test('派工前重查現況：狀態已被推進的任務本輪跳過，不用過期快照重複派工', async () => {
  const { runCsAgent } = require('../pipeline/cs-agent');
  const { createBranch, checkoutDefault } = require('../pipeline/git');

  const csId = await insertTask('cs_running', 'stale_cs');
  const branchId = await insertTask('branch_pending', 'stale_br');
  // 確保 cs 任務先被處理（ORDER BY updated_at ASC）
  await dbModule.query('UPDATE tasks SET updated_at = $2 WHERE id = $1', [csId, new Date(Date.now() - 60000)]);

  runCsAgent.mockImplementation(async () => {
    // 模擬快照過期：branch 任務在本輪等待期間已被推進到 coding_running
    await dbModule.query("UPDATE tasks SET status='coding_running' WHERE id = $1", [branchId]);
  });

  await runnerModule.runPipeline(userId);

  // 舊快照 branch_pending 不得再觸發 handleBranch（否則會重砍分支／worktree）
  expect(createBranch).not.toHaveBeenCalled();
  expect(checkoutDefault).not.toHaveBeenCalled();
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [branchId]);
  expect(rows[0].status).toBe('coding_running');
});
