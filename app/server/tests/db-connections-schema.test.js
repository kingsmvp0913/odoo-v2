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
