jest.mock('../pipeline/claude-runner', () => ({
  runClaude: jest.fn(),
  stopReason: (label, err) => `${label}失敗：${err.message}`
}));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));

const { newDb } = require('pg-mem');
const { runClaude } = require('../pipeline/claude-runner');
let dbModule;

const { parseClarifyChat, runClarifyChat, loadConversation } = require('../pipeline/clarify-chat');

test('parseClarifyChat：answer 只取 DECISION 與 REPLY，不得有題目', () => {
  const out = parseClarifyChat('DECISION: answer\nREPLY:\n分頁是指超過 40 筆時只顯示前 40 筆。\n第二行也算回覆。');
  expect(out.decision).toBe('answer');
  expect(out.reply).toBe('分頁是指超過 40 筆時只顯示前 40 筆。\n第二行也算回覆。');
  expect(out.questions_yaml).toBeNull();
});

test('parseClarifyChat：proceed 是獨立決策，不會被當成 answer', () => {
  const out = parseClarifyChat('DECISION: proceed\nREPLY:\n了解，開始實作。');
  expect(out.decision).toBe('proceed');
});

test('parseClarifyChat：revise 必須帶可解析的 QUESTIONS，reply 與 yaml 正確切開', () => {
  const raw = [
    'DECISION: revise',
    'REPLY:',
    '我把第二題刪掉了。',
    '---QUESTIONS---',
    'intro: 說明段',
    'questions:',
    '  - id: q1',
    '    text: 要自動重編嗎？',
    '    type: text',
    '    required: true'
  ].join('\n');
  const out = parseClarifyChat(raw);
  expect(out.decision).toBe('revise');
  expect(out.reply).toBe('我把第二題刪掉了。');
  expect(out.questions_yaml).toContain('intro: 說明段');
});

// 壞輸出一律丟例外 → 上層退回原狀態，絕不把壞資料寫進 analysis_yaml
test('parseClarifyChat：revise 缺 QUESTIONS 區塊 → 丟例外', () => {
  expect(() => parseClarifyChat('DECISION: revise\nREPLY:\n改好了')).toThrow();
});

test('parseClarifyChat：revise 的 QUESTIONS 不是合法 YAML 物件 → 丟例外', () => {
  expect(() => parseClarifyChat('DECISION: revise\nREPLY:\nx\n---QUESTIONS---\n: : :')).toThrow();
});

test('parseClarifyChat：缺 DECISION → 丟例外', () => {
  expect(() => parseClarifyChat('REPLY:\n沒有決策')).toThrow();
});

test('parseClarifyChat：缺 REPLY → 丟例外（使用者一定要看到回覆）', () => {
  expect(() => parseClarifyChat('DECISION: answer\nREPLY:\n   ')).toThrow();
});

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, approved) VALUES ('u','x','U','admin',true)"
  );
});

async function makeTask(status) {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, analysis_yaml) VALUES (1,$1,'odoo','T',$2,'summary: s') RETURNING *",
    [`t_${status}_${Math.floor(Math.random() * 1e6)}`, status]
  );
  return rows[0];
}

test('送出回答時使用者其實在反問 → answer → 狀態留 confirm_pending、沒有推進（task 5 回歸）', async () => {
  const task = await makeTask('clarify_chat_running');
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: answer\nREPLY:\n分頁是指……\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat(task, 1, null, 'answer_or_proceed');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_pending');
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [task.id]);
  expect(logs[0].content).toContain('分頁');
});

test('答齊了 → proceed → confirm_answered', async () => {
  const task = await makeTask('clarify_chat_running');
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: proceed\nREPLY:\n了解，開始實作。\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat(task, 1, null, 'answer_or_proceed');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_answered');
});

