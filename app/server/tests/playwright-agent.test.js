// 意圖：E2E 改用 Odoo tour。tour-author agent 寫測試檔（副作用），Node 依 runTourTests exit code 判：
// exit0→review_pending；exit0 但 log 含「Chrome executable not found」＝tour 被 skip→env stopped；
// 失敗且分類 code→退 coding 計數（滿 PW_LIMIT→stopped）；分類 env→stopped/env。
const { newDb } = require('pg-mem');

process.env.APP_SECRET = 'test-app-secret';
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ runClaude: jest.fn(), stopReason: (m) => m }));
jest.mock('../pipeline/agent-loader', () => ({ loadAgent: () => ({ model: 'sonnet', render: () => 'PROMPT' }) }));
jest.mock('../pipeline/task-agent', () => ({ getProjectInfo: jest.fn(), worktreeParent: () => '/cwd' }));
jest.mock('../pipeline/ensure-env', () => ({ ensureEnvRunning: jest.fn() }));
jest.mock('../pipeline/env-agent', () => ({ runTourTests: jest.fn() }));
jest.mock('../pipeline/failure-classifier', () => ({ classifyFailureWithAgent: jest.fn() }));
jest.mock('../pipeline/reentry', () => ({ bumpReentryOrStop: jest.fn().mockResolvedValue(false) }));
jest.mock('../pipeline/git', () => ({
  mergeInto: jest.fn().mockResolvedValue({ hasConflicts: false, conflictFiles: [] }),
  abortMerge: jest.fn().mockResolvedValue(undefined)
}));

let dbModule, runTourStage, taskAgent, runClaude, ensureEnvRunning, envAgent, classifier, projectId, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('pw', $1, 'P') RETURNING id", [hash]);
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('PWP', '17.0') RETURNING id");
  projectId = p.id;

  taskAgent = require('../pipeline/task-agent');
  ({ runClaude } = require('../pipeline/claude-runner'));
  ({ ensureEnvRunning } = require('../pipeline/ensure-env'));
  envAgent = require('../pipeline/env-agent');
  classifier = require('../pipeline/failure-classifier');
  ({ runTourStage } = require('../pipeline/playwright-agent'));
});
afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  runClaude.mockReset(); runClaude.mockResolvedValue({ text: '', usage: {}, durationMs: 1 });
  taskAgent.getProjectInfo.mockReset(); taskAgent.getProjectInfo.mockResolvedValue({ root: '/repos/pwp' });
  const git = require('../pipeline/git');
  git.mergeInto.mockReset().mockResolvedValue({ hasConflicts: false, conflictFiles: [] });
  git.abortMerge.mockReset().mockResolvedValue(undefined);
  ensureEnvRunning.mockReset(); ensureEnvRunning.mockResolvedValue(true);
  envAgent.runTourTests.mockReset();
  classifier.classifyFailureWithAgent.mockReset(); classifier.classifyFailureWithAgent.mockResolvedValue('code');
  require('../pipeline/reentry').bumpReentryOrStop.mockResolvedValue(false);
  await dbModule.query('DELETE FROM odoo_envs WHERE project_id=$1', [projectId]);
  await dbModule.query("INSERT INTO odoo_envs (project_id, status, url) VALUES ($1,'running','http://127.0.0.3:8070')", [projectId]);
});

let seq = 0;
async function makeTask(pwCount = 0) {
  seq++;
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status, project_id, analysis_yaml, git_branch, pw_retry_count) VALUES ($1,$2,'manual','playwright_running',$3,'module: idx_x',$4,$5) RETURNING id",
    [userId, `tt_${seq}`, projectId, `task/tt_${seq}`, pwCount]);
  return t.id;
}
const statusOf = async (id) => (await dbModule.query('SELECT status, blocker_type, pw_retry_count FROM tasks WHERE id=$1', [id])).rows[0];

