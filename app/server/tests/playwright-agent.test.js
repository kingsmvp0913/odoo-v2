// 意圖：E2E 改用 Odoo tour。tour-author agent 寫測試檔（副作用），Node 依 runTourTests exit code 判：
// exit0→review_pending；exit0 但 log 含「Chrome executable not found」＝tour 被 skip→env stopped；
// 失敗且分類 code→退 coding 計數（滿 PW_LIMIT→stopped）；分類 env→stopped/env。
const { newDb } = require('pg-mem');

process.env.APP_SECRET = 'test-app-secret';
// 核心 source 供給走 docker 解壓——單測不碰真 docker，回固定守則字串（真行為由 odoo-core-src.test.js 驗）
jest.mock('../lib/odoo-core-src', () => ({ coreSourceGuidance: () => '（測試：核心來源守則）', ensureOdooCoreSrc: () => '', majorOf: (v) => String(v || '').split('.')[0] }));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ runClaude: jest.fn(), stopReason: (m) => m }));
// var + mock 前綴：jest.mock 的 factory 被提升到宣告之前執行，const 會撞 TDZ、非 mock* 命名會被 jest 擋下
var mockRenderSpy = jest.fn(() => 'PROMPT');
jest.mock('../pipeline/agent-loader', () => ({ loadAgent: () => ({ model: 'sonnet', render: mockRenderSpy }) }));
// worktreeParent 可覆寫：規格 tour 那組案例要指到真的暫存目錄，才驗得到「有沒有實測 tour 檔存在」
var mockWorktreeParent = jest.fn(() => '/cwd');
jest.mock('../pipeline/task-agent', () => ({ getProjectInfo: jest.fn(), worktreeParent: (...a) => mockWorktreeParent(...a), buildRepoPaths: () => '- /cwd/idx_x' }));
jest.mock('../pipeline/ensure-env', () => ({ ensureEnvRunning: jest.fn() }));
jest.mock('../pipeline/env-agent', () => ({ runTourTests: jest.fn(), restartEnv: jest.fn() }));
jest.mock('../pipeline/failure-classifier', () => ({ classifyFailureWithAgent: jest.fn() }));
jest.mock('../pipeline/reentry', () => ({ bumpReentryOrStop: jest.fn().mockResolvedValue(false) }));
jest.mock('../pipeline/git', () => ({
  mergeInto: jest.fn().mockResolvedValue({ hasConflicts: false, conflictFiles: [] }),
  abortMerge: jest.fn().mockResolvedValue(undefined),
  getMainBranch: jest.fn().mockResolvedValue('main'),
  diffNameOnly: jest.fn().mockResolvedValue([]),
  AI_BRANCH: 'ai-dev'
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
  taskAgent.getProjectInfo.mockReset(); taskAgent.getProjectInfo.mockResolvedValue({ root: '/repos/pwp', repos: [{ local_path: '/repos/pwp/main', subdir: 'main' }] });
  const git = require('../pipeline/git');
  git.mergeInto.mockReset().mockResolvedValue({ hasConflicts: false, conflictFiles: [] });
  git.abortMerge.mockReset().mockResolvedValue(undefined);
  ensureEnvRunning.mockReset(); ensureEnvRunning.mockResolvedValue(true);
  envAgent.runTourTests.mockReset();
  envAgent.restartEnv.mockReset().mockResolvedValue({ ok: true });
  classifier.classifyFailureWithAgent.mockReset(); classifier.classifyFailureWithAgent.mockResolvedValue('code');
  require('../pipeline/reentry').bumpReentryOrStop.mockResolvedValue(false);
  mockRenderSpy.mockClear();
  mockWorktreeParent.mockReset().mockReturnValue('/cwd');
  await dbModule.query('UPDATE projects SET spec_tour_enabled=false WHERE id=$1', [projectId]);
  await dbModule.query('DELETE FROM odoo_envs WHERE project_id=$1', [projectId]);
  await dbModule.query("INSERT INTO odoo_envs (project_id, status, url, port) VALUES ($1,'running','http://127.0.0.3:8070',21000)", [projectId]);
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

// ---- 規格 tour 模式（spec_tour_enabled）----
// 意圖：這是本關唯一會改變「產不產 tour」判定的分支，原本零測試覆蓋。
// 真實 Odoo 17 輸出格式（2026-08-11 首航實測擷取）。原本的 fixture 是憑空編的
// `odoo.tests.runner: idx_x: 1 tests 0.50s ...`——正因為它跟真實輸出不同，
// 「0 個測試時 log 照樣含 odoo.tests」這個假綠燈才能一路存活到上線。
const PASS_LOG = "2026-08-11 02:15:05,382 38 INFO test_x odoo.tests.result: 0 failed, 0 error(s) of 4 tests when loading database 'test_x'";
// 0 個測試時 odoo 照樣印出這一行——這正是舊守衛放行、新守衛必須攔下的輸入
const ZERO_TEST_LOG = "2026-08-11 02:27:46,160 68 WARNING test_x odoo.tests.result: 0 failed, 0 error(s) of 0 tests when loading database 'test_x'";

// 造一個帶（或不帶）tour 檔的假 worktree，回傳它的父目錄
function makeWorktree(withTour) {
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-wt-'));
  const modDir = path.join(parent, 'main', 'idx_x');
  fs.mkdirSync(modDir, { recursive: true });
  if (withTour) {
    const tourDir = path.join(modDir, 'static', 'tests', 'tours');
    fs.mkdirSync(tourDir, { recursive: true });
    fs.writeFileSync(path.join(tourDir, 'idx_x_tour.js'), '// tour');
  }
  return parent;
}

// 在 worktree 裡放真的測試檔，驗「平台自己從 diff 推導 test class」這條路。
// 用真檔案而非 mock fs：要驗的正是「讀得到檔、解析得出 class 名」，mock 掉就等於沒測。
function writeTestFiles(parent, files) {
  const fs = require('fs'); const path = require('path');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(parent, 'main', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

// 意圖：`--test-tags /<module>` 會連模組內既有的壞測試一起跑（鴻久實測 48 支裡 25 支既有失敗），
// tour 全對也會被拖成 exit 非 0 → 退 coding → coding 禁改測試檔 → 三輪 stopped。
// class 清單必須由平台從 git diff 推導，不能讓 agent 自己標 tag（守門條件寫在 prompt 裡等於沒守門）。
test('只把「本次 diff 內的 HttpCase class」交給 runTourTests（不含既有測試、不含 TransactionCase）', async () => {
  const wt = makeWorktree(true);
  writeTestFiles(wt, {
    'idx_x/tests/test_new_tour.py':
      'from odoo.tests.common import HttpCase, tagged\n\n@tagged("post_install")\nclass TestNewTour(HttpCase):\n    pass\n',
    // 同一次 diff 常一併改到純 ORM 測試——那不是考題，不該進 --test-tags
    'idx_x/tests/test_calc.py':
      'from odoo.tests.common import TransactionCase\n\nclass TestCalc(TransactionCase):\n    pass\n',
    // 既有的壞測試：存在於 worktree 但不在本次 diff 內，必須被排除
    'idx_x/tests/test_legacy_broken.py':
      'from odoo.tests.common import HttpCase\n\nclass TestLegacyBroken(HttpCase):\n    pass\n',
  });
  mockWorktreeParent.mockReturnValue(wt);
  require('../pipeline/git').diffNameOnly.mockResolvedValue([
    'idx_x/tests/test_new_tour.py', 'idx_x/tests/test_calc.py', 'idx_x/models/thing.py',
  ]);
  await dbModule.query('UPDATE projects SET spec_tour_enabled=true WHERE id=$1', [projectId]);
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: PASS_LOG });

  const id = await makeTask();
  await runTourStage(id, userId);

  expect(envAgent.runTourTests.mock.calls[0][3]).toEqual(['TestNewTour']);
});

test('規格 tour 模式＋worktree 內確有 tour → 不重產，直接執行', async () => {
  await dbModule.query('UPDATE projects SET spec_tour_enabled=true WHERE id=$1', [projectId]);
  mockWorktreeParent.mockReturnValue(makeWorktree(true));
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: PASS_LOG });
  const id = await makeTask();
  await runTourStage(id, userId);
  // 重產等於讓 agent 照著已完成的實作重寫考題，先定稿的意義整個消失
  expect(runClaude).not.toHaveBeenCalled();
  expect((await statusOf(id)).status).toBe('review_pending');
});

test('tour 全過（exit0）→ review_pending', async () => {
  // 真實通過的 log 含 odoo.tests 命名空間（HttpCase/tour 執行必經該 logger），代表確實跑了測試
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: PASS_LOG });
  const id = await makeTask();
  await runTourStage(id, userId);
  expect((await statusOf(id)).status).toBe('review_pending');
});

