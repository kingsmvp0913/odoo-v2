const { determineNextStatus } = require('../pipeline/analysis');

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
