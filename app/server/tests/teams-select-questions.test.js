const { selectQuestions } = require('../teams');

// clarify_pending 應讀 QA 的 [需要你裁決] log（每行一題），而非 analysis_yaml 的舊 clarification_channel。
// 回歸目標：修過期問題（analysis 階段殘留）與空問題（clarify_pending 但撈不到 log 時不誤發）。
describe('selectQuestions', () => {
  test('clarify_pending：從 [需要你裁決] log 內容逐行取問題', () => {
    const log = '[需要你裁決]\n問題A\n問題B';
    expect(selectQuestions('clarify_pending', null, log)).toEqual(['問題A', '問題B']);
  });

  test('clarify_pending：空 log 回傳空陣列（不誤貼舊問題）', () => {
    expect(selectQuestions('clarify_pending', null, '')).toEqual([]);
  });

  test('confirm_pending：既有 analysis_yaml.clarification_channel.questions 行為不變', () => {
    const yamlStr = 'clarification_channel:\n  questions:\n    - 舊問題1\n    - 舊問題2\n';
    expect(selectQuestions('confirm_pending', yamlStr, '')).toEqual(['舊問題1', '舊問題2']);
  });

  test('clarify_pending：即使 analysis_yaml 有舊 clarification_channel，也不回傳過期問題', () => {
    const yamlStr = 'clarification_channel:\n  questions:\n    - 過期問題\n';
    const log = '[需要你裁決]\n新問題A';
    expect(selectQuestions('clarify_pending', yamlStr, log)).toEqual(['新問題A']);
  });
});
