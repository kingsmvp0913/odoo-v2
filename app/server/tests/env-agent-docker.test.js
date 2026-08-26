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
    containerMountSources: jest.fn().mockResolvedValue(null),
    execOdoo: jest.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' }),
    execPipInstall: jest.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' }),
  };
});
jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));
jest.mock('../pipeline/git', () => ({ ensureTestingBranch: jest.fn().mockResolvedValue(undefined) }));
// runEnvSetup／stopEnv 會 start/stopProjectVpns；不 mock 會對本機 docker 發真指令（實測會停掉真容器）。
jest.mock('../lib/project-vpn', () => ({
  startProjectVpns: jest.fn().mockResolvedValue(''),
  stopProjectVpns: jest.fn().mockResolvedValue(undefined),
}));

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

// 意圖：deploy／E2E 判定失敗歸屬的兩道守衛只吃 err.exitCode 與 err.killed——
//   looksLikeInfraDeath（非常規退出碼＋log 無 Odoo 錯誤＝infra 死亡，退 coding 無用）
//   err.killed（我方逾時砍掉＝重試無益，直接停等人工）
// docker 化後這兩欄沒被帶出來，兩道守衛在 undefined 上恆為 false ＝整組死碼，猝死／逾時會被
// haiku 瞎猜成 code 誤退開發（107 事故）。用 4294967295 這個真實事故值當輸入才有鑑別力。
test('upgradeModules 失敗：Error 帶 exitCode（供 looksLikeInfraDeath 判猝死），非逾時則 killed=false', async () => {
  dockerEnv.execOdoo.mockResolvedValueOnce({ code: 4294967295, stdout: '', stderr: 'boom' });
  await expect(envAgent.upgradeModules(PID, ['m'])).rejects.toMatchObject({ exitCode: 4294967295, killed: false });
});

test('upgradeModules 逾時被砍：Error 帶 killed=true（deploy 據此停等人工，不再重跑一次 10 分鐘）', async () => {
  dockerEnv.execOdoo.mockResolvedValueOnce({ code: null, timedOut: true, stdout: '', stderr: '[docker] 逾時（600s）' });
  await expect(envAgent.upgradeModules(PID, ['m'])).rejects.toMatchObject({ killed: true });
});

test('runTourTests 失敗：同樣帶 exitCode／killed（E2E 走同一套 env/code 歸屬）', async () => {
  dockerEnv.execOdoo.mockResolvedValueOnce({ code: 1, stdout: 'AssertionError', stderr: '' });
  await expect(envAgent.runTourTests(PID, 'mod_x')).rejects.toMatchObject({ exitCode: 1, killed: false });
  dockerEnv.execOdoo.mockResolvedValueOnce({ code: null, timedOut: true, stdout: '', stderr: 'timeout' });
  await expect(envAgent.runTourTests(PID, 'mod_x')).rejects.toMatchObject({ killed: true });
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

// 意圖：`--test-tags /<module>` 會跑到模組內所有測試。鴻久實測 48 支裡 25 支是早就壞掉的既有
// 測試，tour 全對也會被它們拖成 exit 非 0 → 退 coding → coding 禁改測試檔 → 三輪 stopped。
// 收窄語法在真環境驗過：48 → 4，既有壞測試全數排除。
test('runTourTests 帶 test class → --test-tags 收窄成 /<mod>:Class（不跑模組內其他測試）', async () => {
  await envAgent.runTourTests(PID, 'mod_x', undefined, ['TourA', 'TourB']);
  const arg = dockerEnv.execOdoo.mock.calls[0][0];
  const tags = arg.odooArgs[arg.odooArgs.indexOf('--test-tags') + 1];
  expect(tags).toBe('/mod_x:TourA,/mod_x:TourB');
  expect(tags).not.toBe('/mod_x');   // 沒收窄的話等於沒修
});

// 意圖：兩份 tour agent 的 prompt 都叫產出的 HttpCase 讀 os.environ["E2E_PASSWORD"] 建使用者並
// start_tour(login=...)，但這裡歷來沒帶 env → 容器內是 None → 帳號建不出來／登不進去。
// 沒被發現是因為這一關歷來執行 0 次。
test('runTourTests 把 E2E_PASSWORD 注入容器（不注入的話 tour 一律登入失敗）', async () => {
  await envAgent.runTourTests(PID, 'mod_x');
  const arg = dockerEnv.execOdoo.mock.calls[0][0];
  expect(arg.env && arg.env.E2E_PASSWORD).toBeTruthy();
});

test('uninstallModule（docker）：解析 RESULT: 行、傳 UNINSTALL_MODULE', async () => {
  dockerEnv.execOdoo.mockResolvedValueOnce({ code: 0, stdout: 'noise\nRESULT:uninstalled\n', stderr: '' });
  const r = await envAgent.uninstallModule(PID, 'mod_x');
  expect(r).toEqual({ result: 'uninstalled' });
  const arg = dockerEnv.execOdoo.mock.calls[0][0];
  expect(arg.env.UNINSTALL_MODULE).toBe('mod_x');
  expect(arg.interactive).toBe(true);
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

// 意圖：容器的 addons 掛載在 docker run 那一刻定型，之後專案新增 repo 是補掛不進去的（docker 無此
// 能力），而新增 repo 不會自動重建環境——結果是那個 repo 的模組在測試區完全不存在，卻毫無徵狀：
// 容器照跑、部署照綠。addonsMountDrift 是唯一問得出這件事的地方（實測萊峰19 加入第二個 repo 後，
// 容器仍只掛著 main）。
describe('addonsMountDrift', () => {
  async function setRepos(paths) {
    await dbModule.query('DELETE FROM project_repos WHERE project_id=$1', [PID]);
    for (const [label, p] of paths) {
      await dbModule.query(
        "INSERT INTO project_repos (project_id, label, repo_url, local_path, clone_status) VALUES ($1,$2,'u',$3,'done')",
        [PID, label, p]
      );
    }
  }

  test('容器少掛一個 repo → 回報該 repo 的 label', async () => {
    await setRepos([['main', '/repos/p/main'], ['純水', '/repos/p/repo']]);
    dockerEnv.containerMountSources.mockResolvedValueOnce(['/repos/p/main', '/var/lib/odoo/filestore']);

    expect(await envAgent.addonsMountDrift(PID)).toEqual(['純水']);
  });

  test('全部掛齊 → 無漂移（含尾斜線等路徑寫法差異不得誤判）', async () => {
    await setRepos([['main', '/repos/p/main'], ['純水', '/repos/p/repo']]);
    dockerEnv.containerMountSources.mockResolvedValueOnce(['/repos/p/main/', '/repos/p/repo']);

    expect(await envAgent.addonsMountDrift(PID)).toEqual([]);
  });

  // 有鑑別力的反例：環境還沒建（inspect 不到容器）時一律視為「無從得知」而非「什麼都沒掛」——
  // 後者會讓每個專案的第一次部署都被自己擋下來。
  test('容器不存在（inspect 回 null）→ 不報漂移', async () => {
    await setRepos([['main', '/repos/p/main']]);
    dockerEnv.containerMountSources.mockResolvedValueOnce(null);

    expect(await envAgent.addonsMountDrift(PID)).toEqual([]);
  });
});
