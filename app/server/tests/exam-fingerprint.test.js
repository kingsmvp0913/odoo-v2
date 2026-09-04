const { fingerprint, normalizeQuestion } = require('../lib/exam/fingerprint');

test('大小寫、標點、空白差異視為同一題', () => {
  const a = 'In a multi-company setup, how can you allow a customer record to be shared?';
  const b = 'in a multi company setup  HOW can you allow a customer record to be shared';
  expect(fingerprint(a)).toBe(fingerprint(b));
});

test('不同題目得到不同指紋', () => {
  expect(fingerprint('What is a delivery order?'))
    .not.toBe(fingerprint('What is a purchase order?'));
});

// 這條防的是「換行與縮排讓同一題變成兩列」——題幹從截圖抄下來時
// 換行位置每次都可能不同，那不是內容差異。
test('換行與縮排不影響指紋', () => {
  expect(fingerprint('Line one\n   line two')).toBe(fingerprint('Line one line two'));
});

test('指紋是 64 字元的十六進位字串', () => {
  expect(fingerprint('anything')).toMatch(/^[0-9a-f]{64}$/);
});

// 空題幹必須拋錯，不可以回一個「空字串的指紋」——那會讓所有讀不出題幹的題
// 合併成同一列，而且症狀（題庫少了很多題）離真因很遠。
test('空題幹拋錯', () => {
  expect(() => fingerprint('')).toThrow();
  expect(() => fingerprint('   ,,,   ')).toThrow();
  expect(() => fingerprint(null)).toThrow();
});

test('normalizeQuestion 抹平標點但保留字詞邊界', () => {
  expect(normalizeQuestion('Multi-company: how?')).toBe('multi company how');
});

// 題幹可能夾中文（question_zh 不走這條，但英文題幹裡出現中文標記時不該被抹掉）
test('中文字元保留', () => {
  expect(normalizeQuestion('設定 Reordering Rule')).toBe('設定 reordering rule');
});
