// 意圖：改寫 tasks.analysis_yaml 的路徑不只 runner 的 writeAnalysisYaml 一條。規格審核閘門
// (spec-review)、澄清閘門 (clarify-chat)、途中追加需求 (respec-agent) 三處也各自下 UPDATE。
// 這三處若不留版本快照，會壞掉兩件事：
//   (1) 使用者在最常走的規格審核閘門送出修改意見後，畫面上只剩一段 AI 純文字，展不開新版規格書；
//   (2) 版號跳號——task_specs 少記一版，之後經分析關寫入時會把第 N+1 版記成第 N 版，中間那版永久消失。
// 本檔釘住「三條路徑都會留快照，且版號連號」，內容正確性由各自的 *.test.js 負責。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ ...jest.requireActual('../pipeline/claude-runner'), runClaude: jest.fn() }));

let dbModule, runClaude, runSpecReview, runClarifyChat, runRespecPatch;
let userId, projectId, seq = 0;

async function insertTask(status, analysisYaml) {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, analysis_yaml, coding_session_id)
     VALUES ($1, $2, 'odoo', 'T', 'c', $3, $4, $5, 'sess-1') RETURNING *`,
    [userId, `sv_${++seq}`, status, projectId, analysisYaml]
  );
  return t;
}
async function specs(taskId) {
  const { rows } = await dbModule.query(
    'SELECT version, analysis_yaml FROM task_specs WHERE task_id=$1 ORDER BY version', [taskId]
  );
  return rows;
}
async function aiLogs(taskId) {
  const { rows } = await dbModule.query(
    "SELECT content FROM task_logs WHERE task_id=$1 AND role='ai' ORDER BY id", [taskId]
  );
  return rows.map(r => r.content);
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
    "INSERT INTO users (username, password_hash, display_name) VALUES ('sv', $1, 'V') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('VP', '17.0') RETURNING id"
  );
  projectId = p.id;
  ({ runClaude } = require('../pipeline/claude-runner'));
  ({ runSpecReview } = require('../pipeline/spec-review'));
  ({ runClarifyChat } = require('../pipeline/clarify-chat'));
  ({ runRespecPatch } = require('../pipeline/respec-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  runClaude.mockReset();
  await dbModule.query('DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE user_id=$1)', [userId]);
  await dbModule.query('DELETE FROM task_specs WHERE task_id IN (SELECT id FROM tasks WHERE user_id=$1)', [userId]);
  await dbModule.query('DELETE FROM task_messages WHERE task_id IN (SELECT id FROM tasks WHERE user_id=$1)', [userId]);
  await dbModule.query('DELETE FROM tasks WHERE user_id=$1', [userId]);
});

// 這條是提案的主症狀：任務 243 走 analysis-retry 那輪有 v3 快照與時間軸那則，走 spec-review 閘門
// 那輪兩者皆無——使用者在同一個畫面上做同一件事，只因為走了另一條路就看不到新版規格書。
test('規格審核閘門 revise → 留快照、時間軸出現帶版號的那一則', async () => {
  const task = await insertTask('respec_running', 'module: sale\nsummary: 原摘要\n');
  await dbModule.query("INSERT INTO task_logs (task_id, role, content) VALUES ($1,'user','備註欄改成可編輯')", [task.id]);
  runClaude.mockResolvedValue({
    text: '<result>\nDECISION: revise\nREPLY:\n已改。\n---SPEC---\nmodule: sale\nsummary: 改過的摘要\n</result>',
    usage: null, durationMs: null
  });

  await runSpecReview(task, userId, undefined);

  const rows = await specs(task.id);
  expect(rows.map(r => r.version)).toEqual([1, 2]);
  expect(rows[0].analysis_yaml).toContain('原摘要');       // 被覆寫掉的那版留住了
  expect(rows[1].analysis_yaml).toContain('改過的摘要');
  // 前端靠這個前綴＋括號裡的版號決定「這一則底下要掛第幾版規格書」；沒有它就只剩純文字回覆
  expect((await aiLogs(task.id)).some(c => c.includes('[等待你審核規格]（第 2 版）'))).toBe(true);
});

// 鑑別力：版號要從 task_specs 的最新版遞增。同一條路徑連改兩次若只記得到 v2，
// 就是拿舊快照內容在比對而不是取號——之後每一版都會少記一號。
test('規格審核閘門連改兩次 → 版號連號到 3，不跳號', async () => {
  const task = await insertTask('respec_running', 'module: sale\nsummary: 第一版\n');
  runClaude.mockResolvedValue({
    text: '<result>\nDECISION: revise\nREPLY:\n改了。\n---SPEC---\nmodule: sale\nsummary: 第二版\n</result>',
    usage: null, durationMs: null
  });
  await runSpecReview(task, userId, undefined);

  runClaude.mockResolvedValue({
    text: '<result>\nDECISION: revise\nREPLY:\n再改。\n---SPEC---\nmodule: sale\nsummary: 第三版\n</result>',
    usage: null, durationMs: null
  });
  const { rows: [fresh] } = await dbModule.query('SELECT * FROM tasks WHERE id=$1', [task.id]);
  await runSpecReview(fresh, userId, undefined);

  const rows = await specs(task.id);
  expect(rows.map(r => r.version)).toEqual([1, 2, 3]);
  expect(rows[2].analysis_yaml).toContain('第三版');
});

// 澄清閘門就地改寫題目也是動 analysis_yaml：不記版就會在後續路徑上造成跳號。
test('澄清閘門 revise 改寫題目 → 一樣留快照', async () => {
  const task = await insertTask('clarify_chat_running', 'summary: s\n');
  runClaude.mockResolvedValueOnce({
    text: '<result>\nDECISION: revise\nREPLY:\n調整了\n---QUESTIONS---\nintro: 新說明\nquestions: []\n</result>',
    usage: {}, durationMs: 1
  });

  await runClarifyChat(task, userId, null, 'ask');

  const rows = await specs(task.id);
  expect(rows.map(r => r.version)).toEqual([1, 2]);
  expect(rows[1].analysis_yaml).toContain('新說明');
});

test('途中追加需求 patch 規格 → 一樣留快照與帶版號的那一則', async () => {
  const task = await insertTask('respec_running', 'module: sale\nfeatures:\n  - 折扣欄位\n');
  await dbModule.query(
    "INSERT INTO task_messages (task_id, source, author, content, occurred_at) VALUES ($1,'manual','me','請加匯出按鈕', NOW())",
    [task.id]
  );
  runClaude.mockResolvedValue({
    text: '<result>\nmodule: sale\nfeatures:\n  - 折扣欄位\n  - 匯出 Excel 按鈕\n</result>',
    usage: null, durationMs: null
  });

  await runRespecPatch(task.id, userId, undefined);

  const rows = await specs(task.id);
  expect(rows.map(r => r.version)).toEqual([1, 2]);
  expect(rows[1].analysis_yaml).toContain('匯出 Excel 按鈕');
  expect((await aiLogs(task.id)).some(c => c.includes('（第 2 版）'))).toBe(true);
});

// 意圖：小修正規格（kind='tweak'）與主規格各跑各的版本序列。混用一條序列的話，一次人工退回就會
// 把主規格的下一版從第 2 版推成第 3 版——而時間軸上的規格書是靠標頭列的版號去對的，跳號＝那一則
// 對不到任何一份規格，畫面上規格書靜默消失。
test('小修正規格不佔主規格的版本序列（兩邊各自從 1 起算）', async () => {
  const { recordTweakSpec, loadTweakSpecs } = require('../pipeline/spec-version');
  const task = await insertTask('respec_running', 'module: sale\nfeatures:\n  - 折扣欄位\n');
  // 先寫一份主規格第 1 版（模擬分析關），再插進兩份小修正規格
  await dbModule.query(
    "INSERT INTO task_specs (task_id, version, analysis_yaml, kind) VALUES ($1,1,'module: sale','main')", [task.id]
  );
  expect(await recordTweakSpec(task.id, '1. 匯出鈕移到表頭。')).toBe(1);
  expect(await recordTweakSpec(task.id, '1. 匯出鈕改藍色。')).toBe(2);

  // 主規格接著被改寫 → 應該是第 2 版，不是被小修正推成第 4 版
  await dbModule.query(
    "INSERT INTO task_messages (task_id, source, author, content, occurred_at) VALUES ($1,'manual','me','加一個匯出 Excel 按鈕', NOW())",
    [task.id]
  );
  runClaude.mockResolvedValue({
    text: '<result>\nmodule: sale\nfeatures:\n  - 折扣欄位\n  - 匯出 Excel 按鈕\n</result>',
    usage: null, durationMs: null
  });
  await runRespecPatch(task.id, userId, undefined);

  const { rows: mains } = await dbModule.query(
    "SELECT version FROM task_specs WHERE task_id=$1 AND kind='main' ORDER BY version", [task.id]
  );
  expect(mains.map(r => r.version)).toEqual([1, 2]);
  // 反向也要成立：主規格改版不影響小修正的序列
  expect(await recordTweakSpec(task.id, '1. 再加一條。')).toBe(3);
  // 讀回時給的是全部、依序，不是只有最新（coding 無狀態，少一份就等於那條要求消失）
  const text = await loadTweakSpecs(task.id);
  expect(text).toContain('匯出鈕移到表頭');
  expect(text).toContain('匯出鈕改藍色');
  expect(text).toContain('再加一條');
});

// 空字串／null 不得寫出一份沒有內容的規格：spec_patch 是選填欄位，分診沒寫時這裡會收到空值，
// 寫進去的話下游會拿到一份標題有內容卻空白的「規格」，比沒有更糟。
test('spec_patch 為空 → 不寫規格、不寫 log', async () => {
  const { recordTweakSpec } = require('../pipeline/spec-version');
  const task = await insertTask('respec_running', 'module: sale\n');
  expect(await recordTweakSpec(task.id, '   ')).toBeNull();
  expect(await recordTweakSpec(task.id, undefined)).toBeNull();
  expect(await specs(task.id)).toEqual([]);
  expect(await aiLogs(task.id)).toEqual([]);
});

// 鑑別力：respec 判「規格不需要調整」不走那條 UPDATE，也就不該憑空多一版。
test('規格一字未動 → 不記新版', async () => {
  const task = await insertTask('respec_running', 'module: sale\nfeatures:\n  - 折扣欄位\n');
  await dbModule.query(
    "INSERT INTO task_messages (task_id, source, author, content, occurred_at) VALUES ($1,'manual','me','直接推進到部署', NOW())",
    [task.id]
  );
  runClaude.mockResolvedValue({
    text: '<result>\nmodule: sale\nfeatures:\n  - 折扣欄位\n</result>',
    usage: null, durationMs: null
  });

  await runRespecPatch(task.id, userId, undefined);

  expect(await specs(task.id)).toEqual([]);
});
