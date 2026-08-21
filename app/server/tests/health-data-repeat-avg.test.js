// 意圖：起手包（buildWindowSummary）的 per_stage.repeat_avg 用來讀「同一任務重跑幾次」，是健檢
// 判準表裡最強的失敗訊號之一。但 chat／chat-to-task 這類非 task-bound 關 token_usage.task_id 恆為
// null，若拿 max(1, distinct task) 當分母會塌成 1，repeat_avg 直接等於 calls——把 N 場獨立對話偽裝成
// 「同一任務重跑 N 次」。這支釘住：非 task-bound 關改用 distinct chat 當分母，兩者皆無時回 null。
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

test('repeat_avg：非 task-bound 關用 distinct chat 當分母，不把獨立對話當成同任務重跑', async () => {
  await dbModule.query('DELETE FROM token_usage');
  // chat 關：4 次呼叫散在 3 場不同對話（chat_id 42/43/44），task_id 全 null。
  // 分母塌成 1 的舊算法會報 repeat_avg=4；正解是 4÷3≈1.33。刻意用不均分佈（chat 42 兩次）讓分母有鑑別力。
  for (const cid of [42, 42, 43, 44]) {
    await dbModule.query(
      `INSERT INTO token_usage (task_id, chat_id, agent_type, model, input_tokens, duration_ms, status, recorded_at)
       VALUES (NULL,$1,'chat','claude-opus-5',1,1000,'completed',NOW())`, [cid]);
  }
  // task-bound 關（coding）維持原語意：同一任務兩次呼叫＝repeat_avg 2。
  for (let i = 0; i < 2; i++) {
    await dbModule.query(
      `INSERT INTO token_usage (task_id, agent_type, model, input_tokens, duration_ms, status, recorded_at)
       VALUES ('R1','coding','claude-opus-5',1,1000,'completed',NOW())`);
  }
  // 既無 task_id 又無 chat_id 的關（如 workflow_health）：分母無從得知，回 null 標 N/A，不與「重跑」同形。
  await dbModule.query(
    `INSERT INTO token_usage (task_id, chat_id, agent_type, model, input_tokens, duration_ms, status, recorded_at)
     VALUES (NULL,NULL,'workflow_health','claude-opus-5',1,1000,'completed',NOW())`);

  const w = await buildWindowSummary(new Date(Date.now() - 86400000));

  expect(w.per_stage.chat.calls).toBe(4);
  expect(w.per_stage.chat.tasks).toBe(0);
  expect(w.per_stage.chat.chats).toBe(3);
  expect(w.per_stage.chat.repeat_avg).toBeCloseTo(1.33, 2); // 不是 4
  expect(w.per_stage.coding.repeat_avg).toBe(2);            // task-bound 關語意不變
  expect(w.per_stage.coding.chats).toBeUndefined();         // 有 task 就不加對話分母的噪音
  expect(w.per_stage.workflow_health.repeat_avg).toBeNull(); // 兩者皆無＝N/A
});
