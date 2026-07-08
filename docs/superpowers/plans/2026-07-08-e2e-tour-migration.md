# E2E 改用 Odoo 原生 tour 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 E2E 階段從「LLM 手刻 Playwright 腳本」改為「獨立 E2E 階段產 Odoo 原生 tour + HttpCase 並用 `odoo-bin --test-enable` 判 exit code」。

**Architecture:** E2E 階段（沿用 `playwright_running` 狀態）先讓 tour-author agent 把 tour+HttpCase 寫進模組並 commit，再由 Node 呼叫 `runTourTests()`（＝deploy 的 `odoo-bin -i/-u` 指令加 `--test-enable --test-tags`）判定；verdict 對映複用 deploy 的 `extractOdooError` / `classifyFailureWithAgent`。chrome 於「環境建置」時檢查、缺則 env error，並在 verdict 層防 tour 靜默 skip 假綠燈。

**Tech Stack:** Node（`app/server`）、pg-mem + Jest 測試、Odoo `odoo-bin` / HttpCase tours、Python。

## Global Constraints

- 禁止寫死絕對路徑；一律相對路徑或環境變數（`ENV_BASE`/`ODOO_ENV_BASE` 既有慣例）。
- 只動必要檔案，比照既有風格，零順手重構。
- Commit 訊息 `[E2E]: Why`（非 what）。
- 測試測意圖（Rule 9）：鎖住「用 Odoo 官方 test runner、對正確 DB、跑對模組」與「exit code→階段流轉」。
- E2E token `agent_type` 維持 `'playwright'`（報表連續性）。
- E2E 失敗語意沿用現況：pass→`review_pending`；code→退 `coding_running` 並加 `pw_retry_count`（滿 `PW_LIMIT=3`→`stopped`）；env→`stopped`(`blocker_type='env'`)。

---

## 檔案結構

- `app/server/pipeline/env-agent.js` — 新增 `findChrome()`、`runTourTests()`；`runEnvSetup` build 路徑加 chrome 前置檢查；擴充 `module.exports`。
- `app/server/pipeline/playwright-agent.js` — 全檔改寫為 tour 階段（匯出 `runTourStage`）。
- `app/server/pipeline/runner.js` — `handlePlaywright` 改呼叫 `runTourStage`。
- `.claude/agents/playwright.md` — 改寫為 tour-author 規則。
- `app/server/tests/env-agent-chrome.test.js` — 新增，測 `findChrome`。
- `app/server/tests/env-agent-tour.test.js` — 新增，測 `runTourTests` 送出的 odoo-bin 旗標。
- `app/server/tests/playwright-agent.test.js` — 改寫為 tour 階段的 verdict 對映測試。

---

## Task 1: `findChrome()` ＋ 環境建置 chrome 前置檢查

**Files:**
- Modify: `app/server/pipeline/env-agent.js`（新增 `findChrome`；`runEnvSetup` build 分支加檢查；`module.exports` 加 `findChrome`）
- Test: `app/server/tests/env-agent-chrome.test.js`（新增）

**Interfaces:**
- Produces: `findChrome(): string|null` — 回傳可用的 chrome 執行檔路徑，找不到回 `null`。

- [ ] **Step 1: 寫失敗測試**

新增 `app/server/tests/env-agent-chrome.test.js`：

```js
// 意圖：tour(browser_js) 需 chrome；建環境時要能偵測，缺則擋下（否則 Odoo SkipTest → exit 0 假綠燈）。
const fs = require('fs');
const path = require('path');
const { findChrome } = require('../pipeline/env-agent');

const isWin = process.platform === 'win32';
const winIt = isWin ? test : test.skip; // 目標平台為 Windows；chrome 路徑邏輯僅在 win32 分支

winIt('findChrome：命中 %ProgramFiles% 路徑', () => {
  process.env.ProgramFiles = 'C:\\Program Files';
  const expected = path.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  const spy = jest.spyOn(fs, 'existsSync').mockImplementation(p => p === expected);
  expect(findChrome()).toBe(expected);
  spy.mockRestore();
});

winIt('findChrome：三路徑皆不存在時回 null', () => {
  const spy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
  expect(findChrome()).toBeNull();
  spy.mockRestore();
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx jest tests/env-agent-chrome.test.js`
Expected: FAIL —「findChrome is not a function」。

- [ ] **Step 3: 實作 `findChrome`**

