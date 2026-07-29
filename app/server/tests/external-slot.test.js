// 意圖：對外子網域是「按需借用的檢視名額」，載體必須是獨立欄位而非由 port 推導——
// port 是 pipeline 也在用的內部資源，兩者綁在一起就回到「pipeline 吃掉對外名額」的老問題。
const { newDb } = require('pg-mem');

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('migrate 後 odoo_envs 有 external_slot 欄位，預設 NULL', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('a','17.0') RETURNING id"
  );
  await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1,'idle')", [p.id]);
  const { rows: [env] } = await dbModule.query(
    'SELECT external_slot FROM odoo_envs WHERE project_id=$1', [p.id]
  );
  expect(env.external_slot).toBeNull();
});

// 意圖：migrate 走 add-if-missing，重複執行必須冪等——正式機每次啟動都會跑。
test('重複 migrate 不炸', async () => {
  await expect(dbModule.migrate()).resolves.not.toThrow();
});
