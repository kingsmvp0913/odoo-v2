const { query } = require('../db');
const { getUsage } = require('../lib/claude-usage');
const claudeAuth = require('../lib/claude-auth');

// 單一視窗的超標判定：回 { blocked, window, current, threshold, resets_at, stale }
function _evaluate(u, th5, th7) {
  // 從未成功抓過用量 → fail-open（不擋）；有 snapshot（含 stale）就照它判
  if (!u || u.available === false) return { available: false, blocked: false };
  const u5 = u.five_hour?.utilization;
  const u7 = u.seven_day?.utilization;
  const hit5 = u5 != null && u5 >= th5;
  const hit7 = u7 != null && u7 >= th7;
  const blocked = hit5 || hit7;         // OR
  return {
    available: true,
    blocked,
    window: hit5 ? '5h' : (hit7 ? '7d' : null),
    current: hit5 ? u5 : u7,
    threshold: hit5 ? th5 : th7,
    resets_at: hit5 ? u.five_hour?.resets_at : u.seven_day?.resets_at,
    stale: !!u.stale
  };
}

// 讀設定欄＋用量，算出閘門狀態。全域單一（全台共用同一 claude 帳號）。
// 主帳號撞門檻時，若備援開著且貼了備用憑證（另一份訂閱），改用備用憑證繼續跑而不是停下；
// 主帳號降回門檻下就切回。切換的旗標交給 lib/claude-auth，spawn 當下同步讀。
async function getGateState() {
  let s = {};
  try {
    const { rows } = await query(
      `SELECT usage_gate_enabled, usage_gate_5h_threshold, usage_gate_7d_threshold, usage_gate_fallback_enabled
       FROM teams_settings WHERE id=1`
    );
    s = rows[0] || {};
  } catch { /* 讀不到設定＝視為預設啟用（下方 default），config 讀取失敗故意 fail-closed 保護，不悄悄關閉閘門 */ }

  const enabled = s.usage_gate_enabled != null ? !!s.usage_gate_enabled : true;
  const th5 = s.usage_gate_5h_threshold ?? 90;
  const th7 = s.usage_gate_7d_threshold ?? 95;
  const fallbackEnabled = !!s.usage_gate_fallback_enabled;

  // 閘門關掉時一律回主憑證：否則上一輪切到備用後就停在那，第二份訂閱被無限燒卻沒有任何閘門在看
  if (!enabled) {
    claudeAuth.setActiveCredential('primary');
    return { enabled: false, blocked: false, reason: null, active_credential: 'primary', fallback_enabled: fallbackEnabled };
  }

  const u = await getUsage('primary');
  const primary = _evaluate(u, th5, th7);

  const base = {
    enabled: true, available: primary.available, stale: primary.stale,
    five_hour: u?.five_hour, seven_day: u?.seven_day,
    threshold_5h: th5, threshold_7d: th7,
    fallback_enabled: fallbackEnabled, backup: null
  };

  if (!primary.blocked) {
    claudeAuth.setActiveCredential('primary');
    return { ...base, blocked: false, reason: null, active_credential: 'primary' };
  }

  const reason = {
    window: primary.window, current: primary.current, threshold: primary.threshold,
    resets_at: primary.resets_at, stale: primary.stale
  };

  // 主帳號超標。備援可用時看備用帳號還有沒有額度。
  if (fallbackEnabled && claudeAuth.hasBackupToken()) {
    const bu = await getUsage('backup');
    const backup = _evaluate(bu, th5, th7);
    // 量不到備用的用量時比照既有 available:false 慣例 fail-open——切過去讓任務跑。
    //（長效 setup-token 能不能打 usage API 未經證實；量不到就整條停住等於備援白做）
    if (!backup.blocked) {
      claudeAuth.setActiveCredential('backup');
      return {
        ...base, blocked: false, reason: null, active_credential: 'backup',
        primary_reason: reason,
        backup: { available: backup.available, five_hour: bu?.five_hour, seven_day: bu?.seven_day, stale: backup.stale }
      };
    }
    // 備用也超標 → 回到原本的暫停行為，並把憑證切回主的（停著時沒有子行程在跑，切回較不易誤用）
    claudeAuth.setActiveCredential('primary');
    return {
      ...base, blocked: true, reason, active_credential: 'primary',
      backup: { available: backup.available, five_hour: bu?.five_hour, seven_day: bu?.seven_day, stale: backup.stale, blocked: true }
    };
  }

  claudeAuth.setActiveCredential('primary');
  return { ...base, blocked: true, reason, active_credential: 'primary' };
}