test('tour 全過（exit0）→ review_pending', async () => {
  // 真實通過的 log 含 odoo.tests 命名空間（HttpCase/tour 執行必經該 logger），代表確實跑了測試
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: 'INFO test_x odoo.tests.runner: idx_x: 1 tests 0.50s 0 failed, 0 error(s)' });
  const id = await makeTask();
  await runTourStage(id, userId);
  expect((await statusOf(id)).status).toBe('review_pending');
});

test('exit0 但 log 無測試執行痕跡（--test-tags 匹配 0 個）→ 退 coding（防假綠燈，健檢項2）', async () => {
  // agent 沒寫出測試檔或 test tag 拼錯 → odoo-bin 仍 exit0，但 log 無 odoo.tests＝這關等於沒測
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: 'INFO test_x odoo.modules.loading: Modules loaded.' });
  const id = await makeTask();
  await runTourStage(id, userId);
  const s = await statusOf(id);
  expect(s.status).toBe('coding_running');
  expect(s.pw_retry_count).toBe(1);
});

test('exit0 但 log 含 Chrome executable not found → env stopped（防假綠燈）', async () => {
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: 'unittest.SkipTest: Chrome executable not found' });
  const id = await makeTask();
  await runTourStage(id, userId);
  const s = await statusOf(id);
  expect(s.status).toBe('stopped');
  expect(s.blocker_type).toBe('env');
});

test('tour 失敗且分類 code → 退 coding 並加計數', async () => {
  envAgent.runTourTests.mockRejectedValue(Object.assign(new Error('AssertionError: 備註T 欄位不存在'), { exitCode: 1 }));
  classifier.classifyFailureWithAgent.mockResolvedValue('code');
  const id = await makeTask(0);
  await runTourStage(id, userId);
  const s = await statusOf(id);
  expect(s.status).toBe('coding_running');
  expect(s.pw_retry_count).toBe(1);
});

test('tour 失敗且分類 env → stopped/env（不退 coding）', async () => {
  envAgent.runTourTests.mockRejectedValue(Object.assign(new Error('could not connect to database'), { exitCode: 1 }));
  classifier.classifyFailureWithAgent.mockResolvedValue('env');
  const id = await makeTask(0);
  await runTourStage(id, userId);
  const s = await statusOf(id);
  expect(s.status).toBe('stopped');
  expect(s.blocker_type).toBe('env');
});

test('code 失敗達 PW_LIMIT → stopped', async () => {
  envAgent.runTourTests.mockRejectedValue(Object.assign(new Error('AssertionError'), { exitCode: 1 }));
  classifier.classifyFailureWithAgent.mockResolvedValue('code');
  const id = await makeTask(2); // 第 3 次
  await runTourStage(id, userId);
  expect((await statusOf(id)).status).toBe('stopped');
});

// --- 假綠燈根治：tour commit 在任務分支（worktree），不併入 testing 的話
//     addons-path（主 clone）收不到新 tour，--test-tags 匹配不到測試就 exit 0 ---

async function makeBranchTask() {
  seq++;
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status, project_id, analysis_yaml, git_branch) VALUES ($1,$2,'manual','playwright_running',$3,'module: idx_x',$4) RETURNING id",
    [userId, `tb_${seq}`, projectId, `task/tb_${seq}`]);
  return t.id;
}

test('tour 檔先併入 testing（逐 repo）、之後才跑 runTourTests', async () => {
  const git = require('../pipeline/git');
  taskAgent.getProjectInfo.mockResolvedValue({
    root: '/repos/pwp',
    repos: [{ label: 'main', local_path: '/repos/pwp/main', subdir: 'main' }]
  });
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: 'odoo.tests.runner: 1 tests 0 failed, 0 error(s)' });
  const id = await makeBranchTask();
  await runTourStage(id, userId);

  const { rows: [t] } = await dbModule.query('SELECT status, git_branch FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('review_pending');
  expect(git.mergeInto).toHaveBeenCalledWith('/repos/pwp/main', 'testing', t.git_branch);
  expect(git.mergeInto.mock.invocationCallOrder[0]).toBeLessThan(envAgent.runTourTests.mock.invocationCallOrder[0]);
});

