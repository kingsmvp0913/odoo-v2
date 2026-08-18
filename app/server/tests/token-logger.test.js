// 意圖：QA 每輪是 fresh 還是 resume，是「改動有沒有讓準確率退步」的唯一判讀依據。不落地成欄位的話
// 事後只能靠比對 task_events 裡的 session id 反推，而 qa_resume_count 在 pass 時就被歸零、歷史被抹掉。
const { newDb } = require('pg-mem');

let dbModule, logTokenUsage;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ logTokenUsage } = require('../pipeline/token-logger'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

const usage = {
  model: 'sonnet', input_tokens: 1, output_tokens: 2,
  cache_read_input_tokens: 3, cache_creation_input_tokens: 4
};

test('resumed 旗標落地：true 與 false 要分得出來，不是只記 true', async () => {
  await logTokenUsage({ taskId: 'tk-resume' }, null, 'qa', usage, 100, 'completed', true);
  await logTokenUsage({ taskId: 'tk-fresh' }, null, 'qa', usage, 100, 'completed', false);
  const { rows } = await dbModule.query(
    "SELECT task_id, resumed FROM token_usage WHERE task_id IN ('tk-resume','tk-fresh') ORDER BY task_id"
  );
  expect(rows.map(r => r.resumed)).toEqual([false, true]); // tk-fresh, tk-resume
});

// 沒傳＝該關卡沒有 resume 概念（或還沒接），必須與「跑了 fresh」區分開；混成 false 會讓
// 「fresh 佔比」這個要用來判斷準確率的統計從第一天就是錯的。
test('未傳 resumed → 留 NULL（未記錄），不得誤落成 false', async () => {
  await logTokenUsage({ taskId: 'tk-none' }, null, 'coding', usage, 100);
  const { rows: [r] } = await dbModule.query("SELECT resumed FROM token_usage WHERE task_id='tk-none'");
  expect(r.resumed).toBeNull();
});