// 意圖：子網域模式下 odoo_envs.url 開機時一律存 NULL——對外網址改成「真人借到檢視名額的當下」
// 才算得出來，而 pipeline 從不借名額。E2E 是 docker exec 進容器跑的、根本不經對外網址，若這關
// 仍拿 url 當前置條件，正式機每張啟用 E2E 的任務都會卡在「測試環境未提供 URL」，
// 而本機（port 模式 url 有值）永遠重現不了。前置條件必須是內部埠。
test('url 為 NULL 但持有內部埠（子網域模式）→ 照常執行，不因缺 url 停任務', async () => {
  await dbModule.query('UPDATE odoo_envs SET url=NULL, port=21005 WHERE project_id=$1', [projectId]);
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: PASS_LOG });
  const id = await makeTask();
  await runTourStage(id, userId);
  expect((await statusOf(id)).status).toBe('review_pending');
});

// 意圖：真正的前置條件是「借到內部埠」。沒埠代表環境沒真的起來，此時放行會讓 agent 拿到
// 一個組不出來的位址，且失敗原因會被歸到程式碼而不是環境。
test('無內部埠 → 停任務並歸 env（不是 code）', async () => {
  await dbModule.query('UPDATE odoo_envs SET url=NULL, port=NULL WHERE project_id=$1', [projectId]);
  const id = await makeTask();
  await runTourStage(id, userId);
  const s = await statusOf(id);
  expect(s.status).toBe('stopped');
  expect(s.blocker_type).toBe('env');
});

