process.env.APP_SECRET = 'test-secret';
process.env.JWT_SECRET = 'test-log-schema';
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

test('db_connections 具備 log 來源五欄', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name,folder_name,odoo_version) VALUES ('t','t','17.0') RETURNING id");
  await dbModule.query(
    `INSERT INTO db_connections (project_id,name,ssh_host,ssh_user,db_name,log_mode,log_container,log_unit,log_path,log_tz_offset)
     VALUES ($1,'c','1.1.1.1','root','odoo_prd','docker','odoo-app','odoo','/var/log/odoo/odoo.log',480)`, [p.id]);
  const { rows: [c] } = await dbModule.query('SELECT * FROM db_connections WHERE name=$1', ['c']);
  expect(c.log_mode).toBe('docker');
  expect(c.log_container).toBe('odoo-app');
  expect(c.log_unit).toBe('odoo');
  expect(c.log_path).toBe('/var/log/odoo/odoo.log');
  expect(c.log_tz_offset).toBe(480);
});

test('PUBLIC_COLS 含 log 欄位（前端讀得到）', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'db-query-routes.js'), 'utf8');
  const m = /const PUBLIC_COLS = '([^']+)'/.exec(src);
  expect(m).not.toBeNull();
  for (const col of ['log_mode', 'log_container', 'log_unit', 'log_path', 'log_tz_offset']) {
    expect(m[1]).toContain(col);
  }
});
