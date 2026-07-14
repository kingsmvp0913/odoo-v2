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

// 成本歸屬：runClaude 把 resolved model 折進 usage.model，logTokenUsage 須落 model 欄
test('logTokenUsage 落 usage.model 到 model 欄（供 USD 成本按 model 單價計）', async () => {
  await logTokenUsage(
    { taskId: 'task_model_1' }, null, 'chat',
    { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5' },
    100
  );
  const { rows } = await dbModule.query("SELECT model FROM token_usage WHERE task_id='task_model_1'");
  expect(rows.length).toBe(1);
  expect(rows[0].model).toBe('claude-sonnet-5');
});

// 意圖：手動暫停（abort）不是 Agent 失敗；失敗原因須顯示「手動暫停」而非「XXX 執行失敗：aborted」，
// 讓使用者看得懂那是自己按的暫停，不是程式壞掉。
test('stopReason：手動暫停顯示「手動暫停」，真正失敗才帶階段前綴', () => {
  const { abortError, stopReason } = require('../pipeline/claude-runner');
  expect(abortError().aborted).toBe(true);
  expect(stopReason('實作 Agent 執行失敗', abortError())).toBe('手動暫停');
  expect(stopReason('QA Agent 執行失敗', new Error('boom'))).toBe('QA Agent 執行失敗：boom');
});

// 健檢 U9：runClaude 逾時——CLI 掛死＝任務永久卡在 *_running、
// merge 鎖鏈永不釋放，只能重啟 server。逾時必須主動 kill 並 reject。
test('runClaude 逾時 → kill 子行程並以逾時錯誤 reject', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = jest.fn(() => { setImmediate(() => child.emit('close', 143)); });
  spawn.mockReturnValue(child);

  const { runClaude } = require('../pipeline/claude-runner');
  await expect(runClaude('p', { timeoutMs: 30 })).rejects.toThrow(/逾時/);
  expect(child.kill).toHaveBeenCalled();
});

// Prompt 稽核：runClaude 送出前把完整 prompt 落 prompt_logs（含 agent_type/model/task_id/字數），
// 供管理員頁確認「實際送出了什麼」。落地為 best-effort（fire-and-forget），故輪詢等待。
test('runClaude：送出前把完整 prompt 落 prompt_logs', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => setImmediate(() => child.emit('close', 0)), on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValueOnce(child);

  const { runClaude } = require('../pipeline/claude-runner');
  const PROMPT = '這是一段測試 prompt 內容 hello';
  await runClaude(PROMPT, { agentType: 'coding', model: 'opus', taskId: 42 });

  let row;
  for (let i = 0; i < 20 && !row; i++) {
    const { rows } = await dbModule.query("SELECT * FROM prompt_logs WHERE agent_type='coding'");
    row = rows[0];
  }
  expect(row).toBeTruthy();
  expect(row.prompt).toBe(PROMPT);
  expect(row.model).toBe('opus');
  expect(row.task_id).toBe('42');
  expect(row.char_len).toBe(PROMPT.length);
});

// B-1（主題 B）：init 事件抓 session_id 回傳、給 resumeSessionId 才帶 --resume。
// 原在 task-agent.test.js 測 spawnClaude，合併後 runClaude 承接（健檢 U13）。
test('runClaude：從 init 事件抓到 session_id 並回傳', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValue(child);

  const { runClaude } = require('../pipeline/claude-runner');
  const p = runClaude('p', {});
  child.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc' }) + '\n');
  child.stdout.emit('data', JSON.stringify({ type: 'result', result: 'done', usage: null, duration_ms: 5 }) + '\n');
  child.emit('close', 0);
  const r = await p;
  expect(r.sessionId).toBe('sess-abc');
});

test('runClaude：給 resumeSessionId → args 含 --resume；不給 → 不含', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const mk = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => setImmediate(() => child.emit('close', 0)), on: () => {} };
    child.kill = jest.fn();
    return child;
  };
  const { runClaude } = require('../pipeline/claude-runner');

  spawn.mockReturnValueOnce(mk());
  await runClaude('p', { resumeSessionId: 'sess-xyz' });
  expect(spawn.mock.calls[spawn.mock.calls.length - 1][1]).toEqual(expect.arrayContaining(['--resume', 'sess-xyz']));

  spawn.mockReturnValueOnce(mk());
  await runClaude('p', {});
  expect(spawn.mock.calls[spawn.mock.calls.length - 1][1]).not.toContain('--resume');
});

// 暫停時序缺口：signal 在 runClaude 被呼叫「之前」就已 abort（使用者在前置 DB 查詢／
// 同關前一次 runClaude 期間按暫停）——addEventListener 對已 abort 的 signal 不會觸發，
// 不前置檢查的話整段 claude 會照跑白燒 token。
test('runClaude：signal 已 abort → 不 spawn、直接以手動暫停 reject', async () => {
  const { spawn } = require('child_process');
  spawn.mockClear();
  const { runClaude } = require('../pipeline/claude-runner');
  const ctrl = new AbortController();
  ctrl.abort();
  await expect(runClaude('p', { signal: ctrl.signal })).rejects.toMatchObject({ aborted: true });
  expect(spawn).not.toHaveBeenCalled();
});

// exit code null＝被外部 signal 終止（OOM killer 等）：不能拿空結果當成功回傳，
// 否則下游拿到空輸出會誤歸因成「agent 沒回有效結果」。
test('runClaude：exit code null（外部 kill）→ reject 而非空成功', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValueOnce(child);
  const { runClaude } = require('../pipeline/claude-runner');
  const p = runClaude('p', {});
  child.emit('close', null, 'SIGKILL');
  await expect(p).rejects.toThrow(/外部終止/);
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
