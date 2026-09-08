// 意圖：任務併入 ai-dev 之後自動部署到客戶測試區。守的是「什麼時候不做、做壞了會怎樣」——
// 碼進 ai-dev 是既成事實，部署失敗不可以回頭改 git 狀態，也不可以讓整張任務失敗。
const { newDb } = require('pg-mem');

jest.mock('../pipeline/git', () => ({
  AI_BRANCH: 'ai-dev',
  mergeToAiBranch: jest.fn().mockResolvedValue(undefined),
  concludeAiMerge: jest.fn().mockResolvedValue(undefined),
  deleteBranchLocal: jest.fn().mockResolvedValue(undefined),
  removeWorktree: jest.fn().mockResolvedValue(undefined),
  refExists: jest.fn().mockResolvedValue(true),
}));
jest.mock('../pipeline/merge-agent', () => ({ resolveConflicts: jest.fn() }));
jest.mock('../lib/git-identity', () => ({ buildGitEnv: jest.fn().mockResolvedValue({}) }));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../lib/deploy-run', () => ({ runDeploy: jest.fn() }));

process.env.JWT_SECRET = 'test-deploy-trigger';
process.env.APP_SECRET = 'test-app-secret';

const { runDeploy } = require('../lib/deploy-run');
const notify = require('../notify');

let dbModule, pushAi, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('p','h','P','user') RETURNING id"
  );
  userId = rows[0].id;
  pushAi = require('../pipeline/push-ai');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  runDeploy.mockReset().mockResolvedValue({ ok: true, status: 'success', modules: ['idx_hj'] });
  notify.emitToUser.mockReset();
  await dbModule.query('DELETE FROM deploy_runs');
  await dbModule.query('DELETE FROM project_deploy_targets');
  await dbModule.query('DELETE FROM tasks');
  await dbModule.query('DELETE FROM project_repos');
  await dbModule.query('DELETE FROM projects');
  await dbModule.query('DELETE FROM teams_settings');
  await dbModule.query('INSERT INTO teams_settings (id, auto_deploy_enabled) VALUES (1, true)');
});

async function setup({ targets = [] } = {}) {
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('PA','17.0','pa') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/pa/main',true,'done')",
    [proj.id]
  );
  for (const t of targets) {
    await dbModule.query(
      `INSERT INTO project_deploy_targets (project_id, env, runtime, addons_dir, db_name, branch, enabled)
       VALUES ($1,$2,'docker','/a/addons','db','ai-dev',$3)`, [proj.id, t.env, t.enabled]
    );
  }
  const { rows: [task] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, git_branch)
     VALUES ($1,'task_pa_1','odoo','T','c','push_ai_running',$2,'task/task_pa_1') RETURNING id`,
    [userId, proj.id]
  );
  return task.id;
}

const said = () => notify.emitToUser.mock.calls
  .map(c => (c[2] && c[2].data) || '').filter(d => d.includes('[DEPLOY]')).join('');
const statusOf = async (id) => (await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id])).rows[0].status;

test('有啟用的測試區目標時觸發部署，且任務照常推進', async () => {
  const id = await setup({ targets: [{ env: 'test', enabled: true }] });
  await pushAi.runPushAi(id, userId, null);
  expect(runDeploy).toHaveBeenCalledTimes(1);
  expect(runDeploy.mock.calls[0][1].trigger).toBe('auto_test');
  expect(await statusOf(id)).toBe('wiki_updating');
});

// 意圖：靜默跳過最難查——使用者會以為部署了，其實沒有。
test('總開關關閉時不部署，但留一行說明', async () => {
  await dbModule.query('UPDATE teams_settings SET auto_deploy_enabled = false WHERE id = 1');
  const id = await setup({ targets: [{ env: 'test', enabled: true }] });
  await pushAi.runPushAi(id, userId, null);
  expect(runDeploy).not.toHaveBeenCalled();
  expect(said()).toMatch(/停用/);
  expect(await statusOf(id)).toBe('wiki_updating');
});

test('沒有啟用的測試區目標時不部署，也留一行說明', async () => {
  const id = await setup({ targets: [{ env: 'test', enabled: false }, { env: 'prod', enabled: true }] });
  await pushAi.runPushAi(id, userId, null);
  expect(runDeploy).not.toHaveBeenCalled();
  expect(said()).toMatch(/沒有啟用/);
});

// 意圖：正式區只能由「上正式」按鈕觸發。核准就打正式機是絕不允許的。
test('絕不觸發正式區目標', async () => {
  const id = await setup({ targets: [{ env: 'prod', enabled: true }] });
  await pushAi.runPushAi(id, userId, null);
  expect(runDeploy).not.toHaveBeenCalled();
});

// 意圖（Rule 9）：碼已經在 ai-dev 上了，這是事實。部署失敗讓任務失敗，
// 會讓使用者以為程式根本沒併進去，然後跑去重做一次。
test('部署回失敗時任務照常推進，只留錯誤訊息', async () => {
  runDeploy.mockResolvedValue({ ok: false, status: 'rolled_back', modules: ['idx_hj'], error: '健康檢查未通過' });
  const id = await setup({ targets: [{ env: 'test', enabled: true }] });
  await pushAi.runPushAi(id, userId, null);
  expect(await statusOf(id)).toBe('wiki_updating');
  expect(said()).toMatch(/失敗/);
  expect(said()).toMatch(/健康檢查未通過/);
});

test('部署丟例外也不讓任務卡住', async () => {
  runDeploy.mockRejectedValue(new Error('SSH 連不上'));
  const id = await setup({ targets: [{ env: 'test', enabled: true }] });
  await pushAi.runPushAi(id, userId, null);
  expect(await statusOf(id)).toBe('wiki_updating');
  expect(said()).toMatch(/例外/);
});

test('多個啟用的測試區目標會逐一部署', async () => {
  const id = await setup({ targets: [{ env: 'test', enabled: true }, { env: 'test', enabled: true }] });
  await pushAi.runPushAi(id, userId, null);
  expect(runDeploy).toHaveBeenCalledTimes(2);
});
