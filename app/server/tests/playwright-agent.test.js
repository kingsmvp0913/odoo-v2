// 意圖：E2E 依 SD 打測試區。pass→人工審核；fail→退 coding 並計數，滿上限 stopped；
// 登入用全域固定 E2E 測試帳號 auto_test_user（e2e-account.js），非使用者真實密碼、非每專案設定。
const { newDb } = require('pg-mem');

process.env.APP_SECRET = 'test-app-secret';

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ ...jest.requireActual('../pipeline/claude-runner'), runClaude: jest.fn() }));
jest.mock('../pipeline/task-agent', () => {
  const actual = jest.requireActual('../pipeline/task-agent');
  return { ...actual, getProjectInfo: jest.fn() };
});
// E2E 前自動啟動環境的 helper 以 mock 控制 true/false（其真實邏輯於 ensure-env.test.js）
jest.mock('../pipeline/ensure-env', () => ({ ensureEnvRunning: jest.fn() }));

let dbModule, runPlaywrightAgent, taskAgent, crypto, runClaude, ensureEnvRunning;
let userWithCreds, userNoCreds, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  crypto = require('../lib/crypto');

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u1] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, password_enc) VALUES ('pw', $1, 'P', $2) RETURNING id",
    [hash, crypto.encrypt('e2epass')]
  );
  userWithCreds = u1.id;
  const { rows: [u2] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('nocreds', $1, 'N') RETURNING id", [hash]
  );
  userNoCreds = u2.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('PWP', '17.0') RETURNING id"
  );
  projectId = p.id;
  await dbModule.query("INSERT INTO odoo_envs (project_id, status, url) VALUES ($1,'running','http://localhost:8069')", [projectId]);

  taskAgent = require('../pipeline/task-agent');
  ({ runClaude } = require('../pipeline/claude-runner'));
  ({ ensureEnvRunning } = require('../pipeline/ensure-env'));
  ({ runPlaywrightAgent } = require('../pipeline/playwright-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  runClaude.mockReset();
  taskAgent.getProjectInfo.mockReset();
  taskAgent.getProjectInfo.mockResolvedValue({ name: 'PWP', odoo_version: '17.0', root: '/repos/pwp', repos: [] });
  ensureEnvRunning.mockReset();
  ensureEnvRunning.mockResolvedValue(true); // 預設環境已就緒；個別測試覆寫
});

