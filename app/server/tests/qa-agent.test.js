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

// F11 意圖：QA 執行失敗不再一律 status=stopped/blocker_type=null 黑箱；比照 deploy 接 failure-classifier——
// transient 自動重試一次（不佔計數），非 transient 把分類寫進 blocker_type，判不出才留 null 交人工。
test('F11 transient 失敗 → 自動重試一次（不計數），成功後照常判定', async () => {
  const id = await makeTask();
  runClaude
    .mockRejectedValueOnce(new Error('socket hang up'))
    .mockResolvedValueOnce({ text: '<result>{"verdict":"pass"}</result>', usage: null, durationMs: null, sessionId: 'qs' });
  await runQaAgent(id, userId);
  expect(runClaude).toHaveBeenCalledTimes(2); // 原一次＋自動重試一次
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
  expect(t.qa_retry_count).toBe(0); // 重試不佔 QA 失敗計數
});

test('F11 transient 重試後仍失敗 → stopped、blocker_type=transient', async () => {
  const id = await makeTask();
  runClaude.mockRejectedValue(new Error('ECONNRESET'));
  await runQaAgent(id, userId);
  expect(runClaude).toHaveBeenCalledTimes(2);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('transient');
});

test('F11 環境問題 → stopped、blocker_type=env（不重試）', async () => {
  const id = await makeTask();
  runClaude.mockRejectedValue(new Error('could not connect to server: connection refused'));
  await runQaAgent(id, userId);
  expect(runClaude).toHaveBeenCalledTimes(1); // 非 transient 不重試
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
});

test('F11 程式錯誤 → blocker_type=code', async () => {
  const id = await makeTask();
  runClaude.mockRejectedValue(new Error('SyntaxError: invalid syntax'));
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT blocker_type FROM tasks WHERE id=$1', [id]);
  expect(t.blocker_type).toBe('code');
});

test('F11 判不出的失敗 → stopped、blocker_type 留 null（交人工）', async () => {
  const id = await makeTask();
  runClaude.mockRejectedValue(new Error('某種說不清的錯'));
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBeNull();
});

// F12 意圖：resume 逾時若不清 stale session，人工每次解鎖都拿同一 session 重演同一 timeout、
// counter 也永不推進、永遠碰不到 QA_RESUME_LIMIT。故 timeout 要清 qa_session_id／歸零 count 讓下次降 fresh。
test('F12 resume timeout → 清 qa_session_id／歸零 qa_resume_count 後 stopped', async () => {
  const id = await makeTask();
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-stale', qa_resume_count=1 WHERE id=$1", [id]);
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','[QA 未通過]\n舊問題')", [id]);
  runClaude.mockRejectedValue(Object.assign(new Error('claude 執行逾時（600s）'), { claudeStatus: 'timeout' }));
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_session_id, qa_resume_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.qa_session_id).toBeNull(); // stale session 已清，下次解鎖降 fresh 讀新脈絡
  expect(t.qa_resume_count).toBe(0);
});

// F13 意圖：verdict 用嚴格 === 比對時，大小寫／空白變體會整包落到「無效結果」stopped，
// 最痛的是 FAIL＋完整 issues 被丟棄、不退 coding、log 不寫。正規化後各變體要落到既有 handler。
test('F13 verdict 大寫 FAIL → 退 coding（不被當無效結果丟棄）', async () => {
  claudeReturns({ verdict: 'FAIL', issues: ['大寫也要退 coding'] });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_retry_count).toBe(1);
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [id]);
  expect(logs.some(l => l.content.includes('大寫也要退 coding'))).toBe(true);
});

test('F13 verdict 前後空白＋大寫 " PASS " → merge_running', async () => {
  claudeReturns({ verdict: ' PASS ' });
  const id = await makeTask();
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
});

