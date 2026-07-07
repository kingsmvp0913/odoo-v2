const path = require('path');
const { newDb } = require('pg-mem');

jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn().mockResolvedValue(undefined),
  checkoutDefault: jest.fn().mockResolvedValue(undefined),
  runDeploy: jest.fn().mockResolvedValue(undefined),
  ensureWorktreeAtMain: jest.fn().mockResolvedValue(undefined),
  getMainBranch: jest.fn().mockResolvedValue('main')
}));
jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));
jest.mock('../pipeline/cs-agent', () => ({ runCsAgent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/qa-agent', () => ({ runQaAgent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/deploy-testing', () => ({ runDeployTesting: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/playwright-agent', () => ({ runPlaywrightAgent: jest.fn().mockResolvedValue(undefined) }));

let dbModule, runnerModule, userId;

// runPipeline 只派工（fire-and-forget）；測試要等在飛任務跑完才能斷言 handler 效果
async function run() {
  const r = await runnerModule.runPipeline(userId);
  await runnerModule.whenIdle();
  return r;
}

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
  const git = require('../pipeline/git');
  const cs = require('../pipeline/cs-agent');
  require('../pipeline/analysis').analyzeTask.mockReset();
  git.createBranch.mockReset().mockResolvedValue(undefined);
  git.checkoutDefault.mockReset().mockResolvedValue(undefined);
  git.ensureWorktreeAtMain.mockReset().mockResolvedValue(undefined);
  git.getMainBranch.mockReset().mockResolvedValue('main');
  require('../notify').emitToUser.mockReset();
  cs.runCsAgent.mockReset().mockResolvedValue(undefined);
  require('../pipeline/qa-agent').runQaAgent.mockReset().mockResolvedValue(undefined);
  require('../pipeline/deploy-testing').runDeployTesting.mockReset().mockResolvedValue(undefined);
  require('../pipeline/playwright-agent').runPlaywrightAgent.mockReset().mockResolvedValue(undefined);
  await dbModule.query('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [userId]);
  await dbModule.query('DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [userId]);
  await dbModule.query('DELETE FROM tasks WHERE user_id = $1', [userId]);
});

async function insertTask(status, suffix = Date.now(), projectId = null) {
  const { rows } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id)
     VALUES ($1, $2, 'odoo', 'Test', 'content', $3, $4) RETURNING id`,
    [userId, `task_odoo_${suffix}`, status, projectId]
  );
  return rows[0].id;
}

// --- handler 分派 ---

test('analysis_running → analyzeTask', async () => {
  const { analyzeTask } = require('../pipeline/analysis');
  analyzeTask.mockResolvedValue({ next_status: 'branch_pending', analysis_yaml: 'yaml' });
  const taskId = await insertTask('analysis_running');
  const r = await run();
  expect(r.dispatched).toBe(1);
  expect(analyzeTask).toHaveBeenCalledWith(taskId, expect.anything());
});

test('branch_pending 非專案 → createBranch → coding_running', async () => {
  const { createBranch } = require('../pipeline/git');
  const taskId = await insertTask('branch_pending');
  await run();
  expect(createBranch).toHaveBeenCalledWith('/repo', expect.stringContaining('task/task_odoo'));
  const { rows } = await dbModule.query('SELECT status, git_branch FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('coding_running');
  expect(rows[0].git_branch).toContain('task/');
});

test('branch_pending 專案任務：每 repo 冪等確保 worktree（reset=false 沿用 analysis 已建）', async () => {
  const { ensureWorktreeAtMain } = require('../pipeline/git');
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('P1','17.0','p1') RETURNING id"
  );
  await dbModule.query(
    `INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status)
     VALUES ($1,'main','u','/repos/p1/main',true,'done'),($1,'hr','u','/repos/p1/hr',false,'done')`, [proj.id]
  );
  const t = await insertTask('branch_pending', 'wt1', proj.id);
  await run();

  expect(ensureWorktreeAtMain).toHaveBeenCalledTimes(2);
  for (const c of ensureWorktreeAtMain.mock.calls) {
    expect(c[2]).toBe('task/task_odoo_wt1'); // branch
    expect(c[3]).toBe('main');               // base
    expect(c[4]).toBe(false);                // 沿用、不 reset
    expect(c[1]).toContain(path.join('.worktrees', 'task_odoo_wt1'));
  }
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t]);
  expect(rows[0].status).toBe('coding_running');
});

test('branch_pending worktree 建立失敗 → 任務 stopped，原因寫進執行歷程', async () => {
  const { ensureWorktreeAtMain } = require('../pipeline/git');
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('P2','17.0','p2') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/p2/main',true,'done')", [proj.id]
  );
  const t = await insertTask('branch_pending', 'wt2', proj.id);
  ensureWorktreeAtMain.mockRejectedValueOnce(new Error('boom worktree'));
  await run();

  const { rows } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [t]);
  expect(rows[0].status).toBe('stopped');
  expect(rows[0].blocker_content).toContain('worktree');
  const { rows: ev } = await dbModule.query('SELECT content FROM task_events WHERE task_id=$1', [t]);
  expect(ev.some(r => r.content.includes('❌ 失敗') && r.content.includes('worktree'))).toBe(true);
});

test('new → cs-agent', async () => {
  const { runCsAgent } = require('../pipeline/cs-agent');
  const taskId = await insertTask('new');
  await run();
  expect(runCsAgent).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

test('confirm_answered → analysis_running（帶答案重跑）', async () => {
  const taskId = await insertTask('confirm_answered');
  await run();
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('analysis_running');
});

test('review_pending 非 runnable，不推進', async () => {
  const taskId = await insertTask('review_pending');
  await run();
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('review_pending');
});

test('qa_running → qa-agent', async () => {
  const { runQaAgent } = require('../pipeline/qa-agent');
  const taskId = await insertTask('qa_running');
  await run();
  expect(runQaAgent).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

test('deploy_testing → deploy-testing', async () => {
  const { runDeployTesting } = require('../pipeline/deploy-testing');
  const taskId = await insertTask('deploy_testing');
  await run();
  expect(runDeployTesting).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

test('playwright_running → playwright-agent', async () => {
  const { runPlaywrightAgent } = require('../pipeline/playwright-agent');
  const taskId = await insertTask('playwright_running');
  await run();
  expect(runPlaywrightAgent).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

test('進入一關寫階段標記 task_event（執行歷程可見「跑到哪」）', async () => {
  const taskId = await insertTask('qa_running');
  await run();
  const { rows } = await dbModule.query('SELECT content FROM task_events WHERE task_id = $1 ORDER BY id', [taskId]);
  expect(rows.some(r => r.content.includes('▶') && r.content.includes('QA 審查中'))).toBe(true);
});

// --- C-4 併發派工 ---

test('C-4 每人併發上限：8 個可跑任務、上限 5 → 只派 5，其餘留下輪', async () => {
  const { runCsAgent } = require('../pipeline/cs-agent');
  let openGate;
  const gate = new Promise(res => { openGate = res; }); // 所有 handler 共用，掛住佔 _inFlight
  runCsAgent.mockImplementation(() => gate);
  for (let i = 0; i < 8; i++) await insertTask('new', `cap${i}`);

  const r = await runnerModule.runPipeline(userId);
  expect(r.dispatched).toBe(5);                               // 上限 5
  expect(runnerModule.getInflightTaskIds().length).toBe(5);   // 佔位同步完成

  openGate();
  await runnerModule.whenIdle();
});

test('C-4 已在飛的任務不重複派；槽位釋出後下一輪續派', async () => {
  const { runCsAgent } = require('../pipeline/cs-agent');
  let openGate;
  const gate = new Promise(res => { openGate = res; });
  runCsAgent.mockImplementation(() => gate);
  const a = await insertTask('new', 'inflightA');

  const r1 = await runnerModule.runPipeline(userId); // 派 A，掛住
  expect(r1.dispatched).toBe(1);
  const r2 = await runnerModule.runPipeline(userId); // A 仍在飛 → 不重複派
  expect(r2.dispatched).toBe(0);
  expect(runnerModule.getInflightTaskIds()).toEqual([a]);

  openGate();
  await runnerModule.whenIdle();
  await dbModule.query("UPDATE tasks SET status='done' WHERE id=$1", [a]); // A 已推進、非 runnable
  // 槽位釋出；再放一個新任務可派
  runCsAgent.mockReset().mockResolvedValue(undefined);
  await insertTask('new', 'inflightB');
  const r3 = await run();
  expect(r3.dispatched).toBe(1); // 只派 B
});

test('C-4 暫停的任務不被掃到、不執行 handler', async () => {
  const { runCsAgent } = require('../pipeline/cs-agent');
  const t = await insertTask('new', 'paused');
  await dbModule.query('UPDATE tasks SET is_paused = true WHERE id = $1', [t]);
  const r = await run();
  expect(r.dispatched).toBe(0);
  expect(runCsAgent).not.toHaveBeenCalled();
});
