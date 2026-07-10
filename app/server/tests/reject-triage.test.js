// 意圖：退回後分診——bug 直進 coding（保留 retry_feedback 走 resume）、respec 改寫 SD 後 fresh 重做、
// clarify 落 AI 提問轉 reject_confirm_pending；同 task 二次退回禁判 bug；無有效結果 stopped。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ ...jest.requireActual('../pipeline/claude-runner'), runClaude: jest.fn() }));
jest.mock('../pipeline/git', () => ({ getMainBranch: jest.fn().mockResolvedValue('main') }));
jest.mock('../pipeline/task-agent', () => {
  const actual = jest.requireActual('../pipeline/task-agent');
  return { ...actual, getProjectInfo: jest.fn() };
});

let dbModule, runRejectTriage, taskAgent, runClaude;
let userId, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('rt', $1, 'R') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('RP', '17.0') RETURNING id"
  );
  projectId = p.id;
  taskAgent = require('../pipeline/task-agent');
  ({ runClaude } = require('../pipeline/claude-runner'));
  ({ runRejectTriage } = require('../pipeline/reject-triage'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  runClaude.mockReset();
  taskAgent.getProjectInfo.mockReset();
  taskAgent.getProjectInfo.mockResolvedValue({
    name: 'RP', odoo_version: '17.0', root: '/repos/rp',
    repos: [{ subdir: 'main', local_path: '/repos/rp/main' }]
  });
});

let seq = 0;
// rejectCount：預先塞幾筆 task_rejections（模擬第 N 次退回）
async function makeTask(rejectCount = 1) {
  seq++;
  const bizId = `rt_${seq}`;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, git_branch, analysis_yaml, retry_feedback, coding_session_id)
     VALUES ($1,$2,'odoo','T','reject_triage',$3,'task/x','module: sale','[人工退回]\n備註型別錯','sess-1') RETURNING id`,
    [userId, bizId, projectId]
  );
  for (let i = 0; i < rejectCount; i++) {
    await dbModule.query(
      "INSERT INTO task_rejections (task_id, project_id, user_id, reason, status) VALUES ($1,$2,$3,'r','new')",
      [bizId, projectId, userId]
    );
  }
  return t.id;
}

function claudeReturns(json) {
  runClaude.mockResolvedValue({ text: `x\n<result>\n${JSON.stringify(json)}\n</result>`, usage: null, durationMs: null });
}

test('decision bug → coding_running，保留 retry_feedback、SD 不變', async () => {
  claudeReturns({ decision: 'bug' });
  const id = await makeTask(1);
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, analysis_yaml FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.retry_feedback).toContain('備註型別錯');   // 保留 → coding 走 resume 修補
  expect(t.analysis_yaml).toBe('module: sale');        // SD 不動
});

test('decision respec → coding_running，改寫 SD、清空 retry_feedback', async () => {
  claudeReturns({ decision: 'respec', analysis_yaml: 'module: sale\nrequirements:\n  - 備註改用 Text 型別' });
  const id = await makeTask(1);
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, analysis_yaml FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.retry_feedback).toBeNull();                 // 清空 → coding 走 fresh 重做
  expect(t.analysis_yaml).toContain('Text 型別');
});

test('decision clarify → reject_confirm_pending，AI 提問落 log', async () => {
  claudeReturns({ decision: 'clarify', question: '你要的預設收合是指整區還是逐項？' });
  const id = await makeTask(1);
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('reject_confirm_pending');
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  expect(logs.some(l => l.role === 'ai' && l.content.includes('預設收合'))).toBe(true);
});

test('防呆：同 task 第 2 次退回，模型判 bug 也強制轉 clarify', async () => {
  claudeReturns({ decision: 'bug' });
  const id = await makeTask(2);   // 已 2 筆 rejection → allow_bug=false
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('reject_confirm_pending');
});

test('無有效 result → stopped', async () => {
  runClaude.mockResolvedValue({ text: '沒有標記', usage: null, durationMs: null });
  const id = await makeTask(1);
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
});
