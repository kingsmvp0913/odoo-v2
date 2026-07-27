// 意圖：env-agent 的公開入口（docker 唯一模式）要把正確參數交給 docker-env（純參數組裝另在
// docker-env.test.js 驗）。用 mock docker-env + pg-mem 鎖住「契約」：
// build/upgrade/uninstall/seed/stop 帶對 dbName/odooArgs/SEED_USERS。
// 註：pg-mem 在本檔情境下多次 INSERT projects 會踩 SERIAL/pkey quirk，故只建「一個」fixture 專案
// （單列 INSERT、當作第一筆寫入）並全測試共用；需要 odoo_envs 的測試各自 upsert。
const { newDb } = require('pg-mem');

jest.mock('../lib/docker-env', () => {
  const actual = jest.requireActual('../lib/docker-env');
  return {
    ...actual,
    ensureDockerRunning: jest.fn().mockResolvedValue(undefined),
    ensureImage: jest.fn().mockResolvedValue({ ok: true, log: '[image] ok\n' }),
    runContainer: jest.fn().mockResolvedValue({ ok: true, log: 'cid\n' }),
    removeContainer: jest.fn().mockResolvedValue(undefined),
    stopContainer: jest.fn().mockResolvedValue({ code: 0 }),
    containerRunning: jest.fn().mockResolvedValue(true),
    containerExists: jest.fn().mockResolvedValue(true),
    containerLogs: jest.fn().mockResolvedValue('log'),
    execOdoo: jest.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' }),
    execPipInstall: jest.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' }),
  };
});
jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));
jest.mock('../pipeline/git', () => ({ ensureTestingBranch: jest.fn().mockResolvedValue(undefined) }));

let dbModule, envAgent, dockerEnv;
const PID = 1001; // 單一共用 fixture 專案（odoo 13 / folder=shopx）

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  // 模式由管理設定（teams_settings.env_mode）決定，非環境變數
  await dbModule.query("INSERT INTO teams_settings (id, env_mode) VALUES (1, 'docker')");
  await dbModule.query(
    `INSERT INTO projects (id, name, odoo_version, folder_name, port) VALUES (${PID}, 'P-docker', '13.0', 'shopx', 8070)`
  );
  envAgent = require('../pipeline/env-agent');
  dockerEnv = require('../lib/docker-env');
});
afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => { for (const f of Object.values(dockerEnv)) if (jest.isMockFunction(f)) f.mockClear(); });

test('dockerCtxFor：由專案組出容器名/image/dbName（odoo13→odoo-idx:13）', async () => {
  const ctx = await envAgent.dockerCtxFor(PID);
  expect(ctx.image).toBe('odoo-idx:13');
  expect(ctx.container).toBe('odoo-test-shopx');
  expect(ctx.dbName).toBe('test_shopx');
});

test('runEnvSetup（docker）：image build 失敗 → 落 error，確實走到 docker 分支', async () => {
  dockerEnv.ensureImage.mockResolvedValueOnce({ ok: false, log: '[image] boom\n' });
  await envAgent.runEnvSetup(PID);
  expect(dockerEnv.ensureImage).toHaveBeenCalled();
  const { rows: [env] } = await dbModule.query('SELECT status, error_msg FROM odoo_envs WHERE project_id=$1', [PID]);
  expect(env.status).toBe('error');
  expect(env.error_msg).toContain('image');
});

test('runEnvSetup（docker）：Docker 引擎沒起（ensureDockerRunning reject）→ 落 error，且不進 build', async () => {
  dockerEnv.ensureDockerRunning.mockRejectedValueOnce(new Error('Docker 引擎啟動逾時，請手動確認 Docker Desktop'));
  await envAgent.runEnvSetup(PID);
  expect(dockerEnv.ensureDockerRunning).toHaveBeenCalled();
  expect(dockerEnv.ensureImage).not.toHaveBeenCalled(); // preflight 失敗就收尾，不浪費時間去 build
  const { rows: [env] } = await dbModule.query('SELECT status, error_msg FROM odoo_envs WHERE project_id=$1', [PID]);
  expect(env.status).toBe('error');
  expect(env.error_msg).toContain('Docker');
});