於 `app/server/pipeline/env-agent.js` `odooDbArgs()` 之後加入：

```js
// tour 的 browser_js 需 chrome 執行檔；Odoo 各平台認固定路徑（odoo/tests/common.py ChromeBrowser.executable）。
// 找不到時 Odoo raise unittest.SkipTest → 測試靜默跳過但 exit 0 ＝假綠燈，故建環境時先擋。
function findChrome() {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env.LocalAppData || process.env.LOCALAPPDATA || '';
    const bins = [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      lad ? path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    ].filter(Boolean);
    return bins.find(b => fs.existsSync(b)) || null;
  }
  for (const b of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(b)) return b;
  }
  return null;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx jest tests/env-agent-chrome.test.js`
Expected: PASS（2 passed）。

- [ ] **Step 5: 把檢查接進 `runEnvSetup` 的 build 分支**

在 `runEnvSetup` 內、`INSERT ... status='setting_up'` 之後、`const steps = [...]` **之前**，加入（只在完整建置時擋，routine 快啟不受影響——見設計 §5-D）：

```js
  // 建置測試環境即驗證 chrome 存在：tour 需要它，缺則整個環境不算就緒（避免日後 E2E 假綠燈）。
  if (!fs.existsSync(readyMarker) && !findChrome()) {
    await query(
      "UPDATE odoo_envs SET status='error', error_msg=$2, updated_at=NOW() WHERE project_id=$1",
      [projectId, '找不到 Google Chrome（tour E2E 需要）。請安裝 Chrome 後重建環境。預期路徑：%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe']
    );
    return;
  }
```

於 `module.exports` 加入 `findChrome`：

```js
module.exports = { runEnvSetup, upgradeModules, runTourTests, findChrome, stopEnv, syncUsers, nightlyShutdown, seedOdooUsers, envIsActive, cleanupProjectEnv, waitForPort, ENV_BASE };
```

（`runTourTests` 於 Task 2 加入；本步一併列入 exports 以免遺漏，Task 2 完成後即生效。若 Task 2 尚未做，先移除該名再於 Task 2 補回亦可。）

- [ ] **Step 6: 跑全套確認無回歸並 commit**

Run: `cd app && npx jest tests/env-agent-chrome.test.js tests/ensure-env.test.js`
Expected: PASS。

```bash
git add app/server/pipeline/env-agent.js app/server/tests/env-agent-chrome.test.js
git commit -m "[E2E]: 環境建置檢查 chrome，缺則 env error（防 tour 靜默 skip 假綠燈）"
```

---

## Task 2: `runTourTests()`（odoo-bin 加 --test-enable --test-tags）

**Files:**
- Modify: `app/server/pipeline/env-agent.js`（新增 `runTourTests`）
- Test: `app/server/tests/env-agent-tour.test.js`（新增）

**Interfaces:**
- Consumes: 既有 `execCmd`、`odooDbArgs`、`projectAddonsPaths`、`ENV_BASE`、`test_<dirName>` DB 慣例。
- Produces: `runTourTests(projectId: number, moduleName: string): Promise<{ ok: true, log: string }>` — exit 非 0 時（含 tour/斷言失敗、模組載入錯）由 `execCmd` throw（error 帶 `exitCode`/`stdout`/`stderr`）。

- [ ] **Step 1: 寫失敗測試**

新增 `app/server/tests/env-agent-tour.test.js`：

