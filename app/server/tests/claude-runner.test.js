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

test('logTokenUsage inserts a server record', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('x', 4);
  const { rows: [u] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ('tlu1', $1, 'TL') RETURNING id`, [hash]
  );
  await logTokenUsage(
    { taskId: 'task_odoo_1' }, u.id, 'cs',
    { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    1234
  );
  const { rows } = await dbModule.query("SELECT * FROM token_usage WHERE task_id='task_odoo_1'");
  expect(rows.length).toBe(1);
  expect(rows[0].agent_type).toBe('cs');
  expect(rows[0].input_tokens).toBe(100);
  expect(rows[0].output_tokens).toBe(50);
  expect(rows[0].duration_ms).toBe(1234);
  expect(rows[0].source).toBe('server');
});

test('logTokenUsage silently skips when usage is null', async () => {
  await expect(logTokenUsage({ taskId: 'x' }, null, 'cs', null, null)).resolves.toBeUndefined();
});

// 意圖：手動暫停（abort）不是 Agent 失敗；失敗原因須顯示「手動暫停」而非「XXX 執行失敗：aborted」，
// 讓使用者看得懂那是自己按的暫停，不是程式壞掉。
test('stopReason：手動暫停顯示「手動暫停」，真正失敗才帶階段前綴', () => {
  const { abortError, stopReason } = require('../pipeline/claude-runner');
  expect(abortError().aborted).toBe(true);
  expect(stopReason('實作 Agent 執行失敗', abortError())).toBe('手動暫停');
  expect(stopReason('QA Agent 執行失敗', new Error('boom'))).toBe('QA Agent 執行失敗：boom');
});
