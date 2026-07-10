// 意圖：退回分診只判 bug 與否——bug 直進 coding（保留 retry_feedback 走 resume）；
// 規格類（respec，含二次退回禁 bug 被降級者）不自己改 SD，改轉回 analysis 重寫，
// 並把分診結論以 user 澄清落地餵給重跑的分析，清 retry_feedback/coding_session_id 走全新一輪；
// 無有效結果 stopped。
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

test('decision bug → coding_running，保留 retry_feedback、SD 不變，summary 落 AI 泡泡', async () => {
  claudeReturns({ decision: 'bug', summary: '退回原因：備註型別錯；結論：研判為程式 bug，已轉回 coding 修補。' });
  const id = await makeTask(1);
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, analysis_yaml FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.retry_feedback).toContain('備註型別錯');   // 保留 → coding 走 resume 修補
  expect(t.analysis_yaml).toBe('module: sale');        // SD 不動
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  expect(logs.some(l => l.role === 'ai' && l.content.includes('研判為程式 bug'))).toBe(true);
});

test('decision respec → analysis_running：不自己改 SD，清 retry_feedback/coding_session_id，結論以 user 澄清落地餵回分析', async () => {
  claudeReturns({ decision: 'respec', summary: '退回原因：備註需求變更；結論：判定為規格問題，交回分析階段重寫 SD。' });
  const id = await makeTask(1);
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, coding_session_id, analysis_yaml FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('analysis_running');           // 交回分析重寫，非直接 coding
  expect(t.retry_feedback).toBeNull();                 // 清退回內容
  expect(t.coding_session_id).toBeNull();              // 清舊 coding session → fresh 重跑
  expect(t.analysis_yaml).toBe('module: sale');        // triage 不自己動 SD
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  // 分診結論以 user 澄清落地，analysis 重跑的 clarification（讀 role='user'）才拿得到
  expect(logs.some(l => l.role === 'user' && l.content.includes('需調整規格') && l.content.includes('規格問題'))).toBe(true);
});

test('防呆：同 task 第 2 次退回，模型判 bug 也強制降級為規格類 → analysis_running', async () => {
  claudeReturns({ decision: 'bug', summary: '退回原因：同一問題再次被退。' });
  const id = await makeTask(2);   // 已 2 筆 rejection → allow_bug=false
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, coding_session_id FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('analysis_running');
  expect(t.retry_feedback).toBeNull();
  expect(t.coding_session_id).toBeNull();
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  expect(logs.some(l => l.role === 'user' && l.content.includes('同一問題再次被退'))).toBe(true);
});

test('agent 未回 summary → 不因缺欄位丟例外，bug 仍轉 coding_running', async () => {
  claudeReturns({ decision: 'bug' });   // 無 summary（fallback）
  const id = await makeTask(1);
  await expect(runRejectTriage(id, userId)).resolves.toBe(true);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
});

test('無有效 result → stopped', async () => {
  runClaude.mockResolvedValue({ text: '沒有標記', usage: null, durationMs: null });
  const id = await makeTask(1);
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
});
