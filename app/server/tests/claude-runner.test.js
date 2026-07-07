const { newDb } = require('pg-mem');

jest.mock('child_process', () => ({ spawn: jest.fn() }));

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

// 健檢 U9：callClaude 原本無 timeout——CLI 掛死＝任務永久卡在 *_running、
// merge 鎖鏈永不釋放，只能重啟 server。逾時必須主動 kill 並 reject。
test('callClaude 逾時 → kill 子行程並以逾時錯誤 reject', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {} };
  child.kill = jest.fn(() => { setImmediate(() => child.emit('close', 143)); });
  spawn.mockReturnValue(child);

  const { callClaude } = require('../pipeline/claude-runner');
  await expect(callClaude('p', undefined, { timeoutMs: 30 })).rejects.toThrow(/逾時/);
  expect(child.kill).toHaveBeenCalled();
});

// 健檢 U12：失敗/中斷/逾時的執行也要記帳（usage 為零＋status 標記），
// 否則最貴的情境（失敗重跑）在 token 帳面上隱形，成本控管系統性低估。
test('logFailedUsage：失敗執行落一筆零用量記錄，status 標注失敗類別', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('x', 4);
  const { rows: [u] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ('tlu2', $1, 'TL2') RETURNING id`, [hash]
  );
  const { logFailedUsage } = require('../pipeline/token-logger');
  const err = Object.assign(new Error('claude subprocess timed out'), { claudeStatus: 'timeout', durationMs: 600000 });
  await logFailedUsage({ taskId: 'task_fail_1', projectId: null }, u.id, 'coding', err);

  const { rows } = await dbModule.query("SELECT * FROM token_usage WHERE task_id='task_fail_1'");
  expect(rows.length).toBe(1);
  expect(rows[0].status).toBe('timeout');
  expect(rows[0].input_tokens).toBe(0);
  expect(rows[0].duration_ms).toBe(600000);
});

test('logTokenUsage：成功但 usage 為 null 時維持不落帳（相容既有行為）', async () => {
  await expect(require('../pipeline/token-logger').logTokenUsage({ taskId: 'x2' }, null, 'cs', null, null))
    .resolves.toBeUndefined();
  const { rows } = await dbModule.query("SELECT * FROM token_usage WHERE task_id='x2'");
  expect(rows.length).toBe(0);
});
