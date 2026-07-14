// 意圖：QA 對照 SD 判定 diff。pass 往下 merge、fail 退 coding 並依關卡計數，
// 連續失敗達上限改為 stopped（人工介入），無有效結果視為失敗停止。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ ...jest.requireActual('../pipeline/claude-runner'), runClaude: jest.fn() }));
jest.mock('../pipeline/task-agent', () => {
  const actual = jest.requireActual('../pipeline/task-agent');
  return { ...actual, getProjectInfo: jest.fn() };
});

let dbModule, runQaAgent, taskAgent, runClaude;
let userId, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  const pool = new Pool();
  // pg-mem 缺陷 shim（同 workflow-scenarios）：pg-mem 把 LIKE 的 '[' 誤當 regex 字元類，
  // '[QA 未通過]%' 前綴查詢永遠 0 列；改寫成 substring 前綴比較以還原真 PG 語意。
  const rawQuery = pool.query.bind(pool);
  pool.query = (sql, ...rest) => {
    if (typeof sql === 'string') {
      sql = sql.replace(/(\w+)\s+LIKE\s+'(\[[^%']*)%'/g, (_, col, prefix) => `substring(${col}, 1, ${prefix.length}) = '${prefix}'`);
    }
    return rawQuery(sql, ...rest);
  };
  dbModule._setPoolForTesting(pool);
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('qa', $1, 'Q') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('QP', '17.0') RETURNING id"
  );
  projectId = p.id;

  taskAgent = require('../pipeline/task-agent');
  ({ runClaude } = require('../pipeline/claude-runner'));
  ({ runQaAgent } = require('../pipeline/qa-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  runClaude.mockReset();
  taskAgent.getProjectInfo.mockReset();
  taskAgent.getProjectInfo.mockResolvedValue({
    name: 'QP', odoo_version: '17.0', root: '/repos/qp',
    repos: [{ subdir: 'main', local_path: '/repos/qp/main' }]
  });
});

