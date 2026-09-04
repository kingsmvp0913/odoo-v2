const { parseAnswers, checkCount, alignAnswers } = require('../lib/exam/answers');

describe('parseAnswers', () => {
  test('顯式編號以編號為準', () => {
    const r = parseAnswers('第 1 題 B；第 2 題 A；第 3 題 A');
    expect(r.answers).toEqual([['B'], ['A'], ['A']]);
    expect(r.count).toBe(3);
    expect(r.note).toBe('');
  });

  test('各種編號寫法都吃', () => {
    expect(parseAnswers('1. B  2) A  Q3: C').answers).toEqual([['B'], ['A'], ['C']]);
  });

  // 漏答中間某題時只有編號救得回來——用位置會讓後面全部往前移一格
  test('中間漏答時後面的題號不移位', () => {
    const r = parseAnswers('第 1 題 B；第 3 題 C');
    expect(r.answers).toEqual([['B'], [], ['C']]);
    expect(r.note).toMatch(/第 2 題/);
  });

  // 排序過的 BCA 會變成第一題 A，原專案實測踩過
  test('連寫不可排序，順序就是題序', () => {
    expect(parseAnswers('BCA').answers).toEqual([['B'], ['C'], ['A']]);
  });

  test('一題複選', () => {
    expect(parseAnswers('第 1 題 B、D').answers).toEqual([['B', 'D']]);
  });

  test('空值與無字母不拋錯', () => {
    expect(parseAnswers('').count).toBe(0);
    expect(parseAnswers(null).count).toBe(0);
    expect(parseAnswers('沒有任何字母').count).toBe(0);
  });

  // 重複呼叫時全域 regex 的 lastIndex 若沒重設，第二次會從中間開始比對
  test('連續呼叫結果一致（regex lastIndex 有重設）', () => {
    const a = parseAnswers('第 1 題 B；第 2 題 A');
    const b = parseAnswers('第 1 題 B；第 2 題 A');
    expect(a).toEqual(b);
  });
});

describe('checkCount', () => {
  test('題數吻合就通過', () => {
    expect(checkCount(parseAnswers('第 1 題 B；第 2 題 A'), 2).ok).toBe(true);
  });

  test('題數不符具名回報', () => {
    const r = checkCount(parseAnswers('BAA'), 5);
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/3 題.*5 題/);
  });

  test('審查沒讀到題目也回報', () => {
    expect(checkCount(parseAnswers('BAA'), 0).ok).toBe(false);
  });
});

describe('alignAnswers', () => {
  test('吻合時逐題對齊', () => {
    expect(alignAnswers(parseAnswers('BAA'), 3)).toEqual([['B'], ['A'], ['A']]);
  });

  // 寧可留空也不移位：補空或截斷都會讓答案錯位，而錯位的症狀是
  // 「某幾題莫名被判不一致」，離真因很遠
  test('題數不符時全部留空，不猜也不截斷', () => {
    expect(alignAnswers(parseAnswers('BAA'), 5)).toEqual([[], [], [], [], []]);
    expect(alignAnswers(parseAnswers('BAAAA'), 2)).toEqual([[], []]);
  });
});
