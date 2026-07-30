// 意圖：測試區 seed 這一步寫的是「測試 DB 裡的 E2E 帳號」與「ir.config_parameter('aidev.sso_secret')」，
// 而平台端的 sso_secret／e2e_password 在更早就已經寫進 odoo_envs 了。seed 失敗卻照樣把環境標成
// running，兩邊憑證就永久不一致：SSO 免密登入驗章失敗、E2E 拿一組測試 DB 裡不存在的密碼登入。
// 兩種症狀都完全不指向 seed，而唯一的線索（setup_log 裡那行 [seed] FAIL）沒有任何人會去看。
//
// 本檔跑完整的 _runEnvSetupDocker，故所有外部 IO 都必須夾住：
//   - docker-env 全 mock（唯一放行的是被斷言的 removeContainer 呼叫紀錄）
//   - project-vpn mock（stopEnv 會去 docker stop 真的 vpn 容器）
//   - leasePort mock 成本檔自己開的 listener 埠，ENV_BIND_HOST 固定 127.0.0.1，
//     讓真實的 waitForPort 健康檢查連得上（否則會先卡在健康檢查失敗，測不到 seed）
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
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
jest.mock('../lib/project-vpn', () => ({
  startProjectVpns: jest.fn().mockResolvedValue(''),
  stopProjectVpns: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../pipeline/git', () => ({ ensureTestingBranch: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../port-alloc', () => {
  const actual = jest.requireActual('../port-alloc');
  return { ...actual, leasePort: jest.fn() };
});

let dbModule, envAgent, dockerEnv, portAlloc, tmpBase, listener, leasedPort, prevEnv;
const PID = 3101;

beforeAll(async () => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'seedfail-envbase-'));
  prevEnv = {
    ODOO_ENV_BASE: process.env.ODOO_ENV_BASE,
    ENV_BIND_HOST: process.env.ENV_BIND_HOST,
    ENV_HEALTH_TIMEOUT_MS: process.env.ENV_HEALTH_TIMEOUT_MS,
  };
  process.env.ODOO_ENV_BASE = tmpBase;   // 否則會寫進真實 repo 樹下的 odoo-envs/
  process.env.ENV_BIND_HOST = '127.0.0.1';
  process.env.ENV_HEALTH_TIMEOUT_MS = '2000';

  // 真的開一個 listener 當「容器已在監聽」：健康檢查是真函式（waitForPort），探不到就走不到 seed。
  listener = net.createServer(sock => sock.destroy());
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  leasedPort = listener.address().port;

  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query(
    `INSERT INTO projects (id, name, odoo_version, folder_name) VALUES (${PID}, 'P-seed', '17.0', 'seedx')`
  );
  envAgent = require('../pipeline/env-agent');
  dockerEnv = require('../lib/docker-env');
  portAlloc = require('../port-alloc');
  // 非首次建置：省掉 firstBuild 的 300 秒健康檢查下限（listener 早就活著，只是別讓 deadline 影響語意）
  fs.mkdirSync(path.join(tmpBase, 'seedx'), { recursive: true });
  fs.writeFileSync(path.join(tmpBase, 'seedx', '.docker-ready'), 'x');
}, 30000);

afterAll(async () => {
  dbModule._setPoolForTesting(null);
  await new Promise(r => listener.close(r));
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
  for (const f of Object.values(dockerEnv)) if (jest.isMockFunction(f)) f.mockClear();
  portAlloc.leasePort.mockClear().mockResolvedValue(leasedPort);
  await dbModule.query('DELETE FROM odoo_envs');
});

test('seed 成功 → running（對照組：其餘條件都相同，唯一變數是 seed 的結果）', async () => {
  await envAgent.runEnvSetup(PID);
  const { rows: [env] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=$1', [PID]);
  expect(env.status).toBe('running');
});

test('seed 失敗 → 落 error 且 error_msg 指名 seed，絕不可標 running', async () => {
  // 唯一一次 execOdoo 呼叫就是 seed（升級/卸載走別的入口）
  dockerEnv.execOdoo.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'psycopg2.OperationalError: 連不到 DB' });
  await envAgent.runEnvSetup(PID);
  const { rows: [env] } = await dbModule.query(
    'SELECT status, error_msg, setup_log FROM odoo_envs WHERE project_id=$1', [PID]
  );
  expect(env.status).toBe('error');
  expect(env.error_msg).toContain('seed');
  expect(env.setup_log).toContain('[seed] FAIL');
});

// 意圖：狀態說 error、容器卻還在跑＝閒置回收（只掃 status='running'）永遠不會收它，那個容器
// 與它綁的埠會一直留著。比照健康檢查失敗那條路徑，一併把容器移除。
test('seed 失敗 → 移除容器（不留下 DB 標 error、容器卻還活著的孤兒）', async () => {
  dockerEnv.execOdoo.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'boom' });
  await envAgent.runEnvSetup(PID);
  // 第一次 removeContainer 是啟動前的冪等清理，seed 失敗後必須再有一次
  expect(dockerEnv.removeContainer.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(dockerEnv.removeContainer).toHaveBeenLastCalledWith('odoo-test-seedx');
});
