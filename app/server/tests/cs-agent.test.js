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
});

test('cs 拿到 context7 MCP profile（可查 Odoo API）', () => {
  const { mcpConfigPath } = require('../pipeline/claude-runner');
  expect(mcpConfigPath('cs')).toMatch(/context7/);
});