test('tour 檔併入 testing 衝突 → abortMerge 清半套、stopped(tech)、不跑測試', async () => {
  const git = require('../pipeline/git');
  taskAgent.getProjectInfo.mockResolvedValue({
    root: '/repos/pwp',
    repos: [{ label: 'main', local_path: '/repos/pwp/main', subdir: 'main' }]
  });
  git.mergeInto.mockResolvedValue({ hasConflicts: true, conflictFiles: ['idx_x/tests/test_tour.py'] });
  const id = await makeBranchTask();
  await runTourStage(id, userId);

  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('tech');
  expect(t.blocker_content).toContain('test_tour.py');
  expect(git.abortMerge).toHaveBeenCalledWith('/repos/pwp/main');
  expect(envAgent.runTourTests).not.toHaveBeenCalled();
});

// --- 健檢：tour 失敗完整輸出不得永久遺失（比照 deploy-testing 的 saveDeployLog）---

test('tour 失敗且分類 code → 完整 log 落地成檔，retry_feedback 附檔案路徑供事後鑑識', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  process.env.E2E_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2elog-'));
  try {
    const err = new Error('AssertionError: 備註T 欄位不存在');
    err.exitCode = 1; err.stdout = 'tour 執行 stdout 斷言細節'; err.stderr = 'AssertionError: 備註T 欄位不存在';
    envAgent.runTourTests.mockRejectedValue(err);
    classifier.classifyFailureWithAgent.mockResolvedValue('code');
    const id = await makeTask(0);
    await runTourStage(id, userId);

    const { rows: [t] } = await dbModule.query('SELECT status, blocker_content, retry_feedback FROM tasks WHERE id=$1', [id]);
    expect(t.status).toBe('coding_running');
    const feedback = t.blocker_content || t.retry_feedback;
    expect(feedback).toContain('完整 log：');
    const logPath = feedback.match(/完整 log：(.+)$/m)[1].trim();

    const files = fs.readdirSync(process.env.E2E_LOG_DIR);
    expect(files.some(f => /^e2e-task.*\.log$/.test(f))).toBe(true);

    const saved = fs.readFileSync(logPath, 'utf8');
    expect(saved).toContain('exitCode: 1');
    expect(saved).toContain('tour 執行 stdout 斷言細節'); // stdout 斷言細節不得丟棄
  } finally {
    delete process.env.E2E_LOG_DIR;
  }
});

// 防呆：無已 clone repo 時不得 fallback 到 process.cwd()——
// tour-author 帶 --dangerously-skip-permissions，會把測試檔寫進平台自身 repo
test('專案無已 clone repo（info=null）→ stopped，不以 process.cwd() 執行 agent', async () => {
  taskAgent.getProjectInfo.mockResolvedValue(null);
  const id = await makeTask();
  await runTourStage(id, userId);
  const s = await statusOf(id);
  expect(s.status).toBe('stopped');
  expect(runClaude).not.toHaveBeenCalled();
});

// 防結構性假綠燈：無任務分支＝tour 無法併入 testing，--test-tags 匹配不到任何測試 exit 0＝假通過
test('任務缺 git_branch → stopped，不執行 tour（避免 0 測試假綠燈直達審核）', async () => {
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status, project_id, analysis_yaml) VALUES ($1,'tt_nobranch','manual','playwright_running',$2,'module: idx_x') RETURNING id",
    [userId, projectId]);
  await runTourStage(t.id, userId);
  const s = await statusOf(t.id);
  expect(s.status).toBe('stopped');
  expect(envAgent.runTourTests).not.toHaveBeenCalled();
});
