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

// 邊緣通知的狀態（Task 6 填內容），此處先建立以固定介面
let _lastBlocked = false;
function _resetForTesting() { _lastBlocked = false; }

module.exports = { getGateState, _resetForTesting };