```js
// 意圖：tour 測試＝deploy 的 odoo-bin 指令＋--test-enable --test-tags /<module>，對 test_<dir> DB 跑。
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'envtour-'));
process.env.ODOO_ENV_BASE = TMP; // 必須在 require env-agent 前設定（ENV_BASE 於載入時定值）

let execFileMock;
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, execFile: jest.fn() };
});

const { newDb } = require('pg-mem');
let dbModule, envAgent, projectId;
const DIR = 'TOURP';

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  await dbModule.query("INSERT INTO users (username, password_hash, display_name) VALUES ('t', $1, 'T')", [hash]);
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('TourP', '17.0', $1) RETURNING id", [DIR]
  );
  projectId = p.id;
  // 讓 fs.existsSync(venvPython) 為真（否則 runTourTests 會先 throw「環境尚未建立」）
  const isWin = process.platform === 'win32';
  const venvDir = path.join(TMP, DIR, 'venv', isWin ? 'Scripts' : 'bin');
  fs.mkdirSync(venvDir, { recursive: true });
  fs.writeFileSync(path.join(venvDir, isWin ? 'python.exe' : 'python'), '');
  fs.mkdirSync(path.join(TMP, DIR, 'src'), { recursive: true });
  fs.writeFileSync(path.join(TMP, DIR, 'src', 'odoo-bin'), '');

  ({ execFile: execFileMock } = require('child_process'));
  envAgent = require('../pipeline/env-agent');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('runTourTests：odoo-bin 帶 --test-enable 與 --test-tags /<module>，對 test_<dir> 跑', async () => {
  execFileMock.mockImplementation((bin, args, opts, cb) => cb(null, 'idx_x tests: 1 passed, 0 failed', ''));
  const { ok, log } = await envAgent.runTourTests(projectId, 'idx_x');
  expect(ok).toBe(true);
  expect(log).toContain('1 passed');
  const [, args] = execFileMock.mock.calls[0];
  expect(args).toContain('--test-enable');
  const i = args.indexOf('--test-tags');
  expect(args[i + 1]).toBe('/idx_x');
  expect(args).toEqual(expect.arrayContaining(['-i', 'idx_x', '-u', 'idx_x', '-d', `test_${DIR}`, '--stop-after-init']));
});

test('runTourTests：未給 module 直接 throw', async () => {
  await expect(envAgent.runTourTests(projectId, '')).rejects.toThrow(/module/);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx jest tests/env-agent-tour.test.js`
Expected: FAIL —「runTourTests is not a function」。

- [ ] **Step 3: 實作 `runTourTests`**

於 `env-agent.js` `upgradeModules` 之後加入：

```js
// E2E via tour：與升級同一條 odoo-bin 指令，加 --test-enable 觸發 tour、--test-tags 只跑本模組測試。
// exit 非 0（tour/斷言失敗或載入錯）由 execCmd throw，供上層依 deploy 同套邏輯分類。
async function runTourTests(projectId, moduleName) {
  if (!moduleName) throw new Error('未指定 module，無法執行 tour 測試');
  const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id = $1', [projectId]);
  if (!project) throw new Error('project not found');
  const dirName = project.folder_name || project.name;
  const envDir = path.join(ENV_BASE, dirName);
  const srcDir = path.join(envDir, 'src');
  const odooBin = path.join(srcDir, 'odoo-bin');
  const dbName = `test_${dirName}`;
  const extraAddons = await projectAddonsPaths(projectId);
  const addonsPath = [path.join(srcDir, 'addons'), ...extraAddons].join(',');
  const isWin = process.platform === 'win32';
  const venvPython = path.join(envDir, 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  if (!fs.existsSync(venvPython)) throw new Error('環境尚未建立，請先建立測試環境');
  const out = await execCmd(venvPython, [
    odooBin, '-i', moduleName, '-u', moduleName, '-d', dbName, '--stop-after-init',
    '--test-enable', '--test-tags', `/${moduleName}`,
    '--addons-path', addonsPath, ...odooDbArgs()
  ]);
  return { ok: true, log: out };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx jest tests/env-agent-tour.test.js`
Expected: PASS（2 passed）。

- [ ] **Step 5: commit**

```bash
git add app/server/pipeline/env-agent.js app/server/tests/env-agent-tour.test.js
git commit -m "[E2E]: 新增 runTourTests，odoo-bin --test-enable --test-tags 跑模組 tour"
```

---

## Task 3: 改寫 E2E 階段為 tour（`runTourStage`）

**Files:**
- Modify: `app/server/pipeline/playwright-agent.js`（全檔改寫，匯出 `runTourStage`）
- Modify: `app/server/pipeline/runner.js:169-172`（`handlePlaywright` 改呼叫 `runTourStage`）
- Test: `app/server/tests/playwright-agent.test.js`（改寫）

**Interfaces:**
- Consumes: `runTourTests`（Task 2）、`ensureEnvRunning`（`ensure-env`）、`classifyFailureWithAgent`（`failure-classifier`）、`extractOdooError`（`deploy-testing`）、`loadAgent`/`runClaude`/`stopReason`、`getProjectInfo`/`worktreeParent`。
- Produces: `runTourStage(taskId, userId, signal): Promise<boolean>`。

- [ ] **Step 1: 改寫測試（先寫，會失敗）**

覆蓋 `app/server/tests/playwright-agent.test.js`：