test('upgradeModules（docker）：exec odoo -i/-u <mod> --stop-after-init，帶對 dbName', async () => {
  const r = await envAgent.upgradeModules(PID, ['sale_ext']);
  expect(r.ok).toBe(true);
  const arg = dockerEnv.execOdoo.mock.calls[0][0];
  expect(arg.odooArgs).toEqual(['-i', 'sale_ext', '-u', 'sale_ext', '--stop-after-init']);
  expect(arg.dbName).toBe('test_shopx');
});

test('upgradeModules（docker）：容器未運行 → throw', async () => {
  dockerEnv.containerRunning.mockResolvedValueOnce(false);
  await expect(envAgent.upgradeModules(PID, ['m'])).rejects.toThrow(/容器未運行/);
});

test('runTourTests（docker）：exec -i/-u <mod> --test-enable，chromium 在 image', async () => {
  await envAgent.runTourTests(PID, 'mod_x');
  const arg = dockerEnv.execOdoo.mock.calls[0][0];
  expect(arg.odooArgs).toContain('--test-enable');
  expect(arg.odooArgs).toContain('--test-tags');
  expect(arg.odooArgs).toContain('/mod_x');
});

test('uninstallModule（docker）：解析 RESULT: 行、傳 UNINSTALL_MODULE', async () => {
  dockerEnv.execOdoo.mockResolvedValueOnce({ code: 0, stdout: 'noise\nRESULT:uninstalled\n', stderr: '' });
  const r = await envAgent.uninstallModule(PID, 'mod_x');
  expect(r).toEqual({ result: 'uninstalled' });
  const arg = dockerEnv.execOdoo.mock.calls[0][0];
  expect(arg.env.UNINSTALL_MODULE).toBe('mod_x');
  expect(arg.interactive).toBe(true);
});

test('syncUsers（docker）：只 seed E2E（不再灌平台 users＋hash），傳 AIDEV_SSO_SECRET', async () => {
  const bcrypt = require('bcryptjs');
  // 平台有 user 也不得被灌進測試區（憑證外洩防線）
  await dbModule.query("INSERT INTO users (username, password_hash, display_name, role) VALUES ('u1', $1, 'U1', 'user')", [await bcrypt.hash('p', 4)]);
  await envAgent.syncUsers(PID);
  const arg = dockerEnv.execOdoo.mock.calls[0][0];
  const seeded = JSON.parse(arg.env.SEED_USERS);
  expect(seeded.some(u => u.login === 'u1')).toBe(false);      // 平台 user 不外洩
  expect(seeded).toHaveLength(1);                              // 只有 E2E 一筆
  expect(seeded[0].password_plain).toBeTruthy();               // E2E 隨機明文密碼
  expect(seeded[0].password).toBeUndefined();                  // 無平台 password_hash
  expect(arg.env.AIDEV_SSO_SECRET).toMatch(/^[0-9a-f]{64}$/);  // 32-byte hex SSO secret
  // 憑證已落 odoo_envs 供 mintSsoToken／playwright 讀
  const { rows: [env] } = await dbModule.query('SELECT sso_secret, e2e_password FROM odoo_envs WHERE project_id=$1', [PID]);
  expect(env.sso_secret).toBe(arg.env.AIDEV_SSO_SECRET);
  expect(env.e2e_password).toBe(seeded[0].password_plain);
});

test('stopEnv（docker）：stop+rm 容器並標 idle', async () => {
  await dbModule.query('DELETE FROM odoo_envs WHERE project_id=$1', [PID]);
  await dbModule.query("INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,'running',8070)", [PID]);
  await envAgent.stopEnv(PID);
  expect(dockerEnv.stopContainer).toHaveBeenCalled();
  expect(dockerEnv.removeContainer).toHaveBeenCalled();
  const { rows: [env] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=$1', [PID]);
  expect(env.status).toBe('idle');
});