test('exit0 但 odoo 根本沒跑到測試階段（無結果行）→ 退 coding（防假綠燈）', async () => {
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: 'INFO test_x odoo.modules.loading: Modules loaded.' });
  const id = await makeTask();
  await runTourStage(id, userId);
  const s = await statusOf(id);
  expect(s.status).toBe('coding_running');
  expect(s.pw_retry_count).toBe(1);
});

// 這支是本次修復的核心迴歸防線。舊守衛判斷「log 含不含 odoo.tests」，而 Odoo 在 0 個測試時
// 照樣印 `odoo.tests.result: ... of 0 tests`（2026-08-11 對真環境餵不存在的 class 實測），
// 於是「一題都沒考」被判定通過、直達人工審核——正是這道守衛唯一要防的事。
// 舊 fixture 用的是憑空編的 log 格式，所以測試全綠卻擋不住真實輸入。
test('exit0 但實際跑了 0 支測試（log 仍含 odoo.tests）→ 退 coding，不得放行', async () => {
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: ZERO_TEST_LOG });
  const id = await makeTask();
  await runTourStage(id, userId);
  const s = await statusOf(id);
  expect(s.status).toBe('coding_running');
  expect(s.pw_retry_count).toBe(1);
  // 訊息要指得出「哪些 class 沒被載入」，否則收到退回的人只知道 0 支、不知道從哪查起。
  // 比對放在 JS 端而非 SQL：pg-mem 的 LIKE 跨不了換行（rules/testing 13），而 bounceToCoding
  // 的第一行是標題、訊息在第二行，用 '%...%' 會永遠 0 筆而看起來像功能沒做。
  const { rows } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [id]);
  expect(rows.some(r => r.content.includes('0 支測試'))).toBe(true);
});