```js
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
    "INSERT INTO tasks (user_id, task_id, source, status, project_id, analysis_yaml, pw_retry_count) VALUES ($1,$2,'manual','playwright_running',$3,'module: idx_x',$4) RETURNING id",
    [userId, `tt_${seq}`, projectId, pwCount]);
  return t.id;
}
const statusOf = async (id) => (await dbModule.query('SELECT status, blocker_type, pw_retry_count FROM tasks WHERE id=$1', [id])).rows[0];

test('tour 全過（exit0）→ review_pending', async () => {
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: 'idx_x: 1 passed, 0 failed' });
  const id = await makeTask();
  await runTourStage(id, userId);
  expect((await statusOf(id)).status).toBe('review_pending');
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx jest tests/playwright-agent.test.js`
Expected: FAIL —「runTourStage is not a function」。

- [ ] **Step 3: 全檔改寫 `playwright-agent.js`**

覆蓋 `app/server/pipeline/playwright-agent.js`：

```js
const { query } = require('../db');
const notify = require('../notify');
const yaml = require('js-yaml');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { loadAgent } = require('./agent-loader');
const { E2E_LOGIN, E2E_PASSWORD } = require('./e2e-account');
const { getProjectInfo, worktreeParent } = require('./task-agent');
const { runClaude, stopReason } = require('./claude-runner');
const { ensureEnvRunning } = require('./ensure-env');
const { runTourTests } = require('./env-agent');
const { classifyFailureWithAgent } = require('./failure-classifier');
const { extractOdooError } = require('./deploy-testing');

const PW_LIMIT = 3;

async function stopTask(taskId, userId, msg, blockerType = null) {
  await query("UPDATE tasks SET status='stopped', blocker_type=$3, blocker_content=$2, updated_at=NOW() WHERE id=$1", [taskId, msg, blockerType]);
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
}

// tour 失敗屬程式問題：把報告餵回 coding 並加計數，滿 PW_LIMIT→stopped（沿用原 E2E 失敗語意）。
async function bounceToCoding(task, taskId, userId, report) {
  await query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)", [taskId, `[E2E tour 未通過]\n${report}`]);
  const nextCount = (task.pw_retry_count || 0) + 1;
  if (nextCount >= PW_LIMIT) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_type='code', pw_retry_count=$2, blocker_content=$3, updated_at=NOW() WHERE id=$1",
      [taskId, nextCount, `E2E tour 連續 ${PW_LIMIT} 次未通過，需人工介入。最後結果：${String(report).slice(0, 300)}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }
  const { bumpReentryOrStop } = require('./reentry');
  if (await bumpReentryOrStop(taskId, userId)) return; // 總循環達上限 → 已標 stopped
  await query(
    "UPDATE tasks SET status='coding_running', pw_retry_count=$2, retry_feedback=$3, updated_at=NOW() WHERE id=$1",
    [taskId, nextCount, `[E2E tour 未通過]\n${report}`]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'coding_running' });
}

