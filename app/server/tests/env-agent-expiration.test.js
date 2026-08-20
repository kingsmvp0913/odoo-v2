// 意圖：企業版測試區的 database.expiration_date 若沿用 Odoo 建 DB 時的預設（一個月後的試用期），
// 每個環境每個月都會到期一次，後台開始擋操作、要人工進 ir.config_parameter 改一次——而那件事
// 既不緊急也不會有人記得，只會在有人要用測試區的當下才發現。故建置的 seed 這一步一律把到期日
// 推到 50 年後。三件事在此鎖死：
//   ①企業版真的有傳（且值是 Odoo 認得的 datetime 格式、確實在數十年後）
//   ②社群版不傳（社群版沒有到期鎖，寫了只是憑空多一個沒人看得懂的參數）
//   ③到期日算得出來（純函式，不必跑整個建置流程）
// 本檔跑完整的 _runEnvSetupDocker，故所有外部 IO 都必須夾住（同 env-agent-seed-fail.test.js 的作法）：
// docker-env 全 mock、project-vpn mock、leasePort 指向本檔自己開的 listener 埠讓真實健康檢查連得上，
// 模組就緒閘以 _setModuleReadyCheckForTesting 固定放行（否則會真的去連 test_<folder> 那個 DB）。
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
    execOdoo: jest.fn().mockResolvedValue({ code: 0, stdout: 'SEED_DONE 1', stderr: '' }),
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

let dbModule, envAgent, dockerEnv, portAlloc, tmpBase, entBase, entDir, listener, leasedPort, prevEnv;
const PID = 3401;

beforeAll(async () => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'expdate-envbase-'));
  entBase = fs.mkdtempSync(path.join(os.tmpdir(), 'expdate-srcbase-'));
  prevEnv = {
    ODOO_ENV_BASE: process.env.ODOO_ENV_BASE,
    ENTERPRISE_BASE_DIR: process.env.ENTERPRISE_BASE_DIR,
    ENV_BIND_HOST: process.env.ENV_BIND_HOST,
    ENV_HEALTH_TIMEOUT_MS: process.env.ENV_HEALTH_TIMEOUT_MS,
  };
  process.env.ODOO_ENV_BASE = tmpBase;   // 否則會寫進真實 repo 樹下的 odoo-envs/
  process.env.ENTERPRISE_BASE_DIR = entBase;
  process.env.ENV_BIND_HOST = '127.0.0.1';
  process.env.ENV_HEALTH_TIMEOUT_MS = '2000';
  entDir = path.join(entBase, '17');
  fs.mkdirSync(entDir, { recursive: true });

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
    `INSERT INTO projects (id, name, odoo_version, folder_name) VALUES (${PID}, 'P-exp', '17.0', 'expx')`
  );
  await dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url, local_path, clone_status) VALUES ('17','https://x/e.git',$1,'done')",
    [entDir]
  );
  envAgent = require('../pipeline/env-agent');
  dockerEnv = require('../lib/docker-env');
  portAlloc = require('../port-alloc');
  // 模組就緒閘固定放行：真函式會另開連線去查 test_expx 那個 DB（本機不存在），逾時後會在 seed 前中止。
  envAgent._setModuleReadyCheckForTesting(async () => true);
  // 非首次建置：省掉 firstBuild 的 300 秒健康檢查下限
  fs.mkdirSync(path.join(tmpBase, 'expx'), { recursive: true });
  fs.writeFileSync(path.join(tmpBase, 'expx', '.docker-ready'), 'x');
}, 30000);

afterAll(async () => {
  envAgent._setModuleReadyCheckForTesting(null);
  dbModule._setPoolForTesting(null);
  await new Promise(r => listener.close(r));
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(entBase, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
  for (const f of Object.values(dockerEnv)) if (jest.isMockFunction(f)) f.mockClear();
  portAlloc.leasePort.mockClear().mockResolvedValue(leasedPort);
  await dbModule.query('DELETE FROM odoo_envs');
});

// seed 是本流程唯一一次 execOdoo（升級／卸載走別的入口），故直接取第一次呼叫。
const seedEnv = () => dockerEnv.execOdoo.mock.calls[0][0].env;

test('企業版：seed 帶入 database.expiration_date 的值，且落在數十年後', async () => {
  await dbModule.query("UPDATE projects SET edition='enterprise' WHERE id=$1", [PID]);
  await envAgent.runEnvSetup(PID);
  const { rows: [env] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=$1', [PID]);
  expect(env.status).toBe('running');

  const passed = seedEnv().AIDEV_EXPIRATION_DATE;
  // 格式必須是 Odoo 的 DEFAULT_SERVER_DATETIME_FORMAT，否則寫得進去但前後端都解析不了到期日
  expect(passed).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // 「有傳一個日期」不夠——傳成明年也會通過上面那條。真正要保證的是使用者不會再被討工。
  const years = (new Date(passed.replace(' ', 'T')) - Date.now()) / (365.25 * 24 * 3600 * 1000);
  expect(years).toBeGreaterThan(45);
});

test('社群版：不傳到期日（社群版沒有到期鎖，不該憑空多一個參數）', async () => {
  await dbModule.query("UPDATE projects SET edition='community' WHERE id=$1", [PID]);
  await envAgent.runEnvSetup(PID);
  const { rows: [env] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=$1', [PID]);
  expect(env.status).toBe('running');
  expect(seedEnv()).not.toHaveProperty('AIDEV_EXPIRATION_DATE');
  // 對照：同一次呼叫裡本來就有的東西仍在，確保上面那條不是因為根本沒跑到 seed 而通過
  expect(seedEnv()).toHaveProperty('AIDEV_SSO_SECRET');
});

test('到期日是「現在起算」的 50 年後，不是寫死的年份（純函式）', () => {
  expect(envAgent.enterpriseExpirationDate(new Date('2026-08-20T13:45:07'))).toBe('2076-08-20 13:45:07');
});
