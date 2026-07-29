jest.mock('../pipeline/claude-runner', () => ({
  runClaude: jest.fn(),
  stopReason: (label, err) => `${label}失敗：${err.message}`
}));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));

const { newDb } = require('pg-mem');
const { runClaude } = require('../pipeline/claude-runner');
let dbModule;

const { parseClarifyChat, runClarifyChat } = require('../pipeline/clarify-chat');

test('parseClarifyChat：answer 只取 DECISION 與 REPLY，不得有題目', () => {
  const out = parseClarifyChat('DECISION: answer\nREPLY:\n分頁是指超過 40 筆時只顯示前 40 筆。\n第二行也算回覆。');
  expect(out.decision).toBe('answer');
  expect(out.reply).toBe('分頁是指超過 40 筆時只顯示前 40 筆。\n第二行也算回覆。');
  expect(out.questions_yaml).toBeNull();
});

test('parseClarifyChat：proceed 是獨立決策，不會被當成 answer', () => {
  const out = parseClarifyChat('DECISION: proceed\nREPLY:\n了解，開始實作。');
  expect(out.decision).toBe('proceed');
});

test('parseClarifyChat：revise 必須帶可解析的 QUESTIONS，reply 與 yaml 正確切開', () => {
  const raw = [
    'DECISION: revise',
    'REPLY:',
    '我把第二題刪掉了。',
    '---QUESTIONS---',
    'intro: 說明段',
    'questions:',
    '  - id: q1',
    '    text: 要自動重編嗎？',
    '    type: text',
    '    required: true'
  ].join('\n');
  const out = parseClarifyChat(raw);
  expect(out.decision).toBe('revise');
  expect(out.reply).toBe('我把第二題刪掉了。');
  expect(out.questions_yaml).toContain('intro: 說明段');
});

// 壞輸出一律丟例外 → 上層退回原狀態，絕不把壞資料寫進 analysis_yaml
test('parseClarifyChat：revise 缺 QUESTIONS 區塊 → 丟例外', () => {
  expect(() => parseClarifyChat('DECISION: revise\nREPLY:\n改好了')).toThrow();
});

test('parseClarifyChat：revise 的 QUESTIONS 不是合法 YAML 物件 → 丟例外', () => {
  expect(() => parseClarifyChat('DECISION: revise\nREPLY:\nx\n---QUESTIONS---\n: : :')).toThrow();
});

test('parseClarifyChat：缺 DECISION → 丟例外', () => {
  expect(() => parseClarifyChat('REPLY:\n沒有決策')).toThrow();
});

test('parseClarifyChat：缺 REPLY → 丟例外（使用者一定要看到回覆）', () => {
  expect(() => parseClarifyChat('DECISION: answer\nREPLY:\n   ')).toThrow();
});

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, approved) VALUES ('u','x','U','admin',true)"
  );
});

async function makeTask(status) {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, analysis_yaml) VALUES (1,$1,'odoo','T',$2,'summary: s') RETURNING *",
    [`t_${status}_${Math.floor(Math.random() * 1e6)}`, status]
  );
  return rows[0];
}

test('送出回答時使用者其實在反問 → answer → 狀態留 confirm_pending、沒有推進（task 5 回歸）', async () => {
  const task = await makeTask('clarify_chat_running');
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: answer\nREPLY:\n分頁是指……\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat(task, 1, null, 'answer_or_proceed');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_pending');
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [task.id]);
  expect(logs[0].content).toContain('分頁');
});

test('答齊了 → proceed → confirm_answered', async () => {
  const task = await makeTask('clarify_chat_running');
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: proceed\nREPLY:\n了解，開始實作。\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat(task, 1, null, 'answer_or_proceed');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_answered');
});

test('提問入口即使 agent 硬回 proceed 也推不動（結構性限制，不靠 prompt 自律）', async () => {
  const task = await makeTask('clarify_chat_running');
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: proceed\nREPLY:\n我要往前跑\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat(task, 1, null, 'ask');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_pending');
});

test('revise → 草案只落 clarify_draft，analysis_yaml 一個字都不動', async () => {
  const task = await makeTask('clarify_chat_running');
  runClaude.mockResolvedValueOnce({
    text: '<result>\nDECISION: revise\nREPLY:\n調整了\n---QUESTIONS---\nintro: 新說明\nquestions: []\n</result>',
    usage: {}, durationMs: 1
  });
  await runClarifyChat(task, 1, null, 'revise');
  const { rows } = await dbModule.query('SELECT status, clarify_draft, analysis_yaml FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_pending');
  expect(rows[0].clarify_draft).toContain('intro: 新說明');
  expect(rows[0].analysis_yaml).toBe('summary: s');
});

test('agent 失敗 → 狀態退回 confirm_pending，不是 stopped', async () => {
  const task = await makeTask('clarify_chat_running');
  runClaude.mockRejectedValueOnce(new Error('claude exited with code 1'));
  await runClarifyChat(task, 1, null, 'answer_or_proceed');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_pending');
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [task.id]);
  expect(logs[logs.length - 1].content).toContain('請再送出一次');
});

// claude-runner 對認證失效已標 claudeStatus='auth'（auth-signature.js）——訊息要讓使用者
// 知道跟他的回答無關，否則他會以為自己答錯而反覆改答案
test('認證失效 → 訊息點明與回答無關，狀態一樣退回不 stopped', async () => {
  const task = await makeTask('clarify_chat_running');
  const err = new Error('Claude CLI 未登入或認證失效：Not logged in');
  err.claudeStatus = 'auth';
  runClaude.mockRejectedValueOnce(err);
  await runClarifyChat(task, 1, null, 'answer_or_proceed');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_pending');
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [task.id]);
  expect(logs[logs.length - 1].content).toContain('與你的回答無關');
});

test('clarify_pending 來的任務：proceed 進 clarify_answered', async () => {
  const task = await makeTask('clarify_chat_running');
  task.resume_status = 'clarify_pending';
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: proceed\nREPLY:\n收到裁決\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat(task, 1, null, 'answer_or_proceed');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('clarify_answered');
});