let seq = 0;
async function makeTask(qaCount = 0) {
  seq++;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, git_branch, analysis_yaml, qa_retry_count)
     VALUES ($1,$2,'odoo','T','qa_running',$3,'task/x','module: sale',$4) RETURNING id`,
    [userId, `qa_${seq}`, projectId, qaCount]
  );
  return t.id;
}

function claudeReturns(json) {
  runClaude.mockResolvedValue({
    text: `前置輸出\n<result>\n${JSON.stringify(json)}\n</result>`, usage: null, durationMs: null
  });
}

test('verdict pass → merge_running', async () => {
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask();
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
});

test('verdict fail 未達上限 → coding_running、計數+1、issues 進 log', async () => {
  claudeReturns({ verdict: 'fail', issues: ['第1條未實作'], summary: '修這個' });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count, reentry_count, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_retry_count).toBe(1);
  expect(t.reentry_count).toBe(1); // C-5：退回 coding 累加總循環次數
  // summary（給實作 Agent 的修正指引）要進 retry_feedback，不能因 issues 存在被丟棄
  expect(t.retry_feedback).toContain('修正指引：修這個');
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [id]);
  expect(logs.some(l => l.content.includes('第1條未實作'))).toBe(true);
  // [QA 未通過] log 是下一輪 QA 的未解清單，修正指引不得混入被當成待驗項
  expect(logs.some(l => l.content.includes('修正指引'))).toBe(false);
});

test('verdict fail 第 5 次 → stopped', async () => {
  claudeReturns({ verdict: 'fail', issues: ['又錯'] });
  const id = await makeTask(4); // 已 4 次，本次是第 5 次（QA_LIMIT=5）
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.qa_retry_count).toBe(5);
});

// 收斂關鍵：QA 每輪必須看到上一輪的未解清單，才能逐項重驗、不重新發散。
// 這條意圖若默默失效，迴圈會退回「每輪各抓不同子集」的打轉，故明確鎖住。
test('上一輪 [QA 未通過] 會帶入本輪 QA 的 prompt', async () => {
  claudeReturns({ verdict: 'fail', issues: ['沿用問題'] });
  const id = await makeTask(0);
  // 正式格式為「[QA 未通過]\n<清單>」，但 pg-mem 的 LIKE '%' 不跨換行（正式 Postgres 會），
  // 故 seed 用標頭+空白；查詢前綴比對與 strip 的 \s* 對空白/換行行為一致，僅 pg-mem 換行處理不同。
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
    [id, '[QA 未通過] 按鈕位置未緊鄰新增按鈕']
  );
  await runQaAgent(id, userId);
  const sentPrompt = runClaude.mock.calls[0][0];
  expect(sentPrompt).toContain('按鈕位置未緊鄰新增按鈕');
  expect(sentPrompt).not.toContain('[QA 未通過]'); // 標頭已剝除，只留清單本體
});

test('首輪無上一輪清單 → prompt 帶入佔位字串', async () => {
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const sentPrompt = runClaude.mock.calls[0][0];
  expect(sentPrompt).toContain('（首輪，無上輪清單）');
});

test('無 RESULT-JSON → stopped', async () => {
  runClaude.mockResolvedValue({ text: '亂七八糟沒有標記', usage: null, durationMs: null });
  const id = await makeTask();
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
});

// 意圖（比照 coding 健檢 U3）：QA 重驗走 --resume 續用上輪 session（已含規格＋規則＋diff 探索），
// 只送短增量 prompt；fresh 才送全量規格。省 token 且讓重驗聚焦在未解清單。
test('QA resume：有 qa_session_id＋上輪未解清單 → --resume 短 prompt、count+1', async () => {
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask();
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-1', qa_resume_count=0 WHERE id=$1", [id]);
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','[QA 未通過]\n備註欄位未加進 form view')", [id]
  );
  await runQaAgent(id, userId);

  const opts = runClaude.mock.calls[0][1];
  expect(opts.resumeSessionId).toBe('qs-1');                       // 續用上輪 session
  expect(runClaude.mock.calls[0][0]).toContain('備註欄位未加進 form view'); // 未解清單有帶
  expect(runClaude.mock.calls[0][0]).not.toContain('module: sale');  // 不重送全量規格
  const { rows: [t] } = await dbModule.query('SELECT qa_resume_count, status FROM tasks WHERE id=$1', [id]);
  expect(t.qa_resume_count).toBe(1);
  expect(t.status).toBe('merge_running');
});

test('QA fresh：首輪（無 session）→ 全量 prompt、存 qa_session_id', async () => {
  runClaude.mockResolvedValue({
    text: '<result>{"verdict":"pass"}</result>', usage: null, durationMs: null, sessionId: 'qs-new'
  });
  const id = await makeTask();
  await runQaAgent(id, userId);
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBeUndefined();
  expect(runClaude.mock.calls[0][0]).toContain('module: sale');      // fresh 帶全量規格
  const { rows: [t] } = await dbModule.query('SELECT qa_session_id FROM tasks WHERE id=$1', [id]);
  expect(t.qa_session_id).toBe('qs-new');
});

test('QA resume 額度用完（count=2）→ 強制 fresh 全量', async () => {
  runClaude.mockResolvedValue({
    text: '<result>{"verdict":"pass"}</result>', usage: null, durationMs: null, sessionId: 'qs-gen2'
  });
  const id = await makeTask();
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-old', qa_resume_count=2 WHERE id=$1", [id]);
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','[QA 未通過]\n還是不對')", [id]
  );
  await runQaAgent(id, userId);
  expect(runClaude.mock.calls[0][1].resumeSessionId).toBeUndefined(); // 不 resume
  const { rows: [t] } = await dbModule.query('SELECT qa_session_id, qa_resume_count FROM tasks WHERE id=$1', [id]);
  expect(t.qa_session_id).toBe('qs-gen2'); // 換新世代
  expect(t.qa_resume_count).toBe(0);
});
