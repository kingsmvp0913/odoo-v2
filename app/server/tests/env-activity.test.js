// 意圖：閒置判定必須排除輪詢類請求——Odoo 前端的 bus/longpolling 會持續打，
// 使用者把分頁開著忘了關就會讓環境「永遠活躍」，池子被一個沒人在看的測試區長期佔住。
const { parseLastActivity } = require('../lib/env-activity');

const REAL = '2026-07-28 10:23:45,123 1 INFO test_cwt werkzeug: 127.0.0.1 - - [28/Jul/2026 10:23:45] "GET /web HTTP/1.1" 200 -';
const POLL = '2026-07-28 11:00:00,000 1 INFO test_cwt werkzeug: 127.0.0.1 - - [28/Jul/2026 11:00:00] "POST /longpolling/poll HTTP/1.1" 200 -';
const WS   = '2026-07-28 11:05:00,000 1 INFO test_cwt werkzeug: 127.0.0.1 - - [28/Jul/2026 11:05:00] "GET /websocket HTTP/1.1" 101 -';
const BUS  = '2026-07-28 11:10:00,000 1 INFO test_cwt werkzeug: 127.0.0.1 - - [28/Jul/2026 11:10:00] "POST /web/dataset/call_kw/bus.bus/_poll HTTP/1.1" 200 -';

test('取最後一筆真實請求的時間（UTC）', () => {
  const d = parseLastActivity([REAL].join('\n'));
  expect(d.toISOString()).toBe('2026-07-28T10:23:45.000Z');
});

test('多筆真實請求 → 取最後一筆', () => {
  const later = REAL.replace('10:23:45', '12:00:00');
  const d = parseLastActivity([REAL, later].join('\n'));
  expect(d.toISOString()).toBe('2026-07-28T12:00:00.000Z');
});

test('longpolling／websocket／bus.bus 一律不算活躍', () => {
  expect(parseLastActivity([POLL, WS, BUS].join('\n'))).toBeNull();
});

// 意圖：這是本模組存在的唯一理由——分頁開著的輪詢不得蓋掉真實活動時間。
test('真實請求之後只有輪詢 → 仍回真實請求那一刻，不被輪詢往後推', () => {
  const d = parseLastActivity([REAL, POLL, WS, BUS].join('\n'));
  expect(d.toISOString()).toBe('2026-07-28T10:23:45.000Z');
});

test('非 werkzeug 的日誌行（模組載入、ORM 訊息）不算活躍', () => {
  const noise = '2026-07-28 13:00:00,000 1 INFO test_cwt odoo.modules.loading: loading 1 modules...';
  expect(parseLastActivity(noise)).toBeNull();
});

test('空字串／無可辨識行 → null', () => {
  expect(parseLastActivity('')).toBeNull();
  expect(parseLastActivity('garbage\nlines')).toBeNull();
});

test('容忍 CRLF 與尾端空行', () => {
  const d = parseLastActivity(`${REAL}\r\n\r\n`);
  expect(d.toISOString()).toBe('2026-07-28T10:23:45.000Z');
});
