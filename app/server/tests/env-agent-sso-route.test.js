// 意圖：測試區「建起來了但點進去 Not Found」這個靜默失效不得再放行成 running。
//
// 真實案發（鴻久 2026-07-30）：容器 CMD 帶 `-i idx_aidev_sso`，但 Odoo 啟動時要載入 DB 裡
// 已安裝的專案模組，而那些模組宣告的 Python 相依是 installModuleRequirements 事後才用
// docker exec pip 裝進「容器可寫層」的——容器一被 rm（夜間關機／閒置回收）就全部消失。
// 於是重建時（firstBuild=false）常駐進程啟動 → ModuleNotFoundError → Failed to load registry
// → idx_aidev_sso 的安裝 transaction 整個 rollback → /aidev/sso 回 404。
//
// 而每一層都回報成功：run OK、pip OK、seed OK、健檢（只探埠）過 → status=running。
// 使用者只在點下「開啟測試區」的那一刻看到 Not Found，畫面上沒有任何線索。
// 這正是 :610-614 已經為 seed 失敗立下的規矩（不得無聲放行）從 registry 這條路繞回來。
//
// 判定用「探 /aidev/sso 是否 404」而非查 ir_module_module：404 是使用者實際遇到的症狀本身，
// 且不依賴 Odoo 內部訊息格式。注意不能只認 403——controller 在 secret 未設時回 503
// （main.py:48-49），任何非 404 都代表 controller 已載入。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');

jest.mock('../lib/docker-env', () => {
  const actual = jest.requireActual('../lib/docker-env');
  return {
    ...actual,
    ensureDockerRunning: jest.fn().mockResolvedValue(undefined),
    ensureImage: jest.fn().mockResolvedValue({ ok: true, log: '[image] ok\n' }),
    runContainer: jest.fn().mockResolvedValue({ ok: true, log: 'cid\n' }),
    restartContainer: jest.fn().mockResolvedValue({ code: 0 }),
    removeContainer: jest.fn().mockResolvedValue(undefined),
    stopContainer: jest.fn().mockResolvedValue({ code: 0 }),
    containerRunning: jest.fn().mockResolvedValue(true),
    containerExists: jest.fn().mockResolvedValue(true),
    containerLogs: jest.fn().mockResolvedValue("ModuleNotFoundError: No module named 'docxtpl'\nFailed to load registry\n"),
    execOdoo: jest.fn().mockResolvedValue({ code: 0, stdout: 'SEED_DONE 1', stderr: '' }),
    execPipInstall: jest.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' }),
  };
});
jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));
jest.mock('../pipeline/git', () => ({ ensureTestingBranch: jest.fn().mockResolvedValue(undefined) }));
// runEnvSetup 尾巴會 startProjectVpns；不 mock 會對本機 docker 發真指令（實測會砍掉真容器）。
jest.mock('../lib/project-vpn', () => ({
  startProjectVpns: jest.fn().mockResolvedValue(''),
  stopProjectVpns: jest.fn().mockResolvedValue(undefined),
}));

let dbModule, envAgent, dockerEnv, portAlloc, srv, envBase;
const PID = 4101;
// 預先寫進 odoo_envs.port ＝ 沿用既有租約（env-agent.js:528），完全繞開 leasePort／isPortFree，
// 讓本檔不受本機 21000-21019 佔用狀況影響。
const PORT = 24501;
let HOST;
// 假 Odoo 對 /aidev/sso 回的狀態碼；404 ＝ 模組沒裝成功。
let ssoStatus = 404;

beforeAll(async () => {
  envBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-envbase-'));
  process.env.ODOO_ENV_BASE = envBase;

  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query("INSERT INTO teams_settings (id, env_mode) VALUES (1, 'docker')");
  await dbModule.query(
    `INSERT INTO projects (id, name, odoo_version, folder_name) VALUES (${PID}, 'P-sso', '17.0', 'ssox')`
  );
  await dbModule.query(
    `INSERT INTO odoo_envs (project_id, status, port, updated_at) VALUES (${PID}, 'idle', ${PORT}, NOW())`
  );

  envAgent = require('../pipeline/env-agent');
  dockerEnv = require('../lib/docker-env');
  portAlloc = require('../port-alloc');
  HOST = portAlloc.envBindHost(PORT);

  // 假 Odoo：健檢探得到埠（症狀的關鍵——埠通不代表模組裝好），/aidev/sso 的回應由 ssoStatus 控制。
  srv = http.createServer((req, res) => {
    const code = req.url.startsWith('/aidev/sso') ? ssoStatus : 200;
    res.writeHead(code, { 'Content-Type': 'text/plain' });
    res.end('x');
  });
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(PORT, HOST, resolve);
  });
}, 30000);

