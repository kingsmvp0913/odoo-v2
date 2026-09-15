// 意圖：clarify-chat 走 withResume、記 agent_type='respec'。它要落 true／false，才分得開同記 respec、
// 但沒有續接概念的 respec-patch（那一關照欄位定義留 NULL）。不 mock token-logger，直接看資料表。
jest.mock('../pipeline/claude-runner', () => ({
  runClaude: jest.fn(),
  stopReason: (label, err) => `${label}失敗：${err.message}`
}));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));

const { newDb } = require('pg-mem');
const { runClaude } = require('../pipeline/claude-runner');
const { runClarifyChat } = require('../pipeline/clarify-chat');
let dbModule;

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, approved) VALUES ('u','x','U','admin',true)"
  );
});
afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => { runClaude.mockReset(); });

let seq = 0;
async function makeTask(sessionId) {
  const { promptVersion } = require('../pipeline/agent-loader');
  const ver = `${promptVersion('clarify-chat')}.${promptVersion('clarify-chat-retry')}`;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, analysis_yaml, clarify_session_id, clarify_prompt_ver)
     VALUES (1, $1, 'odoo', 'T', 'clarify_chat_running', 'summary: s', $2, $3) RETURNING *`,
    [`ccr_${++seq}`, sessionId, sessionId ? ver : null]
  );
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','再問一題')", [t.id]);
  return t;
}
const answer = (sessionId) => ({
  text: '<result>\nDECISION: answer\nREPLY:\n回答\n</result>', usage: {}, durationMs: 1, sessionId
});
async function rowsOf(t) {
  const { rows } = await dbModule.query(
    "SELECT status, resumed FROM token_usage WHERE task_id=$1 AND agent_type='respec' ORDER BY id", [t.task_id]);
  return rows;
}

test('首輪（無 session）→ 落 resumed=false', async () => {
  const t = await makeTask(null);
  runClaude.mockResolvedValueOnce(answer('cl-new'));
  await runClarifyChat({ id: t.id }, 1, null, 'ask');
  expect(await rowsOf(t)).toEqual([{ status: 'completed', resumed: false }]);
});

test('續接成功 → 落 resumed=true', async () => {
  const t = await makeTask('cl-1');
  runClaude.mockResolvedValueOnce(answer('cl-1'));
  await runClarifyChat({ id: t.id }, 1, null, 'ask');
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBe('cl-1');
  expect(await rowsOf(t)).toEqual([{ status: 'completed', resumed: true }]);
});

test('續接失敗降級 fresh → 失敗列 true、緊接的成功列 false', async () => {
  const t = await makeTask('cl-gone');
  runClaude
    .mockRejectedValueOnce(Object.assign(new Error('No conversation found'), { claudeStatus: 'error' }))
    .mockResolvedValueOnce(answer('cl-fresh'));
  await runClarifyChat({ id: t.id }, 1, null, 'ask');
  expect(await rowsOf(t)).toEqual([
    { status: 'error', resumed: true },
    { status: 'completed', resumed: false }
  ]);
});
