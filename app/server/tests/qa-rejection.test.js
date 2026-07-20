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

test('migration：task_rejections.source 預設 human，既有寫法不帶 source 也可插入', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('P','17.0') RETURNING id");
  const { rows: [r] } = await dbModule.query(
    "INSERT INTO task_rejections (task_id, project_id, reason, status) VALUES ('t1',$1,'r','new') RETURNING source",
    [p.id]);
  expect(r.source).toBe('human');
});
