const { filterByKeyword, truncate } = require('../lib/log-parse');

const mk = (i, extra = '') => ({
  ts: `2026-08-10 06:00:${String(i).padStart(2, '0')},000`,
  level: 'ERROR', logger: 'odoo.x', message: `m${i}`,
  raw: `2026-08-10 06:00:${String(i).padStart(2, '0')},000 1 ERROR db odoo.x: m${i}${extra}`,
});

test('關鍵字比對整筆 raw（含 traceback 內文）', () => {
  const entries = [mk(1), { ...mk(2), raw: mk(2).raw + '\nValidationError: 數量不可為負' }];
  expect(filterByKeyword(entries, '數量不可為負')).toHaveLength(1);
  expect(filterByKeyword(entries, 'm1')).toHaveLength(1);
});

test('關鍵字大小寫不敏感', () => {
  expect(filterByKeyword([{ ...mk(1), raw: 'ERROR sale.Order failed' }], 'sale.order')).toHaveLength(1);
});

test('關鍵字含 shell 元字元僅作字面比對，不影響結果', () => {
  const entries = [{ ...mk(1), raw: 'boom; rm -rf /' }];
  expect(filterByKeyword(entries, '; rm -rf /')).toHaveLength(1);
  expect(filterByKeyword(entries, '$(whoami)')).toHaveLength(0);
});

test('空關鍵字不過濾', () => {
  const entries = [mk(1), mk(2)];
  expect(filterByKeyword(entries, '')).toHaveLength(2);
  expect(filterByKeyword(entries, undefined)).toHaveLength(2);
});

test('超過筆數上限即截斷並標記', () => {
  const entries = Array.from({ length: 10 }, (_, i) => mk(i));
  const r = truncate(entries, 3, 1e9);
  expect(r.entries).toHaveLength(3);
  expect(r.truncated).toBe(true);
});

// 只限筆數會出事：Odoo traceback 單筆可達數十行，200 筆可能數 MB，直接爆 agent context。
test('超過 bytes 上限即截斷，即使筆數未達上限', () => {
  const big = Array.from({ length: 5 }, (_, i) => mk(i, 'x'.repeat(1000)));
  const r = truncate(big, 100, 2500);
  expect(r.entries.length).toBeLessThan(5);
  expect(r.truncated).toBe(true);
});

test('未超過任一上限時不標記截斷', () => {
  const r = truncate([mk(1), mk(2)], 10, 1e9);
  expect(r.entries).toHaveLength(2);
  expect(r.truncated).toBe(false);
});

// 截斷必須落在記錄邊界：切一半的 traceback 是沒有結論的堆疊，比不給更糟。
test('截斷永遠落在記錄邊界，不切斷單筆', () => {
  const entries = [mk(1, '\nline A\nline B'), mk(2, '\nline C')];
  const r = truncate(entries, 100, 60);
  for (const e of r.entries) {
    expect(entries.some(o => o.raw === e.raw)).toBe(true);
  }
});