// I2 回歸：proceed 時若殘留舊草案（先前 revise 產生、使用者沒套用也沒放棄），必須清掉——
// 否則之後若又重跑分析回到 confirm_pending 產生新題目，前端仍讀到過期草案，使用者按套用會把
// 新題目整組覆蓋成舊的（掉資料）。
test('proceed 時清掉殘留的 clarify_draft，避免之後覆蓋新題目', async () => {
  const task = await makeTask('clarify_chat_running');
  await dbModule.query("UPDATE tasks SET clarify_draft='intro: 舊草案' WHERE id=$1", [task.id]);
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: proceed\nREPLY:\n了解，開始實作。\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat({ id: task.id }, 1, null, 'answer_or_proceed');
  const { rows } = await dbModule.query('SELECT status, clarify_draft FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_answered');
  expect(rows[0].clarify_draft).toBeNull();
});

test('提問入口即使 agent 硬回 proceed 也推不動（結構性限制，不靠 prompt 自律）', async () => {
  const task = await makeTask('clarify_chat_running');
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: proceed\nREPLY:\n我要往前跑\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat(task, 1, null, 'ask');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_pending');
});

// 草案「產生 → 給人看 → 手動套用」兩段式已退役：實測使用者按了「更新規格書 QA」以為題目就更新了，
// 其實還停在草案、要再按一次「套用」，於是他看著過期題目在對話裡把講過的話重講一遍（正式站 task 171）。
// 現在 revise 一律就地併進 analysis_yaml，且不得留下 clarify_draft——留著的話下游會拿過期草案覆蓋新題目。
test('revise → 新題目就地併進 analysis_yaml，且不留下會覆蓋它的舊草案', async () => {
  const task = await makeTask('clarify_chat_running');
  runClaude.mockResolvedValueOnce({
    text: '<result>\nDECISION: revise\nREPLY:\n調整了\n---QUESTIONS---\nintro: 新說明\nquestions: []\n</result>',
    usage: {}, durationMs: 1
  });
  // mode 用 'ask'：獨立的 revise 入口（手動按「更新規格書 QA」）已經退役，題目改寫一律
  // 發生在提問對話中。挑 'ask' 才有鑑別力——它同時證明 ask 允許 revise（舊規則只准 answer）。
  await runClarifyChat(task, 1, null, 'ask');
  const { rows } = await dbModule.query('SELECT status, clarify_draft, analysis_yaml FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_pending');
  expect(rows[0].analysis_yaml).toContain('新說明');   // 就地更新，使用者當場看到最新結論
  expect(rows[0].analysis_yaml).toContain('summary');   // 併入而非整包覆寫，既有規格仍在
  expect(rows[0].clarify_draft).toBeNull();             // 留著草案＝下游會用它覆蓋新題目
});

// 就地改寫的代價：寫壞就直接毀掉規格。既有 analysis_yaml 解析不出來時寧可讓題目維持原樣，
// 也不能拿 AI 這輪的產出去覆蓋——並且要讓使用者看得到「這次沒更新」，不是靜靜地失敗。
test('revise 但既有規格解析不了 → analysis_yaml 原封不動，且時間軸講明沒更新', async () => {
  const task = await makeTask('clarify_chat_running');
  const broken = 'summary: [這行沒收尾';
  await dbModule.query('UPDATE tasks SET analysis_yaml=$2, clarify_mode=$3 WHERE id=$1', [task.id, broken, 'ask']);
  runClaude.mockResolvedValueOnce({
    text: '<result>\nDECISION: revise\nREPLY:\n調整了\n---QUESTIONS---\nintro: 新說明\nquestions: []\n</result>',
    usage: {}, durationMs: 1
  });
  await runClarifyChat({ id: task.id }, 1, null, null);
  const { rows } = await dbModule.query('SELECT status, analysis_yaml FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].analysis_yaml).toBe(broken);
  expect(rows[0].status).toBe('confirm_pending');
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai' ORDER BY id", [task.id]);
  expect(logs[logs.length - 1].content).toContain('沒有更新');
});

test('agent 失敗 → 狀態退回 confirm_pending，不是 stopped', async () => {
  const task = await makeTask('clarify_chat_running');
  runClaude.mockRejectedValueOnce(new Error('claude exited with code 1'));
  await runClarifyChat(task, 1, null, 'answer_or_proceed');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_pending');
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [task.id]);
  expect(logs[logs.length - 1].content).toContain('請再送出一次');
});

