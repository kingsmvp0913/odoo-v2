// 意圖：spec-review 與 clarify-chat、respec-patch 同記 agent_type='respec'。前兩者有續接、respec-patch 沒有，
// 所以 spec-review 一定要明確記 true／false——留 NULL 就跟「沒有續接概念」的 respec-patch 混成同一類。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ ...jest.requireActual('../pipeline/claude-runner'), runClaude: jest.fn() }));

let dbModule, runSpecReview, runClaude, logTokenUsage, logFailedUsage, userId, projectId, seq = 0;

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('srr', 'x', 'S') RETURNING id");
  userId = u.id;
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('SPR', '17.0') RETURNING id");
  projectId = p.id;
  ({ runClaude } = require('../pipeline/claude-runner'));
  ({ logTokenUsage, logFailedUsage } = require('../pipeline/token-logger'));
  ({ runSpecReview } = require('../pipeline/spec-review'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  runClaude.mockReset();
  logTokenUsage.mockClear();
  logFailedUsage.mockClear();
});

const ver = () => {
  const { promptVersion } = require('../pipeline/agent-loader');
  return `${promptVersion('spec-review')}.${promptVersion('spec-review-retry')}`;
};
const answer = (sessionId) => ({
  text: '<result>\nDECISION: answer\nREPLY:\n可以。\n</result>', usage: null, durationMs: null, sessionId
});

async function taskWith(sessionId) {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, analysis_yaml, spec_session_id, spec_prompt_ver)
     VALUES ($1, $2, 'odoo', 'T', 'c', 'respec_running', $3, 'module: sale', $4, $5)
     RETURNING id, task_id, project_id, analysis_yaml`,
    [userId, `srr_${++seq}`, projectId, sessionId, sessionId ? ver() : null]
  );
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', '那個欄位可以改嗎？')", [t.id]);
  return t;
}

const respecCalls = () => logTokenUsage.mock.calls.filter(c => c[2] === 'respec');

test('首輪（無 session）→ resumed=false', async () => {
  runClaude.mockResolvedValueOnce(answer('sp-new'));
  await runSpecReview(await taskWith(null), userId, undefined);
  expect(respecCalls()).toHaveLength(1);
  expect(respecCalls()[0][5]).toBe('completed');
  expect(respecCalls()[0][6]).toBe(false);
});

test('續接成功 → resumed=true', async () => {
  runClaude.mockResolvedValueOnce(answer('sp-1'));
  await runSpecReview(await taskWith('sp-1'), userId, undefined);
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBe('sp-1');
  expect(respecCalls()[0][6]).toBe(true);
});

test('續接失敗降級 fresh → 失敗列 true、成功列 false', async () => {
  const retryErr = new Error('session 遺失');
  runClaude.mockRejectedValueOnce(retryErr).mockResolvedValueOnce(answer('sp-fresh'));
  await runSpecReview(await taskWith('sp-gone'), userId, undefined);
  const failed = logFailedUsage.mock.calls.find(c => c[3] === retryErr);
  expect(failed[4]).toBe(true);
  expect(respecCalls()).toHaveLength(1);
  expect(respecCalls()[0][6]).toBe(false);
});