afterAll(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  dbModule._setPoolForTesting(null);
  try { fs.rmSync(envBase, { recursive: true, force: true }); } catch {}
  delete process.env.ODOO_ENV_BASE;
});

beforeEach(async () => {
  for (const f of Object.values(dockerEnv)) if (jest.isMockFunction(f)) f.mockClear();
  ssoStatus = 404;
  // 重建情境（firstBuild=false）：容器沒了但宿主的 .docker-ready 還在，DB 裡專案模組仍是已安裝。
  // 這是本 bug 唯一的觸發路徑——首次建（空 DB）不會 import 專案模組，registry 不會掛。
  const envDir = path.join(envBase, 'ssox');
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, '.docker-ready'), 'x');
  await dbModule.query(
    "UPDATE odoo_envs SET status='idle', error_msg=NULL, setup_log=NULL, port=$2 WHERE project_id=$1",
    [PID, PORT]
  );
});

test('SSO route 一直是 404（相依仍缺）→ 落 error，不得放行成 running，且真因要進得了畫面', async () => {
  await envAgent.runEnvSetup(PID);

  const { rows: [env] } = await dbModule.query(
    'SELECT status, error_msg, setup_log FROM odoo_envs WHERE project_id=$1', [PID]
  );
  // 現況（未修）會是 'running'：健檢只探埠、SSO 從沒被驗證過。
  expect(env.status).toBe('error');
  expect(env.error_msg).toMatch(/idx_aidev_sso/);
  // 光落 error 不夠——setup_log 要帶得出「為什麼」，否則使用者只換一個看不懂的紅字。
  // 容器 log 裡的 ModuleNotFoundError 才是可行動的線索。
  expect(env.setup_log).toMatch(/docxtpl|ModuleNotFoundError|registry/i);
});

test('restart 後 SSO route 活了 → 自我修復放行成 running', async () => {
  // pip 已把相依補進容器，restart 讓常駐進程重跑 CMD 的 -i 並 import controllers。
  dockerEnv.restartContainer.mockImplementation(async () => { ssoStatus = 403; return { code: 0 }; });

  await envAgent.runEnvSetup(PID);

  expect(dockerEnv.restartContainer).toHaveBeenCalledWith(expect.stringContaining('odoo-test-ssox'));
  const { rows: [env] } = await dbModule.query(
    'SELECT status, error_msg FROM odoo_envs WHERE project_id=$1', [PID]
  );
  expect(env.status).toBe('running');
  expect(env.error_msg).toBeNull();
});

// 鑑別力：這支擋的是「無條件 restart」的偷懶實作。健康的環境（含所有首次建置）不該白付
// 一次 Odoo 冷啟——Linux 上天天夜間關機，每天早上第一次開測試區都會多等一輪。
test('SSO route 本來就正常（403）→ 不得多做一次 restart', async () => {
  ssoStatus = 403;

  await envAgent.runEnvSetup(PID);

  expect(dockerEnv.restartContainer).not.toHaveBeenCalled();
  const { rows: [env] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=$1', [PID]);
  expect(env.status).toBe('running');
});

// 判定不能只認 403：seed 之前／secret 沒寫成功時 controller 回 503（main.py:48-49），
// 那代表 controller 已經載入了，硬要 restart 是白做工且會掩蓋真正的 secret 問題。
test('503（controller 已載入但 secret 未設）不算 404，不得觸發 restart', async () => {
  ssoStatus = 503;

  await envAgent.runEnvSetup(PID);

  expect(dockerEnv.restartContainer).not.toHaveBeenCalled();
});