// claude-runner 對認證失效已標 claudeStatus='auth'（auth-signature.js）——訊息要讓使用者
// 知道跟他的回答無關，否則他會以為自己答錯而反覆改答案
test('認證失效 → 訊息點明與回答無關，狀態一樣退回不 stopped', async () => {
  const task = await makeTask('clarify_chat_running');
  const err = new Error('Claude CLI 未登入或認證失效：Not logged in');
  err.claudeStatus = 'auth';
  runClaude.mockRejectedValueOnce(err);
  await runClarifyChat(task, 1, null, 'answer_or_proceed');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_pending');
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [task.id]);
  expect(logs[logs.length - 1].content).toContain('與你的回答無關');
});

test('clarify_pending 來的任務：proceed 進 clarify_answered', async () => {
  const task = await makeTask('clarify_chat_running');
  // 執行器現在會依 taskId 重查完整列（見 task 4 修復），mutate 記憶體物件不會生效，須真的寫進 DB
  // 回程狀態走 clarify_from（非 resume_status——那欄是 verdict-router／reject-triage 的「回去哪一關」）。
  await dbModule.query("UPDATE tasks SET clarify_from='clarify_pending' WHERE id=$1", [task.id]);
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: proceed\nREPLY:\n收到裁決\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat(task, 1, null, 'answer_or_proceed');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('clarify_answered');
});

// C1 回歸：clarify_pending 來的任務（QA 規格裁決）走完整條路後，proceed 必須回 clarify_answered，
// 且 verdict-router 寫在 resume_status 的「要回去哪一關」不得被洗掉（曾經被路由／runner 誤蓋成
// clarify_chat_running，導致執行器誤判回 confirm_pending、任務整包重跑分析）。
test('clarify_pending 任務：clarify_from 記回程，resume_status 保持 verdict-router 寫的值', async () => {
  const task = await makeTask('clarify_chat_running');
  await dbModule.query(
    "UPDATE tasks SET clarify_from='clarify_pending', clarify_mode='answer_or_proceed', resume_status='coding_running' WHERE id=$1",
    [task.id]
  );
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: proceed\nREPLY:\n收到裁決\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat({ id: task.id }, 1, null, null);
  const { rows } = await dbModule.query('SELECT status, resume_status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('clarify_answered');
  expect(rows[0].resume_status).toBe('coding_running'); // 不得被澄清流程洗掉
});

// 未知 mode 是程式 bug，但降級方向決定它是「安全地少做」還是「危險地多做」
test('未知的 mode → 退到最嚴格（只准 answer），不得靜默變成可推進', async () => {
  const task = await makeTask('clarify_chat_running');
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: proceed\nREPLY:\n我要往前跑\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat(task, 1, null, 'typo_mode');
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_pending');
});

// 手動暫停＝正常流程：狀態原地不動、時間軸不留錯誤訊息（比照 runner.js 的 abort 慣例）
test('補救解析階段被手動暫停 → 例外往上傳，不得寫成「AI 回覆失敗」', async () => {
  const task = await makeTask('clarify_chat_running');
  runClaude.mockResolvedValueOnce({ text: '這不是合法的 result 格式', usage: {}, durationMs: 1 });
  // 讓補救呼叫拋出 aborted 例外（parseAgentResult 唯一會往外拋的情況）
  const aborted = new Error('aborted');
  aborted.aborted = true;
  runClaude.mockRejectedValueOnce(aborted);
  await expect(runClarifyChat(task, 1, null, 'answer_or_proceed')).rejects.toThrow();
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [task.id]);
  expect(logs.some(l => l.content.includes('AI 回覆失敗'))).toBe(false);
});

