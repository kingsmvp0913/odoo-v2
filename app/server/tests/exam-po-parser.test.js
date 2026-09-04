const { parsePo, isTerm } = require('../lib/exam/po-parser');

// 這是實際 po 檔的形狀：msgid 直接接 msgstr，中間沒有空行。
// 第一版 parser 就是漏了這個轉折點的結算，抽出 0 條而且不報錯。
test('msgid 直接接 msgstr（沒有空行）也要解出來', () => {
  const po = [
    '#. module: stock',
    'msgid "Delivery Orders"',
    'msgstr "交貨單"',
    '',
    'msgid "Reordering Rule"',
    'msgstr "重訂貨規則"',
  ].join('\n');
  expect(parsePo(po)).toEqual([
    { msgid: 'Delivery Orders', msgstr: '交貨單' },
    { msgid: 'Reordering Rule', msgstr: '重訂貨規則' },
  ]);
});

// po 把長字串拆成多行，不合併的話長度判斷會全錯（一段長句會被當成短術語收進去）
test('多行續行要合併', () => {
  const po = [
    'msgid ""',
    '"Line one "',
    '"line two"',
    'msgstr ""',
    '"第一行"',
    '"第二行"',
  ].join('\n');
  expect(parsePo(po)).toEqual([{ msgid: 'Line one line two', msgstr: '第一行第二行' }]);
});

test('跳脫字元還原', () => {
  const po = 'msgid "say \\"hi\\""\nmsgstr "說\\"嗨\\""';
  expect(parsePo(po)).toEqual([{ msgid: 'say "hi"', msgstr: '說"嗨"' }]);
});

// po 檔開頭的 metadata 區塊 msgid 是空的，收進去會變成一條垃圾對照
test('檔頭的空 msgid metadata 不算一條', () => {
  const po = [
    'msgid ""',
    'msgstr ""',
    '"Project-Id-Version: Odoo Server 19\\n"',
    '"Language: zh_TW\\n"',
    '',
    'msgid "Vendor"',
    'msgstr "供應商"',
  ].join('\n');
  expect(parsePo(po)).toEqual([{ msgid: 'Vendor', msgstr: '供應商' }]);
});

// 未翻譯的條目 msgstr 是空的，不該被當成「翻成空字串」收進去
test('msgstr 為空的條目不算一條', () => {
  const po = 'msgid "Untranslated"\nmsgstr ""\n\nmsgid "Vendor"\nmsgstr "供應商"';
  expect(parsePo(po)).toEqual([{ msgid: 'Vendor', msgstr: '供應商' }]);
});

describe('isTerm', () => {
  test('短的名詞是術語', () => {
    expect(isTerm('Delivery Orders', '交貨單')).toBe(true);
    expect(isTerm('Bill of Materials', '物料清單')).toBe(true);
  });

  test('整句話不是術語', () => {
    expect(isTerm('You cannot delete this record.', '你不能刪除這筆記錄。')).toBe(false);
  });

  test('含格式化符號的不是術語', () => {
    expect(isTerm('Order %s confirmed', '訂單 %s 已確認')).toBe(false);
  });

  test('超過 60 字元的不是術語', () => {
    expect(isTerm('a'.repeat(61), '中')).toBe(false);
  });

  test('譯文為空的不算', () => {
    expect(isTerm('Vendor', '')).toBe(false);
    expect(isTerm('Vendor', '   ')).toBe(false);
  });

  test('含換行的不是術語', () => {
    expect(isTerm('Line\nBreak', '換行')).toBe(false);
  });
});
