// 意圖：起手包（buildWindowSummary）的 per_stage.failed_calls 是健檢判「這關失敗率高不高」的依據，
// 口徑必須與正式報表（token-report-routes.js:78）一致——只有真正的執行失敗（timeout／error 等）才算失敗。
// aborted（使用者按停止鈕）與 interrupted（進程被外部信號終止，如重啟／OOM）是刻意／外部中斷，非執行失敗。
// 若把這兩種也算成 failed，每輪只要有人按停止或平台重啟就把 failed 灌水、產生假警報。這支釘住兩者不計入。
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

const { buildWindowSummary } = require('../pipeline/health-data');

test('failed_calls：aborted／interrupted 不計入失敗，只有真正執行失敗才算', async () => {
  await dbModule.query('DELETE FROM token_usage');
  // coding 關 5 次呼叫：completed、aborted（按停止）、interrupted（重啟中斷）、error、timeout。
  // 舊算法（status !== 'completed'）會把 aborted／interrupted 都算進去＝4 failed；
  // 對齊正式報表後只剩 error／timeout＝2 failed。刻意每種各一筆讓判定有鑑別力。
  for (const st of ['completed', 'aborted', 'interrupted', 'error', 'timeout']) {
    await dbModule.query(
      `INSERT INTO token_usage (task_id, agent_type, model, input_tokens, duration_ms, status, recorded_at)
       VALUES ('F1','coding','claude-opus-5',1,1000,$1,NOW())`, [st]);
  }

  const w = await buildWindowSummary(new Date(Date.now() - 86400000));

  expect(w.per_stage.coding.calls).toBe(5);
  expect(w.per_stage.coding.failed_calls).toBe(2); // 不是 4——aborted／interrupted 排除
});
