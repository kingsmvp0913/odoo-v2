// 意圖：健檢兩表隨 migrate 建立（工作流程健檢子專案 2）。
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

test('migrate 建立 health_check_runs / health_check_findings 兩表', async () => {
  await dbModule.query(
    "INSERT INTO health_check_runs (status, window_days) VALUES ('running', 30)"
  );
  const { rows } = await dbModule.query('SELECT status, window_days FROM health_check_runs');
  expect(rows[0].status).toBe('running');
  const { rows: [run] } = await dbModule.query('SELECT id FROM health_check_runs LIMIT 1');
  await dbModule.query(
    "INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity) VALUES ($1,'coding-project','ok','ok')",
    [run.id]
  );
  const { rows: f } = await dbModule.query('SELECT severity FROM health_check_findings');
  expect(f[0].severity).toBe('ok');
});
