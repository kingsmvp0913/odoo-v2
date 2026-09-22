/**
 * release-window.js — 「現在是不是維護時段」的唯一真相。
 *
 * 刻意不碰 DB、不碰 process.env：時段算錯的後果（該重啟的週末沒重啟／上班時間把人踢下線）
 * 完全不會留下 log，所以它必須是能用表格窮舉測試的純函式。
 * 時區用平台所在機器的本地時間（台北），與排程頁顯示的一致——不要在這裡做時區轉換。
 */
function isInWindow(cfg, now) {
  if (!cfg || !Array.isArray(cfg.weekdays) || !cfg.weekdays.length) return false;
  if (!cfg.weekdays.includes(now.getDay())) return false;
  const start = new Date(now);
  start.setHours(cfg.startHour, 0, 0, 0);
  const end = new Date(start.getTime() + cfg.durationHours * 3600000);
  // 進場含、出場不含：兩邊都含的話，設成連續兩天會在交界那一秒重複觸發。
  return now >= start && now < end;
}

function nextWindow(cfg, now) {
  if (!cfg || !Array.isArray(cfg.weekdays) || !cfg.weekdays.length) return null;
  if (isInWindow(cfg, now)) {
    const s = new Date(now); s.setHours(cfg.startHour, 0, 0, 0); return s;
  }
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    d.setHours(cfg.startHour, 0, 0, 0);
    if (cfg.weekdays.includes(d.getDay()) && d > now) return d;
  }
  return null;
}

module.exports = { isInWindow, nextWindow };
