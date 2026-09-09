// 意圖：失敗的執行是最貴也最需要事後追查的情境，但 token_usage 原本只留 status 與 duration_ms。
// logFailedUsage 有一半的呼叫點傳 taskId=null（health-check-runner／fix-review／fix-verify／chat），
// 那些列連 task_events 都沒有對應紀錄——錯誤訊息不落庫，事後就只能靠 duration 的形狀猜成因。
const { newDb } = require('pg-mem');

let dbModule, logTokenUsage, logFailedUsage;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ logTokenUsage, logFailedUsage } = require('../pipeline/token-logger'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('logFailedUsage 落下 err.message，taskId 為 null 的呼叫點也查得到成因', async () => {
  const err = new Error('codex resume 續接失敗：session not found');
  err.claudeStatus = 'error';
  err.durationMs = 1234;
  await logFailedUsage({ taskId: null, projectId: null }, null, 'fix_verify', err);

  const { rows: [r] } = await dbModule.query(
    "SELECT status, duration_ms, error_message FROM token_usage WHERE agent_type='fix_verify'"
  );
  expect(r.status).toBe('error');
  expect(r.duration_ms).toBe(1234);
  expect(r.error_message).toBe('codex resume 續接失敗：session not found');
});

test('成功列不寫錯誤訊息（NULL），才分得出哪些列是失敗的', async () => {
  await logTokenUsage({ taskId: 'tk-ok' }, null, 'qa', { input_tokens: 1 }, 100);
  const { rows: [r] } = await dbModule.query("SELECT error_message FROM token_usage WHERE task_id='tk-ok'");
  expect(r.error_message).toBeNull();
});

// token_usage 是高頻寫入表：agent 的錯誤訊息可能夾帶整份輸出，不截斷會把這張表撐爆。
test('過長的錯誤訊息被截斷，不整份塞進表裡', async () => {
  const err = new Error('X'.repeat(5000));
  await logFailedUsage({ taskId: 'tk-long' }, null, 'coding', err);
  const { rows: [r] } = await dbModule.query("SELECT error_message FROM token_usage WHERE task_id='tk-long'");
  expect(r.error_message.length).toBe(2000);
});
