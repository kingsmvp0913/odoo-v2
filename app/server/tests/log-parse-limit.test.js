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
// 注意：斷言必須是「剛好留下第一筆、第二筆被砍」，不能只驗「回傳的每筆都出現在原陣列裡」——
// truncate 從不修改 entry，這種寫法連空集合都會通過，測了等於沒測（M5）。
test('截斷永遠落在記錄邊界，不切斷單筆', () => {
  const entries = [mk(1, '\nline A\nline B'), mk(2, '\nline C')];
  const r = truncate(entries, 100, 60);
  expect(r.entries).toHaveLength(1);
  expect(r.truncated).toBe(true);
});

// I2：第一筆若無條件放行，MAX_BYTES 存在的理由（避免爆 agent context）就形同虛設，
// 且 truncated 仍回 false 會讓呼叫端誤以為內容完整——Odoo 的 QWeb/ORM 例外把整個 context
// 傾印進單一 message 是實際會發生的情境。
test('單筆本身就超過 maxBytes 時仍要截斷，不可無條件放行', () => {
  const big = { ...mk(1), raw: 'x'.repeat(500000) };
  const r = truncate([big], 200, 65536);
  expect(r.truncated).toBe(true);
  expect(r.entries).toHaveLength(1);
  expect(Buffer.byteLength(r.entries[0].raw, 'utf8')).toBeLessThan(500000);
  expect(r.entries[0].raw).toContain('已截斷');
  // 純 ASCII 迴歸：每個字元恆 1 byte，裁切點不可能落在字元中間，含提示文字後的總長度
  // 必須不超過宣稱的上限——這是 I2 修復本身要驗證的核心承諾，複審發現舊實作會超標。
  expect(Buffer.byteLength(r.entries[0].raw, 'utf8')).toBeLessThanOrEqual(65536);
});

// 複審發現的 Important：I2 的裁切用固定 byte 位置切 Buffer，若剛好切在多位元組 UTF-8
// 字元中間，toString('utf8') 會把殘缺 byte 序列轉成替代字元 U+FFFD——中文業務資料（客戶名、
// 商品名、Odoo traceback）常見。maxBytes=100 刻意挑成「扣掉提示文字（30 bytes）後的預算
// 70 不是 3 的倍數」，確保裁切點必然落在某個中文字（3 bytes）中間，而不是幸運對齊邊界。
test('多位元組安全：裁切不落在字元中間，輸出不含替代字元 U+FFFD', () => {
  const raw = '中'.repeat(200); // 600 bytes，遠超過 maxBytes
  const big = { ts: 't', level: 'ERROR', logger: 'x', message: 'm', raw };
  const maxBytes = 100;
  const r = truncate([big], 200, maxBytes);
  expect(r.truncated).toBe(true);
  expect(r.entries[0].raw).not.toContain('�');
});

// 複審發現的 Minor：截斷提示文字（約 30 bytes）附加在裁到 maxBytes 的內容後面，
// 會讓總 bytes 超過宣稱的上限，與這支 finding 本身要驗證的「bytes ≤ maxBytes」矛盾。
test('多位元組情境下，含提示文字的總 bytes 仍不超過 maxBytes', () => {
  const raw = '中'.repeat(200);
  const big = { ts: 't', level: 'ERROR', logger: 'x', message: 'm', raw };
  const maxBytes = 100;
  const r = truncate([big], 200, maxBytes);
  expect(Buffer.byteLength(r.entries[0].raw, 'utf8')).toBeLessThanOrEqual(maxBytes);
});
