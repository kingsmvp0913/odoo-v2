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
jest.mock('../lib/deploy-run', () => ({ runDeploy: jest.fn(), runDeployGroup: jest.fn() }));

process.env.JWT_SECRET = 'test-deploy-trigger';
process.env.APP_SECRET = 'test-app-secret';

const { runDeployGroup } = require('../lib/deploy-run');
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
  runDeployGroup.mockReset().mockImplementation(async (ids) =>
    ids.map((id) => ({ targetId: id, ok: true, status: 'success', modules: ['idx_hj'] })));
  notify.emitToUser.mockReset();
  await dbModule.query('DELETE FROM deploy_runs');
  await dbModule.query('DELETE FROM project_deploy_targets');
  await dbModule.query('DELETE FROM tasks');
  await dbModule.query('DELETE FROM project_repos');
  await dbModule.query('DELETE FROM projects');
});

async function setup({ targets = [] } = {}) {
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name, auto_deploy_enabled) VALUES ('PA','17.0','pa',true) RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/pa/main',true,'done')",
    [proj.id]
  );
  for (const t of targets) {
    await dbModule.query(
      `INSERT INTO project_deploy_targets
         (project_id, env, runtime, addons_dir, db_name, branch, enabled, compose_dir, compose_service)
       VALUES ($1,$2,'docker',$3,$4,'ai-dev',$5,'/srv',$6)`,
      [proj.id, t.env, t.addons_dir || '/a/addons', t.db_name || 'db', t.enabled, t.service || 'web']
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
  expect(runDeployGroup).toHaveBeenCalledTimes(1);
  expect(runDeployGroup.mock.calls[0][1].trigger).toBe('auto_test');
  expect(await statusOf(id)).toBe('wiki_updating');
});

// 意圖：靜默跳過最難查——使用者會以為部署了，其實沒有。
test('專案開關關閉時不部署，但留一行說明', async () => {
  const id = await setup({ targets: [{ env: 'test', enabled: true }] });
  await dbModule.query('UPDATE projects SET auto_deploy_enabled = false');
  await pushAi.runPushAi(id, userId, null);
  expect(runDeployGroup).not.toHaveBeenCalled();
  expect(said()).toMatch(/未啟用/);
  expect(await statusOf(id)).toBe('wiki_updating');
});

test('沒有啟用的測試區目標時不部署，也留一行說明', async () => {
  const id = await setup({ targets: [{ env: 'test', enabled: false }, { env: 'prod', enabled: true }] });
  await pushAi.runPushAi(id, userId, null);
  expect(runDeployGroup).not.toHaveBeenCalled();
  expect(said()).toMatch(/沒有啟用/);
});

// 意圖：正式區只能由「上正式」按鈕觸發。核准就打正式機是絕不允許的。
test('絕不觸發正式區目標', async () => {
  const id = await setup({ targets: [{ env: 'prod', enabled: true }] });
  await pushAi.runPushAi(id, userId, null);
  expect(runDeployGroup).not.toHaveBeenCalled();
});

// 意圖（Rule 9）：碼已經在 ai-dev 上了，這是事實。部署失敗讓任務失敗，
// 會讓使用者以為程式根本沒併進去，然後跑去重做一次。
test('部署回失敗時任務照常推進，只留錯誤訊息', async () => {
  runDeployGroup.mockImplementation(async (ids) =>
    ids.map((id) => ({ targetId: id, ok: false, status: 'rolled_back', modules: ['idx_hj'], error: '健康檢查未通過' })));
  const id = await setup({ targets: [{ env: 'test', enabled: true }] });
  await pushAi.runPushAi(id, userId, null);
  expect(await statusOf(id)).toBe('wiki_updating');
  expect(said()).toMatch(/失敗/);
  expect(said()).toMatch(/健康檢查未通過/);
});

test('部署丟例外也不讓任務卡住', async () => {
  runDeployGroup.mockRejectedValue(new Error('SSH 連不上'));
  const id = await setup({ targets: [{ env: 'test', enabled: true }] });
  await pushAi.runPushAi(id, userId, null);
  expect(await statusOf(id)).toBe('wiki_updating');
  expect(said()).toMatch(/例外/);
});

// 意圖（Rule 9）：同一個容器上的多個資料庫（鴻久那台 odoo_prd 與 odoo_dev 都掛在
// odoo-prd 底下）必須合成一輪停機。拆成一個目標停一次的話客戶被斷線 N 次，
// 而且兩次停機之間服務是活的——使用者這時進得來，用到的是只升了一半的狀態。
test('同一個容器上的多個資料庫合併成一次停機，兩個目標都有部署到', async () => {
  const id = await setup({ targets: [
    { env: 'test', enabled: true, db_name: 'db_a' },
    { env: 'test', enabled: true, db_name: 'db_b' },
  ] });
  await pushAi.runPushAi(id, userId, null);
  expect(runDeployGroup).toHaveBeenCalledTimes(1);
  expect(runDeployGroup.mock.calls[0][0]).toHaveLength(2);
  expect(said()).toMatch(/db_a/);
  expect(said()).toMatch(/db_b/);
});

// 反面：不同 addons 目錄＝不同的部署位置，共用一次停機會互相覆蓋檔案，必須拆開。
test('不同 addons 目錄的目標不合併，各跑各的', async () => {
  const id = await setup({ targets: [
    { env: 'test', enabled: true, db_name: 'db_a', addons_dir: '/a/addons' },
    { env: 'test', enabled: true, db_name: 'db_b', addons_dir: '/b/addons' },
  ] });
  await pushAi.runPushAi(id, userId, null);
  expect(runDeployGroup).toHaveBeenCalledTimes(2);
  expect(runDeployGroup.mock.calls[0][0]).toHaveLength(1);
  expect(runDeployGroup.mock.calls[1][0]).toHaveLength(1);
});
