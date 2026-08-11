// 客戶正式區 Odoo log 讀取。與 lib/ssh-sql.js 的 runSelect 並列，共用同一條 SSH 通道。
//
// 安全模型與 runSelect 相反且更嚴：runSelect 讓呼叫端自由撰寫 SQL、靠黑名單攔截危險語句；
// 本模組所有進入指令的參數都是型別受控（時間戳由程式重新序列化、window/level 是 enum、
// 連線設定來自 DB），唯一的自由文字 keyword 根本不進指令，在平台側比對。
const { splitEntries, filterByLevel, filterByKeyword, truncate, maskSecrets } = require('./log-parse');

const WINDOWS = [10, 30, 60];
const LEVELS = ['ERROR', 'WARNING', 'INFO', 'ALL'];
// INFO/ALL 量級遠大於 ERROR/WARNING，窗必須跟著縮
const WINDOW_CAP = { INFO: 10, ALL: 10 };

function validateLogParams({ at, window, level, keyword } = {}) {
  if (!at) return { ok: false, error: '必須指定事發時間點 at（ISO 8601，含時區）' };

  // 檢查時區偏移。Date.parse 沒偏移會用伺服器本機時區解讀，跨機器會產生 8 小時錯誤。
  // 接受 Z/z（UTC）或 ±HH:MM/±HHMM 格式。
  const hasTimezoneOffset = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(String(at).trim());
  if (!hasTimezoneOffset) {
    return { ok: false, error: '`at` 必須帶時區偏移（如 `+08:00` 或 `Z`），否則會被當成伺服器本機時間解讀' };
  }

  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) return { ok: false, error: `at 無法解析為時間：${at}` };

  const windowMin = window === undefined || window === null ? 10 : Number(window);
  if (!WINDOWS.includes(windowMin)) return { ok: false, error: `window 只接受 ${WINDOWS.join(' / ')} 分鐘` };

  const lv = level === undefined || level === null || level === '' ? 'ERROR' : String(level).toUpperCase();
  if (!LEVELS.includes(lv)) return { ok: false, error: `level 只接受 ${LEVELS.join(' / ')}` };

  const cap = WINDOW_CAP[lv];
  if (cap && windowMin > cap) {
    return { ok: false, error: `level=${lv} 的資料量遠大於 ERROR，window 上限為 ${cap} 分鐘（收到 ${windowMin}）` };
  }

  return { ok: true, atMs, windowMin, level: lv, keyword: keyword == null ? '' : String(keyword) };
}

const IDENT_RE = /^[A-Za-z0-9_.\-]+$/;
const PATH_RE = /^\/[A-Za-z0-9_.\-\/]+$/;

function validateLogPath(p) {
  const s = String(p || '');
  return PATH_RE.test(s) && !s.includes('..');
}

function requireIdent(val, name) {
  if (!val) throw new Error(`連線缺少 ${name}，請先執行 log 來源偵測`);
  if (!IDENT_RE.test(String(val))) throw new Error(`連線欄位 ${name} 含不允許的字元`);
  return String(val);
}

// 兩位數補零的 UTC 分解，避免依賴執行機時區。
function partsUtc(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}
function isoUtc(ms) { const { date, time } = partsUtc(ms); return `${date}T${time}Z`; }
function spaceUtc(ms) { const { date, time } = partsUtc(ms); return `${date} ${time}`; }

// sudo 前綴：沿用 ssh-sql 的慣例，有密碼走 sudo -S，沒有就直接 sudo。
function sudoPrefix(conn) {
  const pw = conn.ssh_password || '';
  if (!pw) return 'sudo ';
  return `echo '${pw.replace(/'/g, "'\\''")}' | sudo -S `;
}

// 時間基準三者不同，見計畫「對 spec 未定處的明確化」第 3 點。
function buildLogCmd(conn, fromMs, toMs) {
  const mode = conn.log_mode;
  if (!mode) throw new Error('此連線尚未偵測 log 來源，請先至連線設定執行偵測');

  if (mode === 'docker') {
    const c = requireIdent(conn.log_container, 'log_container');
    return `${sudoPrefix(conn)}docker logs --since ${isoUtc(fromMs)} --until ${isoUtc(toMs)} ${c} 2>&1`;
  }

  if (mode === 'journald') {
    const u = requireIdent(conn.log_unit, 'log_unit');
    return `${sudoPrefix(conn)}journalctl -u ${u} --since "${spaceUtc(fromMs)} UTC" --until "${spaceUtc(toMs)} UTC" -o cat`;
  }

  if (mode === 'file') {
    if (!validateLogPath(conn.log_path)) throw new Error('log_path 不是合法的絕對路徑');
    const off = Number(conn.log_tz_offset || 0) * 60000;
    const s = spaceUtc(fromMs + off);
    const e = spaceUtc(toMs + off);
    // 利用 Odoo 時間戳字典序即時間序的特性；inrange 讓 traceback 續行跟隨所屬記錄。
    const awk = `/^[0-9]{4}-/ { inrange = ($0 >= s && $0 <= e) } inrange`;
    return `${sudoPrefix(conn)}awk -v s="${s}" -v e="${e}" '${awk}' ${conn.log_path}`;
  }

  throw new Error(`未知的 log_mode：${mode}`);
}

module.exports = { validateLogParams, WINDOWS, LEVELS, WINDOW_CAP, buildLogCmd, validateLogPath };
