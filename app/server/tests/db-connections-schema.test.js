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
});