// 使用者要求：綠燈只給很簡單的確認、紅燈才給錯誤訊息。
// 成功路徑原本完全不寫 task_logs，這一關跑過沒有在畫面上看不出來。
test('綠燈 → 時間軸只留一行帶題數的確認（題數即守衛結果，可被人眼複核）', async () => {
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: PASS_LOG });   // of 4 tests
  const id = await makeTask();
  await runTourStage(id, userId);
  const { rows } = await dbModule.query(
    "SELECT content FROM task_logs WHERE task_id=$1 ORDER BY id", [id]);
  expect(rows).toHaveLength(1);
  expect(rows[0].content).toBe('[E2E 通過] 4 支測試全數通過');
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

// P4：tour 進程猝死（非常規退出碼＋無 Odoo 錯誤）→ 直接 env，不叫 classifier 瞎猜成 code 退 coding。
test('P4 tour 進程猝死（非常規退出碼＋無錯誤）→ stopped/env，不呼叫 classifier、不退 coding', async () => {
  envAgent.runTourTests.mockRejectedValue(Object.assign(
    new Error('loading module web (10/65)\nloading module hr (30/65)'),
    { exitCode: 4294967295, killed: false }
  ));
  classifier.classifyFailureWithAgent.mockResolvedValue('code'); // 若被叫到會誤判 code
  const id = await makeTask(0);
  await runTourStage(id, userId);
  const s = await statusOf(id);
  expect(s.status).toBe('stopped');
  expect(s.blocker_type).toBe('env');
  expect(s.pw_retry_count).toBe(0);                          // infra 猝死不佔計數
  expect(classifier.classifyFailureWithAgent).not.toHaveBeenCalled(); // 猝死走確定性判定，不問 haiku
});

// P3：容器必須在測試期間保持存活。這支原本斷言的是「先 stopEnv 再跑測試」——而 stopEnv 在 docker
// 模式下是 stopContainer + removeContainer，runTourTests 卻要 docker exec 進同一個容器，
// 兩者不可能同時成立。舊測試之所以全綠，是因為 runTourTests 被 mock 掉了，永遠不會抱怨容器不見。
// 2026-08-11 首航實測（真容器）才炸出來：log 只有 19 bytes 的「測試容器未運行」。
// 原本的 intent（環境要被正確收尾、不能留在壞狀態）保留，改以 restartEnv 表達。
test('P3 測試期間不得移除容器；跑完以 restartEnv 重載 registry', async () => {
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: PASS_LOG });
  const id = await makeTask();
  await runTourStage(id, userId);
  // 容器不得在測試前被收掉（stopEnv 已不再被引用；若有人改回去，這條會抓到）
  expect(envAgent.stopEnv).toBeUndefined();
  // 重載在 runTourTests 之後：-u <module> 已改過 schema，常駐 server 的 registry 是升級前的
  expect(envAgent.restartEnv).toHaveBeenCalledWith(projectId);
  expect(envAgent.restartEnv.mock.invocationCallOrder[0])
    .toBeGreaterThan(envAgent.runTourTests.mock.invocationCallOrder[0]);
  const s = await statusOf(id);
  expect(s.status).toBe('review_pending');
});

// P3：即使 tour 失敗，也要重起常駐 server（try/finally），別把環境留在 idle。
test('P3 tour 失敗也要重載 registry（finally）', async () => {
  envAgent.runTourTests.mockRejectedValue(Object.assign(new Error('AssertionError'), { exitCode: 1 }));
  classifier.classifyFailureWithAgent.mockResolvedValue('code');
  const id = await makeTask(0);
  await runTourStage(id, userId);
  // 失敗路徑同樣走過 -u <module>，DB 已經被動過；不重載就把走鏽的 registry 留給下一關與使用者
  expect(envAgent.restartEnv.mock.invocationCallOrder.at(-1))
    .toBeGreaterThan(envAgent.runTourTests.mock.invocationCallOrder[0]);
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
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: PASS_LOG });
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
