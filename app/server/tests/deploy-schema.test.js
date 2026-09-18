const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-deploy-schema';
process.env.APP_SECRET = 'test-app-secret';

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});

test('project_deploy_targets 建得起來且欄位齊', async () => {
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('p1', '17.0')");
  await dbModule.query(
    `INSERT INTO project_deploy_targets
       (project_id, repo_id, env, conn_id, runtime, compose_dir, compose_service,
        container_name, addons_dir, conf_path, db_name, http_port, modules, branch,
        sudo_mode, enabled)
     VALUES (1, NULL, 'test', 1, 'docker', '/home/arich/DockerData/odoo', 'odoo-tst',
             'odoo-tst-web', '/home/arich/DockerData/odoo/Data/odoo-tst/addons',
             '/etc/odoo/odoo.conf', 'odoo_tst', 8101, ARRAY['idx_hj'], 'ai-dev',
             'password', false)`
  );
  const { rows } = await dbModule.query('SELECT * FROM project_deploy_targets');
  expect(rows).toHaveLength(1);
  expect(rows[0].modules).toEqual(['idx_hj']);
  expect(rows[0].compose_service).toBe('odoo-tst');
  // 意圖：預設關閉。這個功能會動客戶的正式機，漏掉 DEFAULT false 等於新建就自動跑。
  expect(rows[0].enabled).toBe(false);
});

// 意圖（Rule 9）：FK 沒帶 CASCADE 會讓「刪專案」這條路徑整個卡死，而症狀出現在
// 完全無關的地方（刪不掉的專案）。此 repo 已經因為 user_inbox 漏 CASCADE 踩過。
test('刪專案會連帶刪掉 target 與部署紀錄', async () => {
  await dbModule.query(
    `INSERT INTO deploy_runs (target_id, trigger, status, modules)
     VALUES (1, 'manual_prod', 'success', ARRAY['idx_hj'])`
  );
  await dbModule.query('DELETE FROM projects WHERE id = 1');
  const t = await dbModule.query('SELECT * FROM project_deploy_targets');
  const r = await dbModule.query('SELECT * FROM deploy_runs');
  expect(t.rows).toHaveLength(0);
  expect(r.rows).toHaveLength(0);
});

// 意圖：開關是每個專案自己的。預設 false——這個功能會連進客戶正式機下指令，
// 新建專案不該一建好就處於「會自動部署」的狀態。
test('projects 有 auto_deploy_enabled 且預設關閉', async () => {
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('p2', '17.0')");
  const { rows } = await dbModule.query("SELECT auto_deploy_enabled FROM projects WHERE name = 'p2'");
  expect(rows[0].auto_deploy_enabled).toBe(false);
});

// 意圖：全域總開關已退場（使用者裁決只留專案層）。留著一顆沒人讀的開關最危險——
// 有人會去撥它，然後以為自己關掉了什麼。
test('teams_settings 不再有 auto_deploy_enabled', async () => {
  const { rows } = await dbModule.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name='teams_settings' AND column_name='auto_deploy_enabled'"
  );
  expect(rows).toHaveLength(0);
});

// 意圖（Rule 9）：systemd 目標的 odoo 執行檔路徑。NULL＝退回裸名 odoo-bin（既有行為不變），
// 有值才走完整路徑。欄位不存在的話探測抓到了也存不下來，慈雲那台的部署會一直
// `sudo: odoo-bin: command not found`。
test('odoo_bin 欄位存在，預設 NULL', async () => {
  // 上一支測試把 project 1 連同 target 一起刪了，這裡自己建一個專案
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('慈雲', '19.0') RETURNING id"
  );
  await dbModule.query(
    `INSERT INTO project_deploy_targets
       (project_id, env, runtime, service_name, addons_dir, conf_path, db_name, branch)
     VALUES ($1, 'test', 'systemd', 'odoo-test', '/odoo/custom/addons_test',
             '/etc/odoo-test.conf', 'production_test', 'ai-dev')`, [p.id]
  );
  const { rows } = await dbModule.query(
    "SELECT odoo_bin FROM project_deploy_targets WHERE runtime = 'systemd'"
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].odoo_bin).toBeNull();

  await dbModule.query(
    "UPDATE project_deploy_targets SET odoo_bin = '/odoo/odoo-server/odoo-bin' WHERE runtime = 'systemd'"
  );
  const { rows: after } = await dbModule.query(
    "SELECT odoo_bin FROM project_deploy_targets WHERE runtime = 'systemd'"
  );
  expect(after[0].odoo_bin).toBe('/odoo/odoo-server/odoo-bin');
});
