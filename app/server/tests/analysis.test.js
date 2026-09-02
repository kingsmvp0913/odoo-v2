jest.mock('../db', () => ({ query: jest.fn() }));
const { query } = require('../db');
const { determineNextStatus, recommendedLine, logAnalysisGate } = require('../pipeline/analysis');

// determineNextStatus 是分析路徑唯一的「YAML → 下一閘門」推導（analysis-project/task-agent 共用）。
// 純函式測試釘住分支意圖，取代已移除的 analyzeTask（analysis-basic 一次性路徑）整合測試。
const parsed = (over) => ({
  execution_mode: 'MODE_A',
  low_confidence: false,
  clarification_channel: { questions: [] },
  ...over,
});

test('MODE_A 無問題、非低信心 → branch_pending（直接開工）', () => {
  expect(determineNextStatus(parsed())).toBe('branch_pending');
});

test('MODE_B 無待答問題 → spec_review（先審規格再開工）', () => {
  expect(determineNextStatus(parsed({ execution_mode: 'MODE_B' }))).toBe('spec_review');
});

// 意圖：問題分支優先於 MODE_B——有待答問題時先進 confirm_pending 答題，
// 不可被 MODE_B→spec_review 吃掉（否則叫使用者審規格卻還有題沒答，UX 是壞的）。
test('MODE_B 但有待答問題 → confirm_pending（問題分支優先）', () => {
  expect(determineNextStatus(parsed({
    execution_mode: 'MODE_B',
    clarification_channel: { questions: ['這欄放哪？'] },
  }))).toBe('confirm_pending');
});

test('有待答問題 → confirm_pending', () => {
  expect(determineNextStatus(parsed({
    clarification_channel: { questions: ['請確認格式？'] },
  }))).toBe('confirm_pending');
});

test('low_confidence → confirm_pending', () => {
  expect(determineNextStatus(parsed({ low_confidence: true }))).toBe('confirm_pending');
});

// 意圖：fallback 必須指向最嚴格的那一邊。舊版是「不等於 'MODE_B' 就 branch_pending（直接開工）」，
// 於是 execution_mode 只要飄成 mode_b、'MODE_B（先確認）'、空值、缺欄位，就靜默跳過 spec_review
// 這道「使用者親自看過規格」的人工閘門——而 MODE_B 正是會動到既有行為／金額／稅／庫存的那一類。
// 跳過完全無聲：不會有警告、不會有測試變紅、log 也看不出來。
// 平台規則 59：查表式降級的 fallback 要指向最嚴格的選項。
test.each([
  ['缺 execution_mode 欄位', {}],
  ['空字串', { execution_mode: '' }],
  ['null', { execution_mode: null }],
  ['模型多寫了字', { execution_mode: 'MODE_B（先確認）' }],
  ['認不得的值', { execution_mode: 'MODE_C' }],
])('execution_mode 為 %s → spec_review（不得靜默直接開工）', (_name, over) => {
  const p = { low_confidence: false, clarification_channel: { questions: [] }, ...over };
  expect(determineNextStatus(p)).toBe('spec_review');
});

// 反向守衛：正規化只該吸收大小寫與空白飄動，不該寬鬆到讓認不得的值也開工（上面那組守住）。
test.each([['mode_a'], ['  MODE_A  '], ['Mode_A']])('execution_mode 為 %s → 仍認得是 MODE_A，直接開工', (v) => {
  expect(determineNextStatus(parsed({ execution_mode: v }))).toBe('branch_pending');
});

// recommendedLine：三個呈現端共用同一份（時間軸 analysis.js、Teams 推播 teams.js、respec 提問轉字串）。
// 抽成單一來源的理由就是這裡測的東西——各寫一份必然漂移成「平台顯示 label、推播顯示 A」。
const q = (over) => ({
  text: '重編項次時已確認的訂單要不要一起重編？', type: 'choice',
  options: [{ key: 'A', label: '只重編草稿單' }, { key: 'B', label: '已確認的也一起重編' }],
  ...over,
});

// choice 題的 recommended 存的是 option 的 key。直接印它＝畫面上出現「建議：A」，使用者根本不知道 A 是什麼。
test('choice 題：recommended 是 option key → 換成 label 顯示', () => {
  expect(recommendedLine(q({ recommended: 'A' }))).toBe('只重編草稿單');
});

test('有 recommended_why → 依據跟在後面（使用者要的是有依據的預選，不是一個沒來由的答案）', () => {
  expect(recommendedLine(q({ recommended: 'A', recommended_why: '既有 write() 對 state=sale 有寫入保護' })))
    .toBe('只重編草稿單（既有 write() 對 state=sale 有寫入保護）');
});