let _lastBlocked = false;
let _lastCredential = 'primary';

function _gateMessage(state) {
  const r = state.reason || {};
  const win = r.window === '5h' ? '5 小時視窗' : '本週';
  const staleNote = r.stale ? '（用量資料為快取，可能不是最新）' : '';
  return `Claude 用量閘門觸發：${win}用量 ${r.current}% 已達門檻 ${r.threshold}%，暫停自動推進任務${staleNote}。重置時間：${r.resets_at || '未知'}。`;
}

// 切到備用憑證要主動說一聲：第二份訂閱被燒掉而沒人知道，是這個功能最容易發生的失敗方式。
function _switchMessage(state) {
  const r = state.primary_reason || {};
  const win = r.window === '5h' ? '5 小時視窗' : '本週';
  return `Claude 主憑證${win}用量 ${r.current}% 已達門檻 ${r.threshold}%，已改用備用憑證繼續推進任務。主帳號重置時間：${r.resets_at || '未知'}。`;
}

async function _broadcast(payload, socketEvent, socketData, teamsHtml) {
  // socket 廣播（管理員在線即時看到）
  try { require('../notify').emitAll(socketEvent, socketData); } catch { /* 通知不影響閘門 */ }
  // 外部 webhook（離線出口）
  try { await require('../notify-webhook').sendWebhook(null, payload); } catch { /* best-effort */ }
  // Teams（若已設定）
  try {
    const teams = require('../teams');
    const settings = await teams.getSettings();
    if (teams.isConfigured(settings)) {
      await teams.sendChannelMessage(settings, teamsHtml);
    }
  } catch { /* best-effort */ }
}

async function _sendGateNotification(state) {
  const msg = _gateMessage(state);
  await _broadcast(
    { type: 'usage_gate_blocked', message: msg, reason: state.reason },
    'usage-gate:changed', { blocked: true, reason: state.reason },
    `<p><strong>⏸ ${msg}</strong></p>`
  );
}

async function _sendSwitchNotification(state) {
  const msg = _switchMessage(state);
  await _broadcast(
    { type: 'usage_gate_switched', message: msg, reason: state.primary_reason },
    'usage-gate:changed', { blocked: false, active_credential: 'backup', reason: state.primary_reason },
    `<p><strong>🔄 ${msg}</strong></p>`
  );
}

// cron 每 tick 呼叫一次：偵測 false→true 邊緣只發一次，避免每分鐘重複轟炸。
async function evaluateAndNotify() {
  const state = await getGateState();
  const nowBlocked = !!state.blocked;
  const wasBlocked = _lastBlocked;
  _lastBlocked = nowBlocked;

  const nowCred = state.active_credential || 'primary';
  const wasCred = _lastCredential;
  _lastCredential = nowCred;

  // fire-and-forget：慢／卡住的 Teams 或 webhook 呼叫不得讓 cron tick 卡死
  if (nowBlocked && !wasBlocked) {
    _sendGateNotification(state).catch(() => {});
  } else if (nowCred === 'backup' && wasCred !== 'backup') {
    _sendSwitchNotification(state).catch(() => {});
  }
  return state;
}

function _resetForTesting() { _lastBlocked = false; _lastCredential = 'primary'; }

module.exports = { getGateState, evaluateAndNotify, _resetForTesting };
