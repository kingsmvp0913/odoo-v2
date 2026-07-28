// 從 Odoo 容器 log 判斷「最後一次有人真的在用」的時間，供閒置回收與壓力徵收共用。
// 純函式（不碰 docker／DB），故可離線單測。
//
// Odoo 預設會把每個 HTTP 請求寫進 log（werkzeug logger, INFO），格式：
//   2026-07-28 10:23:45,123 1 INFO test_cwt werkzeug: 127.0.0.1 - - [...] "GET /web HTTP/1.1" 200 -
// 行首時間戳為 UTC。

// 輪詢類請求不算「有人在用」：Odoo 前端的 bus/longpolling 會持續打，使用者把分頁開著忘了關
// 就會讓環境永遠不閒置，池子被一個沒人在看的測試區長期佔住。
const POLLING_PATTERNS = [
  '/longpolling/poll',
  '/websocket',
  'bus.bus',
];

const LINE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3})\b.*\bwerkzeug:/;

function parseLastActivity(logText) {
  if (!logText) return null;
  const lines = String(logText).split(/\r?\n/);
  // 由後往前找：只要最後一筆真實請求，不需要掃完整份 log
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = LINE_RE.exec(line);
    if (!m) continue;
    if (POLLING_PATTERNS.some(p => line.includes(p))) continue;
    const d = new Date(`${m[1]}T${m[2]}.000Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

module.exports = { parseLastActivity, POLLING_PATTERNS };
