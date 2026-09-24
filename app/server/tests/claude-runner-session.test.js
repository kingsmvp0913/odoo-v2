// 意圖：續接輪找不到 session 時，runner 要標出 session_missing（呼叫端照舊降級 fresh），
// 並在任務時間軸留一行人看得懂的原因——否則使用者只看到這一關莫名多跑一次、慢了一倍（rules/pipeline 77）。
process.env.CLAUDE_RATE_LIMIT_CACHE = require('path').join(require('os').tmpdir(), 'test-claude-rate-limit-session.json');
const { EventEmitter } = require('events');
const { newDb } = require('pg-mem');
jest.mock('child_process', () => ({ spawn: jest.fn(), execFile: jest.fn() }));
// AI 一律在容器裡跑，runClaude 只剩這條路；真品會查 DB、驗映像檔、發通行證，單元測試跑不動
jest.mock('../pipeline/sandbox-run', () => require('./_sandbox-run-mock')());
const { untilSpawned } = require('./_sandbox-run-mock');

let dbModule, taskDbId;
function child() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
  c.kill = jest.fn(); c.once = c.once.bind(c);
  return c;
}
const flush = () => new Promise(r => setTimeout(r, 30));

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name) VALUES ('sess','x','S') RETURNING id");
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,folder_name,odoo_version) VALUES ('sp','sp','17.0') RETURNING id");
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (project_id, user_id, source, task_id, title, status) VALUES ($1,$2,'odoo','task_sess_1','t','qa_running') RETURNING id", [p.id, u.id]);
  taskDbId = t.id;
});
afterAll(() => dbModule._setPoolForTesting(null));

async function runWith(emit, opts) {
  const { spawn } = require('child_process');
  const c = child();
  spawn.mockReturnValueOnce(c);
  const { runClaude } = require('../pipeline/claude-runner');
  const p = runClaude('x', { agentType: 'qa', taskId: taskDbId, resumeSessionId: 'old-session', ...opts });
  await untilSpawned();   // 容器路徑的 spawn 在幾個 await 之後；太早發事件沒有人聽得到
  emit(c);
  return p.then(() => null, e => e);
}
const line = () => require('../pipeline/session-signature').SAMPLE_LINE;

test('字面在 stderr → session_missing，且寫一列 task_logs', async () => {
  const err = await runWith(c => { c.stderr.emit('data', `${line()}\n`); c.emit('close', 1); });
  expect(err.claudeStatus).toBe('session_missing');
  await flush();
  const { rows } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND content LIKE '[續接]%'", [taskDbId]);
  expect(rows.length).toBe(1);
  // 只剩容器一條路，原因就要講那個真實原因：家目錄在容器裡，與上一輪的宿主 session 不同源。
  // 使用者看到的是「這一關莫名多跑一次」，沒有這行字他無從得知為什麼（rules/pipeline 77）。
  expect(rows[0].content).toMatch(/容器/);
});

test('字面在 stdout 的 result 事件 → 同樣認得', async () => {
  const err = await runWith(c => {
    c.stdout.emit('data', `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: line() })}\n`);
    c.emit('close', 1);
  });
  expect(err.claudeStatus).toBe('session_missing');
});

test('logSessionMissing:false（analysis／spec_tour 已自己寫）→ 不重複寫', async () => {
  await dbModule.query("DELETE FROM task_logs WHERE task_id=$1", [taskDbId]);
  await runWith(c => { c.stderr.emit('data', `${line()}\n`); c.emit('close', 1); }, { logSessionMissing: false });
  await flush();
  const { rows } = await dbModule.query("SELECT 1 FROM task_logs WHERE task_id=$1", [taskDbId]);
  expect(rows.length).toBe(0);
});

test('沒有 resumeSessionId 時同樣文字不算 session_missing', async () => {
  const err = await runWith(c => { c.stderr.emit('data', `${line()}\n`); c.emit('close', 1); }, { resumeSessionId: undefined });
  expect(err.claudeStatus).toBe('error');
});

test('其他失敗照舊是 error', async () => {
  const err = await runWith(c => { c.stderr.emit('data', 'boom\n'); c.emit('close', 1); });
  expect(err.claudeStatus).toBe('error');
});
