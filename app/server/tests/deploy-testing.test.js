// 意圖：部署測試區用純程式升級。升級成功往下 E2E；升級失敗＝程式錯，退 coding 並計數，
// 滿上限改 stopped；環境起不來屬 infra 錯，直接 stopped（不退 coding、不呼叫升級）。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/env-agent', () => ({
  upgradeModules: jest.fn(),
  installModuleRequirements: jest.fn(),
  runEnvSetup: jest.fn()
}));
jest.mock('../pipeline/claude-runner', () => ({ runClaude: jest.fn() })); // 分類器 agent fallback 用
jest.mock('../pipeline/git', () => ({
  discardPyc: jest.fn().mockResolvedValue(undefined),
  ensureTestingBranch: jest.fn().mockResolvedValue(undefined)
}));

let dbModule, runDeployTesting, envAgent;
let userId, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('dt', $1, 'D') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('DP', '17.0') RETURNING id"
  );
  projectId = p.id;

  envAgent = require('../pipeline/env-agent');
  ({ runDeployTesting } = require('../pipeline/deploy-testing'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('extractOdooError：抽出結尾真正錯誤，而非開頭版本/addons paths 橫幅', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = [
    'Odoo version 17.0',
    "addons paths: ['C:\\\\odoo-v2\\\\odoo-envs\\\\cwt\\\\src\\\\odoo\\\\addons']",
    'loading module base (1/50)',
    '2026-07-06 09:31:43 ERROR test_cwt odoo.modules.loading: Failed to load module idx_sale_note_t',
    'ParseError: Invalid view definition in idx_sale_note_t/views/x.xml line 5'
  ].join('\n');
  const out = extractOdooError(log);
  expect(out).toContain('ParseError');
  expect(out).not.toContain('Odoo version 17.0');
});

// 意圖：blocker 要讓人一眼看到原因。Python traceback 原因在結尾例外行，開頭是無用呼叫堆疊；
// 舊版從開頭切 → 使用者只看到 server.py→decorator.py、真正原因被截掉、被迫翻 log。
test('extractOdooError：多層 traceback → 帶出結尾例外行（真正原因），非開頭呼叫堆疊', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = [
    'Traceback (most recent call last):',
    '  File ".../odoo/service/server.py", line 1422, in preload_registries',
    '    registry = Registry.new(dbname, update_module=update_module)',
    '  File ".../decorator.py", line 232, in fun',
    '    return caller(func, *(extras + args), **kw)',
    'odoo.exceptions.UserError: Unable to install module "alnas_xlsx" because an external dependency is not met: Python library not installed: xlsxtpl'
  ].join('\n');
  const out = extractOdooError(log);
  expect(out.startsWith('odoo.exceptions.UserError')).toBe(true); // 例外行放最前
  expect(out).toContain('xlsxtpl');                               // 真正原因帶出來
  expect(out).toContain('external dependency');
  expect(out).not.toContain('preload_registries');               // 開頭無用的呼叫堆疊不塞給人
});

// 舊意圖是「回傳整段 traceback、開頭 Traceback header」；改版後改為「原因（結尾例外行）放最前」——
// blocker 一眼可讀，不再開頭塞無用 header／banner（完整 traceback 仍在 saveDeployLog 落的 log 檔供 agent 定位）。
test('extractOdooError：traceback → 帶出結尾例外行（原因）放最前，不含 banner/header', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = 'banner\naddons paths...\nTraceback (most recent call last)\n  File "x.py", line 3\nKeyError: sale_order';
  const out = extractOdooError(log);
  expect(out.startsWith('KeyError')).toBe(true);   // 原因在最前
  expect(out).toContain('KeyError');
  expect(out).not.toContain('banner');             // 開頭 banner/header 不塞給人
});

beforeEach(async () => {
  envAgent.upgradeModules.mockReset();
  envAgent.installModuleRequirements.mockReset().mockResolvedValue('');
  envAgent.runEnvSetup.mockReset();
  require('../pipeline/claude-runner').runClaude.mockReset(); // 分類器 agent fallback，避免測試順序相依
  const git = require('../pipeline/git');
  git.discardPyc.mockReset().mockResolvedValue(undefined);
  git.ensureTestingBranch.mockReset().mockResolvedValue(undefined);
  await dbModule.query('DELETE FROM odoo_envs WHERE project_id=$1', [projectId]);
  await dbModule.query('DELETE FROM project_repos WHERE project_id=$1', [projectId]);
});

