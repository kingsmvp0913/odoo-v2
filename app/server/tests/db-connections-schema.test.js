const { newDb } = require('pg-mem');
let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});
afterAll(() => dbModule._setPoolForTesting(null));

test('db_connections 表可插入與級聯', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('P','17.0') RETURNING id"
  );
  await dbModule.query(
    `INSERT INTO db_connections (project_id, name, ssh_host, ssh_user, db_name)
     VALUES ($1,'conn1','1.2.3.4','root','odoo_prd')`, [p.id]
  );
  const { rows } = await dbModule.query('SELECT * FROM db_connections WHERE project_id=$1', [p.id]);
  expect(rows.length).toBe(1);
  expect(rows[0].connect_mode).toBe('docker');
  expect(rows[0].ssh_port).toBe(22);
});

test('direct 模式欄位存在且有預設（db_port=5432, db_ssl=false）', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('P2','17.0') RETURNING id"
  );
  await dbModule.query(
    `INSERT INTO db_connections (project_id, name, ssh_host, ssh_user, connect_mode, db_host, db_user, db_password_enc, db_name)
     VALUES ($1,'d1','','', 'direct','db.example.com','reader','enc','odoo_prd')`, [p.id]
  );
  const { rows: [c] } = await dbModule.query('SELECT * FROM db_connections WHERE project_id=$1', [p.id]);
  expect(c.connect_mode).toBe('direct');
  expect(c.db_host).toBe('db.example.com');
  expect(c.db_port).toBe(5432);
  expect(c.db_ssl).toBe(false);
  expect(c.db_password_enc).toBe('enc');
  expect(c.db_engine).toBe('postgres'); // 預設引擎
});

test('db_engine 可存 mssql/mysql', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('P3','17.0') RETURNING id"
  );
  await dbModule.query(
    `INSERT INTO db_connections (project_id, name, ssh_host, ssh_user, connect_mode, db_engine, db_host, db_user, db_name)
     VALUES ($1,'m1','','', 'direct','mssql','192.168.1.240','sa','HJTEST')`, [p.id]
  );
  const { rows: [c] } = await dbModule.query('SELECT db_engine FROM db_connections WHERE project_id=$1', [p.id]);
  expect(c.db_engine).toBe('mssql');
});

test('VPN 欄位存在且有預設值（vpn_enabled=false）', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('P4','17.0') RETURNING id"
  );
  await dbModule.query(
    `INSERT INTO db_connections (project_id, name, ssh_host, ssh_user, db_name)
     VALUES ($1,'v1','1.2.3.4','root','odoo_prd')`, [p.id]
  );
  const { rows: [c] } = await dbModule.query('SELECT * FROM db_connections WHERE project_id=$1', [p.id]);
  expect(c.vpn_enabled).toBe(false);
  expect(c.vpn_config_enc).toBeNull();
  expect(c.vpn_username).toBeNull();
  expect(c.vpn_password_enc).toBeNull();
  expect(c.vpn_forward_port).toBeNull();
  expect(c.vpn_container_name).toBeNull();
});

test('VPN 欄位可寫入完整值', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('P5','17.0') RETURNING id"
  );
  await dbModule.query(
    `INSERT INTO db_connections (project_id, name, ssh_host, ssh_user, db_name, vpn_enabled, vpn_config_enc, vpn_username, vpn_password_enc, vpn_forward_port, vpn_container_name)
     VALUES ($1,'v2','1.2.3.4','root','odoo_prd', true, 'encblob', 'vpnuser', 'encpw', 11000, 'vpn-conn-99')`, [p.id]
  );
  const { rows: [c] } = await dbModule.query('SELECT * FROM db_connections WHERE project_id=$1', [p.id]);
  expect(c.vpn_enabled).toBe(true);
  expect(c.vpn_forward_port).toBe(11000);
  expect(c.vpn_container_name).toBe('vpn-conn-99');
});
