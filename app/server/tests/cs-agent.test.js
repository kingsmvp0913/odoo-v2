const { newDb } = require('pg-mem');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({
  ...jest.requireActual('../pipeline/claude-runner'),
  runClaude: mockRunClaude
}));
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
beforeEach(() => { mockRunClaude.mockReset(); });

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
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"operation","reply":"請到報表 > 匯出","question":null}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask();
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, cs_reply FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('cs_reply_pending');
  expect(t.cs_reply).toContain('匯出');
});

// 意圖：operation 回覆也要寫進對話時間軸（role='ai'）。否則回覆只存在 cs_reply 欄、只在 cs_reply_pending
// 動作面板顯示，任務一離開該狀態（→done）面板消失＝使用者再也看不到客服回答了什麼（與 vague 問題同理）。
test('operation → 回覆寫進時間軸 task_logs（role=ai）', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"operation","reply":"請到設定 > 權限開啟該欄位"}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask();
  await runCsAgent(taskId, userId);
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [taskId]);
  expect(logs.some(l => l.content.includes('請到設定 > 權限開啟該欄位'))).toBe(true);
});

test('code_change_clear + 有專案 → analysis_running', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"code_change_clear","reply":null,"question":null}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({
    withProject: true,
    title: 'Bug in report',
    text: 'When clicking export the system crashes. Steps: 1. Go to report 2. Click export. Expected: file downloads. Actual: 500 error.'
  });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('analysis_running');
});

// 意圖：cs 深入查證後判 clear 時，其初步定因 reason 要 (1) 寫進時間軸讓使用者看到「為何判定要改程式」
// (2) 存 cs_findings 供分析關當待驗證線索，免得 cs 查過的根因被丟掉、分析從零重查（雙倍 token）。
test('code_change_clear 帶 reason → 寫時間軸＋存 cs_findings，仍進分析', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"code_change_clear","reason":"按鈕 groups 漏資材主管群組，idx_maintenance.xml:159，設定無法解決"}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({ withProject: true, title: '指派評估設定', text: '指派評估如何設定' });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, cs_findings FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('analysis_running');
  expect(t.cs_findings).toContain('資材主管');
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [taskId]);
  expect(logs.some(l => l.content.includes('[客服判定：需改程式]') && l.content.includes('資材主管'))).toBe(true);
});

// 意圖：reason 與 reason_plain 是「兩個受眾」不是「兩種措辭」。reason 依 cs.md 必須帶檔案路徑與
// Model/Method 給分析關定位，那份原文貼給使用者就是他反映看不懂的主因。所以時間軸只能出現白話那份，
// 技術那份只准進 cs_findings；兩者若又被寫成同一個字串，這個測試就會紅。
test('code_change_clear 同時帶 reason_plain → 時間軸只放白話、技術定因只進 cs_findings', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"code_change_clear","reason":"idx_maintenance.py 的 Method action_confirm 缺冪等防護 [碼]","reason_plain":"按下確認時如果系統重試，單子會被重複建立一次。這是程式寫入資料的時機有問題，設定裡關不掉。"}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({ withProject: true, title: '重複建單', text: '按確認會產生兩張單' });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, cs_findings FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('analysis_running');
  expect(t.cs_findings).toContain('action_confirm'); // 分析關仍拿得到定位資訊
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [taskId]);
  const shown = logs.find(l => l.content.includes('[客服判定：需改程式]'));
  expect(shown.content).toContain('設定裡關不掉');
  expect(shown.content).not.toContain('action_confirm'); // 技術名不得外洩到使用者眼前
  expect(shown.content).not.toContain('[碼]');
});

// fail-safe：舊 prompt／偶發漏 reason_plain 時不得讓使用者完全看不到判定理由——退回貼技術版 reason
test('code_change_clear 只有 reason、無 reason_plain → 時間軸退回貼 reason', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"code_change_clear","reason":"按鈕 groups 漏資材主管群組 [碼]"}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({ withProject: true, title: '權限', text: '看不到按鈕' });
  await runCsAgent(taskId, userId);
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [taskId]);
  expect(logs.some(l => l.content.includes('[客服判定：需改程式]') && l.content.includes('資材主管'))).toBe(true);
});

// fail-safe：model 沒吐 reason 時不得中斷——照舊進分析，cs_findings 留空，分析退回獨立重查（現況）
test('code_change_clear 無 reason → 進分析、cs_findings 留空、不寫時間軸', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"code_change_clear"}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({ withProject: true, title: 'Bug', text: 'crash' });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, cs_findings FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('analysis_running');
  expect(t.cs_findings).toBeNull();
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [taskId]);
  expect(logs.length).toBe(0);
});

