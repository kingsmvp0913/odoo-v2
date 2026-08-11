const { splitEntries, filterByLevel } = require('../lib/log-parse');

const SAMPLE = [
  '2026-08-10 06:23:45,123 1234 INFO test_db odoo.http: request done',
  '2026-08-10 06:23:46,001 1234 ERROR test_db odoo.sql_db: bad query',
  'Traceback (most recent call last):',
  '  File "/opt/odoo/models.py", line 42, in write',
  '    raise ValidationError()',
  'ValidationError: 數量不可為負',
  '2026-08-10 06:23:47,500 1234 WARNING test_db odoo.addons.sale: slow',
].join('\n');

test('依行首時間戳切出三筆記錄', () => {
  const entries = splitEntries(SAMPLE);
  expect(entries).toHaveLength(3);
  expect(entries[0].level).toBe('INFO');
  expect(entries[1].level).toBe('ERROR');
  expect(entries[2].level).toBe('WARNING');
});

test('traceback 續行歸屬前一筆記錄的 raw', () => {
  const entries = splitEntries(SAMPLE);
  expect(entries[1].raw).toContain('Traceback (most recent call last):');
  expect(entries[1].raw).toContain('ValidationError: 數量不可為負');
  // 續行不可外溢到下一筆
  expect(entries[2].raw).not.toContain('Traceback');
});

test('解析出 logger 與訊息', () => {
  const entries = splitEntries(SAMPLE);
  expect(entries[1].logger).toBe('odoo.sql_db');
  expect(entries[1].message).toBe('bad query');
  expect(entries[1].ts).toBe('2026-08-10 06:23:46,001');
});

// 這條是本設計的核心保證：級別過濾必須保住整筆 traceback。
// 防的是日後有人「順手」把級別過濾改成遠端 grep ERROR——那會只留下標題行，
// 堆疊內容全數消失，agent 拿到的是沒有結論的錯誤。
test('級別過濾保留整筆 traceback', () => {
  const errs = filterByLevel(splitEntries(SAMPLE), 'ERROR');
  expect(errs).toHaveLength(1);
  expect(errs[0].raw).toContain('ValidationError: 數量不可為負');
  expect(errs[0].raw.split('\n').length).toBeGreaterThan(4);
});

test('級別是門檻不是精確匹配', () => {
  const entries = splitEntries(SAMPLE);
  expect(filterByLevel(entries, 'WARNING').map(e => e.level)).toEqual(['ERROR', 'WARNING']);
  expect(filterByLevel(entries, 'INFO').map(e => e.level)).toEqual(['INFO', 'ERROR', 'WARNING']);
  expect(filterByLevel(entries, 'ALL')).toHaveLength(3);
});

test('開頭的孤兒續行不會產生無時間戳的記錄', () => {
  const entries = splitEntries('  File "x.py", line 1\n2026-08-10 06:23:45,123 1 INFO db odoo.http: ok');
  expect(entries).toHaveLength(1);
  expect(entries[0].level).toBe('INFO');
});
