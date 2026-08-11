// Odoo log 的解析與過濾。純函式、無 IO——這是刻意的：本檔的邏輯最密，
// 獨立出來讓測試不需要任何 mock 就能密集覆蓋。
// 格式：2026-08-10 06:23:45,123 1234 ERROR test_db odoo.sql_db: message
const TS_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}) (\d+) (DEBUG|INFO|WARNING|ERROR|CRITICAL) (\S+) ([^\s:]+): ?([\s\S]*)$/;

const LEVEL_ORDER = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3, CRITICAL: 4 };
const LEVEL_THRESHOLD = { ALL: 0, INFO: 1, WARNING: 2, ERROR: 3 };

// 以「行首是時間戳」為記錄邊界切分。不符合的行（traceback 續行）併入前一筆的 raw。
// 檔頭出現的孤兒續行（時間範圍切割造成）直接丟棄——沒有所屬記錄，級別未知，
// 保留它只會讓下游過濾無所適從。
function splitEntries(text) {
  const entries = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = TS_RE.exec(line);
    if (m) {
      if (cur) entries.push(cur);
      cur = { ts: m[1], pid: m[2], level: m[3], db: m[4], logger: m[5], message: m[6], raw: line };
    } else if (cur) {
      cur.raw += '\n' + line;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

// 門檻語意：ERROR 取 ERROR 以上，WARNING 取 WARNING 以上，依此類推。
function filterByLevel(entries, level) {
  const min = LEVEL_THRESHOLD[level];
  if (min === undefined) return entries;
  return entries.filter(e => (LEVEL_ORDER[e.level] ?? 0) >= min);
}

module.exports = { TS_RE, splitEntries, filterByLevel, LEVEL_ORDER, LEVEL_THRESHOLD };
