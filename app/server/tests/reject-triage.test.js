// 意圖：通用分診員——任務停下（reject_triage=人工退回／resolve_triage=卡關修正指示）後，
// 依使用者語氣＋實機真相判 resume/advance/fix/respec 決定下一步：
//   fix→coding（保留 retry_feedback resume 修補）；respec→analysis（不自己改 SD，結論以 user 澄清餵回）；
//   advance→放行推進到指定關（歸零該關計數器）；resume→回原關重跑；二次退回禁 fix 降級 respec；無效結果 stopped。
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
// 建一個分診中的任務。預設為人工退回入口（reject_triage）。
async function makeTask({ rejectCount = 1, status = 'reject_triage', resume_status = null, blocker = null,
  qa = 0, deploy = 0, pw = 0, instruction = null } = {}) {
  seq++;
  const bizId = `rt_${seq}`;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, resume_status, blocker_content, project_id,
       git_branch, analysis_yaml, retry_feedback, coding_session_id, qa_retry_count, deploy_retry_count, pw_retry_count)
     VALUES ($1,$2,'odoo','T',$3,$4,$5,$6,'task/x','module: sale','[人工退回]\n備註型別錯','sess-1',$7,$8,$9) RETURNING id`,
    [userId, bizId, status, resume_status, blocker, projectId, qa, deploy, pw]
  );
  for (let i = 0; i < rejectCount; i++) {
    await dbModule.query(
      "INSERT INTO task_rejections (task_id, project_id, user_id, reason, status) VALUES ($1,$2,$3,'r','new')",
      [bizId, projectId, userId]
    );
  }
  if (instruction) {
    await dbModule.query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user',$2)", [t.id, `[修正指示] ${instruction}`]
    );
  }
  return t.id;
}

function claudeReturns(json) {
  runClaude.mockResolvedValue({ text: `x\n<result>\n${JSON.stringify(json)}\n</result>`, usage: null, durationMs: null });
}

// ---- 人工退回入口（reject_triage）----

test('fix → coding_running：保留 retry_feedback、SD 不動、summary 落 AI 泡泡', async () => {
  claudeReturns({ decision: 'fix', summary: '退回原因：備註型別錯；結論：研判為程式 bug，已轉回 coding 修補。' });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, coding_session_id, analysis_yaml FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.retry_feedback).toContain('備註型別錯');   // 保留 → coding resume 修補
  expect(t.coding_session_id).toBe('sess-1');          // resume 續用
  expect(t.analysis_yaml).toBe('module: sale');        // SD 不動
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  expect(logs.some(l => l.role === 'ai' && l.content.includes('研判為程式 bug'))).toBe(true);
});

test('respec → analysis_running：不自己改 SD，清 retry_feedback/coding_session_id，結論以 user 澄清餵回分析', async () => {
  claudeReturns({ decision: 'respec', summary: '退回原因：備註需求變更；結論：判定為規格問題，交回分析階段重寫 SD。' });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, coding_session_id, analysis_yaml FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('analysis_running');
  expect(t.retry_feedback).toBeNull();
  expect(t.coding_session_id).toBeNull();
  expect(t.analysis_yaml).toBe('module: sale');
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  expect(logs.some(l => l.role === 'user' && l.content.includes('需調整規格') && l.content.includes('規格問題'))).toBe(true);
});

test('advance target=review → review_pending：誤判/點錯直接送審', async () => {
  claudeReturns({ decision: 'advance', target: 'review', summary: '結論：判定為誤判，直接推進到人工審核。' });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('review_pending');
  expect(t.retry_feedback).toBeNull();   // 放行不帶失敗回饋
});

test('resume → 回原關（reject 入口的原關＝review_pending）', async () => {
  claudeReturns({ decision: 'resume', summary: '結論：判定為暫時狀態，回原關重跑。' });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('review_pending');
});

test('防呆：二次退回，模型判 fix 也強制降級 respec → analysis_running', async () => {
  claudeReturns({ decision: 'fix', summary: '退回原因：同一問題再次被退。' });
  const id = await makeTask({ rejectCount: 2 });   // allow_bug=false
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, coding_session_id FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('analysis_running');
  expect(t.retry_feedback).toBeNull();
  expect(t.coding_session_id).toBeNull();
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [id]);
  expect(logs.some(l => l.role === 'user' && l.content.includes('同一問題再次被退'))).toBe(true);
});

// ---- 卡關修正指示入口（resolve_triage）----

test('resolve 入口 advance target=e2e → playwright_running，並歸零 pw 計數器', async () => {
  claudeReturns({ decision: 'advance', target: 'e2e', summary: '結論：判定為誤判，重測 E2E。' });
  const id = await makeTask({ status: 'resolve_triage', resume_status: 'playwright_running', blocker: 'E2E boom', pw: 3, instruction: '沒事誤判，直接重測 E2E' });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, pw_retry_count, resume_status, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('playwright_running');
  expect(t.pw_retry_count).toBe(0);          // 落到 e2e 關 → 重取完整重試額度
  expect(t.resume_status).toBeNull();
  expect(t.blocker_content).toBeNull();
});

test('專案停用 E2E：advance target=e2e 改導向 review_pending，並留痕跡（旗標在此當家，堵繞過路徑）', async () => {
  await dbModule.query('UPDATE projects SET e2e_disabled=true WHERE id=$1', [projectId]);
  try {
    claudeReturns({ decision: 'advance', target: 'e2e', summary: '結論：判定為誤判，重測 E2E。' });
    const id = await makeTask({ status: 'resolve_triage', resume_status: 'playwright_running', blocker: 'E2E boom', pw: 3, instruction: '重測 E2E' });
    await runRejectTriage(id, userId);
    const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
    expect(t.status).toBe('review_pending');   // 不進 E2E，直接送審
    const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1", [id]);
    expect(logs.some(l => l.content.includes('E2E 已依專案設定停用，跳過'))).toBe(true);
  } finally {
    await dbModule.query('UPDATE projects SET e2e_disabled=false WHERE id=$1', [projectId]);
  }
});

test('resolve 入口 resume → 回原關（resume_status）並歸零該關計數器', async () => {
  claudeReturns({ decision: 'resume', summary: '結論：環境已修，回原關重跑。' });
  const id = await makeTask({ status: 'resolve_triage', resume_status: 'qa_running', blocker: 'QA env boom', qa: 3, instruction: '環境弄好了，再跑一次' });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count, resume_status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('qa_running');
  expect(t.qa_retry_count).toBe(0);
  expect(t.resume_status).toBeNull();
});

// ---- 邊界 ----

test('agent 未回 summary → 不因缺欄位丟例外，fix 仍轉 coding_running', async () => {
  claudeReturns({ decision: 'fix' });
  const id = await makeTask({ rejectCount: 1 });
  await expect(runRejectTriage(id, userId)).resolves.toBe(true);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
});

test('advance 但 target 不合法 → 保守退回 resume（回原關）', async () => {
  claudeReturns({ decision: 'advance', target: 'done', summary: '想跳到完成' });  // done 不在白名單
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('review_pending');   // reject 入口的原關
});

test('無有效 result → stopped', async () => {
  runClaude.mockResolvedValue({ text: '沒有標記', usage: null, durationMs: null });
  const id = await makeTask({ rejectCount: 1 });
  await runRejectTriage(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
});
