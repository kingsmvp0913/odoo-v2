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

test('CLI 回報的實際美元金額優先落庫，沒有金額時保留 NULL 供估算', async () => {
  await logTokenUsage({ taskId: 'tk-actual-cost' }, null, 'coding', { ...usage, total_cost_usd: 1.2345 }, 100);
  await logTokenUsage({ taskId: 'tk-estimated-cost' }, null, 'coding', usage, 100);
  const { rows } = await dbModule.query(
    "SELECT task_id, cost_usd FROM token_usage WHERE task_id IN ('tk-actual-cost','tk-estimated-cost') ORDER BY task_id"
  );
  expect(Number(rows[0].cost_usd)).toBeCloseTo(1.2345);
  expect(rows[1].cost_usd).toBeNull();
  const { cost } = require('../lib/token-cost').costSql();
  const { rows: totals } = await dbModule.query(
    `SELECT task_id, ${cost} AS amount FROM token_usage WHERE task_id IN ('tk-actual-cost','tk-estimated-cost') ORDER BY task_id`
  );
  expect(Number(totals[0].amount)).toBeCloseTo(1.2345);
  expect(Number(totals[1].amount)).toBeGreaterThan(0);
});

test('CLI 回報失敗但已有結果金額時仍計入花費', async () => {
  const { logFailedUsage } = require('../pipeline/token-logger');
  await logFailedUsage({ taskId: 'tk-failed-cost' }, null, 'qa', {
    message: 'Claude 執行失敗', claudeStatus: 'error', usage: { total_cost_usd: 0.75 }
  });
  const { rows: [row] } = await dbModule.query("SELECT status, cost_usd FROM token_usage WHERE task_id='tk-failed-cost'");
  expect(row.status).toBe('error');
  expect(Number(row.cost_usd)).toBe(0.75);
});

test('上限檢查擋下的執行沒有真正呼叫 AI，不新增用量列', async () => {
  const { logFailedUsage } = require('../pipeline/token-logger');
  await logFailedUsage({ taskId: 'tk-budget-blocked' }, null, 'qa', {
    message: '已達花費上限', code: 'TASK_BUDGET_EXCEEDED'
  });
  const { rows } = await dbModule.query("SELECT id FROM token_usage WHERE task_id='tk-budget-blocked'");
  expect(rows).toHaveLength(0);
});
