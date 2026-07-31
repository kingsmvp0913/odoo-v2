// 意圖：spec_review 對話式閘門——pre-coding 的 respec_running 由 spec-review agent 讀 task_logs 對話判斷：
//   answer（純提問）→ 回覆落 task_logs(ai)、analysis_yaml 不變、回 spec_review；
//   revise（明確要改）→ 更新 analysis_yaml＋回覆落 task_logs(ai)、回 spec_review；
//   無有效輸出 → stopped。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ ...jest.requireActual('../pipeline/claude-runner'), runClaude: jest.fn() }));

let dbModule, runSpecReview, runClaude, userId, projectId, seq = 0;

async function insertTask(analysisYaml) {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, analysis_yaml)
     VALUES ($1, $2, 'odoo', 'T', 'c', 'respec_running', $3, $4) RETURNING id`,
    [userId, `sr_${++seq}`, projectId, analysisYaml]
  );
  return t.id;
}
async function addLog(taskId, role, content) {
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,$2,$3)", [taskId, role, content]);
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
    "INSERT INTO users (username, password_hash, display_name) VALUES ('sr', $1, 'S') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('SP', '17.0') RETURNING id"
  );
  projectId = p.id;
  ({ runClaude } = require('../pipeline/claude-runner'));
  ({ runSpecReview } = require('../pipeline/spec-review'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  runClaude.mockReset();
  await dbModule.query('DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE user_id=$1)', [userId]);
  await dbModule.query('DELETE FROM tasks WHERE user_id=$1', [userId]);
});

async function loadTask(id) {
  const { rows: [t] } = await dbModule.query(
    'SELECT id, task_id, project_id, analysis_yaml FROM tasks WHERE id=$1', [id]
  );
  return t;
}

test('answer（純提問）→ 回覆落 task_logs(ai)、analysis_yaml 不變、回 spec_review', async () => {
  const id = await insertTask('module: sale\nsummary: 原摘要');
  await addLog(id, 'user', '為什麼備註欄設計成唯讀？');
  runClaude.mockResolvedValue({
    text: '<result>\nDECISION: answer\nREPLY:\n因為它同步自來源工單，由系統寫入避免不一致。\n</result>',
    usage: null, durationMs: null
  });

  await runSpecReview(await loadTask(id), userId, undefined);

  const { rows: [t] } = await dbModule.query('SELECT status, analysis_yaml FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('spec_review');
  expect(t.analysis_yaml).toBe('module: sale\nsummary: 原摘要');   // 純提問：規格不動
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  expect(logs.some(l => l.role === 'ai' && l.content.includes('同步自來源工單'))).toBe(true);
});

test('revise（明確要改）→ 更新 analysis_yaml＋回覆落 ai、回 spec_review', async () => {
  const id = await insertTask('module: sale\nsummary: 原摘要');
  await addLog(id, 'user', '備註欄改成可編輯多行');
  runClaude.mockResolvedValue({
    text: '<result>\nDECISION: revise\nREPLY:\n已把備註欄改為可編輯多行。\n---SPEC---\nmodule: sale\nsummary: 備註可編輯多行\n</result>',
    usage: null, durationMs: null
  });

  await runSpecReview(await loadTask(id), userId, undefined);

  const { rows: [t] } = await dbModule.query('SELECT status, analysis_yaml FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('spec_review');
  expect(t.analysis_yaml).toContain('備註可編輯多行');   // 規格已重產
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  expect(logs.some(l => l.role === 'ai' && l.content.includes('可編輯多行'))).toBe(true);
});

test('revise 但 SPEC 段非有效 YAML → stopped（regen 失敗不靜默放行）', async () => {
  const id = await insertTask('module: sale');
  await addLog(id, 'user', '改一下');
  runClaude.mockResolvedValue({
    text: '<result>\nDECISION: revise\nREPLY:\n改了\n---SPEC---\n: : : 不是 YAML : :\n</result>',
    usage: null, durationMs: null
  });

  await runSpecReview(await loadTask(id), userId, undefined);

  const { rows: [t] } = await dbModule.query('SELECT status, analysis_yaml FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.analysis_yaml).toBe('module: sale');   // 未被壞 YAML 覆蓋
});

test('agent 無有效 result → stopped', async () => {
  const id = await insertTask('module: sale');
  await addLog(id, 'user', '問題');
  runClaude.mockResolvedValue({ text: '完全沒有 result 標記的垃圾', usage: null, durationMs: null });

  await runSpecReview(await loadTask(id), userId, undefined);

  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
});

test('續接輪：有 spec_session_id ＋指紋相符 → 帶 --resume，且 prompt 含當前規格全文', async () => {
  const { promptVersion } = require('../pipeline/agent-loader');
  const ver = `${promptVersion('spec-review')}.${promptVersion('spec-review-retry')}`;
  const id = await insertTask('module: sale\nsummary: 目前這版');
  await dbModule.query('UPDATE tasks SET spec_session_id=$2, spec_prompt_ver=$3 WHERE id=$1', [id, 'sp-1', ver]);
  await addLog(id, 'user', '那個欄位可以改嗎？');
  runClaude.mockResolvedValue({
    text: '<result>\nDECISION: answer\nREPLY:\n可以。\n</result>',
    usage: null, durationMs: null, sessionId: 'sp-1'
  });

  await runSpecReview(await loadTask(id), userId, undefined);

  const [prompt, opts] = runClaude.mock.calls[0];
  expect(opts.resumeSessionId).toBe('sp-1');
  // 權威重送：session 內可能殘留舊版規格，每輪必須重送 DB 的當前版本
  expect(prompt).toContain('目前這版');
});

test('續接輪：revise 之後 session 不清（權威規格靠每輪重送，不靠重開 session）', async () => {
  const { promptVersion } = require('../pipeline/agent-loader');
  const ver = `${promptVersion('spec-review')}.${promptVersion('spec-review-retry')}`;
  const id = await insertTask('module: sale\nsummary: 舊');
  await dbModule.query('UPDATE tasks SET spec_session_id=$2, spec_prompt_ver=$3 WHERE id=$1', [id, 'sp-2', ver]);
  await addLog(id, 'user', '改成可編輯');
  runClaude.mockResolvedValue({
    text: '<result>\nDECISION: revise\nREPLY:\n改好了\n---SPEC---\nmodule: sale\nsummary: 新\n</result>',
    usage: null, durationMs: null, sessionId: 'sp-2'
  });

  await runSpecReview(await loadTask(id), userId, undefined);

  const { rows: [t] } = await dbModule.query('SELECT spec_session_id, analysis_yaml FROM tasks WHERE id=$1', [id]);
  expect(t.spec_session_id).toBe('sp-2');        // 同一場對話，續接點保留
  expect(t.analysis_yaml).toContain('新');
});

test('首輪：無 session → 不帶 --resume，且跑完存下 session', async () => {
  const id = await insertTask('module: sale');
  await addLog(id, 'user', '第一個問題');
  runClaude.mockResolvedValue({
    text: '<result>\nDECISION: answer\nREPLY:\n回答\n</result>',
    usage: null, durationMs: null, sessionId: 'sp-new'
  });

  await runSpecReview(await loadTask(id), userId, undefined);

  expect(runClaude.mock.calls[0][1].resumeSessionId).toBeUndefined();
  const { rows: [t] } = await dbModule.query('SELECT spec_session_id FROM tasks WHERE id=$1', [id]);
  expect(t.spec_session_id).toBe('sp-new');
});
