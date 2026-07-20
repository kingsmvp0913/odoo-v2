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