// R1 意圖：QA agent 掛在 API 過載（529/500）時應比照網路抖動自動重試一次，
// 不可停等人工再燒一次分診才得出「重跑就好」的結論。
test('R1 QA 遇 529 overloaded → 自動重試一次成功 → merge_running', async () => {
  const id = await makeTask();
  runClaude
    .mockRejectedValueOnce(Object.assign(new Error('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), { claudeStatus: 'error' }))
    .mockResolvedValueOnce({ text: '<result>\n{"verdict":"pass"}\n</result>', usage: null, durationMs: null });
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
  expect(t.qa_retry_count).toBe(0); // infra 重試不佔 QA 計數
  expect(runClaude).toHaveBeenCalledTimes(2);
});

// R2 意圖：verdict 詞形變體（passed/failed）語意完全明確，不可被當「未回傳有效結果」丟棄整輪審查。
test('R2 verdict "passed" → merge_running', async () => {
  claudeReturns({ verdict: 'passed' });
  const id = await makeTask();
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('merge_running');
});

test('R2 verdict "failed"＋issues → 退 coding', async () => {
  claudeReturns({ verdict: 'failed', issues: ['詞形變體也要退 coding'] });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_retry_count).toBe(1);
});

// R3 意圖：fail 卻沒任何可行動細節（issues/summary 皆空）＝無效審查。退 coding 只會讓實作
// Agent 拿「未提供細節」瞎改一輪、還污染下一輪 QA 的未解清單。應重問一次，仍無細節才停等人工。
test('R3 fail 無細節 → 重問一次拿到細節 → 退 coding、log 無「未提供細節」', async () => {
  const id = await makeTask(0);
  runClaude
    .mockResolvedValueOnce({ text: '<result>\n{"verdict":"fail","issues":[]}\n</result>', usage: null, durationMs: null })
    .mockResolvedValueOnce({ text: '<result>\n{"verdict":"fail","issues":["真正的問題"]}\n</result>', usage: null, durationMs: null });
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_retry_count).toBe(1); // 無效那輪不計數，有效 fail 才計
  expect(runClaude).toHaveBeenCalledTimes(2);
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [id]);
  expect(logs.some(l => l.content.includes('真正的問題'))).toBe(true);
  expect(logs.some(l => l.content.includes('未提供細節'))).toBe(false); // 污染源不得進未解清單
});

test('R3 連兩輪 fail 皆無細節 → stopped、不退 coding、不寫 [QA 未通過] log', async () => {
  const id = await makeTask(0);
  runClaude.mockResolvedValue({ text: '<result>\n{"verdict":"fail","issues":[],"summary":""}\n</result>', usage: null, durationMs: null });
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.qa_retry_count).toBe(0);
  expect(t.blocker_content).toContain('連兩輪');
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND content LIKE '[QA 未通過]%'", [id]);
  expect(logs.length).toBe(0);
});

// R4 意圖：timeout 是 infra 而非程式問題，停下時要標 blocker_type='env'（比照 deploy 關），
// 人工/分診一眼識別，不必讀 blocker 文字猜。
test('R4 fresh QA timeout → stopped、blocker_type=env', async () => {
  const id = await makeTask();
  runClaude.mockRejectedValue(Object.assign(new Error('claude 執行逾時（600s）'), { claudeStatus: 'timeout' }));
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
});

// 意圖：QA 判規格歧義（spec_questions 非空）→ 進 clarify_pending 批次問人，不退 coding、不加 qa_retry_count。
test('spec_questions 非空 → clarify_pending、批次問題、不加 qa_retry_count', async () => {
  claudeReturns({ verdict: 'fail', spec_questions: ['金額用單價還是小計?', '要不要含稅?'], issues: ['順帶：按鈕漏綁'] });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count, resume_status, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('clarify_pending');
  expect(t.qa_retry_count).toBe(0);           // 規格裁決非 code-fix 輪，不計數
  expect(t.resume_status).toBe('coding_running');
  expect(t.retry_feedback).toContain('按鈕漏綁'); // 同輪 code 問題暫存，答完一次補
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [id]);
  expect(logs.some(l => l.content.includes('金額用單價還是小計?') && l.content.includes('要不要含稅?'))).toBe(true);
});

// 回歸：fail 但無 spec_questions → 照舊退 coding（反轉舉證：漏給類別＝維持現況）。
test('fail 無 spec_questions → 照舊 coding_running、qa_retry_count+1', async () => {
  claudeReturns({ verdict: 'fail', issues: ['純 code bug'] });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_retry_count).toBe(1);
});

// 意圖：純規格歧義（spec_questions 非空、issues/summary 皆空）不可被 R3「無細節」誤攔，
// 必須直接進 clarify_pending 問使用者，且只呼叫一次 QA（不重問、不 stopped）。
test('純 spec_questions（無 issues/summary）→ clarify_pending，不被 R3 攔截', async () => {
  claudeReturns({ verdict: 'fail', spec_questions: ['金額用單價還是小計?'], issues: [], summary: '' });
  const id = await makeTask(0);
  await runQaAgent(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, qa_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('clarify_pending');
  expect(t.qa_retry_count).toBe(0);
  expect(runClaude).toHaveBeenCalledTimes(1); // 沒有被 R3 重問
});
