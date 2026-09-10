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

// ── 多資料庫共用一次停機（runDeployGroup）

// 第二個目標：同一台機、同一個容器、同一個 addons 目錄，只有資料庫不同。
// 這就是鴻久那台的形狀（odoo_prd 與 odoo_dev 都掛在 odoo-prd 底下）。
beforeAll(async () => {
  await dbModule.query(
    `INSERT INTO project_deploy_targets
      (project_id, env, conn_id, runtime, compose_dir, compose_service, container_name,
       addons_dir, conf_path, db_name, http_port, modules, branch, sudo_mode, enabled)
     VALUES (1,'test',1,'docker','/home/arich/DockerData/odoo','odoo-tst','odoo-tst-web',
             '/home/arich/DockerData/odoo/Data/odoo-tst/addons','/etc/odoo/odoo.conf',
             'odoo_dev',8101,ARRAY['idx_hj','idx_scan'],'ai-dev','password',true)`
  );
});

function multiDeps({ codes = { odoo_tst: 0, odoo_dev: 0 }, health = 'OK' } = {}) {
  const calls = [];
  return {
    calls,
    git: {
      headSha: async () => 'newsha',
      changedPaths: async () => ['idx_hj/views/x.xml'],
      archive: async () => Buffer.from('tar-bytes'),
    },
    uploads: [],
    upload: async () => {},
    exec: async (conn, cmd) => {
      calls.push(cmd);
      if (cmd.includes('--stop-after-init')) {
        // 照 buildUpgradeCmdMulti 的形狀回：每個 DB 一段 marker + 自己的 EXITCODE
        const out = Object.entries(codes)
          .map(([db, rc]) => `### DB ${db}\nLoading modules...\nEXITCODE=${rc}`).join('\n');
        return { stdout: out + '\n', stderr: '', code: 0 };
      }
      if (cmd.includes('/web/login')) return { stdout: health === 'OK' ? 'HEALTH_OK' : 'HEALTH_FAIL', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
  };
}

const resetBoth = (v) => dbModule.query('UPDATE project_deploy_targets SET last_deployed_sha = $1', [v]);

// 意圖（Rule 9）：兩個資料庫共用一次停機。若退化成一個目標停一次，客戶會被斷線兩次，
// 而且兩次之間服務是活的——使用者這時進得來，用到的是只升了一半的狀態。
test('兩個資料庫共用一次停機：檔案只送一次，升級指令只下一次', async () => {
  await resetBoth(null);
  const { runDeployGroup } = require('../lib/deploy-run');
  const d = multiDeps();
  const rs = await runDeployGroup([1, 2], { trigger: 'manual_prod', userId: 1 }, d);

  expect(rs).toHaveLength(2);
  expect(rs.every(r => r.ok)).toBe(true);
  // swap（解檔替換）只做一次——兩個目標共用同一個 addons 目錄
  expect(d.calls.filter(c => c.includes('.deploy-staging')).length).toBe(1);
  // 升級整串只下一次，裡面兩個 DB
  const upg = d.calls.filter(c => c.includes('--stop-after-init'));
  expect(upg).toHaveLength(1);
  expect(upg[0]).toMatch(/-d odoo_tst /);
  expect(upg[0]).toMatch(/-d odoo_dev /);
  expect((upg[0].match(/docker compose stop/g) || [])).toHaveLength(1);
  // 兩個目標的 sha 都要更新
  const { rows } = await dbModule.query('SELECT last_deployed_sha FROM project_deploy_targets ORDER BY id');
  expect(rows.map(r => r.last_deployed_sha)).toEqual(['newsha', 'newsha']);
});

// 意圖（Rule 9）：只有其中一個 DB 升級失敗時，檔案是共用的一份，另一個 DB 不能留在新碼上——
// 那會變成「DB 是舊的、檔案是新的」，Odoo 直接壞。整組一起回滾才對。
test('其中一個資料庫升級失敗時整組回滾，兩個目標都不更新 sha', async () => {
  await resetBoth(null);
  const { runDeployGroup } = require('../lib/deploy-run');
  const d = multiDeps({ codes: { odoo_tst: 0, odoo_dev: 1 } });
  const rs = await runDeployGroup([1, 2], { trigger: 'manual_prod', userId: 1 }, d);

  expect(rs.every(r => !r.ok)).toBe(true);
  expect(rs[0].status).toBe('rolled_back');
  expect(rs[1].status).toBe('rolled_back');
  // 錯誤訊息要指出是哪一個資料庫，否則兩個 DB 的部署失敗長得一模一樣
  expect(rs[0].error).toMatch(/odoo_dev/);
  expect(rs[0].error).not.toMatch(/odoo_tst（/);
  const { rows } = await dbModule.query('SELECT last_deployed_sha FROM project_deploy_targets ORDER BY id');
  expect(rows.map(r => r.last_deployed_sha)).toEqual([null, null]);
});

// 意圖：讀不到某個 DB 的 exit code（指令被截斷、DB 根本沒跑到）一律當失敗。
// 漏讀當成功的話，客戶那台就是靜靜地沒升級，而畫面回報綠燈。
test('某個資料庫讀不到 exit code 時當失敗處理', async () => {
  await resetBoth(null);
  const { runDeployGroup } = require('../lib/deploy-run');
  const d = multiDeps({ codes: { odoo_tst: 0 } });   // odoo_dev 那段完全沒出現
  const rs = await runDeployGroup([1, 2], { trigger: 'manual_prod', userId: 1 }, d);
  expect(rs.every(r => !r.ok)).toBe(true);
  expect(rs[0].error).toMatch(/odoo_dev（EXITCODE=讀不到）/);
});

// 意圖：單一目標走 runDeployGroup 的單元素路徑，指令必須跟過去一模一樣（不帶 ### DB marker）。
// 這條守的是「重構沒有改到既有行為」。
test('單一目標仍走原本的單 DB 指令，不帶多 DB 的段落標記', async () => {
  await resetBoth(null);
  const { runDeployGroup } = require('../lib/deploy-run');
  const d = deps();
  const rs = await runDeployGroup([1], { trigger: 'manual_retry', userId: 1 }, d);
  expect(rs).toHaveLength(1);
  expect(rs[0].ok).toBe(true);
  const upg = d.calls.filter(c => c.includes('--stop-after-init'));
  expect(upg).toHaveLength(1);
  expect(upg[0]).not.toMatch(/### DB/);
});

// 意圖：組裡有目標這次沒有模組要動時，它算成功且不進聯集，但另一個仍要照常部署。
test('組裡某個目標沒有模組變更時略過它，其餘照常部署', async () => {
  await resetBoth('oldsha');
  await dbModule.query("UPDATE project_deploy_targets SET modules = ARRAY['idx_scan'] WHERE id = 2");
  const { runDeployGroup } = require('../lib/deploy-run');
  // changedPaths 只回 idx_hj，所以 id=2（只管 idx_scan）這次沒事做
  const d = multiDeps();
  const rs = await runDeployGroup([1, 2], { trigger: 'manual_prod', userId: 1 }, d);
  expect(rs[0].ok).toBe(true);
  expect(rs[0].modules).toEqual(['idx_hj']);
  expect(rs[1].ok).toBe(true);
  expect(rs[1].modules).toEqual([]);
  // 升級指令裡只有還有事做的那個 DB
  const upg = d.calls.filter(c => c.includes('--stop-after-init'))[0];
  expect(upg).toMatch(/-d odoo_tst /);
  expect(upg).not.toMatch(/-d odoo_dev /);
  await dbModule.query("UPDATE project_deploy_targets SET modules = ARRAY['idx_hj','idx_scan'] WHERE id = 2");
});

// 意圖（Rule 9）：換檔那段是 set -e，非 0 就代表模組可能已經被搬進備份卻沒補回。
// 而下游的 odoo -u 對「找不到的模組」只印警告就 exit 0，健康檢查也照樣過——
// 不在這裡擋住，結果會是「部署回報成功、模組從客戶正式機消失、last_deployed_sha 還被推進」，
// 於是那個模組永遠不會再被送上去，而且沒有任何徵狀。
test('換檔失敗就停住：不進行升級、走回滾、last_deployed_sha 不動', async () => {
  await resetSha('oldsha');
  const calls = [];
  const d = {
    git: {
      headSha: async () => 'newsha',
      changedPaths: async () => ['idx_hj/models/x.py'],
      archive: async () => Buffer.from('tar-bytes'),
    },
    upload: async () => {},
    exec: async (conn, cmd) => {
      calls.push(cmd);
      // 換檔是唯一會提到 .deploy-staging 的指令；回滾只碰 .deploy-bak-
      if (cmd.includes('.deploy-staging')) return { stdout: '', stderr: 'tar: 寫入失敗：裝置空間不足', code: 2 };
      return { stdout: '', stderr: '', code: 0 };
    },
  };
  const r = await runDeploy(1, { trigger: 'manual_retry', userId: 1 }, d);
  expect(r.ok).toBe(false);
  expect(r.status).toBe('rolled_back');
  // 最關鍵的一條：升級指令根本不該被送出去
  expect(calls.some(c => c.includes('--stop-after-init'))).toBe(false);
  const { rows } = await dbModule.query('SELECT last_deployed_sha FROM project_deploy_targets WHERE id = 1');
  expect(rows[0].last_deployed_sha).toBe('oldsha');
});
