const { query } = require('../db');
const { getUsage, getRateLimitState } = require('../lib/claude-usage');
const claudeAuth = require('../lib/claude-auth');

// rate_limit_event 的 status 值域只實測過 allowed。故意寫成黑名單而非白名單：
// 拿沒把握的未知值去停 pipeline，誤停的代價遠大於漏擋。認不得的值只記一次 log
// 供日後補進本表，行為完全維持現狀。
const RL_BLOCKING = new Set(['rejected', 'blocked', 'exceeded', 'limited']);
const RL_OK = new Set(['allowed', 'allowed_warning', 'warning']);
const _rlUnknownSeen = new Set();

// 百分比來自 usage API，那支端點被 429 罰站時就凍在舊值上（2026-09-07 實地觀察凍住近兩
// 小時），閘門等於瞎的。rate_limit_event 走 pipeline 自己的 stream-json、不花配額、429
// 期間照樣更新，是那段期間唯一還會動的真相來源；缺點是沒有百分比。
// 故只拿它「加擋」不拿它「放行」：百分比判不擋但它說被拒 → 改判擋；百分比已判擋 →
// 不因它而放行。最壞情況（值域猜錯）退回原本的行為，不會誤停。
function _rateLimitBlock(rl) {
  if (!rl || typeof rl.status !== 'string') return null;
  if (RL_OK.has(rl.status)) return null;
  if (!RL_BLOCKING.has(rl.status)) {
    if (!_rlUnknownSeen.has(rl.status)) {
      _rlUnknownSeen.add(rl.status);
      console.warn(`[USAGE-GATE] 未知的 rate_limit_event status「${rl.status}」，不據此擋任務；確認語意後補進 RL_BLOCKING／RL_OK`);
    }
    return null;
  }
  // 視窗已重置就作廢：這筆狀態只在它自己的視窗內成立，而任務不是隨時在跑，
  // 沒有新事件覆蓋時它會一直留著（且跨重啟保留），否則會擋到天荒地老。
  const resets = Date.parse(rl.resets_at || '');
  if (Number.isFinite(resets) && resets <= Date.now()) return null;
  return {
    window: rl.rate_limit_type === 'seven_day' ? '7d' : '5h',
    current: null,
    threshold: null,
    resets_at: rl.resets_at || null,
    stale: false,
    source: 'rate_limit_event'
  };
}

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
  // 百分比判不擋時才問串流事件（見 _rateLimitBlock）——它只加擋、不放行。
  const rlReason = primary.blocked ? null : _rateLimitBlock(getRateLimitState());
  const blocked = primary.blocked || !!rlReason;

  const base = {
    enabled: true, available: primary.available, stale: primary.stale,
    five_hour: u?.five_hour, seven_day: u?.seven_day,
    threshold_5h: th5, threshold_7d: th7,
    fallback_enabled: fallbackEnabled, backup: null
  };

  if (!blocked) {
    claudeAuth.setActiveCredential('primary');
    return { ...base, blocked: false, reason: null, active_credential: 'primary' };
  }

  const reason = rlReason || {
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
  // rate_limit_event 那條來源只給狀態不給百分比，照原句型會印出「用量 null% 已達門檻
  // null%」。訊息是給人看的，說不出數字就別假裝有。
  const detail = r.source === 'rate_limit_event'
    ? `Claude 回報${win}已被限流`
    : `${win}用量 ${r.current}% 已達門檻 ${r.threshold}%`;
  return `Claude 用量閘門觸發：${detail}，暫停自動推進任務${staleNote}。重置時間：${r.resets_at || '未知'}。`;
}

// 切到備用憑證要主動說一聲：第二份訂閱被燒掉而沒人知道，是這個功能最容易發生的失敗方式。
function _switchMessage(state) {
  const r = state.primary_reason || {};
  const win = r.window === '5h' ? '5 小時視窗' : '本週';
  const detail = r.source === 'rate_limit_event'
    ? `Claude 回報主憑證${win}已被限流`
    : `Claude 主憑證${win}用量 ${r.current}% 已達門檻 ${r.threshold}%`;
  return `${detail}，已改用備用憑證繼續推進任務。主帳號重置時間：${r.resets_at || '未知'}。`;
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