let seq = 0;
async function makeTask(ownerId, pwCount = 0) {
  seq++;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, git_branch, analysis_yaml, pw_retry_count)
     VALUES ($1,$2,'odoo','T','playwright_running',$3,'task/x','module: sale',$4) RETURNING id`,
    [ownerId, `pw_${seq}`, projectId, pwCount]
  );
  return t.id;
}
function claudeReturns(json) {
  runClaude.mockResolvedValue({
    text: `<result>\n${JSON.stringify(json)}\n</result>`, usage: null, durationMs: null
  });
}

test('verdict pass → review_pending', async () => {
  claudeReturns({ verdict: 'pass', plan: 'p', report: 'r' });
  const id = await makeTask(userWithCreds);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('review_pending');
});

test('verdict fail 未達上限 → coding_running、計數+1、失敗報告寫入 retry_feedback', async () => {
  claudeReturns({ verdict: 'fail', report: '登入後找不到選單' });
  const id = await makeTask(userWithCreds, 0);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status, pw_retry_count, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.pw_retry_count).toBe(1);
  // 健檢 U4：不寫 feedback 的話 coding 重跑拿到「（無）」只能盲改再燒一輪
  expect(t.retry_feedback).toContain('登入後找不到選單');
});

test('verdict fail 第 3 次 → stopped', async () => {
  claudeReturns({ verdict: 'fail', report: '又失敗' });
  const id = await makeTask(userWithCreds, 2);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status, pw_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.pw_retry_count).toBe(3);
});

// 全域固定帳號：不需任何專案設定即可跑，登入用 auto_test_user
test('固定 E2E 帳號：prompt 用 auto_test_user、無須專案設定即可執行', async () => {
  claudeReturns({ verdict: 'pass' });
  const { rows: [p2] } = await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('ANY', '17.0') RETURNING id");
  await dbModule.query("INSERT INTO odoo_envs (project_id, status, url) VALUES ($1,'running','http://localhost:8069')", [p2.id]);
  const { rows: [t0] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id, git_branch, analysis_yaml) VALUES ($1,'pw_any','odoo','T','playwright_running',$2,'task/x','module: sale') RETURNING id",
    [userWithCreds, p2.id]
  );
  await runPlaywrightAgent(t0.id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t0.id]);
  expect(t.status).toBe('review_pending');            // 未卡在「請先設定 E2E 帳號」
  const [prompt] = runClaude.mock.calls[0];
  expect(prompt).toContain('auto_test_user');         // 固定帳號進 prompt
});

// 主題 E-1：密碼走環境變數、不進 prompt/串流/腳本（此處為固定密碼 auto_test_user）
test('E-1 密碼以 env var E2E_PASSWORD 傳入，prompt 不含密碼明文', async () => {
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask(userWithCreds);
  await runPlaywrightAgent(id, userWithCreds);
  const [prompt, opts] = runClaude.mock.calls[0];
  expect(opts.env.E2E_PASSWORD).toBe('auto_test_user'); // 密碼走 env
  expect(prompt).toContain('auto_test_user');           // 帳號（非機密）仍在 prompt
});

// ===== 主題 A：E2E fail 先檢查 env（夜間 shutdown 誤歸因）=====

test('A-4 verdict fail 但 env 於 E2E 期間被砍 → 判 env、不加 pw 計數、不退 coding', async () => {
  // 模擬夜間 shutdown 砍在 E2E 執行中間：env 一開始 running（通過前置檢查），跑到一半變 idle
  runClaude.mockImplementation(async () => {
    await dbModule.query("UPDATE odoo_envs SET status='idle' WHERE project_id=$1", [projectId]);
    return { text: `<result>\n${JSON.stringify({ verdict: 'fail', report: '連不上測試站台' })}\n</result>`, usage: null, durationMs: null };
  });
  const id = await makeTask(userWithCreds, 0);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, pw_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');           // 不退 coding
  expect(t.blocker_type).toBe('env');
  expect(t.pw_retry_count).toBe(0);           // 環境問題不佔 pw 計數
  await dbModule.query("UPDATE odoo_envs SET status='running' WHERE project_id=$1", [projectId]); // 還原
});

test('A-4 verdict fail 且 env 正常 → 退 coding、pw 計數+1（真 bug，現行不破）', async () => {
  claudeReturns({ verdict: 'fail', report: '欄位沒出現' });
  const id = await makeTask(userWithCreds, 0);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status, pw_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.pw_retry_count).toBe(1);
});

// ===== agent 自報 failure_type：登入/環境問題不該退 coding（與 deploy 分類一致）=====

test('fail 且 failure_type=env（登入進不去）→ stopped 標 env、不退 coding、不加 pw 計數', async () => {
  // env 仍 running，但 agent 判定「連登入都進不去」＝環境/測試帳號問題，非程式 bug
  claudeReturns({ verdict: 'fail', failure_type: 'env', report: '輸入帳密後仍停在登入頁，無法進入系統' });
  const id = await makeTask(userWithCreds, 0);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, pw_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');       // 不退 coding
  expect(t.blocker_type).toBe('env');
  expect(t.pw_retry_count).toBe(0);       // 環境問題不佔 pw 計數
});

test('fail 且 failure_type=code → 退 coding（明確程式問題）', async () => {
  claudeReturns({ verdict: 'fail', failure_type: 'code', report: '儲存後金額欄位算錯' });
  const id = await makeTask(userWithCreds, 0);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status, pw_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.pw_retry_count).toBe(1);
});

test('fail 但缺 failure_type → 保守當 code 退 coding（預設不破現行）', async () => {
  claudeReturns({ verdict: 'fail', report: '沒帶類別' });
  const id = await makeTask(userWithCreds, 0);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status, pw_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.pw_retry_count).toBe(1);
});

// ===== E2E 前自動檢查並啟動測試環境（不再直接報錯）=====

test('env 於 E2E 前未運行 → 自動啟動成功後照常跑 E2E（不報錯）', async () => {
  // ensureEnvRunning 代表「偵測未運行 → 已自動起環境」，回 true
  ensureEnvRunning.mockResolvedValue(true);
  claudeReturns({ verdict: 'pass', plan: 'p', report: 'r' });
  const id = await makeTask(userWithCreds);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(ensureEnvRunning).toHaveBeenCalledWith(projectId); // E2E 前確實嘗試確保環境
  expect(t.status).toBe('review_pending');                  // 未卡在「環境未運行」報錯
});

test('env 無法自動啟動 → stopped 標 env、不呼叫 Playwright agent', async () => {
  ensureEnvRunning.mockResolvedValue(false);
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask(userWithCreds);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
  expect(runClaude).not.toHaveBeenCalled(); // 環境起不來就不浪費 token 跑 agent
});
