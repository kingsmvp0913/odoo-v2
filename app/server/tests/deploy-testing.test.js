// 意圖：部署測試區用純程式升級。升級成功往下 E2E；升級失敗＝程式錯，退 coding 並計數，
// 滿上限改 stopped；環境起不來屬 infra 錯，直接 stopped（不退 coding、不呼叫升級）。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/env-agent', () => ({
  upgradeModules: jest.fn(),
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

test('extractOdooError：優先抓 Traceback 段', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = 'banner\naddons paths...\nTraceback (most recent call last)\n  File "x.py", line 3\nKeyError: sale_order';
  const out = extractOdooError(log);
  expect(out.startsWith('Traceback')).toBe(true);
  expect(out).toContain('KeyError');
});

beforeEach(async () => {
  envAgent.upgradeModules.mockReset();
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

test('升級失敗第 3 次 → stopped', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error('boom'));
  const id = await makeTask(2);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.deploy_retry_count).toBe(3);
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

test('升級失敗 → 完整 log 落地成檔，retry_feedback 附檔案路徑供事後鑑識', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  process.env.DEPLOY_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deploylog-'));
  try {
    await setEnvRunning();
    const err = new Error('short banner only');
    err.exitCode = 1; err.stdout = 'stdout 裡的線索'; err.stderr = 'short banner only';
    envAgent.upgradeModules.mockRejectedValue(err);
    const id = await makeTask(0);
    await runDeployTesting(id, userId);

    const { rows: [t] } = await dbModule.query('SELECT retry_feedback FROM tasks WHERE id=$1', [id]);
    expect(t.retry_feedback).toContain('完整 log：');
    const logPath = t.retry_feedback.match(/完整 log：(.+)$/m)[1].trim();
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
});

test('A-3 code 類失敗（ParseError）→ 退 coding、計數+1（現行不破）', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error('Traceback\nodoo.tools.convert.ParseError: bad view'));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.deploy_retry_count).toBe(1);
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
