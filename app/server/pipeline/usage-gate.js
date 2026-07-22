const { query } = require('../db');
const { getUsage } = require('../lib/claude-usage');

// 讀三個設定欄＋用量，算出閘門狀態。全域單一（全台共用同一 claude 帳號）。
async function getGateState() {
  let s = {};
  try {
    const { rows } = await query(
      'SELECT usage_gate_enabled, usage_gate_5h_threshold, usage_gate_7d_threshold FROM teams_settings WHERE id=1'
    );
    s = rows[0] || {};
  } catch { /* 讀不到設定＝視為預設啟用（下方 default） */ }

  const enabled = s.usage_gate_enabled != null ? !!s.usage_gate_enabled : true;
  const th5 = s.usage_gate_5h_threshold ?? 90;
  const th7 = s.usage_gate_7d_threshold ?? 95;

  if (!enabled) return { enabled: false, blocked: false, reason: null };

  const u = await getUsage();
  // 從未成功抓過用量 → fail-open（不擋）；有 snapshot（含 stale）就照它判
  if (!u || u.available === false) {
    return { enabled: true, blocked: false, reason: null, available: false };
  }

  const u5 = u.five_hour?.utilization;
  const u7 = u.seven_day?.utilization;
  const hit5 = u5 != null && u5 >= th5;
  const hit7 = u7 != null && u7 >= th7;
  const blocked = hit5 || hit7;         // OR
  const win = hit5 ? '5h' : (hit7 ? '7d' : null);
  const reason = blocked ? {
    window: win,
    current: hit5 ? u5 : u7,
    threshold: hit5 ? th5 : th7,
    resets_at: hit5 ? u.five_hour?.resets_at : u.seven_day?.resets_at,
    stale: !!u.stale
  } : null;

  return {
    enabled: true, blocked, reason, available: true, stale: !!u.stale,
    five_hour: u.five_hour, seven_day: u.seven_day,
    threshold_5h: th5, threshold_7d: th7
  };
}

let _lastBlocked = false;

function _gateMessage(state) {
  const r = state.reason || {};
  const win = r.window === '5h' ? '5 小時視窗' : '本週';
  const staleNote = r.stale ? '（用量資料為快取，可能不是最新）' : '';
  return `Claude 用量閘門觸發：${win}用量 ${r.current}% 已達門檻 ${r.threshold}%，暫停自動推進任務${staleNote}。重置時間：${r.resets_at || '未知'}。`;
}

async function _sendGateNotification(state) {
  const msg = _gateMessage(state);
  const payload = { type: 'usage_gate_blocked', message: msg, reason: state.reason };
  // socket 廣播（管理員在線即時看到）
  try { require('../notify').emitAll('usage-gate:changed', { blocked: true, reason: state.reason }); } catch { /* 通知不影響閘門 */ }
  // 外部 webhook（離線出口）
  try { await require('../notify-webhook').sendWebhook(null, payload); } catch { /* best-effort */ }
  // Teams（若已設定）
  try {
    const teams = require('../teams');
    const settings = await teams.getSettings();
    if (teams.isConfigured(settings)) {
      await teams.sendChannelMessage(settings, `<p><strong>⏸ ${msg}</strong></p>`);
    }
  } catch { /* best-effort */ }
}

// cron 每 tick 呼叫一次：偵測 false→true 邊緣只發一次，避免每分鐘重複轟炸。
async function evaluateAndNotify() {
  const state = await getGateState();
  const nowBlocked = !!state.blocked;
  if (nowBlocked && !_lastBlocked) {
    await _sendGateNotification(state);
  }
  _lastBlocked = nowBlocked;
  return state;
}

function _resetForTesting() { _lastBlocked = false; }

module.exports = { getGateState, evaluateAndNotify, _resetForTesting };
