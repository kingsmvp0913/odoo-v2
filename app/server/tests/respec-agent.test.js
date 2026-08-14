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
  // respec 判「無規格變更」時會寫一行 task_logs 交代原因（否則使用者看不到任務為何轉了一圈），
  // 不一併清會讓下一個 test 的 DELETE tasks 撞 task_logs 的 FK。
  await dbModule.query('DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE user_id=$1)', [userId]);
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

// 途中追加需求改寫規格後，若不清 qa_session_id，下輪 QA 會 resume 舊 session（內嵌舊 analysis_yaml、
// qa-retry prompt 不帶新規格）＝用舊規格審查。故要一併清 session／歸零 count，強制下輪 QA 跑 fresh 讀新規格。
test('途中追加需求：一併清 qa_session_id／歸零 qa_resume_count（強制下輪 QA fresh）', async () => {
  const taskId = await insertTask('module: sale');
  await dbModule.query("UPDATE tasks SET qa_session_id='qs-old', qa_resume_count=2 WHERE id=$1", [taskId]);
  await addMsg(taskId, '追加需求 X');
  runClaude.mockResolvedValue({ text: '<result>\nmodule: sale\nnote: patched\n</result>', usage: null, durationMs: null });

  await runRespecPatch(taskId, userId, undefined);

  const { rows: [t] } = await dbModule.query('SELECT status, qa_session_id, qa_resume_count FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('coding_running');
  expect(t.qa_session_id).toBeNull();   // 舊 QA session 清掉，下輪跑 fresh 讀新規格
  expect(t.qa_resume_count).toBe(0);
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

// 縫（stage2-B）：coding fresh 成功但 CLI 沒回 sessionId 時 task-agent 存 NULL（task-agent 以 COALESCE
// 防的就是這件事）。若 respec 只看 coding_session_id 判 pre-coding，已併版部署中的任務留言會被
// 誤送回 spec_review（規格審核閘門）——任務倒退過 merge、審核頁還叫使用者重新確認規格。
// git_branch 在 branch_pending→coding 轉移時必寫，是「已開工」的可靠訊號。
test('已開工但 coding_session_id=NULL（CLI 沒回 sessionId）→ 退回 coding，不誤回 spec_review', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, analysis_yaml, coding_session_id, git_branch)
     VALUES ($1, $2, 'odoo', 'T', 'c', 'respec_running', $3, 'module: sale', NULL, 'task/t_null_sess') RETURNING id`,
    [userId, `t_${Date.now()}`, projectId]
  );
  await addMsg(t.id, '加一個欄位');
  runClaude.mockResolvedValue({ text: '<result>\nmodule: sale\nrequirements:\n  - 加一個欄位\n</result>', usage: null, durationMs: null });
  await runRespecPatch(t.id, userId);
  const { rows: [after] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('coding_running');
  expect(after.retry_feedback).toContain('加一個欄位');
});

// 意圖：使用者要推進卡住的任務，唯一管道就是留言框——所以「用留言下流程指令」是常態，不是誤用。
// 這種留言被檢查點攔下轉進 respec 後，規格會一字未動；舊版仍照樣退回 coding，害 coding→QA→merge
// →deploy 整條白跑一遍（task 171：一句「已修正，直接推進到部署測試區」在 deploy 成功後觸發重跑）。
// 用 review_pending 當回程值才有鑑別力：若用 coding_running，修好與沒修的結果一模一樣、測不出東西。
test('留言不含規格變更 → 回原本要去的那一關，不退 coding、不清 qa_session_id', async () => {
  const yamlSpec = 'module: sale\nfeatures:\n  - 折扣欄位';
  const taskId = await insertTask(yamlSpec);
  await dbModule.query(
    "UPDATE tasks SET respec_return_status='review_pending', qa_session_id='qs-keep' WHERE id=$1", [taskId]
  );
  await addMsg(taskId, '確認升級失敗是其他問題造成，已修正，直接推進到部署測試區環節');
  // 規格原樣回傳＝respec 判定這則留言沒有帶來規格變更
  runClaude.mockResolvedValue({ text: `<result>\n${yamlSpec}\n</result>`, usage: null, durationMs: null });

  await runRespecPatch(taskId, userId, undefined);

  const { rows: [t] } = await dbModule.query(
    'SELECT status, respec_return_status, retry_feedback, qa_session_id FROM tasks WHERE id=$1', [taskId]
  );
  expect(t.status).toBe('review_pending');        // 回原關續跑，不是退回 coding
  expect(t.respec_return_status).toBeNull();      // 用完即清，不留給下一次誤用
  expect(t.retry_feedback).toBeNull();            // 沒有新需求要交代給 coding
  expect(t.qa_session_id).toBe('qs-keep');        // 規格沒變，QA 舊 session 可續用，不必強制 fresh
  const { rows: [m] } = await dbModule.query('SELECT applied_at FROM task_messages WHERE task_id=$1', [taskId]);
  expect(m.applied_at).not.toBeNull();            // 仍要銷帳，否則下個推進點又被攔一次
});

// 反向守衛：上面那條捷徑不能把「真的有追加需求」也一起放行——規格有變就必須退回 coding 補實作。
test('留言含實質規格變更 → 仍退回 coding（回程值不得蓋過追加需求）', async () => {
  const taskId = await insertTask('module: sale\nfeatures:\n  - 折扣欄位');
  await dbModule.query("UPDATE tasks SET respec_return_status='review_pending' WHERE id=$1", [taskId]);
  await addMsg(taskId, '請加匯出 Excel 按鈕');
  runClaude.mockResolvedValue({
    text: '<result>\nmodule: sale\nfeatures:\n  - 折扣欄位\n  - 匯出 Excel 按鈕\n</result>',
    usage: null, durationMs: null
  });

  await runRespecPatch(taskId, userId, undefined);

  const { rows: [t] } = await dbModule.query(
    'SELECT status, respec_return_status, retry_feedback FROM tasks WHERE id=$1', [taskId]
  );
  expect(t.status).toBe('coding_running');        // 有新需求＝一定要回去補實作
  expect(t.respec_return_status).toBeNull();
  expect(t.retry_feedback).toContain('匯出 Excel 按鈕');
});

// 意圖：路由旗標是「規格有無實質變更」，但 agent 是否逐字複製原規格本來就不可控——
// respec-patch.md 自己也寫著「不必為此刻意逐字複製」。位元組比對會把重排鍵序／換引號／改縮排
// 全判成「有變更」，把已跑到 QA/deploy 的任務打回開發重跑整條。這支釘住語意比對。
test('規格只有排版差異（鍵序／引號／縮排）→ 視為未變更，回原關不退 coding', async () => {
  const taskId = await insertTask("module: sale\nfeatures:\n  - 折扣欄位\nowner: 'IDX'");
  await dbModule.query("UPDATE tasks SET respec_return_status='review_pending' WHERE id=$1", [taskId]);
  await addMsg(taskId, '已修正，直接推進');
  // 同一份規格：鍵序調換、引號風格改變、縮排加寬——語意完全相同
  runClaude.mockResolvedValue({
    text: '<result>\nowner: "IDX"\nmodule: sale\nfeatures:\n    - 折扣欄位\n</result>',
    usage: null, durationMs: null
  });

  await runRespecPatch(taskId, userId, undefined);

  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('review_pending');   // 沒被排版差異騙去退 coding
  expect(t.retry_feedback).toBeNull();
});

// 反向守衛：語意比對不能寬鬆到把真需求也吃掉。陣列順序刻意視為實質變更（requirements 有序）。
test('規格內容真的多一條 → 仍判有變更、退回 coding', async () => {
  const taskId = await insertTask('module: sale\nfeatures:\n  - 折扣欄位');
  await dbModule.query("UPDATE tasks SET respec_return_status='review_pending' WHERE id=$1", [taskId]);
  await addMsg(taskId, '請加匯出 Excel 按鈕');
  runClaude.mockResolvedValue({
    text: '<result>\nmodule: sale\nfeatures:\n  - 折扣欄位\n  - 匯出 Excel 按鈕\n</result>',
    usage: null, durationMs: null
  });

  await runRespecPatch(taskId, userId, undefined);

  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('coding_running');
  expect(t.retry_feedback).toContain('匯出 Excel 按鈕');
});

// 解析失敗時必須落到位元組比對的保守側：寧可誤判成「有變更」多跑一輪，也不要把真需求
// 當成沒變更而靜默丟掉（那會讓使用者的需求人間蒸發且毫無痕跡）。
test('舊規格不是合法 YAML → 退回位元組比對，內容不同仍判有變更', async () => {
  const taskId = await insertTask('這不是 YAML: [[[壞掉的');
  await dbModule.query("UPDATE tasks SET respec_return_status='review_pending' WHERE id=$1", [taskId]);
  await addMsg(taskId, '請加匯出功能');
  runClaude.mockResolvedValue({ text: '<result>\nmodule: sale\nfeatures:\n  - 匯出\n</result>', usage: null, durationMs: null });

  await runRespecPatch(taskId, userId, undefined);

  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('coding_running');
});

// 規格裡的視覺數值（色碼／px／選擇器）是分析關看著附件截圖量出來的，而這一關會整份重產規格。
// prompt 不帶附件路徑＝重產時只能憑既有 YAML 的文字猜，猜錯就把量出來的值靜默覆蓋掉——
// 測試不紅、QA 只有新規格可比，完全無訊號。同「人工退回的規格層要求被靜默抹掉」的 bug 家族。
test('prompt 帶【任務附件】絕對路徑（無附件則整個區塊不出現）', async () => {
  const path = require('path');
  const { uploadRoot } = require('../lib/attachments');
  const spec = 'module: sale\nrequirements:\n  - 首頁主按鈕背景 #1B2A4A';

  const withAtt = await insertTask(spec);
  await addMsg(withAtt, '按鈕再大一點');
  await dbModule.query(
    `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin)
     VALUES ($1, '參考站首頁.png', 'image/png', $2, 'manual')`,
    [withAtt, `task_${withAtt}/1_參考站首頁.png`]
  );
  runClaude.mockResolvedValue({ text: `<result>\n${spec}\n</result>`, usage: null, durationMs: null });
  await runRespecPatch(withAtt, userId, undefined);

  const prompt = runClaude.mock.calls[0][0];
  expect(prompt).toContain('【任務附件】');
  expect(prompt).toContain(path.resolve(uploadRoot(), `task_${withAtt}/1_參考站首頁.png`));

  runClaude.mockClear();
  const noAtt = await insertTask(spec);
  await addMsg(noAtt, '按鈕再大一點');
  await runRespecPatch(noAtt, userId, undefined);
  expect(runClaude.mock.calls[0][0]).not.toContain('【任務附件】');
});