// 沒有建議是常態、不是缺漏：純屬「使用者要什麼」的題目 agent 刻意留空（它沒有依據可循）。
// 回空字串讓呼叫端整行不渲染——回 undefined 或 'undefined' 會在畫面上印出一行空的「建議：」。
test.each([
  ['欄位不存在', {}],
  ['空字串', { recommended: '' }],
  ['只有空白', { recommended: '   ' }],
])('%s → 回空字串（呼叫端據此不渲染建議那一行）', (_n, over) => {
  expect(recommendedLine(q(over))).toBe('');
});

// text 題沒有 options，key 也可能打錯（AI 填了不存在的選項）。這兩種都不該讓建議整個消失——
// 原樣印出來至少使用者看得到 AI 的意思，比靜默吞掉好。
test('text 題（無 options）→ 原樣顯示 recommended 本身', () => {
  expect(recommendedLine({ text: '欄位名稱要叫什麼？', type: 'text', recommended: '備註T' })).toBe('備註T');
});

test('recommended 指向不存在的 option key → 原樣顯示，不得靜默吞掉', () => {
  expect(recommendedLine(q({ recommended: 'Z' }))).toBe('Z');
});

test('withWhy:false → 只回選項名稱；預設仍帶理由（推播與 respec 沒有動作面板可看）', () => {
  const item = q({ recommended: 'A', recommended_why: '既有 write() 對 state=sale 有寫入保護' });
  expect(recommendedLine(item, { withWhy: false })).toBe('只重編草稿單');
  expect(recommendedLine(item)).toBe('只重編草稿單（既有 write() 對 state=sale 有寫入保護）');
});

// logAnalysisGate：時間軸那則閘門訊息。它與動作面板並存在同一頁，面板上已有完整的 intro、
// 題目與建議理由——這則的角色是「答完之後回頭還看得到問過什麼」的書籤，不是第二份說明書。
const gateContent = () => query.mock.calls[0][1][1];

// 意圖：summary 現在可能帶 markdown 表格（「現在 vs 改完」對照）。表格的每一列都必須在行首，
// 接在「模組：…｜重點：」後面同一行的話 marked 不會解析，畫面上就是一排管線符號。
test('summary 帶表格 → 表格自己起一行，不與模組黏在同一行', async () => {
  query.mockClear();
  await logAnalysisGate(7, {
    module: 'idx_hj',
    summary: '備註欄改成可以打字。\n\n| 項目 | 現在 | 改完 |\n| --- | --- | --- |\n| 備註欄 | 唯讀 | 可填 |',
    clarification_channel: { questions: [{ id: 'q1', text: '要不要一起拆？' }] },
  }, 'confirm_pending');
  const lines = gateContent().split('\n');
  expect(lines[0]).toBe('[需要你回答]');
  expect(lines[1]).toBe('模組：idx_hj');
  expect(gateContent()).toContain('\n| 項目 | 現在 | 改完 |');
  expect(gateContent()).not.toContain('重點：');
});

// 意圖：recommended_why 動輒上百字，是這則訊息最長的一段，而它完整印在旁邊的面板上。
test('建議只印選項名稱，不把理由再抄一遍', async () => {
  query.mockClear();
  await logAnalysisGate(7, {
    module: 'idx_hj',
    summary: '把報表的開關拆開。',
    clarification_channel: {
      questions: [{
        id: 'q1', text: '報告設定檔要不要一起拆？', type: 'choice',
        options: [{ key: 'A', label: '一起拆' }, { key: 'B', label: '維持原本一列' }],
        recommended: 'B', recommended_why: '您要比照的維修前報告也只拆了報表本身的開關',
      }],
    },
  }, 'confirm_pending');
  expect(gateContent()).toContain('建議：維持原本一列');
  expect(gateContent()).not.toContain('維修前報告');
});

test('spec_review 分支：標題後同樣帶模組與摘要', async () => {
  query.mockClear();
  await logAnalysisGate(7, { module: 'idx_hj', summary: '把報表的開關拆開。' }, 'spec_review');
  expect(gateContent()).toBe('[等待你審核規格]\n模組：idx_hj\n\n把報表的開關拆開。');
});

// summary 留空是允許的（低信心時 agent 可能只列問題）：不得留下一個孤零零的空行。
test('summary 為空 → 只有標題與模組，不留空行', async () => {
  query.mockClear();
  await logAnalysisGate(7, { module: 'idx_hj', summary: '   ' }, 'spec_review');
  expect(gateContent()).toBe('[等待你審核規格]\n模組：idx_hj');
});
