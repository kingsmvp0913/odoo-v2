const { newDb } = require('pg-mem');

const mockCallClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ callClaude: mockCallClaude }));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));

let dbModule, runCsAgent;
let userSeq = 0;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ runCsAgent } = require('../pipeline/cs-agent'));
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => { mockCallClaude.mockReset(); });

async function makeTask(overrides = {}) {
  userSeq++;
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: [user] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ('cs${userSeq}', $1, 'CS') RETURNING id`,
    [hash]
  );
  let projectId = null;
  if (overrides.withProject) {
    const { rows: [p] } = await dbModule.query(
      `INSERT INTO projects (name, odoo_version) VALUES ('csproj${userSeq}', '17.0') RETURNING id`
    );
    projectId = p.id;
  }
  const { rows: [task] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, task_type, project_id)
     VALUES ($1, $2, 'service', $3, $4, 'cs_running', 'service', $5) RETURNING id`,
    [user.id, `svc${userSeq}`, overrides.title || 'How do I export?', overrides.text || 'I want to export a report.', projectId]
  );
  return { userId: user.id, taskId: task.id };
}

test('operation → cs_reply_pending with reply', async () => {
  mockCallClaude.mockResolvedValueOnce({ text: '{"type":"operation","reply":"請到報表 > 匯出","question":null}', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask();
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, cs_reply FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('cs_reply_pending');
  expect(t.cs_reply).toContain('匯出');
});

test('code_change_clear + 有專案 → analysis_running', async () => {
  mockCallClaude.mockResolvedValueOnce({ text: '{"type":"code_change_clear","reply":null,"question":null}', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({
    withProject: true,
    title: 'Bug in report',
    text: 'When clicking export the system crashes. Steps: 1. Go to report 2. Click export. Expected: file downloads. Actual: 500 error.'
  });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('analysis_running');
});

test('code_change_clear + 無專案 → stopped（需先綁定專案）', async () => {
  mockCallClaude.mockResolvedValueOnce({ text: '{"type":"code_change_clear","reply":null,"question":null}', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({ title: 'Bug', text: 'export crashes' });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_content).toContain('綁定專案');
});

test('code_change_vague → cs_data_needed with question', async () => {
  mockCallClaude.mockResolvedValueOnce({ text: '{"type":"code_change_vague","reply":null,"question":"請提供重現步驟和錯誤截圖"}', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({ title: 'Something wrong', text: 'It does not work.' });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, cs_question FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('cs_data_needed');
  expect(t.cs_question).toContain('重現步驟');
});

test('API error → stopped', async () => {
  mockCallClaude.mockRejectedValueOnce(new Error('timeout'));
  const { userId, taskId } = await makeTask();
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('stopped');
});

test('missing task → returns silently', async () => {
  await expect(runCsAgent(99999, 1)).resolves.toBeUndefined();
  expect(mockCallClaude).not.toHaveBeenCalled();
});
