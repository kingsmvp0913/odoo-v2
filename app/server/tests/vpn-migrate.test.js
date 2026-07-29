// 意圖：遷移必須「只搬一次、搬對那一條、重跑不破壞」。
// 這三件事出錯的後果分別是：憑證被覆蓋成錯的、搬到廢帳號、每次開機亂改埠。
process.env.APP_SECRET = 'test-secret';
const { newDb } = require('pg-mem');
const { migrateVpnToProjects } = require('../lib/vpn-migrate');

let dbModule;

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});
afterEach(() => dbModule._setPoolForTesting(null));

async function seedProject(name = 'P') {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name,odoo_version) VALUES ($1,'17.0') RETURNING id", [name]
  );
  return p.id;
}

async function seedConn(projectId, over = {}) {
  const c = {
    name: `c${Math.random()}`, connect_mode: 'docker', ssh_host: '192.168.1.233', ssh_port: 22,
    db_host: null, db_port: null, db_name: 'odoo_tst', vpn_enabled: false,
    vpn_config_enc: null, vpn_username: null, vpn_password_enc: null,
    vpn_forward_port: null, vpn_container_name: null, ...over,
  };
  const { rows: [r] } = await dbModule.query(
    `INSERT INTO db_connections
       (project_id,name,ssh_host,ssh_port,ssh_user,connect_mode,db_host,db_port,db_name,
        vpn_enabled,vpn_config_enc,vpn_username,vpn_password_enc,vpn_forward_port,vpn_container_name)
     VALUES ($1,$2,$3,$4,'root',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [projectId, c.name, c.ssh_host, c.ssh_port, c.connect_mode, c.db_host, c.db_port, c.db_name,
     c.vpn_enabled, c.vpn_config_enc, c.vpn_username, c.vpn_password_enc, c.vpn_forward_port, c.vpn_container_name]
  );
  return r.id;
}

test('把 id 最小且有設定檔的連線憑證搬到專案，並打開該專案所有連線的 vpn_enabled', async () => {
  const pid = await seedProject();
  const c1 = await seedConn(pid, {
    vpn_enabled: true, vpn_config_enc: 'ENC_OVPN_1', vpn_username: 'aicd5',
    vpn_password_enc: 'ENC_PW_1', vpn_forward_port: 11000, vpn_container_name: 'vpn-conn-1',
  });
  const c2 = await seedConn(pid, { connect_mode: 'direct', ssh_host: '', db_host: '192.168.1.240', db_port: 1433 });

  await migrateVpnToProjects(dbModule.query);

  const { rows: [p] } = await dbModule.query('SELECT vpn_config_enc, vpn_username, vpn_password_enc FROM projects WHERE id=$1', [pid]);
  expect(p.vpn_config_enc).toBe('ENC_OVPN_1');   // 密文原樣搬，不解密（不依賴 APP_SECRET 可用）
  expect(p.vpn_username).toBe('aicd5');
  expect(p.vpn_password_enc).toBe('ENC_PW_1');

  const { rows } = await dbModule.query('SELECT id, vpn_enabled, vpn_forward_port FROM db_connections WHERE project_id=$1 ORDER BY id', [pid]);
  expect(rows.map(r => r.vpn_enabled)).toEqual([true, true]);
  // 不同目標 → 不同埠；且舊的 11000 不在新範圍內，必須被重配
  expect(rows.find(r => r.id === c1).vpn_forward_port).toBe(22000);
  expect(rows.find(r => r.id === c2).vpn_forward_port).toBe(22001);
});

test('同專案打去同一台機器的連線共用同一個轉發埠', async () => {
  const pid = await seedProject();
  await seedConn(pid, { vpn_enabled: true, vpn_config_enc: 'ENC', vpn_username: 'u', vpn_password_enc: 'P' });
  const same = await seedConn(pid, { ssh_host: '192.168.1.233', ssh_port: 22 });
  const other = await seedConn(pid, { connect_mode: 'direct', ssh_host: '', db_host: '192.168.1.240', db_port: 1433 });

  await migrateVpnToProjects(dbModule.query);

  const { rows } = await dbModule.query('SELECT id, vpn_forward_port FROM db_connections WHERE project_id=$1 ORDER BY id', [pid]);
  const byId = Object.fromEntries(rows.map(r => [r.id, r.vpn_forward_port]));
  expect(byId[same]).toBe(22000);      // 與第一條同目標 → 同埠
  expect(byId[other]).toBe(22001);
});

test('重跑不會覆蓋專案已有的憑證，也不會亂改已配好的埠', async () => {
  const pid = await seedProject();
  await seedConn(pid, { vpn_enabled: true, vpn_config_enc: 'ENC_OLD', vpn_username: 'old', vpn_password_enc: 'P_OLD' });
  await migrateVpnToProjects(dbModule.query);

  // 使用者之後在 UI 換了憑證
  await dbModule.query("UPDATE projects SET vpn_config_enc='ENC_NEW', vpn_username='new' WHERE id=$1", [pid]);
  const before = (await dbModule.query('SELECT id, vpn_forward_port FROM db_connections WHERE project_id=$1 ORDER BY id', [pid])).rows;

  await migrateVpnToProjects(dbModule.query);

  const { rows: [p] } = await dbModule.query('SELECT vpn_config_enc, vpn_username FROM projects WHERE id=$1', [pid]);
  expect(p.vpn_config_enc).toBe('ENC_NEW');
  expect(p.vpn_username).toBe('new');
  const after = (await dbModule.query('SELECT id, vpn_forward_port FROM db_connections WHERE project_id=$1 ORDER BY id', [pid])).rows;
  expect(after).toEqual(before);
});

test('沒有任何連線帶設定檔的專案完全不動', async () => {
  const pid = await seedProject();
  await seedConn(pid);
  await migrateVpnToProjects(dbModule.query);

  const { rows: [p] } = await dbModule.query('SELECT vpn_config_enc FROM projects WHERE id=$1', [pid]);
  expect(p.vpn_config_enc).toBeNull();
  const { rows } = await dbModule.query('SELECT vpn_enabled, vpn_forward_port FROM db_connections WHERE project_id=$1', [pid]);
  expect(rows[0].vpn_enabled).toBe(false);
  expect(rows[0].vpn_forward_port).toBeNull();
});

test('多專案各自搬各自的，不互相污染', async () => {
  const a = await seedProject('A');
  const b = await seedProject('B');
  // 兩個專案的連線刻意打去同一台機器（192.168.1.233:22，seedConn 預設值），
  // 用來驗證全域埠不撞號——這是 used 陣列必須宣告在跨專案迴圈「外層」的唯一保障。
  const connA = await seedConn(a, { vpn_enabled: true, vpn_config_enc: 'ENC_A', vpn_username: 'ua', vpn_password_enc: 'PA' });
  const connB = await seedConn(b, { vpn_enabled: true, vpn_config_enc: 'ENC_B', vpn_username: 'ub', vpn_password_enc: 'PB' });

  await migrateVpnToProjects(dbModule.query);

  const { rows } = await dbModule.query('SELECT id, vpn_config_enc, vpn_username FROM projects ORDER BY id');
  expect(rows.find(r => r.id === a).vpn_username).toBe('ua');
  expect(rows.find(r => r.id === b).vpn_username).toBe('ub');

  const { rows: conns } = await dbModule.query('SELECT id, vpn_forward_port FROM db_connections WHERE id IN ($1,$2)', [connA, connB]);
  const portA = conns.find(r => r.id === connA).vpn_forward_port;
  const portB = conns.find(r => r.id === connB).vpn_forward_port;
  expect(portA).toBe(22000);
  expect(portB).toBe(22001);
  expect(portA).not.toBe(portB);
});
