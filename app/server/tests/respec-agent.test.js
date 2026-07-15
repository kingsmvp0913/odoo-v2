// 意圖：使用者途中留言＝追加需求。respec 把待吸收留言增量 patch 進 analysis_yaml、標記留言已吸收、
// 把需求塞進 retry_feedback，退回 coding_running；無有效 YAML 則 stopped；無待吸收留言則直接退回 coding 不空跑。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ ...jest.requireActual('../pipeline/claude-runner'), runClaude: jest.fn() }));

let dbModule, runRespecPatch, runClaude, userId, projectId, taskSeq = 0;

// codingSessionId 預設 'sess-1'＝coding 已跑過（途中追加需求流程）；傳 null＝coding 未曾跑過（規格審核閘門改規格流程）
async function insertTask(analysisYaml, codingSessionId = 'sess-1') {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, analysis_yaml, coding_session_id)
     VALUES ($1, $2, 'odoo', 'T', 'c', 'respec_running', $3, $4, $5) RETURNING id`,
    [userId, `t_${++taskSeq}`, projectId, analysisYaml, codingSessionId]
  );
  return t.id;
}
async function addMsg(taskId, content) {
  const { rows: [m] } = await dbModule.query(
    "INSERT INTO task_messages (task_id, source, author, content, occurred_at) VALUES ($1,'manual','me',$2, NOW()) RETURNING id",
    [taskId, content]
  );
  return m.id;
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('rs', $1, 'R') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('RP', '17.0') RETURNING id"
  );
  projectId = p.id;
  ({ runClaude } = require('../pipeline/claude-runner'));
  ({ runRespecPatch } = require('../pipeline/respec-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  runClaude.mockReset();
  await dbModule.query('DELETE FROM task_messages WHERE task_id IN (SELECT id FROM tasks WHERE user_id=$1)', [userId]);
  await dbModule.query('DELETE FROM tasks WHERE user_id=$1', [userId]);
});

test('有留言：patch 規格→標記已吸收→帶需求進 retry_feedback→退回 coding', async () => {
  const taskId = await insertTask('module: sale\nfeatures:\n  - 折扣欄位');
  await addMsg(taskId, '請加匯出 Excel 按鈕');
  runClaude.mockResolvedValue({
    text: '<result>\nmodule: sale\nfeatures:\n  - 折扣欄位\n  - 匯出 Excel 按鈕\n</result>',
    usage: null, durationMs: null
  });

  await runRespecPatch(taskId, userId, undefined);

  const { rows: [t] } = await dbModule.query('SELECT status, analysis_yaml, retry_feedback FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('coding_running');
  expect(t.analysis_yaml).toContain('匯出 Excel 按鈕');          // 新需求已併進規格（QA 重驗吃得到）
  expect(t.retry_feedback).toContain('[追加需求]');
  expect(t.retry_feedback).toContain('請加匯出 Excel 按鈕');      // coding-retry resume 只讀 retry_feedback，需求須帶到
  const { rows: [m] } = await dbModule.query('SELECT applied_at FROM task_messages WHERE task_id=$1', [taskId]);
  expect(m.applied_at).not.toBeNull();                           // 留言標記已吸收（防反覆觸發）
});

test('多則留言：全部標記已吸收、逐條帶進需求', async () => {
  const taskId = await insertTask('module: sale');
  await addMsg(taskId, '需求一');
  await addMsg(taskId, '需求二');
  runClaude.mockResolvedValue({ text: '<result>\nmodule: sale\nnote: patched\n</result>', usage: null, durationMs: null });

  await runRespecPatch(taskId, userId, undefined);

  const { rows } = await dbModule.query('SELECT applied_at FROM task_messages WHERE task_id=$1', [taskId]);
  expect(rows).toHaveLength(2);
  expect(rows.every(r => r.applied_at !== null)).toBe(true);
  const { rows: [t] } = await dbModule.query('SELECT retry_feedback FROM tasks WHERE id=$1', [taskId]);
  expect(t.retry_feedback).toContain('需求一');
  expect(t.retry_feedback).toContain('需求二');
});

test('agent 未回傳有效 YAML → stopped（留言不被標記，留待人工處理後重跑）', async () => {
  const taskId = await insertTask('module: sale');
  await addMsg(taskId, '需求');
  // 原始與 repair 都回垃圾 → parseAgentResult 得 null
  runClaude.mockResolvedValue({ text: '完全沒有 result 標記的垃圾', usage: null, durationMs: null });

  await runRespecPatch(taskId, userId, undefined);

  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('stopped');
  const { rows: [m] } = await dbModule.query('SELECT applied_at FROM task_messages WHERE task_id=$1', [taskId]);
  expect(m.applied_at).toBeNull();
});

test('無待吸收留言（競態）→ 直接退回 coding，不呼叫 agent', async () => {
  const taskId = await insertTask('module: sale');
  // 不插入任何留言

  await runRespecPatch(taskId, userId, undefined);

  expect(runClaude).not.toHaveBeenCalled();
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('coding_running');
});

// 規格審核閘門的改規格：coding 從未跑過（coding_session_id 為 NULL）。patch 完要退回 spec_review
// 讓使用者重看，且不設 retry_feedback（此時尚無 coding session 可 resume）。
test('pre-coding（無 coding_session_id）：patch 規格→退回 spec_review、不設 retry_feedback', async () => {
  const taskId = await insertTask('module: sale\nsummary: 原摘要', null);
  await addMsg(taskId, '請把摘要改成新摘要');
  runClaude.mockResolvedValue({
    text: '<result>\nmodule: sale\nsummary: 新摘要\n</result>',
    usage: null, durationMs: null
  });

  await runRespecPatch(taskId, userId, undefined);

  const { rows: [t] } = await dbModule.query('SELECT status, analysis_yaml, retry_feedback FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('spec_review');           // 退回審核閘門重看，非 coding
  expect(t.analysis_yaml).toContain('新摘要');      // 規格已更新
  expect(t.retry_feedback).toBeNull();             // 尚無 coding 可 resume，不設 retry_feedback
  const { rows: [m] } = await dbModule.query('SELECT applied_at FROM task_messages WHERE task_id=$1', [taskId]);
  expect(m.applied_at).not.toBeNull();             // 意見標記已吸收（防反覆觸發）
});

test('pre-coding 無待吸收留言（競態）→ 退回 spec_review，不呼叫 agent', async () => {
  const taskId = await insertTask('module: sale', null);
  // 不插入任何留言

  await runRespecPatch(taskId, userId, undefined);

  expect(runClaude).not.toHaveBeenCalled();
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('spec_review');
});
