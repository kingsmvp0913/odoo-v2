const { optionScores, SCORE_FLOOR } = require('../lib/exam/score');

// 這個公式最容易寫反：c 是「**你的**答案正確的機率」，不是「審查有多確定」。
// 寫反了畫面照樣好好的，只是每一題都推薦錯的那個選項——沒有任何徵狀。
const q = (over = {}) => ({
  letters: ['A', 'B', 'C', 'D'], qtype: 'single', reviewSource: 'review', ...over,
});

test('官方確認：那個 100，其餘 0', () => {
  expect(optionScores(q({ reviewSource: 'official', reviewAnswer: ['A'] })))
    .toEqual({ A: 100, B: 0, C: 0, D: 0 });
});

test('審查同意你：你的答案拿信心度，其餘平分剩下的', () => {
  expect(optionScores(q({ reviewAnswer: ['A'], mine: ['A'], confidence: 88 })))
    .toEqual({ A: 88, B: 4, C: 4, D: 4 });
});

// c 越低＝審查越有把握你錯了（30 是它找到原始碼佐證，45 是它講不出根據），
// 所以它主張的那個要越高。這條顛倒的話整個推薦系統就是反的。
test('審查推翻你：c 越低，審查主張的那個越高', () => {
  const strong = optionScores(q({ reviewAnswer: ['A'], mine: ['B'], confidence: 30 }));
  expect(strong).toEqual({ A: 64, B: 30, C: 3, D: 3 });
  const weak = optionScores(q({ reviewAnswer: ['A'], mine: ['B'], confidence: 45 }));
  expect(weak).toEqual({ A: 49, B: 45, C: 3, D: 3 });
  expect(strong.A).toBeGreaterThan(weak.A);
});

// 「你錯 ＋ 審查也錯」真的會發生（實測 120 題裡有 7 題正解是兩邊都沒提到的那個）。
// 給 0 分等於宣稱那些選項不可能，而沒有任何人驗證過。
test('沒被提到的選項有底座，不是 0', () => {
  const s = optionScores(q({ reviewAnswer: ['A'], mine: ['B'], confidence: 30 }));
  expect(s.C).toBe(SCORE_FLOOR);
  expect(s.D).toBe(SCORE_FLOOR);
});

// history_wrong（人工勾的「上次答案大概率錯」）刻意不進公式：那個勾是人看著
// 審查的信心度打的，等於把同一個 AI 判斷算兩次。使用者 2026-09-05 拍板拿掉。
test('人工標的「上次答錯」不影響分數', () => {
  const base = optionScores(q({ reviewAnswer: ['A'], mine: ['B'], confidence: 30 }));
  const marked = optionScores(q({
    reviewAnswer: ['A'], mine: ['B'], confidence: 30,
    historyAnswer: ['D'], historyWrong: true }));
  expect(marked).toEqual(base);
});

test('一題永遠加起來剛好 100', () => {
  for (const c of [0, 30, 45, 60, 80, 88, 92, 99, 100]) {
    for (const mine of [['A'], ['B'], null]) {
      for (const n of [2, 3, 4, 5]) {
        const letters = ['A', 'B', 'C', 'D', 'E'].slice(0, n);
        const s = optionScores(q({ letters, reviewAnswer: ['A'], mine, confidence: c }));
        expect(Object.values(s).reduce((a, b) => a + b, 0)).toBe(100);
      }
    }
  }
});

test('沒作答時只認得審查主張的那個', () => {
  const s = optionScores(q({ reviewAnswer: ['A'], mine: null, confidence: 30 }));
  expect(s).toEqual({ A: 91, B: 3, C: 3, D: 3 });
});

describe('算不出分數的情況一律回 null（畫面會顯示 — 並說明原因）', () => {
  test.each([
    ['複選題', { qtype: 'multi', reviewAnswer: ['A'], mine: ['A'], confidence: 90 }],
    ['沒審查過', { reviewSource: null }],
    ['審查沒給答案', { reviewAnswer: [], confidence: 90 }],
    ['沒有信心度', { reviewAnswer: ['A'], mine: ['A'], confidence: null }],
    ['沒有選項', { letters: [], reviewAnswer: ['A'], confidence: 90 }],
  ])('%s', (_, over) => expect(optionScores(q(over))).toBeNull());
});

// 作答的字母不在選項裡（抄題與作答對不上時會發生），不能讓它憑空生出一欄
test('作答字母不在選項裡時退化成「沒作答」', () => {
  const s = optionScores(q({ reviewAnswer: ['A'], mine: ['Z'], confidence: 30 }));
  expect(Object.keys(s)).toEqual(['A', 'B', 'C', 'D']);
  expect(Object.values(s).reduce((a, b) => a + b, 0)).toBe(100);
});