// E2E via Odoo 原生 tour（獨立階段）：agent 產 tour+HttpCase 寫入模組並 commit（副作用），
// 再由 Node 跑 odoo-bin --test-enable 判 exit code；verdict 對映複用 deploy 的分類邏輯。
async function runTourStage(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, project_id, git_branch, analysis_yaml, pw_retry_count FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  if (!(await ensureEnvRunning(task.project_id))) {
    await stopTask(taskId, userId, '測試環境未運行且無法自動啟動，請至專案環境頁檢查', 'env');
    return true;
  }
  const { rows: [env] } = await query('SELECT url FROM odoo_envs WHERE project_id=$1', [task.project_id]);
  if (!env?.url) {
    await stopTask(taskId, userId, '測試環境未提供 URL，無法執行 E2E 測試', 'env');
    return true;
  }

  let moduleName = '';
  try { moduleName = (yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {}).module || ''; } catch { /* SD 解析失敗 */ }
  if (!moduleName) {
    await stopTask(taskId, userId, '無法從分析規格取得 module 名稱，無法產生 tour 測試', 'code');
    return true;
  }

  // 1) tour-author agent：把 tour+HttpCase 寫進模組並 commit（結果由下方 exit code 判，不解析其文字）
  const info = await getProjectInfo(task.project_id);
  const cwd = info?.root ? worktreeParent(info.root, task.task_id) : process.cwd();
  try {
    const agent = loadAgent('playwright');
    const prompt = agent.render({
      analysis_yaml: task.analysis_yaml || '（無規格）',
      test_url: env.url,
      login: E2E_LOGIN,
      module: moduleName
    }).trim();
    const result = await runClaude(prompt, { cwd, taskId, userId, signal, model: agent.model, env: { E2E_PASSWORD } });
    await logTokenUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'playwright', result.usage, result.durationMs);
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id, projectId: task.project_id }, userId, 'playwright', err);
    await stopTask(taskId, userId, stopReason('Tour 產生失敗', err));
    return true;
  }

  // 2) Node 跑 tour（odoo-bin --test-enable），依 exit code 判定
  const clsCtx = { taskId: task.task_id, projectId: task.project_id, userId };
  let log = '', err = null;
  try { ({ log } = await runTourTests(task.project_id, moduleName)); } catch (e) { err = e; }

  // transient（網路抖動/被砍）→ 自動重試一次，不佔計數（比照 deploy）
  if (err && (await classifyFailureWithAgent(err.message, clsCtx)) === 'transient') {
    err = null;
    try { ({ log } = await runTourTests(task.project_id, moduleName)); } catch (e) { err = e; }
  }

  if (!err) {
    // 防假綠燈：chrome 消失時 Odoo raise SkipTest（exit 0），log 會有此字樣＝tour 沒真的跑
    if (/Chrome executable not found|unittest\.SkipTest/i.test(log)) {
      await stopTask(taskId, userId, 'tour 被跳過（測試機找不到 Chrome），E2E 未實際執行。請確認測試環境已安裝 Google Chrome。', 'env');
      return true;
    }
    await query("UPDATE tasks SET status='review_pending', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'review_pending' });
    return true;
  }

  // 失敗分類（比照 deploy）：env／env 已非 running → 停等修環境；code → 退 coding 計數
  const cls = await classifyFailureWithAgent(err.message, clsCtx);
  const odooErr = extractOdooError(err.message);
  const { rows: [env2] } = await query('SELECT status FROM odoo_envs WHERE project_id=$1', [task.project_id]);
  if (cls !== 'code' || !env2 || env2.status !== 'running') {
    await stopTask(taskId, userId, `E2E tour 期間屬環境問題（非程式碼），請恢復環境後重試。最後錯誤：${odooErr.slice(0, 500)}`, 'env');
    return true;
  }
  await bounceToCoding(task, taskId, userId, odooErr);
  return true;
}