// runner 派工的 task 物件只有六個欄位（runner.js:425），執行器若直接用它，agent 會拿到「（無規格）」
test('只給精簡 task 物件時自己重查：agent 仍拿得到 analysis_yaml', async () => {
  const task = await makeTask('clarify_chat_running');
  await dbModule.query("UPDATE tasks SET clarify_mode='answer_or_proceed' WHERE id=$1", [task.id]);
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: answer\nREPLY:\n好\n</result>', usage: {}, durationMs: 1 });
  // 模擬 runner 的精簡列
  await runClarifyChat({ id: task.id, task_id: task.task_id, status: 'clarify_chat_running', user_id: 1, project_id: null, blocker_content: null }, 1, null, null);
  expect(runClaude).toHaveBeenCalled();
  const prompt = runClaude.mock.calls[runClaude.mock.calls.length - 1][0];
  expect(prompt).toContain('summary: s');   // makeTask 寫入的 analysis_yaml
  expect(prompt).not.toContain('（無規格）');
});

// 這條驗的是「ask 規則本身會擋住 proceed」這個行為，不是在證明 mode 有從 DB 讀出來——
// 未知/空 mode 的降級目標剛好也是 MODE_RULES.ask，allow 完全相同，讀不到 clarify_mode 也會走到一樣的結果，
// 沒有鑑別力去證明「DB 讀取」這件事（鑑別力的證明見下一條 answer_or_proceed 版本）。
test('clarify_mode=ask 的任務即使 agent 回 proceed 也推不動', async () => {
  const task = await makeTask('clarify_chat_running');
  await dbModule.query("UPDATE tasks SET clarify_mode='ask' WHERE id=$1", [task.id]);
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: proceed\nREPLY:\n我要往前跑\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat({ id: task.id }, 1, null, null);
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_pending');
});

// mode 走 DB 而非參數：這條的鑑別力在於「讀到 answer_or_proceed 才會放行 proceed」——
// 若 mode 讀不到而退到 fallback（只准 answer），狀態會卡在 confirm_pending 而非 confirm_answered。
test('mode 從 tasks.clarify_mode 讀：讀到 answer_or_proceed 時 proceed 才放行', async () => {
  const task = await makeTask('clarify_chat_running');
  await dbModule.query("UPDATE tasks SET clarify_mode='answer_or_proceed' WHERE id=$1", [task.id]);
  runClaude.mockResolvedValueOnce({ text: '<result>\nDECISION: proceed\nREPLY:\n了解，開始實作。\n</result>', usage: {}, durationMs: 1 });
  await runClarifyChat({ id: task.id }, 1, null, null);
  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(rows[0].status).toBe('confirm_answered');
});

test('回帶對話必須含 AI 發言：只帶 user 會讓分析 agent 看不到自己問過什麼而重複追問（B 回歸）', async () => {
  const task = await makeTask('confirm_pending');
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai','請問項次要自動編號嗎？')", [task.id]);
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','不用')", [task.id]);
  const conv = await loadConversation(task.id);
  expect(conv).toContain('AI：請問項次要自動編號嗎？');
  expect(conv).toContain('使用者：不用');
  expect(conv.indexOf('AI：')).toBeLessThan(conv.indexOf('使用者：')); // 由舊到新
});

