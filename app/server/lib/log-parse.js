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
// 例外：第一筆本身就超過 maxBytes（如 QWeb/ORM 例外把整個 context 傾印進單一 message）——
// 若無條件放行，MAX_BYTES 存在的理由（防止爆 agent context）就形同虛設，且 truncated 仍是
// false 會讓 agent 誤以為內容完整。此時把該筆 raw 裁到 maxBytes 並標記，一併回報 truncated。
function truncate(entries, maxEntries, maxBytes) {
  const out = [];
  let bytes = 0;
  for (const e of entries) {
    if (out.length >= maxEntries) return { entries: out, truncated: true };
    const size = Buffer.byteLength(e.raw, 'utf8') + 1;
    if (out.length && bytes + size > maxBytes) return { entries: out, truncated: true };
    if (out.length === 0 && size > maxBytes) {
      const clipped = Buffer.from(e.raw, 'utf8').subarray(0, maxBytes).toString('utf8');
      out.push({ ...e, raw: `${clipped}（單筆過長，已截斷）` });
      return { entries: out, truncated: true };
    }
    out.push(e);
    bytes += size;
  }
  return { entries: out, truncated: false };
}

// 只遮憑證，不遮業務資料。長字串門檻取 32：Odoo 的路徑與 model 名都遠短於此，
// 而 session id / API key 通常 32 起跳。
// 處理三種格式：
// 1. Authorization: Bearer 或 Authorization=Bearer — 兩種分隔符都要支援
// 2. 'key': 'value' 或 "key": "value" — Python/JSON dict 形式
// 3. key=value 或 key: value — 裸露形式（含 underscore 欄位名如 access_token）
// 關鍵修正：
// - 用 capture group 明確捕捉分隔符，不靠事後猜測（避免值含冒號導致誤判）
// - 長欄位名先在 alternation 前面（access_token 要在 token 前，防止被短名吃掉）
// - 用 negative lookbehind (?<![\w-]) 代替 \b（underscore 是 word char，\b 無法判界）
const BEARER_RE_COLON = /Authorization\s*:\s*Bearer\s+[\w.-]+/gi;
const BEARER_RE_EQUAL = /Authorization\s*=\s*Bearer\s+[\w.-]+/gi;
const QUOTED_CRED_RE = /(?<![\w-])(['"]?)(?:access_token|auth_token|csrf_token|api[_-]?key|password|passwd|pwd|token|secret|authorization)\1?\s*([:=])\s*(['"])([^'"]*)\3/gi;
const UNQUOTED_CRED_RE = /(?<![\w-])((?:access_token|auth_token|csrf_token|api[_-]?key|password|passwd|pwd|token|secret|authorization))\s*([:=])\s*(?!Bearer\s)([^\s,'";}\]]+)/gi;
const LONG_TOKEN_RE = /\b[A-Za-z0-9]{32,}\b/g;

function maskSecrets(text) {
  text = String(text == null ? '' : text);
  // Authorization: Bearer tokens (both : and = separators)
  text = text.replace(BEARER_RE_COLON, 'Authorization: Bearer ***');
  text = text.replace(BEARER_RE_EQUAL, 'Authorization=Bearer ***');
  // Quoted credential values: replace value part with *** (e.g., 'password': 'hunter2' → 'password': '***')
  text = text.replace(QUOTED_CRED_RE, (m) => {
    return m.replace(/(['"])([^'"]*)\1$/, '$1***$1');
  });
  // Unquoted credential values: replace value with *** using capture group to find actual separator
  // Captures: (key) (sep) (value) — no need to guess separator location
  text = text.replace(UNQUOTED_CRED_RE, (m, key, sep, value) => {
    return m.substring(0, m.length - value.length) + '***';
  });
  // Long alphanumeric strings (32+ chars)
  text = text.replace(LONG_TOKEN_RE, '***');
  return text;
}

module.exports = { TS_RE, splitEntries, filterByLevel, filterByKeyword, truncate, maskSecrets, LEVEL_ORDER, LEVEL_THRESHOLD };