module.exports = { runTourStage };
```

- [ ] **Step 4: 更新 `runner.js` 呼叫點**

`app/server/pipeline/runner.js:169-172`，把：

```js
// playwright_running：依 SD 產計畫並跑 E2E（pass→review_pending；fail→退 coding 計數）
async function handlePlaywright(task, signal) {
  const { runPlaywrightAgent } = require('./playwright-agent');
  await runPlaywrightAgent(task.id, task.user_id, signal);
}
```

改為：

```js
// playwright_running：E2E via Odoo 原生 tour（pass→review_pending；fail→退 coding 計數）
async function handlePlaywright(task, signal) {
  const { runTourStage } = require('./playwright-agent');
  await runTourStage(task.id, task.user_id, signal);
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd app && npx jest tests/playwright-agent.test.js`
Expected: PASS（5 passed）。

- [ ] **Step 6: commit**

```bash
git add app/server/pipeline/playwright-agent.js app/server/pipeline/runner.js app/server/tests/playwright-agent.test.js
git commit -m "[E2E]: E2E 階段改跑 Odoo tour（runTourStage），verdict 由 odoo-bin exit code 判"
```

---

## Task 4: 改寫 tour-author prompt（`playwright.md`）

**Files:**
- Modify: `.claude/agents/playwright.md`（全檔改寫）

**Interfaces:**
- Consumes: `runTourStage` 以 `{ analysis_yaml, test_url, login, module }` 呼叫 `agent.render(...)`；本檔須用到這些變數。

- [ ] **Step 1: 覆寫 `.claude/agents/playwright.md`**

```markdown
---
name: playwright
role: playwright
label: E2E 測試
description: 依分析規格產生 Odoo 原生 tour（HttpCase）測試並寫入模組
model: sonnet
stage: playwright
---
你是 Odoo 專案的 E2E 測試 Agent。依【分析規格】為**本次變更的新行為**產出 Odoo 原生 **tour** 測試，寫入模組並 commit。你**只寫測試檔，不得改動功能程式**。

【本次模組】{{module}}
【測試目標環境】網址：{{test_url}}；登入帳號：{{login}}（密碼於環境變數 `E2E_PASSWORD`，切勿寫死或印出）

【工作流程】
1. 讀模組 `{{module}}` 現有實作，確認本次要驗的新行為（欄位/位置/儲存/報表等）。
2. 產出 tour 測試三件：
   - `{{module}}/static/tests/tours/<name>.js`：用標準 tour steps（`trigger`/`run`/`content`），以 tour 內建等待，**不得自行 sleep**。
   - `{{module}}/tests/test_<name>.py`：`HttpCase` 子類；**需要前置資料時在 Python `setUp` 以 ORM 建立**（例：先建一張 sale.order），再 `self.start_tour(自訂 url 或 '/odoo', 'tour_name', login='{{login}}')`。
   - `{{module}}/tests/__init__.py`：`from . import test_<name>`（若無則建）。
3. 於 `{{module}}/__manifest__.py` 的 `assets['web.assets_tests']` 註冊 tour JS。
4. 自我驗證：`python -m py_compile {{module}}/tests/test_<name>.py`。
5. `git add` 上述測試檔與 manifest，`git commit -m "[{{module}}]: 新增 tour E2E 測試"`。

【硬規則】
- 禁止：`require('playwright')`／`chromium`、任何寫死 URL/埠、額外 diag/debug 腳本、`waitForLoadState('networkidle')`。
- 不改功能程式；只新增/調整 `static/tests/`、`tests/`、`__manifest__.py` 的 assets。
- pass/fail 由 `odoo-bin --test-enable` 的 exit code 判定（本階段由系統執行），你不需自行跑瀏覽器。

【分析規格】
{{analysis_yaml}}

【輸出】完成後簡述你新增了哪些測試檔與涵蓋的操作路徑即可（不需其他格式）。
```

- [ ] **Step 2: 驗證 prompt 可被載入且變數齊全**

Run: `cd app && node -e "const {loadAgent}=require('./server/pipeline/agent-loader'); const a=loadAgent('playwright'); console.log(a.render({analysis_yaml:'x',test_url:'u',login:'l',module:'idx_x'}).includes('idx_x'))"`
Expected: 印出 `true`。

- [ ] **Step 3: commit**

```bash
git add .claude/agents/playwright.md
git commit -m "[E2E]: playwright agent 改為 tour-author（寫 tour+HttpCase 進模組）"
```

---

## Task 5: 清理殘留 worktree 舊 spec（收尾，可選）

**Files:**
- Delete: `repos/**/.worktrees/**/e2e_*.spec.js`（及 `diag*.js`）等前代手刻腳本

**Interfaces:** 無（純清理，不影響執行路徑）。

- [ ] **Step 1: 列出殘留**

Run: `find repos -path '*/.worktrees/*' \( -name 'e2e_*.spec.js' -o -name 'diag*.js' \) -not -path '*/node_modules/*'`
Expected: 列出 `manual_1783319749063`、`manual_1783326354710` 等殘留檔。

- [ ] **Step 2: 刪除並記錄**

逐一 `rm` 上一步列出的檔案（worktree 內的一次性測試殘留，非版控功能碼）。若某 worktree 對應任務仍在進行，略過該檔。

- [ ] **Step 3: 說明**

此為清理既有雜物，無需 commit（多半在 `.gitignore`/未追蹤）；於 PR 說明註記已清理避免誤解為遺留。

---

## Self-Review（作者自檢）

- **Spec 覆蓋**：§5-A→Task 4；§5-B→Task 2；§5-C→Task 3；§5-D→Task 1；§6 防假綠燈→Task 3 Step 3（skip 偵測）＋ Task 3 測試；§8 步驟一一對應。無遺漏。
- **Placeholder**：各步皆附完整程式與指令，無 TBD。
- **型別/命名一致**：`runTourTests(projectId, moduleName)→{ok,log}`、`runTourStage(taskId,userId,signal)`、`findChrome()→string|null` 於 Task 1/2/3 與測試中一致；exports 於 Task 1 Step 5 一次補齊 `findChrome, runTourTests`。
- **平台假設**：`findChrome` 測試在非 win32 以 `test.skip` 略過（本平台為 Windows）。