// 續接輪：同一場澄清對話續用同一個 claude session，省掉每輪重新探索程式碼。
// 權威規格每輪重送——session 內可能殘留 revise 前的舊版本。
test('續接輪：有 clarify_session_id ＋指紋相符 → 帶 --resume，prompt 含當前規格', async () => {
  const { promptVersion } = require('../pipeline/agent-loader');
  const ver = `${promptVersion('clarify-chat')}.${promptVersion('clarify-chat-retry')}`;
  const task = await makeTask('clarify_chat_running');
  await dbModule.query(
    "UPDATE tasks SET analysis_yaml='summary: 目前這版', clarify_session_id=$2, clarify_prompt_ver=$3 WHERE id=$1",
    [task.id, 'cl-1', ver]
  );
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','再問一題')", [task.id]);
  runClaude.mockResolvedValueOnce({
    text: '<result>\nDECISION: answer\nREPLY:\n回答\n</result>',
    usage: {}, durationMs: 1, sessionId: 'cl-1'
  });

  await runClarifyChat({ id: task.id }, 1, null, 'ask');

  // ⚠ 本檔沒有 beforeEach 重置 mock，mock.calls 跨 test 累積 —— 必須取最後一次呼叫
  const [prompt, opts] = runClaude.mock.calls.at(-1);
  expect(opts.resumeSessionId).toBe('cl-1');
  expect(prompt).toContain('目前這版');       // 權威規格重送
});

// mode 每輪重算：clarify_mode 可能與 session 開場時不同，retry prompt 必須送本輪的 mode_rule，
// 不能沿用 session 裡開場時的舊 mode——否則 AI 會誤以為自己還在舊 mode 下，
// JS 端卻已用新 mode 的 allow 清單悄悄降級決策，AI 講的話（例如「這就開始實作」）與實際不符。
// 刻意挑 answer_or_proceed（非 ask）：未知 mode 會降級成 ask，若拿 ask 的規則文字去斷言，
// 不管 mode 有沒有真的重送都會通過，沒有鑑別力（testing.md 規則 18 的同款陷阱）。
test('續接輪：本輪 mode 為 answer_or_proceed → retry prompt 帶該 mode 的規則文字', async () => {
  const { promptVersion } = require('../pipeline/agent-loader');
  const { MODE_RULES } = require('../pipeline/clarify-chat');
  const ver = `${promptVersion('clarify-chat')}.${promptVersion('clarify-chat-retry')}`;
  const task = await makeTask('clarify_chat_running');
  await dbModule.query(
    "UPDATE tasks SET clarify_session_id=$2, clarify_prompt_ver=$3 WHERE id=$1",
    [task.id, 'cl-mode', ver]
  );
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','都答完了')", [task.id]);
  runClaude.mockResolvedValueOnce({
    text: '<result>\nDECISION: proceed\nREPLY:\n了解。\n</result>',
    usage: {}, durationMs: 1, sessionId: 'cl-mode'
  });

  await runClarifyChat({ id: task.id }, 1, null, 'answer_or_proceed');

  // ⚠ 本檔沒有 beforeEach 重置 mock，取最後一次呼叫
  const [prompt] = runClaude.mock.calls.at(-1);
  expect(prompt).toContain(MODE_RULES.answer_or_proceed.rule);
});

test('推進（proceed）→ 清掉 clarify session（這場對話結束了）', async () => {
  const { promptVersion } = require('../pipeline/agent-loader');
  const ver = `${promptVersion('clarify-chat')}.${promptVersion('clarify-chat-retry')}`;
  const task = await makeTask('clarify_chat_running');
  await dbModule.query(
    'UPDATE tasks SET clarify_session_id=$2, clarify_prompt_ver=$3 WHERE id=$1',
    [task.id, 'cl-2', ver]
  );
  runClaude.mockResolvedValueOnce({
    text: '<result>\nDECISION: proceed\nREPLY:\n了解，開始實作。\n</result>',
    usage: {}, durationMs: 1, sessionId: 'cl-2'
  });

  await runClarifyChat({ id: task.id }, 1, null, 'answer_or_proceed');

  const { rows: [t] } = await dbModule.query(
    'SELECT status, clarify_session_id, clarify_prompt_ver FROM tasks WHERE id=$1', [task.id]
  );
  expect(t.status).toBe('confirm_answered');
  expect(t.clarify_session_id).toBeNull();
  expect(t.clarify_prompt_ver).toBeNull();
});