let seq = 0;
async function makeTask(deployCount = 0) {
  seq++;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, analysis_yaml, deploy_retry_count)
     VALUES ($1,$2,'odoo','T','deploy_testing',$3,'module: sale',$4) RETURNING id`,
    [userId, `dt_${seq}`, projectId, deployCount]
  );
  return t.id;
}
async function setEnvRunning() {
  await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1, 'running')", [projectId]);
}

test('env 運行 + 升級成功 → playwright_running', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
  const id = await makeTask();
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('playwright_running');
  expect(envAgent.upgradeModules).toHaveBeenCalledWith(projectId, ['sale'], undefined);
});

test('專案停用 E2E + 升級成功 → 跳過 tour，直接 review_pending 並留痕跡', async () => {
  await dbModule.query('UPDATE projects SET e2e_disabled=true WHERE id=$1', [projectId]);
  try {
    await setEnvRunning();
    envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
    const id = await makeTask();
    await runDeployTesting(id, userId);
    const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
    expect(t.status).toBe('review_pending');   // 純程式跳過，不進 playwright_running
    const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1", [id]);
    expect(logs.some(l => l.content.includes('E2E 已依專案設定停用，跳過'))).toBe(true);
  } finally {
    await dbModule.query('UPDATE projects SET e2e_disabled=false WHERE id=$1', [projectId]);
  }
});

// --- 分支歸位：addons-path 指主 clone 工作樹，別任務的 analysis/approve 會把 clone 留在 main，
//     不先 checkout testing 就會對錯的分支升級（假綠燈）---

test('升級前逐 repo 切回 testing 分支（先 discardPyc 再 checkout，於升級之前）', async () => {
  await setEnvRunning();
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/dp/main',true,'done')",
    [projectId]
  );
  envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
  const git = require('../pipeline/git');
  const id = await makeTask();
  await runDeployTesting(id, userId);

  expect(git.ensureTestingBranch).toHaveBeenCalledWith('/repos/dp/main');
  expect(git.discardPyc.mock.invocationCallOrder[0]).toBeLessThan(git.ensureTestingBranch.mock.invocationCallOrder[0]);
  expect(git.ensureTestingBranch.mock.invocationCallOrder[0]).toBeLessThan(envAgent.upgradeModules.mock.invocationCallOrder[0]);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('playwright_running');
});

test('checkout testing 失敗 → stopped(env)，不升級、不退 coding', async () => {
  await setEnvRunning();
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/dp/main',true,'done')",
    [projectId]
  );
  require('../pipeline/git').ensureTestingBranch.mockRejectedValue(new Error('checkout blocked'));
  const id = await makeTask();
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
  expect(t.deploy_retry_count).toBe(0);
  expect(envAgent.upgradeModules).not.toHaveBeenCalled();
});

// --- 手動暫停：中止子行程屬使用者操作，不是失敗，狀態原地、不分類不計數 ---

test('升級中 abort（signal.aborted）→ 狀態停在 deploy_testing、不計數、無 blocker', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(Object.assign(new Error('killed'), { killed: true }));
  const ctrl = new AbortController();
  ctrl.abort();
  const id = await makeTask();
  await runDeployTesting(id, userId, ctrl.signal);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('deploy_testing');
  expect(t.blocker_content).toBeNull();
  expect(t.deploy_retry_count).toBe(0);
});

test('升級失敗未達上限 → coding_running、計數+1', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error('ParseError: bad view'));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.deploy_retry_count).toBe(1);
});

test('升級失敗第 3 次（code 類）→ stopped', async () => {
  await setEnvRunning();
  // 測 code 路徑的重試上限：需用「明確開發者寫錯」字串（反轉舉證後模糊字串會歸 env、不佔計數）
  envAgent.upgradeModules.mockRejectedValue(new Error('ParseError: bad view'));
  const id = await makeTask(2);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.deploy_retry_count).toBe(3);
});

// 意圖：升級前自動補裝各模組宣告的 Python 相依（env 建置只裝 Odoo 核心 requirements，模組自帶的漏裝→
// 宣告 external dependency 的模組安裝時就缺）。必須在 upgradeModules 之前跑，相依才會就位。
test('deploy 升級前先補裝模組 Python 相依，且在 upgradeModules 之前', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockResolvedValue({ ok: true });
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  expect(envAgent.installModuleRequirements).toHaveBeenCalledWith(projectId, undefined);
  expect(envAgent.installModuleRequirements.mock.invocationCallOrder[0])
    .toBeLessThan(envAgent.upgradeModules.mock.invocationCallOrder[0]);   // 補裝在升級之前
});

test('環境起不來 → stopped（不退 coding、不升級）', async () => {
  // 無 odoo_envs row；runEnvSetup 不改狀態 → 仍非 running
  envAgent.runEnvSetup.mockResolvedValue(undefined);
  const id = await makeTask();
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(envAgent.upgradeModules).not.toHaveBeenCalled();
});

// --- 健檢根因 C：診斷資訊不得丟失 ---

test('extractOdooError：無 ERROR/Traceback → 明確標注疑環境層問題（而非默默回傳 banner）', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = 'Odoo version 17.0\naddons paths: [...]';  // 12 秒就死的行程，log 只有 banner
  const out = extractOdooError(log);
  expect(out).toContain('無 ERROR/Traceback');
  expect(out).toContain('環境或啟動層');
});

test('升級失敗（banner-only）→ 判 env、完整 log 落地成檔，blocker_content 附檔案路徑供事後鑑識', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  process.env.DEPLOY_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deploylog-'));
  try {
    await setEnvRunning();
    // stderr 只有 banner（無 ERROR/Traceback）＝進程在載入模組前就死，屬啟動層問題 → 反轉舉證後歸 env
    const err = new Error('short banner only');
    err.exitCode = 1; err.stdout = 'stdout 裡的線索'; err.stderr = 'short banner only';
    envAgent.upgradeModules.mockRejectedValue(err);
    const id = await makeTask(0);
    await runDeployTesting(id, userId);

    const { rows: [t] } = await dbModule.query('SELECT blocker_type, blocker_content FROM tasks WHERE id=$1', [id]);
    expect(t.blocker_type).toBe('env');
    expect(t.blocker_content).toContain('完整 log：');
    const logPath = t.blocker_content.match(/完整 log：(.+)$/m)[1].trim();
    const saved = fs.readFileSync(logPath, 'utf8');
    expect(saved).toContain('exitCode: 1');
    expect(saved).toContain('stdout 裡的線索'); // stderr 之外的輸出不得丟棄
  } finally {
    delete process.env.DEPLOY_LOG_DIR;
  }
});

// ===== 主題 A：部署失敗依分類分流（根因 B）=====

test('A-3 env 類失敗（DB 連不上）→ stopped、blocker_type=env、deploy 計數不變、不退 coding', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error('could not connect to server: Connection refused'));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');            // 不退 coding
  expect(t.blocker_type).toBe('env');
  expect(t.deploy_retry_count).toBe(0);        // 環境問題不佔計數（＝根因 B 修好）
  // 判定寫進執行歷程，人工能看出「為什麼停」（不再黑箱）。pg-mem 的 LIKE 抓不到中文子字串，改 JS 過濾
  const { rows: ev } = await dbModule.query('SELECT content FROM task_events WHERE task_id=$1', [id]);
  const verdict = ev.map(r => r.content).filter(c => c.includes('部署失敗判定'));
  expect(verdict).toHaveLength(1);
  expect(verdict[0]).toMatch(/環境問題/);
});

test('A-3 code 類失敗（ParseError）→ 退 coding、計數+1（現行不破）', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error('Traceback\nodoo.tools.convert.ParseError: bad view'));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.deploy_retry_count).toBe(1);
  // 判定寫進歷程，人工能看出「為什麼回開發、第幾次」（不再黑箱）。pg-mem LIKE 抓不到中文，改 JS 過濾
  const { rows: ev } = await dbModule.query('SELECT content FROM task_events WHERE task_id=$1', [id]);
  const verdict = ev.map(r => r.content).filter(c => c.includes('部署失敗判定'));
  expect(verdict).toHaveLength(1);
  expect(verdict[0]).toMatch(/程式問題/);
  expect(verdict[0]).toMatch(/第 1\/3/);
});

test('A-3 transient 失敗 → 自動重試一次；第二次成功 → playwright，計數不變', async () => {
  await setEnvRunning();
  envAgent.upgradeModules
    .mockRejectedValueOnce(new Error('read ECONNRESET'))
    .mockResolvedValueOnce({ ok: true, log: 'ok' });
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(envAgent.upgradeModules).toHaveBeenCalledTimes(2);  // 重試一次
  expect(t.status).toBe('playwright_running');
  expect(t.deploy_retry_count).toBe(0);                      // transient 不佔計數
});

test('A-3 unknown → 叫 deploy-fix agent；回 env → 走 env 路徑', async () => {
  const { runClaude } = require('../pipeline/claude-runner');
  runClaude.mockResolvedValue({ text: '{"type":"env"}' });
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error('some novel unrecognized failure zzz'));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
  expect(t.deploy_retry_count).toBe(0);
});