test('code_change_clear + 無專案 → stopped（需先綁定專案）', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"code_change_clear","reply":null,"question":null}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({ title: 'Bug', text: 'export crashes' });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_content).toContain('綁定專案');
});

// md 契約：vague 的問題清單是 questions 陣列（前端 TaskDetail 以 JSON.parse 逐題渲染）
test('code_change_vague → cs_data_needed，questions 陣列存成 JSON', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"code_change_vague","questions":["請提供重現步驟","請提供錯誤截圖"]}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({ title: 'Something wrong', text: 'It does not work.' });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, cs_question FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('cs_data_needed');
  expect(JSON.parse(t.cs_question)).toEqual(['請提供重現步驟', '請提供錯誤截圖']);
  // 問題也要寫進時間軸（含問題本文），否則答完換面板就看不到問過什麼（B1）
  const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1 AND role='ai'", [taskId]);
  expect(logs.some(l => l.content.includes('[需要你補充資料]') && l.content.includes('請提供重現步驟'))).toBe(true);
});

// 容錯：model 偏離契約回單數 question 字串時仍可用（前端 JSON.parse 失敗會退回單題顯示）
test('code_change_vague 回單數 question 字串 → 仍存入 cs_question', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"code_change_vague","reply":null,"question":"請提供重現步驟和錯誤截圖"}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({ title: 'Something wrong', text: 'It does not work.' });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, cs_question FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('cs_data_needed');
  expect(t.cs_question).toContain('重現步驟');
});

// 回歸（task#79 真實故障）：cs 把 <result> 當中間步驟吐出後又補收尾散文／派子任務，末輪 ev.result（text）
// 就不含契約標籤。改用整段 assistantText 解析後，仍能撈回最後一組 <result> 正常路由，不再誤判 stopped。
test('末輪 text 無 <result>、assistantText 有 → 從 transcript 撈回契約正常路由', async () => {
  mockRunClaude.mockResolvedValueOnce({
    text: '背景調查完成，維持先前已送出的 code_change_vague 結果與問題不變。',   // ev.result＝收尾散文，無標籤
    assistantText: '先實地查證…\n<result>{"type":"code_change_vague","questions":["附件六階段要做到什麼程度","倉別 R06/R07 要建主檔還是只印在憑證上"]}</result>\n背景調查完成，維持先前已送出的 code_change_vague 結果與問題不變。',
    usage: null, durationMs: null
  });
  const { userId, taskId } = await makeTask({ title: '叫修單憑證修改', text: '請修改如附件' });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, cs_question FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('cs_data_needed');   // 不是 stopped
  expect(JSON.parse(t.cs_question)).toEqual(['附件六階段要做到什麼程度', '倉別 R06/R07 要建主檔還是只印在憑證上']);
});

test('重跑時把先前輪次的答案帶入 prompt（修復 cs_data_needed↔cs_running 鬼打牆）', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"code_change_clear","reply":null,"question":null}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({
    withProject: true,
    title: '報價單客戶下面加備註欄位',
    text: '在報價單客戶下面增加備註欄位'
  });
  // 模擬使用者先前輪次已透過 cs-data-submit 補充答案（寫入 task_logs）
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
    [taskId, 'Q：欄位類型？\nA：多行文字區塊\n\nQ：位置？\nA：客戶名稱下方']
  );

  await runCsAgent(taskId, userId);

  // 意圖：prompt 必須包含使用者已回答的內容，否則 agent 看不到 → 重複詢問
  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain('多行文字區塊');
  expect(prompt).toContain('客戶名稱下方');

  // 資訊已足夠 → 判 clear → 有專案 → 進分析（不再卡 cs_data_needed）
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('analysis_running');
});

// 意圖（Rule 12）：契約只有三種 type，未知值以前會靜默放行成 code_change_clear → 拿垃圾輸出繼續燒 analysis token
test('未知分類 type → stopped（不得靜默放行進分析）', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"banana"}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({ withProject: true });
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_content).toContain('未知分類');
});

test('API error → stopped', async () => {
  mockRunClaude.mockRejectedValueOnce(new Error('timeout'));
  const { userId, taskId } = await makeTask();
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('stopped');
});

test('missing task → returns silently', async () => {
  await expect(runCsAgent(99999, 1)).resolves.toBeUndefined();
  expect(mockRunClaude).not.toHaveBeenCalled();
});

test('cs 用 sonnet（升級為可調查的技術客服）', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"operation","reply":"見設定 > 權限"}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask();
  await runCsAgent(taskId, userId);
  expect(mockRunClaude.mock.calls[0][1].model).toBe('sonnet');
});

