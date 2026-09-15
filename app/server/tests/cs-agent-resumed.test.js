// 意圖：cs 的追問／補資料兩條重跑都走 withResume，token_usage.resumed 要分得出三條路。
// 這支不 mock token-logger，直接看 pg-mem 裡落了什麼——傳錯參數位置（例如把 resumed 塞進 status）
// 在 mock 斷言裡看不出來，在資料表裡一眼就看得出來。
const { newDb } = require('pg-mem');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({
  ...jest.requireActual('../pipeline/claude-runner'),
  runClaude: mockRunClaude
}));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../lib/odoo-core-src', () => ({
  coreSourceGuidance: jest.fn().mockReturnValue(''),
  ensureOdooCoreSrc: jest.fn().mockResolvedValue(''),
  majorOf: jest.fn().mockReturnValue(''),
  CORE_SRC_ROOT: '/core-src'
}));

let dbModule, runCsAgent;
let seq = 0;

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ runCsAgent } = require('../pipeline/cs-agent'));
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => { mockRunClaude.mockReset(); });

async function makeTask() {
  seq++;
  const { rows: [user] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ('csr${seq}', 'x', 'CS') RETURNING id`
  );
  const { rows: [task] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, task_type)
     VALUES ($1, $2, 'service', 'How do I export?', 'I want to export a report.', 'cs_running', 'service') RETURNING id, task_id`,
    [user.id, `svcr${seq}`]
  );
  return { userId: user.id, taskId: task.id, bizId: task.task_id };
}

const ok = (sessionId) => ({
  text: '<result>{"type":"operation","reply":"請到報表 > 匯出"}</result>', usage: {}, durationMs: 1, sessionId
});

async function rowsOf(bizId) {
  const { rows } = await dbModule.query(
    "SELECT status, resumed FROM token_usage WHERE task_id=$1 AND agent_type='cs' ORDER BY id", [bizId]);
  return rows;
}

async function followUp(taskId) {
  await dbModule.query("UPDATE tasks SET status='cs_running' WHERE id=$1", [taskId]);
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', '再問一題')", [taskId]);
}

test('首輪 fresh → 落 resumed=false', async () => {
  const t = await makeTask();
  mockRunClaude.mockResolvedValueOnce(ok('sess-1'));
  await runCsAgent(t.taskId, t.userId);
  expect(await rowsOf(t.bizId)).toEqual([{ status: 'completed', resumed: false }]);
});

test('追問輪續接成功 → 第二列落 resumed=true', async () => {
  const t = await makeTask();
  mockRunClaude.mockResolvedValueOnce(ok('sess-1'));
  await runCsAgent(t.taskId, t.userId);
  await followUp(t.taskId);
  mockRunClaude.mockResolvedValueOnce(ok('sess-1'));
  await runCsAgent(t.taskId, t.userId);

  expect(mockRunClaude.mock.calls[1][1].resumeSessionId).toBe('sess-1');
  expect(await rowsOf(t.bizId)).toEqual([
    { status: 'completed', resumed: false },
    { status: 'completed', resumed: true }
  ]);
});

test('追問輪續接失敗降級 fresh → 失敗列 true、緊接的成功列 false', async () => {
  const t = await makeTask();
  mockRunClaude.mockResolvedValueOnce(ok('sess-1'));
  await runCsAgent(t.taskId, t.userId);
  await followUp(t.taskId);
  mockRunClaude
    .mockRejectedValueOnce(Object.assign(new Error('No conversation found'), { claudeStatus: 'error' }))
    .mockResolvedValueOnce(ok('sess-2'));
  await runCsAgent(t.taskId, t.userId);

  expect(await rowsOf(t.bizId)).toEqual([
    { status: 'completed', resumed: false },
    { status: 'error', resumed: true },
    { status: 'completed', resumed: false }
  ]);
});
