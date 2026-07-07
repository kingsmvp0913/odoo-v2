// 意圖：部署測試區用純程式升級。升級成功往下 E2E；升級失敗＝程式錯，退 coding 並計數，
// 滿上限改 stopped；環境起不來屬 infra 錯，直接 stopped（不退 coding、不呼叫升級）。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/env-agent', () => ({
  upgradeModules: jest.fn(),
  runEnvSetup: jest.fn()
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
  await dbModule.query('DELETE FROM odoo_envs WHERE project_id=$1', [projectId]);
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
  expect(envAgent.upgradeModules).toHaveBeenCalledWith(projectId, ['sale']);
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