test('cs prompt 注入 repo 路徑、指示自查 wiki，且不預載 wiki 全文', async () => {
  const { userId, taskId } = await makeTask({ withProject: true });
  const { rows: [task] } = await dbModule.query('SELECT project_id FROM tasks WHERE id=$1', [taskId]);
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, clone_status, is_primary) VALUES ($1,'main','git@x:idx_sale.git','/repos/csproj/idx_sale','done',true)",
    [task.project_id]
  );
  await dbModule.query(
    "INSERT INTO wiki_pages (project_id, slug, title, content) VALUES ($1,'export','匯出說明','SECRETBODY不該進prompt')",
    [task.project_id]
  );
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"operation","reply":"x"}</result>', usage: null, durationMs: null });
  await runCsAgent(taskId, userId);
  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain('/repos/csproj/idx_sale');   // repo 路徑注入（能讀程式碼）
  expect(prompt).toContain('/ai/wiki/pages');            // 指示 agent 自查 wiki
  expect(prompt).not.toContain('SECRETBODY');            // 不預載 wiki 全文
  expect(prompt).not.toContain('</content>');   // 檔尾不得殘留工具輸出標記
});

test('cs 拿到 context7 MCP profile（可查 Odoo API）', () => {
  const { mcpConfigPath } = require('../pipeline/claude-runner');
  expect(mcpConfigPath('cs')).toMatch(/context7/);
});

// 追問重跑（cs_reply_pending→cs_running）時要帶入前一版 [客服回覆] 草稿，讓「改措辭」類追問能連貫修訂
test('追問重跑帶入前一版 [客服回覆] 草稿當脈絡', async () => {
  const { userId, taskId } = await makeTask();
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
    [taskId, '[客服回覆] 請到設定 > 權限開啟該欄位']
  );
  await dbModule.query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
    [taskId, '回覆請再客氣一點']
  );
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"operation","reply":"您好，煩請至設定 > 權限開啟該欄位，謝謝"}</result>', usage: null, durationMs: null });
  await runCsAgent(taskId, userId);
  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain('請到設定 > 權限開啟該欄位');   // 前一版草稿帶入 prompt
});

// 無前一版 [客服回覆]：prior_reply 傳「（無）」，三分類行為不變（首輪/補資料迴圈）
test('無前一版 [客服回覆]：仍照常三分類（operation → cs_reply_pending）', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"operation","reply":"見設定 > 權限"}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask();
  await runCsAgent(taskId, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('cs_reply_pending');   // 無前一版不影響原分類流程
});

// ── 時間軸收合 ────────────────────────────────────────────────────────────────
// 意圖：reason_plain 缺席時的 fallback 會把技術版 reason（實測平均 906 字）原樣放上時間軸——
// 也就是 a143fc8 想解決的那個症狀，在這條路徑上原樣重現。fallback 本身要留（看不懂好過看不到），
// 改成讓這則進收合：長的技術文折成一句人話、要看再展開；而正常路徑的 reason_plain 是白話短句、
// 本來就是寫給人讀的，收合它等於藏掉唯一看得懂的說明，故必須維持整段直接顯示。
const { machineLogHint, MACHINE_LOGS } = require('../../public/js/machine-logs.js');

async function csLog(taskId) {
  const { rows } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1 AND role='ai'", [taskId]);
  return rows.find(l => l.content.startsWith(MACHINE_LOGS.cs_code_change.prefix));
}

test('收合：reason fallback 的長技術文 → 折成一句人話，不整段砸在時間軸上', async () => {
  const long = 'idx_maintenance.py 的 Method action_confirm 缺冪等防護，stock.move 的 _action_done 未過濾退貨數量 [碼]。'.repeat(8);
  mockRunClaude.mockResolvedValueOnce({ text: `<result>{"type":"code_change_clear","reason":"${long}"}</result>`, usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({ withProject: true, title: '重複建單', text: '按確認會產生兩張單' });
  await runCsAgent(taskId, userId);
  const log = await csLog(taskId);
  expect(log.content).toContain('action_confirm');                 // fallback 仍在：內容一字不動
  expect(machineLogHint(log.role, log.content)).toBe(MACHINE_LOGS.cs_code_change.hint);
});

test('不收合：reason_plain 的白話短句 → 使用者直接看到，不必多點一下', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>{"type":"code_change_clear","reason":"idx_maintenance.py 的 Method action_confirm 缺冪等防護 [碼]","reason_plain":"按下確認時如果系統重試，單子會被重複建立一次。這是程式寫入資料的時機有問題，設定裡關不掉。"}</result>', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask({ withProject: true, title: '重複建單2', text: '按確認會產生兩張單' });
  await runCsAgent(taskId, userId);
  const log = await csLog(taskId);
  expect(machineLogHint(log.role, log.content)).toBeNull();
});
