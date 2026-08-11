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

// 關鍵字比對整筆 raw（含 traceback 內文），純字串 includes——不是 regex。
// 這是刻意的：關鍵字是唯一的自由文字參數，用 includes 既無 ReDoS 風險，
// 也不會讓 `.*` 之類的輸入意外放行全部。
function filterByKeyword(entries, keyword) {
  const k = String(keyword || '').trim().toLowerCase();
  if (!k) return entries;
  return entries.filter(e => e.raw.toLowerCase().includes(k));
}

// 雙重上限，先到者停，且一律以整筆記錄為單位。
function truncate(entries, maxEntries, maxBytes) {
  const out = [];
  let bytes = 0;
  for (const e of entries) {
    if (out.length >= maxEntries) return { entries: out, truncated: true };
    const size = Buffer.byteLength(e.raw, 'utf8') + 1;
    if (out.length && bytes + size > maxBytes) return { entries: out, truncated: true };
    out.push(e);
    bytes += size;
  }
  return { entries: out, truncated: false };
}

// 只遮憑證，不遮業務資料。長字串門檻取 32：Odoo 的路徑與 model 名都遠短於此，
// 而 session id / API key 通常 32 起跳。
// 處理三種格式：
// 1. Authorization: Bearer <token> — token 可含 dots（JWT format）
// 2. 'key': 'value' 或 "key": "value" — Python/JSON dict 形式
// 3. key=value 或 key: value — 裸露形式（含 underscore 欄位名如 access_token）
const BEARER_RE = /Authorization\s*:\s*Bearer\s+[\w.-]+/gi;
const QUOTED_CRED_RE = /(['"]?)(?:password|passwd|pwd|token|api[_-]?key|access_token|auth_token|csrf_token|secret|authorization)\1?\s*[:=]\s*(['"])([^'"]*)\2/gi;
const UNQUOTED_CRED_RE = /(?:password|passwd|pwd|token|api[_-]?key|access_token|auth_token|csrf_token|secret|authorization)\s*[:=]\s*(?!Bearer\s)([^\s,'";}\]]+)/gi;
const LONG_TOKEN_RE = /\b[A-Za-z0-9]{32,}\b/g;

function maskSecrets(text) {
  text = String(text == null ? '' : text);
  // Authorization: Bearer tokens first (handle full pattern to avoid conflicts with field name regex)
  text = text.replace(BEARER_RE, 'Authorization: Bearer ***');
  // Quoted credential values: 'password': 'value' or "api_key": "secret"
  text = text.replace(QUOTED_CRED_RE, (m, q1, q2) => {
    const start = m.substring(0, m.length - m.match(/(['"])[^'"]*\1$/)[0].length);
    return start + q2 + '***' + q2;
  });
  // Unquoted credential values: password=value or token: xyz (negative lookahead excludes Authorization: Bearer)
  text = text.replace(UNQUOTED_CRED_RE, (m) => {
    const sep = m.includes(':') ? ':' : '=';
    const idx = m.indexOf(sep);
    const prefix = m.substring(0, idx + sep.length);
    const spaceSuffix = m[idx + sep.length] === ' ' ? ' ' : '';
    return prefix + spaceSuffix + '***';
  });
  // Long alphanumeric strings (32+ chars)
  text = text.replace(LONG_TOKEN_RE, '***');
  return text;
}

module.exports = { TS_RE, splitEntries, filterByLevel, filterByKeyword, truncate, maskSecrets, LEVEL_ORDER, LEVEL_THRESHOLD };
