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

// 舊測試（只用 regex 掃 PUBLIC_COLS 原始碼字串）已移除：那只證明字串含子字串，證明不了
// 「前端真的讀得到」或「PUT 真的能寫回」。取代它的是 db-query-routes.test.js 的
// 「PUT 可修正 log 來源五欄，且真的寫入 DB」——PUT 後重讀 DB 才是有鑑別力的斷言（C1）。
