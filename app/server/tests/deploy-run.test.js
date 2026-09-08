const { newDb } = require('pg-mem');

jest.mock('../lib/vpn-gateway', () => ({ ensureGatewayRunning: jest.fn().mockResolvedValue({}) }));
jest.mock('../lib/db-connections', () => ({
  loadDecryptedConn: jest.fn().mockResolvedValue({
    id: 1, ssh_host: 'h', ssh_user: 'u', ssh_password: 'pw', vpn_enabled: false, db_name: 'odoo_tst',
  }),
}));

process.env.JWT_SECRET = 'test-deploy-run';
process.env.APP_SECRET = 'test-app-secret';

let dbModule, runDeploy, readExitCode;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('p', '17.0')");
  await dbModule.query(
    `INSERT INTO project_deploy_targets
      (project_id, env, conn_id, runtime, compose_dir, compose_service, container_name,
       addons_dir, conf_path, db_name, http_port, modules, branch, sudo_mode, enabled)
     VALUES (1,'test',1,'docker','/home/arich/DockerData/odoo','odoo-tst','odoo-tst-web',
             '/home/arich/DockerData/odoo/Data/odoo-tst/addons','/etc/odoo/odoo.conf',
             'odoo_tst',8101,ARRAY['idx_hj','idx_scan'],'ai-dev','password',true)`
  );
  ({ runDeploy, readExitCode } = require('../lib/deploy-run'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

function deps({ upgradeExit = 0, health = 'OK', changed = ['idx_hj/views/x.xml'] } = {}) {
  const calls = [];
  return {
    calls,
    git: {
      headSha: async () => 'newsha',
      changedPaths: async () => changed,
      archive: async () => Buffer.from('tar-bytes'),
    },
    upload: async () => {},
    exec: async (conn, cmd) => {
      calls.push(cmd);
      if (cmd.includes('--stop-after-init')) return { stdout: `Loading modules...\nEXITCODE=${upgradeExit}\n`, stderr: '', code: 0 };
      if (cmd.includes('/web/login')) return { stdout: health === 'OK' ? 'HEALTH_OK' : 'HEALTH_FAIL', stderr: '', code: health === 'OK' ? 0 : 1 };
      return { stdout: '', stderr: '', code: 0 };
    },
  };
}

const resetSha = (v) => dbModule.query('UPDATE project_deploy_targets SET last_deployed_sha = $1 WHERE id = 1', [v]);

// 意圖（Rule 9）：odoo -u 失敗時仍會印一堆看似正常的啟動訊息，而 ssh 那層的 exit code
// 是整串指令的碼、不是 odoo 的。只能認我們自己 echo 進 log 的那個值。
test('readExitCode 取最後一個 EXITCODE 行', () => {
  expect(readExitCode('a\nEXITCODE=0\n')).toBe(0);
  expect(readExitCode('EXITCODE=0\nnoise\nEXITCODE=1\n')).toBe(1);
  expect(readExitCode('沒有這行')).toBeNull();
});

test('成功時更新 last_deployed_sha 並寫 success', async () => {
  await resetSha(null);
  const d = deps();
  const r = await runDeploy(1, { trigger: 'manual_retry', userId: 1 }, d);
  expect(r.ok).toBe(true);
  // 第一次部署（沒有 last sha）＝全部模組
  expect(r.modules).toEqual(['idx_hj', 'idx_scan']);
  const { rows } = await dbModule.query('SELECT last_deployed_sha FROM project_deploy_targets WHERE id = 1');
  expect(rows[0].last_deployed_sha).toBe('newsha');
});

test('有 last sha 時只部署這次 diff 碰到的模組', async () => {
  await resetSha('oldsha');
  const d = deps();
  const r = await runDeploy(1, { trigger: 'manual_retry', userId: 1 }, d);
  expect(r.modules).toEqual(['idx_hj']);
});

test('升級 EXITCODE 非 0 判定失敗並回滾，且不推進 sha', async () => {
  await resetSha('oldsha');
  const d = deps({ upgradeExit: 1 });
  const r = await runDeploy(1, { trigger: 'manual_retry', userId: 1 }, d);
  expect(r.ok).toBe(false);
  expect(r.status).toBe('rolled_back');
  expect(d.calls.some(c => c.includes('.deploy-bak-'))).toBe(true);
  // 意圖：推進了 sha 下次就再也不會補上這批改動，而畫面看起來一切正常
  const { rows } = await dbModule.query('SELECT last_deployed_sha FROM project_deploy_targets WHERE id = 1');
  expect(rows[0].last_deployed_sha).toBe('oldsha');
});

test('健康檢查失敗也回滾', async () => {
  await resetSha('oldsha');
  const d = deps({ health: 'FAIL' });
  const r = await runDeploy(1, { trigger: 'manual_retry', userId: 1 }, d);
  expect(r.status).toBe('rolled_back');
  expect(d.calls.some(c => c.includes('.deploy-bak-'))).toBe(true);
});

// 意圖：那不是失敗，別讓它變紅燈；而且完全不必連遠端。
test('沒有模組要部署時整趟跳過，不連遠端', async () => {
  await resetSha('oldsha');
  const d = deps({ changed: ['README.md'] });
  const r = await runDeploy(1, { trigger: 'manual_retry', userId: 1 }, d);
  expect(r.ok).toBe(true);
  expect(r.modules).toEqual([]);
  expect(d.calls).toHaveLength(0);
});

// 意圖：客戶 conf 內是明碼密碼，Odoo 啟動時會印出來。存進 deploy_runs.log 就外洩了。
test('寫進 deploy_runs 的 log 已遮罩', async () => {
  await resetSha(null);
  const d = deps();
  d.exec = async (conn, cmd) => {
    if (cmd.includes('--stop-after-init')) return { stdout: 'db_password = short1\nEXITCODE=0\n', stderr: '', code: 0 };
    if (cmd.includes('/web/login')) return { stdout: 'HEALTH_OK', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  await runDeploy(1, { trigger: 'manual_retry', userId: 1 }, d);
  const { rows } = await dbModule.query('SELECT log FROM deploy_runs ORDER BY id DESC LIMIT 1');
  expect(rows[0].log).not.toContain('short1');
  expect(rows[0].log).toContain('***');
});

test('每一趟都留一筆 deploy_runs，記得 trigger 與 from/to', async () => {
  await resetSha('oldsha');
  await runDeploy(1, { trigger: 'auto_test', taskId: 42, userId: null }, deps());
  const { rows } = await dbModule.query('SELECT * FROM deploy_runs ORDER BY id DESC LIMIT 1');
  expect(rows[0].trigger).toBe('auto_test');
  expect(rows[0].task_id).toBe(42);
  expect(rows[0].from_sha).toBe('oldsha');
  expect(rows[0].to_sha).toBe('newsha');
  expect(rows[0].finished_at).not.toBeNull();
});

test('找不到目標時回 ok:false，不 throw', async () => {
  const r = await runDeploy(999, { trigger: 'manual_retry', userId: 1 }, deps());
  expect(r.ok).toBe(false);
});
