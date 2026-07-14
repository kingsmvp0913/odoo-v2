const fs = require('fs');
const path = require('path');

// 意圖：這份方法論會被 prepend 進 headless 子行程的 prompt。
// 它必須（a）帶穩定標記供 loader/測試辨識；（b）不含互動式指令——
// 「去 invoke 別的 skill」「找 human partner」「進 plan mode」在一次性 headless 子行程裡
// 不是空指就是誤觸發，一旦回歸就會讓診斷關行為劣化，故以反例測試守住。
const P = path.join(__dirname, '..', 'pipeline', 'systematic-debugging.md');

test('方法論檔存在且帶穩定標記', () => {
  const t = fs.readFileSync(P, 'utf8');
  expect(t).toContain('# 系統化除錯（pipeline 版）');
  expect(t).toContain('Iron Law');
});

test('headless-safe：不得含互動式／跨 skill 指令', () => {
  const t = fs.readFileSync(P, 'utf8');
  for (const banned of ['invoke', 'human partner', 'plan mode', 'brainstorm']) {
    expect(t.toLowerCase()).not.toContain(banned.toLowerCase());
  }
});
