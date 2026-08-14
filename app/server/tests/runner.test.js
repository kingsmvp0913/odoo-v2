jest.mock('../pipeline/usage-gate', () => ({
  getGateState: jest.fn().mockResolvedValue({ enabled: true, blocked: false }),
  _resetForTesting: jest.fn()
}));
const path = require('path');
const { newDb } = require('pg-mem');

// 全機上限壓到 6，讓「跨 user 併發不超派」測試不必塞 30 個任務即可觸發（runner 於載入時讀此 env）
process.env.PIPELINE_MAX_GLOBAL = '6';

jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn().mockResolvedValue(undefined),
  checkoutDefault: jest.fn().mockResolvedValue(undefined),
  runDeploy: jest.fn().mockResolvedValue(undefined),
  ensureWorktreeAtMain: jest.fn().mockResolvedValue(undefined),
  syncBranchWithAi: jest.fn().mockResolvedValue({ synced: true, conflictFiles: [], error: null }),
  getMainBranch: jest.fn().mockResolvedValue('main'),
  AI_BRANCH: 'ai-dev'
}));
jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));
jest.mock('../pipeline/cs-agent', () => ({ runCsAgent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/qa-agent', () => ({ runQaAgent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/deploy-testing', () => ({ runDeployTesting: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/merge-agent', () => ({ runMergeAgent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/playwright-agent', () => ({ runTourStage: jest.fn().mockResolvedValue(undefined) }));
// runTask 狀態真的推進時會自動續跑（見 runner.js 的 auto-continue）；branch_pending→coding_running 屬實際變化，
// 會立刻串連派工到 coding_running，故需 mock task-agent 避免打到真的邏輯（非專案任務原本就會 return false）
jest.mock('../pipeline/task-agent', () => ({
  runTaskAnalysis: jest.fn().mockResolvedValue(true),
  runTaskCoding: jest.fn().mockResolvedValue(true),
  // 規格 tour 的統一入口（doBranch 在轉 coding_running 前呼叫）；預設不做事，專屬案例另外覆寫
  runSpecTourGate: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/reject-triage', () => ({ runRejectTriage: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/clarify-chat', () => ({ runClarifyChat: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/respec-agent', () => ({ runRespecPatch: jest.fn().mockResolvedValue(undefined) }));

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

afterAll(() => { dbModule._setPoolForTesting(null); delete process.env.PIPELINE_MAX_GLOBAL; });

beforeEach(async () => {
  const git = require('../pipeline/git');
  const cs = require('../pipeline/cs-agent');
  git.createBranch.mockReset().mockResolvedValue(undefined);
  git.checkoutDefault.mockReset().mockResolvedValue(undefined);
  git.ensureWorktreeAtMain.mockReset().mockResolvedValue(undefined);
  git.syncBranchWithAi.mockReset().mockResolvedValue({ synced: true, conflictFiles: [], error: null });
  git.getMainBranch.mockReset().mockResolvedValue('main');
  require('../notify').emitToUser.mockReset();
  cs.runCsAgent.mockReset().mockResolvedValue(undefined);
  require('../pipeline/qa-agent').runQaAgent.mockReset().mockResolvedValue(undefined);
  require('../pipeline/deploy-testing').runDeployTesting.mockReset().mockResolvedValue(undefined);
  require('../pipeline/merge-agent').runMergeAgent.mockReset().mockResolvedValue(undefined);
  require('../pipeline/playwright-agent').runTourStage.mockReset().mockResolvedValue(undefined);
  require('../pipeline/task-agent').runTaskAnalysis.mockReset().mockResolvedValue(true);
  require('../pipeline/task-agent').runTaskCoding.mockReset().mockResolvedValue(true);
  require('../pipeline/reject-triage').runRejectTriage.mockReset().mockResolvedValue(undefined);
  require('../pipeline/respec-agent').runRespecPatch.mockReset().mockResolvedValue(undefined);
  await dbModule.query('DELETE FROM task_messages WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [userId]);
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

test('analysis_running 綁專案 → runTaskAnalysis', async () => {
  const { runTaskAnalysis } = require('../pipeline/task-agent');
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('R 專案', '17.0') RETURNING id"
  );
  const taskId = await insertTask('analysis_running', Date.now(), p.id);
  const r = await run();
  expect(r.dispatched).toBe(1);
  expect(runTaskAnalysis).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

// 源頭已保證同步進來的任務都綁專案；萬一有未綁專案任務漏進分析關，runTaskAnalysis 回 false，
// 應直接 stopped（與 coding 關對稱），不再走已移除的 analysis-basic 一次性分析路徑。
test('analysis_running 未綁專案 → runTaskAnalysis 回 false → stopped', async () => {
  const { runTaskAnalysis } = require('../pipeline/task-agent');
  runTaskAnalysis.mockResolvedValue(false);
  const taskId = await insertTask('analysis_running');
  await run();
  const { rows } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');
  expect(rows[0].blocker_content).toContain('專案');
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
    expect(c[3]).toBe('ai-dev');             // base＝任務切點（Task 6：改從 ai-dev 切，非 main）
    expect(c[4]).toBe(false);                // 沿用、不 reset
    expect(c[1]).toContain(path.join('.worktrees', 'task_odoo_wt1'));
  }
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t]);
  expect(rows[0].status).toBe('coding_running');
});

// brief 原測試直接呼叫未匯出的 doBranch；runner.js 只匯出 runPipeline 等，改走既有測試沿用的
// insertTask+run() 管道觸發 branch_pending handler，驗證同一件事：worktree base 用 ai-dev（非 main）。
test('branch_pending 重入：worktree base 用 ai-dev', async () => {
  const { ensureWorktreeAtMain } = require('../pipeline/git');
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('P3','17.0','p3') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/p3/main',true,'done')", [proj.id]
  );
  await insertTask('branch_pending', 'wt3', proj.id);
  await run();

  expect(ensureWorktreeAtMain).toHaveBeenCalledWith(
    expect.any(String), expect.any(String), expect.stringContaining('task/task_odoo_wt3'), 'ai-dev', false,
    null // gitEnv：無 PAT 時為 null，merge 會退回 pipeline 身分（見 git.js identArgs）
  );
});

// 意圖：worktree 是 analysis 當下建的，任務在規格審核閘門可能停留數天，期間 ai-dev 已被別的任務
// 與實體 main 推進。進 coding 前不跟上，AI 就是在過期的碼上寫、下載 zip 也會蓋掉期間的人工修正。
// 兩個 repo：只驗一個的話，「只同步 primary」這種漏法測不出來。
test('branch_pending：每個 worktree 都跟上 ai-dev 後才進 coding', async () => {
  const { ensureWorktreeAtMain, syncBranchWithAi } = require('../pipeline/git');
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('P4','17.0','p4') RETURNING id"
  );
  await dbModule.query(
    `INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status)
     VALUES ($1,'main','u','/repos/p4/main',true,'done'),($1,'hr','u','/repos/p4/hr',false,'done')`, [proj.id]
  );
  const t = await insertTask('branch_pending', 'wt4', proj.id);
  await run();

  expect(syncBranchWithAi).toHaveBeenCalledTimes(2);
  const synced = syncBranchWithAi.mock.calls.map(c => c[0]);
  expect(synced).toEqual(ensureWorktreeAtMain.mock.calls.map(c => c[1])); // 同一批 worktree 路徑，順序一致
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t]);
  expect(rows[0].status).toBe('coding_running');
});

// 意圖：同步失敗不得擋住任務（穩定 > 準確），但也不得靜默——使用者事後看不出「這份產出是基於
// 過期的碼」就無從判斷能不能直接佈署。落地必須在 task_logs（時間軸真相來源），不是只發 socket。
test('branch_pending：ai-dev 同步衝突 → 任務照常進 coding，但落地成使用者看得到的提醒', async () => {
  const { syncBranchWithAi } = require('../pipeline/git');
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('P5','17.0','p5') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/p5/main',true,'done')", [proj.id]
  );
  const t = await insertTask('branch_pending', 'wt5', proj.id);
  syncBranchWithAi.mockResolvedValueOnce({ synced: false, conflictFiles: ['idx_hj/models/a.py'], error: 'conflict' });
  await run();

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t]);
  expect(rows[0].status).toBe('coding_running'); // 不擋
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1", [t]);
  expect(logs.some(r => r.content.includes('idx_hj/models/a.py'))).toBe(true);
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

// 意圖：handler 拋未預期例外時，不再靜默吞錯（舊行為只 console.error、狀態卡 running 被 cron 無限重試，
// 使用者端＝「莫名其妙中斷」）；改為轉 stopped 附原因並寫進執行歷程，讓中斷可見、可 resume。
test('coding handler 拋未預期例外 → 任務 stopped，錯誤寫進執行歷程', async () => {
  const { runTaskCoding } = require('../pipeline/task-agent');
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('PErr','17.0','perr') RETURNING id"
  );
  const t = await insertTask('coding_running', 'err1', proj.id);
  runTaskCoding.mockRejectedValueOnce(new Error('unexpected boom'));
  await run();

  const { rows } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [t]);
  expect(rows[0].status).toBe('stopped');
  expect(rows[0].blocker_content).toContain('unexpected boom');
  const { rows: ev } = await dbModule.query('SELECT content FROM task_events WHERE task_id=$1', [t]);
  expect(ev.some(r => r.content.includes('❌ 失敗') && r.content.includes('unexpected boom'))).toBe(true);
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

// --- 追加需求佇列檢查點（respec_running）---

async function addManualMsg(taskId, content = '請加個匯出 Excel 按鈕') {
  await dbModule.query(
    "INSERT INTO task_messages (task_id, source, author, content, occurred_at) VALUES ($1,'manual','me',$2, NOW())",
    [taskId, content]
  );
}

test('coding 跑完＋有待吸收留言 → 攔下轉 respec_running（不逕自進 QA）', async () => {
  const ta = require('../pipeline/task-agent');
  const respec = require('../pipeline/respec-agent');
  // mock coding 成功推進到 qa_running（真實 coding 會改狀態；mock 預設不改，故在此顯式模擬）
  ta.runTaskCoding.mockImplementation(async (id) => {
    await dbModule.query("UPDATE tasks SET status='qa_running' WHERE id=$1", [id]);
    return true;
  });
  const taskId = await insertTask('coding_running');
  await addManualMsg(taskId);
  await run();
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('respec_running');
  expect(respec.runRespecPatch).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

test('coding 跑完但無待吸收留言 → 照常進 QA，不觸發 respec', async () => {
  const ta = require('../pipeline/task-agent');
  const respec = require('../pipeline/respec-agent');
  ta.runTaskCoding.mockImplementation(async (id) => {
    await dbModule.query("UPDATE tasks SET status='qa_running' WHERE id=$1", [id]);
    return true;
  });
  const taskId = await insertTask('coding_running');
  await run();
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('qa_running');
  expect(respec.runRespecPatch).not.toHaveBeenCalled();
});

test('QA 通過（→merge）＋有待吸收留言 → 攔下轉 respec_running', async () => {
  const qa = require('../pipeline/qa-agent');
  const respec = require('../pipeline/respec-agent');
  qa.runQaAgent.mockImplementation(async (id) => {
    await dbModule.query("UPDATE tasks SET status='merge_running' WHERE id=$1", [id]);
  });
  const taskId = await insertTask('qa_running');
  await addManualMsg(taskId);
  await run();
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('respec_running');
  expect(respec.runRespecPatch).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

// 健檢項1：merge 之後的階段（deploy／E2E）期間留言，過去會一路綠燈到 done、永不被吸收。
// 現在 deploy 成功推進到 E2E 時也攔一次。
test('deploy 成功（→playwright）＋有待吸收留言 → 攔下轉 respec_running（項1）', async () => {
  const { runDeployTesting } = require('../pipeline/deploy-testing');
  const respec = require('../pipeline/respec-agent');
  runDeployTesting.mockImplementation(async (id) => {
    await dbModule.query("UPDATE tasks SET status='playwright_running' WHERE id=$1", [id]);
  });
  const taskId = await insertTask('deploy_testing');
  await addManualMsg(taskId);
  await run();
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('respec_running');
  expect(respec.runRespecPatch).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

// merge→deploy 是吸收表的第三個邊界（stage2 補測：另兩個已測，此邊界漏了會讓 merge 期間留言晚一關才被吸收）
test('merge 成功（→deploy_testing）＋有待吸收留言 → 攔下轉 respec_running（項1）', async () => {
  const { runMergeAgent } = require('../pipeline/merge-agent');
  const respec = require('../pipeline/respec-agent');
  runMergeAgent.mockImplementation(async (id) => {
    await dbModule.query("UPDATE tasks SET status='deploy_testing' WHERE id=$1", [id]);
  });
  const taskId = await insertTask('merge_running');
  await addManualMsg(taskId);
  await run();
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('respec_running');
  expect(respec.runRespecPatch).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

test('E2E 通過（→review_pending）＋有待吸收留言 → 攔下轉 respec_running（項1）', async () => {
  const { runTourStage } = require('../pipeline/playwright-agent');
  const respec = require('../pipeline/respec-agent');
  runTourStage.mockImplementation(async (id) => {
    await dbModule.query("UPDATE tasks SET status='review_pending' WHERE id=$1", [id]);
  });
  const taskId = await insertTask('playwright_running');
  await addManualMsg(taskId);
  await run();
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('respec_running');
  expect(respec.runRespecPatch).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

test('coding 失敗（→stopped）即使有留言也不觸發 respec（只攔成功推進）', async () => {
  const ta = require('../pipeline/task-agent');
  const respec = require('../pipeline/respec-agent');
  ta.runTaskCoding.mockImplementation(async (id) => {
    await dbModule.query("UPDATE tasks SET status='stopped' WHERE id=$1", [id]);
    return true;
  });
  const taskId = await insertTask('coding_running');
  await addManualMsg(taskId);
  await run();
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(rows[0].status).toBe('stopped');
  expect(respec.runRespecPatch).not.toHaveBeenCalled();
});

test('deploy_testing → deploy-testing', async () => {
  const { runDeployTesting } = require('../pipeline/deploy-testing');
  const taskId = await insertTask('deploy_testing');
  await run();
  expect(runDeployTesting).toHaveBeenCalledWith(taskId, userId, expect.anything());
});

test('playwright_running → playwright-agent', async () => {
  const { runTourStage } = require('../pipeline/playwright-agent');
  const taskId = await insertTask('playwright_running');
  await run();
  expect(runTourStage).toHaveBeenCalledWith(taskId, userId, expect.anything());
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

// --- P2：重 odoo-bin 階段（E2E/deploy）dispatch 層併發上限 ---

test('P2 E2E 全機併發上限（E2E_MAX_CONCURRENT 預設 2）：4 個 playwright 只派 2，其餘留下輪', async () => {
  const { runTourStage } = require('../pipeline/playwright-agent');
  let openGate;
  const gate = new Promise(res => { openGate = res; });
  runTourStage.mockImplementation(() => gate);
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await insertTask('playwright_running', `e2e${i}`));

  const r = await runnerModule.runPipeline(userId);
  expect(r.dispatched).toBe(2);                              // E2E 上限 2，其餘 2 個 skip（不佔槽）
  expect(runnerModule.getInflightTaskIds().length).toBe(2);

  openGate();
  await runnerModule.whenIdle();
  // 被 skip 的仍是 playwright_running（沒被吃掉/沒 stopped），下輪槽位釋出即可派
  for (const id of ids) await dbModule.query("UPDATE tasks SET status='done' WHERE id=$1", [id]);
});

test('P2 E2E 上限不餓死其他關：3 個 E2E＋1 個 new → E2E 派 2、cs 仍派 1', async () => {
  const { runTourStage } = require('../pipeline/playwright-agent');
  const { runCsAgent } = require('../pipeline/cs-agent');
  let openGate;
  const gate = new Promise(res => { openGate = res; });
  runTourStage.mockImplementation(() => gate);
  runCsAgent.mockImplementation(() => gate);
  for (let i = 0; i < 3; i++) await insertTask('playwright_running', `e2ex${i}`);
  const csId = await insertTask('new', 'cshead'); // 較新 → 排在 E2E 之後被掃到

  const r = await runnerModule.runPipeline(userId);
  expect(r.dispatched).toBe(3);                                  // E2E 2 + cs 1（cs 不被 E2E 上限擋）
  expect(runnerModule.getInflightTaskIds()).toContain(csId);     // 其他關沒被餓死

  openGate();
  await runnerModule.whenIdle();
});

// ===== (B) 尾巴獨佔：merge→deploy→E2E 共用 testing 分支＋test_cwt，同專案一次一個 =====
async function mkProj(name) {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ($1, '17.0') RETURNING id", [name]);
  return p.id;
}

test('(B) 同專案已有人在 deploy_testing（已進 env）→ merge_running 兄弟本輪不派、狀態不變', async () => {
  const { runDeployTesting } = require('../pipeline/deploy-testing');
  let openGate; const gate = new Promise(res => { openGate = res; });
  runDeployTesting.mockImplementation(() => gate);
  const proj = await mkProj('BTail1');
  const a = await insertTask('deploy_testing', 'tailA', proj); // 已進 env、佔用
  const b = await insertTask('merge_running', 'tailB', proj);  // 請求進場 → 應被擋

  const r = await runnerModule.runPipeline(userId);
  expect(r.dispatched).toBe(1);
  expect(runnerModule.getInflightTaskIds()).toContain(a);
  expect(runnerModule.getInflightTaskIds()).not.toContain(b);
  const { rows: [bt] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [b]);
  expect(bt.status).toBe('merge_running');                     // 沒被吃掉、留待下輪

  openGate();
  await runnerModule.whenIdle();
  for (const id of [a, b]) await dbModule.query("UPDATE tasks SET status='done' WHERE id=$1", [id]);
});

test('(B) 同專案兩個 merge_running → 只派 id 較小者（避免兩個同時進場）', async () => {
  const { runMergeAgent } = require('../pipeline/merge-agent');
  let openGate; const gate = new Promise(res => { openGate = res; });
  runMergeAgent.mockImplementation(() => gate);
  const proj = await mkProj('BTail2');
  const a = await insertTask('merge_running', 'twoA', proj);   // id 較小 → 先進
  const b = await insertTask('merge_running', 'twoB', proj);

  const r = await runnerModule.runPipeline(userId);
  expect(r.dispatched).toBe(1);
  expect(runnerModule.getInflightTaskIds()).toContain(a);
  expect(runnerModule.getInflightTaskIds()).not.toContain(b);

  openGate();
  await runnerModule.whenIdle();
  for (const id of [a, b]) await dbModule.query("UPDATE tasks SET status='done' WHERE id=$1", [id]);
});

test('(B) 尾巴閘不跨專案：不同專案各自的 merge_running 都能派', async () => {
  const { runMergeAgent } = require('../pipeline/merge-agent');
  let openGate; const gate = new Promise(res => { openGate = res; });
  runMergeAgent.mockImplementation(() => gate);
  const p1 = await mkProj('BTailX1'); const p2 = await mkProj('BTailX2');
  const a = await insertTask('merge_running', 'xpA', p1);
  const b = await insertTask('merge_running', 'xpB', p2);

  const r = await runnerModule.runPipeline(userId);
  expect(r.dispatched).toBe(2);                                // 跨專案互不阻擋

  openGate();
  await runnerModule.whenIdle();
  for (const id of [a, b]) await dbModule.query("UPDATE tasks SET status='done' WHERE id=$1", [id]);
});

test('C-4 暫停的任務不被掃到、不執行 handler', async () => {
  const { runCsAgent } = require('../pipeline/cs-agent');
  const t = await insertTask('new', 'paused');
  await dbModule.query('UPDATE tasks SET is_paused = true WHERE id = $1', [t]);
  const r = await run();
  expect(r.dispatched).toBe(0);
  expect(runCsAgent).not.toHaveBeenCalled();
});

// 設計測試計畫第 5 點：全機上限跨 user enforce。cron 對每個 user fire-and-forget 呼叫
// runPipeline，同一 tick 內各 user 的 slots 都在自己第一個 await 前算好；若全域上限只用
// 掃描開頭的 _inFlight.size 快照 enforce，兩個 user 會各派滿、總量超過 MAX_GLOBAL（TOCTOU）。
test('C-4 全機上限跨 user 併發掃描不超過 MAX_GLOBAL（TOCTOU 防護）', async () => {
  const { runCsAgent } = require('../pipeline/cs-agent');
  let openGate;
  const gate = new Promise(res => { openGate = res; });
  runCsAgent.mockImplementation(() => gate); // 掛住所有 handler，佔著 _inFlight

  // 第二個 user：避開 _pipelineRunning 的「同 user 掃描鎖」，才能真正併發掃描
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: u2 } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, odoo_settings) VALUES ('runner2', $1, 'R2', 'user', $2) RETURNING id",
    [hash, JSON.stringify({ git_repo_path: '/repo2' })]
  );
  const userId2 = u2[0].id;

  // 每 user 4 個可跑任務（各自 < 每人上限 5，限制點落在全機 MAX_GLOBAL=6）
  for (let i = 0; i < 4; i++) await insertTask('new', `g1_${i}`);
  for (let i = 0; i < 4; i++) {
    await dbModule.query(
      "INSERT INTO tasks (user_id, task_id, source, title, original_text, status) VALUES ($1,$2,'odoo','T','c','new')",
      [userId2, `task_odoo_g2_${i}`]
    );
  }

  try {
    // 同一 tick 併發掃描兩個 user
    const [r1, r2] = await Promise.all([
      runnerModule.runPipeline(userId),
      runnerModule.runPipeline(userId2),
    ]);
    expect(runnerModule.getInflightTaskIds().length).toBeLessThanOrEqual(6); // 全機硬上限
    expect(r1.dispatched + r2.dispatched).toBe(6);                           // 恰好填滿、不超派
  } finally {
    openGate();
    await runnerModule.whenIdle();
    await dbModule.query('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [userId2]);
    await dbModule.query('DELETE FROM tasks WHERE user_id = $1', [userId2]);
    await dbModule.query('DELETE FROM users WHERE id = $1', [userId2]);
  }
});

test('reject_triage 任務會被派工並呼叫 runRejectTriage', async () => {
  const { runRejectTriage } = require('../pipeline/reject-triage');
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('RTP','17.0') RETURNING id");
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'rtq_1','odoo','T','reject_triage',$2) RETURNING id",
    [userId, p.id]
  );
  await run();
  expect(runRejectTriage).toHaveBeenCalledWith(t.id, userId, expect.anything());
});

// runTask 在跑 handler 前會把 resume_status 寫成「目前這一關」。對這四個狀態必須例外，否則
// resume_status 裡的「真正的原關」被自己蓋掉——分診 resume 會回到分診自己（無限重進分診）、
// 澄清對話的回程會指向 clarify_chat_running（QA 裁決導回 coding 的路徑整條消失）。
// 這是防死循環的關鍵防線，四個狀態逐一釘住。
describe('resume_status 覆寫排除清單', () => {
  const cases = [
    ['reject_triage',        'review_pending'],
    ['resolve_triage',       'playwright_running'],
    ['clarify_chat_running', 'coding_running'],
  ];
  test.each(cases)('%s 派工時不得覆寫 resume_status', async (status, home) => {
    const { rows: [p] } = await dbModule.query(
      `INSERT INTO projects (name, odoo_version) VALUES ('RS_${status}','17.0') RETURNING id`);
    const { rows: [t] } = await dbModule.query(
      `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, resume_status)
       VALUES ($1,$2,'odoo','T',$3,$4,$5) RETURNING id`,
      [userId, `rs_${status}`, status, p.id, home]
    );
    await run();
    const { rows: [after] } = await dbModule.query('SELECT resume_status FROM tasks WHERE id=$1', [t.id]);
    expect(after.resume_status).toBe(home);
  });
});

// clarify_answered 的例外由「handleClarifyAnswered 讀 resume_status 決定去哪一關」間接鎖住：
// 被覆寫成 clarify_answered 的話，任務會被送回 clarify_answered 自己（死循環）而非 coding_running。
test('clarify_answered 派工時不得覆寫 resume_status（否則回到自己形成死循環）', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, resume_status)
     VALUES ($1,'rs_clarify_answered','odoo','T','clarify_answered','coding_running') RETURNING id`,
    [userId]
  );
  await run();
  const { rows: [after] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('coding_running');
});

// 分診的 clarify 出口：分診判「我得先問清楚才能決定 fix 還是 respec」時，enterClarifyGate 刻意把
// resume_status 寫成分診關自己（verdict-router.js 的註解逐字寫著這是設計本意），使用者答完要回分診
// 帶著答案續判。這兩個狀態不在 RETURNABLE_STATUSES（那是「pipeline 各關的回程」白名單），但它們在
// RUNNABLE_STATUSES 內、HANDLERS 查得到，回去跑得動。
// 少了這個豁免的後果不只是走錯站：resume 被改寫後，handleClarifyAnswered 的 TRIAGE_RESUME 守衛
// 永遠命中不了 → 路由問題的答覆（「這算 bug 還是規格？」）被寫進 analysis_yaml 的 spec_decisions，
// 而那份規格是 QA 每輪重驗的唯一依據＝永久污染規格本體。
test.each(['resolve_triage', 'reject_triage'])(
  'clarify 答完回分診續判（resume_status=%s）：不得被值域收斂改道到 coding',
  async (triage) => {
    const { rows: [t] } = await dbModule.query(
      `INSERT INTO tasks (user_id, task_id, source, title, status, resume_status, analysis_yaml)
       VALUES ($1,$2,'odoo','T','clarify_answered',$3,'module: sale') RETURNING id`,
      [userId, `rs_back_${triage}`, triage]
    );
    await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','算 bug，請直接修')", [t.id]);
    await run();
    const { rows: [after] } = await dbModule.query('SELECT status, analysis_yaml FROM tasks WHERE id=$1', [t.id]);
    expect(after.status).toBe(triage);                        // 回分診，不是 coding_running
    expect(after.analysis_yaml).toBe('module: sale');          // 路由答覆不得被寫進規格
  }
);

// respec 的 clarify 出口：同一個機制、不同理由。規格層重做認定要改規格、但「該怎麼改」取決於使用者時
// 走 clarify 閘門，答完要回 respec_running 帶著答覆重新 patch。兩個斷言各擋一個坑：
//   status        少了 MIDWAY_RESUME 豁免會被 safeReturnStatus 收斂成 coding_running ＝帶著沒答完的規格
//                 疑問直接開工；而 respec 那批待吸收留言此時還沒銷帳（刻意的），下一輪回來又問一次。
//   analysis_yaml 答案要交給 respec-patch 併進規格（只有它知道該改哪一段），在這裡先寫進 spec_decisions
//                 等於繞過那個 agent，且 respec 重跑時會再寫一次＝同一句話雙寫進規格本體。
// stations.test.js 釘住「respec_running 不在 RETURNABLE_STATUSES」——那支綠燈不保證這條路走得通，
// 沒有本測試的話，把豁免拿掉是零訊號的（該檔 42-50 行的註解正是在講這個歷史教訓）。
test('clarify 答完回規格層重做續判：不得被值域收斂改道到 coding，答覆也不得逕自寫進規格', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, resume_status, analysis_yaml)
     VALUES ($1,'rs_back_respec','odoo','T','clarify_answered','respec_running','module: sale') RETURNING id`,
    [userId]
  );
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','折扣算稅前')", [t.id]);
  await run();
  const { rows: [after] } = await dbModule.query('SELECT status, analysis_yaml FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('respec_running');       // 回規格層重做，不是 coding_running
  expect(after.analysis_yaml).toBe('module: sale');   // 答覆交給 respec-patch 處理，不在這裡落地
});

// 反向守衛：豁免只給這三個中繼關，其餘非法值仍要被收斂掉，不能因此開了大門。
test('clarify 回程是認不得的狀態 → 仍收斂到 coding_running（不製造殭屍）', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, resume_status)
     VALUES ($1,'rs_bogus','odoo','T','clarify_answered','qa_runing') RETURNING id`,
    [userId]
  );
  await run();
  const { rows: [after] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('coding_running');
});
