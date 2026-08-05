// 意圖：waitForPort 只探 TCP，但 Odoo 綁 http port 早於 preload_registries 跑完 -i 安裝。seed 是獨立
// odoo shell、從 DB 重載 registry，base 沒裝完就會 env['res.users'] KeyError，隨後移除容器又中止安裝
// （DB 只剩 orm_signaling_* 表）。純 base 專案沒有 pip 相依的耗時當緩衝故必中。本檔鎖住兩件事：
//   1) waitForModulesInstalled 的輪詢語意（就緒/續等/逾時/fail-open）。
//   2) 就緒閘擋下時，必須在 seed 之前中止（不呼叫 execOdoo）、落 error、且不寫 .docker-ready（讓下次仍
//      以 firstBuild 重跑 -i base 自癒）。
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
    restartContainer: jest.fn().mockResolvedValue(undefined),
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

// —— waitForModulesInstalled 純輪詢邏輯（注入假 client，不連真 DB） ——
describe('waitForModulesInstalled', () => {
  const envAgent = require('../pipeline/env-agent');
  let prevUrl;
  beforeEach(() => { prevUrl = process.env.DATABASE_URL; process.env.DATABASE_URL = 'postgres://x:y@localhost:5432/aidev'; });
  afterEach(() => { if (prevUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevUrl; });

  // 假 client：依 script 逐次回應。數字＝該次查到的 installed 筆數；Error 實例＝模擬 42P01（表尚未建）。
  function factory(script) {
    let i = 0;
    return { createClient: () => ({
      connect: async () => {},
      query: async () => {
        const step = script[Math.min(i, script.length - 1)]; i++;
        if (step instanceof Error) throw step;
        return { rows: [{ n: step }] };
      },
      end: async () => {},
    }), calls: () => i };
  }

  test('模組全部 installed → 立即回 true', async () => {
    const f = factory([2]);
    const ok = await envAgent.waitForModulesInstalled(
      { dbName: 'test_x', modules: ['base', 'idx_aidev_sso'], intervalMs: 1 }, { createClient: f.createClient });
    expect(ok).toBe(true);
    expect(f.calls()).toBe(1);
  });

  test('表尚未建(42P01)/半裝 → 續等，裝好後回 true', async () => {
    const f = factory([new Error('relation "ir_module_module" does not exist'), 1, 2]);
    const ok = await envAgent.waitForModulesInstalled(
      { dbName: 'test_x', modules: ['base', 'idx_aidev_sso'], intervalMs: 1 }, { createClient: f.createClient });
    expect(ok).toBe(true);
    expect(f.calls()).toBe(3); // 撐過「表沒建」與「只裝 1 個」兩輪才就緒
  });

  test('期限內始終未裝好 → 回 false（不會誤放行去 seed）', async () => {
    const f = factory([0]); // 永遠 0 筆 installed
    const ok = await envAgent.waitForModulesInstalled(
      { dbName: 'test_x', modules: ['base', 'idx_aidev_sso'], timeoutMs: 30, intervalMs: 10 }, { createClient: f.createClient });
    expect(ok).toBe(false);
  });

  test('DATABASE_URL 未設 → fail-open 回 true 且不建連線', async () => {
    delete process.env.DATABASE_URL;
    let created = false;
    const ok = await envAgent.waitForModulesInstalled(
      { dbName: 'test_x', modules: ['base'] }, { createClient: () => { created = true; return {}; } });
    expect(ok).toBe(true);
    expect(created).toBe(false);
  });
});

// —— 就緒閘擋下時的建置流程 wiring ——
describe('就緒閘擋下 → seed 前中止', () => {
  const PID = 3131;
  let dbModule, envAgent, dockerEnv, portAlloc, tmpBase, listener, leasedPort, prevEnv;

  beforeAll(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'regready-envbase-'));
    prevEnv = {
      ODOO_ENV_BASE: process.env.ODOO_ENV_BASE,
      ENV_BIND_HOST: process.env.ENV_BIND_HOST,
      ENV_HEALTH_TIMEOUT_MS: process.env.ENV_HEALTH_TIMEOUT_MS,
    };
    process.env.ODOO_ENV_BASE = tmpBase;
    process.env.ENV_BIND_HOST = '127.0.0.1';
    process.env.ENV_HEALTH_TIMEOUT_MS = '2000';

    listener = net.createServer(sock => sock.destroy());
    await new Promise(r => listener.listen(0, '127.0.0.1', r));
    leasedPort = listener.address().port;

    const db = newDb();
    const { Pool } = db.adapters.createPg();
    dbModule = require('../db');
    dbModule._setPoolForTesting(new Pool());
    await dbModule.migrate();
    await dbModule.query(
      `INSERT INTO projects (id, name, odoo_version, folder_name) VALUES (${PID}, 'P-reg', '17.0', 'regx')`
    );
    envAgent = require('../pipeline/env-agent');
    dockerEnv = require('../lib/docker-env');
    portAlloc = require('../port-alloc');
  }, 30000);

  afterAll(async () => {
    envAgent._setModuleReadyCheckForTesting(null);
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
    envAgent._setModuleReadyCheckForTesting(null);
  });

  test('就緒閘回 false → 落 error（指名模組未就緒）、不呼叫 seed(execOdoo)', async () => {
    envAgent._setModuleReadyCheckForTesting(async () => false);
    await envAgent.runEnvSetup(PID);
    const { rows: [env] } = await dbModule.query(
      'SELECT status, error_msg FROM odoo_envs WHERE project_id=$1', [PID]);
    expect(env.status).toBe('error');
    expect(env.error_msg).toContain('模組安裝未完成');
    // seed 走 execOdoo；被擋在 seed 前就不該有任何 execOdoo 呼叫
    expect(dockerEnv.execOdoo).not.toHaveBeenCalled();
    // 移除容器（避免孤兒），且不寫 .docker-ready（讓下次仍 firstBuild 重跑 -i base 自癒）
    expect(dockerEnv.removeContainer).toHaveBeenLastCalledWith('odoo-test-regx');
    expect(fs.existsSync(path.join(tmpBase, 'regx', '.docker-ready'))).toBe(false);
  });

  test('就緒閘回 true → 放行到 seed，正常收 running（對照組）', async () => {
    envAgent._setModuleReadyCheckForTesting(async () => true);
    await envAgent.runEnvSetup(PID);
    const { rows: [env] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=$1', [PID]);
    expect(env.status).toBe('running');
    expect(dockerEnv.execOdoo).toHaveBeenCalled(); // seed 有跑
  });

  // restartEnv：deploy 升級後靠它讓常駐 server 重新 import controllers（見 deploy-testing.js 註解）
  test('restartEnv：容器運行 → restart 容器並等埠就緒', async () => {
    await dbModule.query("INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,'running',$2)", [PID, leasedPort]);
    const r = await envAgent.restartEnv(PID);
    expect(r.ok).toBe(true);
    expect(dockerEnv.restartContainer).toHaveBeenCalledWith('odoo-test-regx');
  });

  test('restartEnv：容器未運行 → 跳過、不 restart（無常駐 server 可重啟）', async () => {
    dockerEnv.containerRunning.mockResolvedValueOnce(false);
    await dbModule.query("INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,'running',$2)", [PID, leasedPort]);
    const r = await envAgent.restartEnv(PID);
    expect(r.skipped).toBe('not_running');
    expect(dockerEnv.restartContainer).not.toHaveBeenCalled();
  });
});
