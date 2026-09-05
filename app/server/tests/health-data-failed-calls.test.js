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

  // 分母也要排除，不是只排分子。這兩個值擺在一起只會被讀成「這關的失敗率」：分子排、分母不排
  // ＝從原本的高報變成低報，兩張畫面的數字照樣對不起來（正式報表的 calls 同樣排除這兩種）。
  expect(w.per_stage.coding.calls).toBe(3);        // 不是 5——aborted／interrupted 不算一次呼叫
  expect(w.per_stage.coding.failed_calls).toBe(2); // 不是 4——同上，只有 error／timeout 算失敗
});

// buildAgentSummary 是同一批資料的另一個投影，token.failed_calls 這個名字跟上面那個一模一樣。
// 定義走樣時看數字分不出是哪一份——它在 2026-09-05 就這樣多活了一輪修正（呼叫端早就不用它，
// 死引用讓它看起來還在服役）。這支釘住兩個投影同口徑，避免只改到看得見的那一份。
test('buildAgentSummary 的 token.calls／failed_calls 與 per_stage 同口徑', async () => {
  await dbModule.query('DELETE FROM token_usage');
  for (const st of ['completed', 'aborted', 'interrupted', 'error', 'timeout']) {
    await dbModule.query(
      `INSERT INTO token_usage (task_id, agent_type, model, input_tokens, duration_ms, status, recorded_at)
       VALUES ('F2','coding','claude-opus-5',1,1000,$1,NOW())`, [st]);
  }

  const { buildAgentSummary } = require('../pipeline/health-data');
  const s = await buildAgentSummary({ name: 'coding-project', stage: 'coding', label: '開發' }, { windowDays: 1 });
  const w = await buildWindowSummary(new Date(Date.now() - 86400000));

  expect(s.token.calls).toBe(w.per_stage.coding.calls);
  expect(s.token.failed_calls).toBe(w.per_stage.coding.failed_calls);
  expect(s.token.failed_calls).toBe(2);   // 兩邊一起錯成 4 的話上面兩條會一起綠，這條才擋得住
});
