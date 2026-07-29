// 意圖：企業版是「多掛一包 addons」，靠 projects.edition 決定掛不掛、靠 enterprise_sources 決定掛哪包。
// 這兩者是後續所有企業版行為的唯一真相來源；schema 若沒隨 migrate() 建起來，既有部署升上來會靜默
// 少一個欄位，症狀是「勾了企業版卻沒作用」——最難查的那種。故鎖在測試裡。
const { newDb } = require('pg-mem');

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('projects.edition 預設 community——既有專案升級後行為完全不變', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('P1','17.0') RETURNING edition"
  );
  expect(p.edition).toBe('community');
});

test('projects.edition 可寫入 enterprise', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, edition) VALUES ('P2','17.0','enterprise') RETURNING edition"
  );
  expect(p.edition).toBe('enterprise');
});

test('enterprise_sources 以大版本為主鍵，同版本只會有一列（重登記＝覆蓋而非長出第二列）', async () => {
  await dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url, branch) VALUES ('17','https://example.com/e.git','17.0')"
  );
  await expect(dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url) VALUES ('17','https://example.com/other.git')"
  )).rejects.toBeDefined();
});

test('enterprise_sources 新登記的預設狀態是 pending——沒同步過就不該被當成可用', async () => {
  const { rows: [s] } = await dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url) VALUES ('18','https://example.com/e18.git') RETURNING clone_status, last_synced_at"
  );
  expect(s.clone_status).toBe('pending');
  expect(s.last_synced_at).toBeNull();
});
