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
  const hasTimezoneOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(String(at).trim());
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

module.exports = { validateLogParams, WINDOWS, LEVELS, WINDOW_CAP };
