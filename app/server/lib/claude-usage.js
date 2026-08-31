const os = require('os');
const path = require('path');
const fs = require('fs');

// 本機互動式登入憑證：管理員沒在網頁設主憑證時的退路（既有行為）
const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// /api/oauth/usage 是非官方端點，限流分兩層。2026-08-31 實測量出門檻：
//   短窗——2 秒間隔連打，第 7 次才 429（Retry-After=300）⇒ 約「5 分鐘 6 次」。
//   60 秒間隔連打 10 次（跨 10 分鐘）全數 200，一次都沒被擋。
// 先前設 10 分鐘是把「曾經撞過 429」誤讀成「這端點不准頻繁問」，反而讓畫面在冷卻期
// 卡上 40 分鐘的 stale。60s 換算＝5 分鐘 5 次，仍在短窗門檻下。
// ⚠ 只實測了 10 分鐘，24/7 長跑會不會累積撞到更深一層（平台憑證曾被罰 Retry-After 2476s）
// 未經驗證；下方的 blockedUntil 退避是安全網，最壞退回原本的行為。
// 改這裡要連同前端 app.js 的輪詢間隔一起改。
const CACHE_TTL_MS = 60 * 1000;
// 磁碟 snapshot：server 重啟後 usage API 若當機仍能靠它判閘門／顯示。lib 在 app/server/lib/，
// 三個 .. 才回到 repo 根（app/server/lib → app/server → app → <repo>）。
// 只存主憑證的用量——備用是「撞閘門才用」的旁路，沒有跨重啟保存的必要。
const SNAPSHOT_PATH = process.env.CLAUDE_USAGE_CACHE
  || path.join(__dirname, '..', '..', '..', 'data', 'claude-usage.json');
// pipeline 每次 spawn claude 都跑 `--output-format stream-json --verbose`，串流裡本來就帶
// rate_limit_event（實測欄位：status／resetsAt／rateLimitType／overageStatus）。那是跑任務用的
// 那把憑證當下的狀態，不必額外打限流端點就拿得到，且 429 期間照樣有效——usage API 卡住時
// 這是唯一還會更新的真相來源。缺點是它不帶百分比，故只補狀態、不取代 utilization。
const RATE_LIMIT_PATH = process.env.CLAUDE_RATE_LIMIT_CACHE
  || path.join(__dirname, '..', '..', '..', 'data', 'claude-rate-limit.json');
// API 成功時留下 (時間, utilization, 視窗重置時間) 樣本，供日後回推「1% 值多少 token」。
// 刻意不在此刻統計 token：token_usage 表一直在記且 recorded_at 有索引，任何時候都能依這裡的
// 時間戳回溯配對，現在算反而讓 lib 綁上 DB。
const CALIBRATION_PATH = process.env.CLAUDE_USAGE_CALIBRATION
  || path.join(__dirname, '..', '..', '..', 'data', 'claude-usage-calibration.jsonl');
// 每筆約 200 bytes；256KB 約可存兩週（10 分鐘一筆）。超過就只留後半，避免無上限成長。
const CALIBRATION_MAX_BYTES = 256 * 1024;

// 主／備各一份快取：共用一份會讓「量過主帳號」的數字被當成備用帳號的回報
// blockedUntil 逐把憑證各記各的：限流是綁在 token 上的，連坐會讓閘門看不到備用的真實用量。
const _state = {
  primary: { cache: { at: 0, data: null }, lastGood: null, blockedUntil: 0 },
  backup: { cache: { at: 0, data: null }, lastGood: null, blockedUntil: 0 }
};

// 最近一次 rate_limit_event。跨重啟保留：任務不是隨時在跑，重啟後若清空，
// 到下一張任務跑完之前都會誤判成「從來沒有狀態」。
let _rateLimit = null;

try {
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  // 只接受真正的 usage snapshot（saveSnapshot 存的一定帶 available:true），
  // 避免讀到格式不符的檔案內容時誤當成好資料。
  if (snap && snap.available) _state.primary.lastGood = snap;
} catch { /* 尚無 snapshot */ }

try {
  const rl = JSON.parse(fs.readFileSync(RATE_LIMIT_PATH, 'utf8'));
  if (rl && typeof rl.status === 'string') _rateLimit = rl;
} catch { /* 尚無 rate limit 記錄 */ }

function pick(w) {
  return w && w.utilization != null
    ? { utilization: w.utilization, resets_at: w.resets_at }
    : null;
}

function saveSnapshot(data) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(data));
  } catch { /* best-effort */ }
}

// claude CLI 的 rate_limit_event。resetsAt／overageResetsAt 是「秒」為單位的 epoch
//（實測 1787809200 → 2026-08-27T05:40:00Z，與同時間 API 回的 five_hour.resets_at 只差 1 秒）。
// status 認不出來就整筆不留：寧可沒有狀態，也不要拿半筆殘值去驅動判斷。
function recordRateLimitEvent(info) {
  if (!info || typeof info !== 'object') return null;
  if (typeof info.status !== 'string' || !info.status) return null;
  const epochToIso = v => (Number.isFinite(v) && v > 0 ? new Date(v * 1000).toISOString() : null);
  const state = {
    status: info.status,
    rate_limit_type: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
    resets_at: epochToIso(info.resetsAt),
    overage_status: typeof info.overageStatus === 'string' ? info.overageStatus : null,
    overage_resets_at: epochToIso(info.overageResetsAt),
    is_using_overage: info.isUsingOverage === true,
    observed_at: new Date().toISOString()
  };
  _rateLimit = state;
  try {
    fs.mkdirSync(path.dirname(RATE_LIMIT_PATH), { recursive: true });
    fs.writeFileSync(RATE_LIMIT_PATH, JSON.stringify(state));
  } catch { /* best-effort：落檔失敗不影響 pipeline */ }
  return state;
}

// 只回記憶體那份（啟動時已從檔案載入）。沒有任務跑過就是 null，呼叫端自行判斷。
function getRateLimitState() {
  return _rateLimit;
}

// 校準樣本：只在 API 回真值時追加，抓不到／stale 一律不記，否則樣本會被推估值汙染。
function _appendCalibration(data) {
  try {
    const line = JSON.stringify({
      at: data.updated_at,
      five_hour: data.five_hour?.utilization ?? null,
      seven_day: data.seven_day?.utilization ?? null,
      five_hour_resets_at: data.five_hour?.resets_at ?? null,
      seven_day_resets_at: data.seven_day?.resets_at ?? null
    }) + '\n';
    fs.mkdirSync(path.dirname(CALIBRATION_PATH), { recursive: true });
    fs.appendFileSync(CALIBRATION_PATH, line);
    if (fs.statSync(CALIBRATION_PATH).size > CALIBRATION_MAX_BYTES) {
      const lines = fs.readFileSync(CALIBRATION_PATH, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(CALIBRATION_PATH, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
    }
  } catch { /* best-effort */ }
}

// 量哪一把憑證的用量，就拿那一把去打 API——跑任務用的是管理員設定的 token，
// 永遠打本機憑證檔會在兩者不同帳號時量到不相干的數字。
// 備用沒設定時回 null（不得拿本機憑證檔頂替：那會把主帳號的用量回報成備用帳號的，
// 閘門看到「備用還很空」就切過去，實際切到同一個已超標的帳號）。
function _tokenFor(which) {
  let tok = null;
  try { tok = require('./claude-auth').getTokenFor(which); } catch { /* 尚未初始化 */ }
  if (tok) return tok;
  if (which === 'backup') return null;
  const raw = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  return raw?.claudeAiOauth?.accessToken || null;
}

async function fetchUsage(which) {
  const token = _tokenFor(which);
  if (!token) throw new Error('no oauth token');
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json'
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) {
    const err = new Error(`usage api ${res.status}`);
    if (res.status === 429) {
      // Retry-After 缺漏或不是秒數就退 5 分鐘（別退回「每 TTL 再打一次」）；
      // 上限 1 小時，避免異常大的值把用量顯示凍住好幾天。
      const ra = Number(res.headers.get('retry-after'));
      err.retryAfterMs = Math.min(Number.isFinite(ra) && ra > 0 ? ra : 300, 3600) * 1000;
    }
    throw err;
  }
  return res.json();
}

// route 與閘門共用：60s TTL cache 內只打一次 API。抓失敗回上一筆 snapshot（標 stale）；
// 從未成功則 available:false（閘門據此 fail-open）。
// 抓不到時的降級結果：有 snapshot 就標 stale 交出去，從未成功則 available:false（閘門 fail-open）
function _degraded(st, reason) {
  return st.lastGood ? { ...st.lastGood, stale: true } : { available: false, error: reason };
}

async function getUsage(which = 'primary') {
  const st = _state[which === 'backup' ? 'backup' : 'primary'];
  if (st.cache.data && Date.now() - st.cache.at < CACHE_TTL_MS) return st.cache.data;
  // 冷卻窗內不再送請求：實測 Retry-After 是逐秒倒數的，窗口不因重打而延長，硬打只是白燒配額。
  if (Date.now() < st.blockedUntil) return _degraded(st, 'rate limited');
  try {
    const u = await fetchUsage(which);
    const data = {
      available: true,
      updated_at: new Date().toISOString(),
      five_hour: pick(u.five_hour),
      seven_day: pick(u.seven_day),
      seven_day_opus: pick(u.seven_day_opus),
      seven_day_sonnet: pick(u.seven_day_sonnet)
    };
    st.cache = { at: Date.now(), data };
    st.lastGood = data;
    if (which !== 'backup') {
      saveSnapshot(data);
      _appendCalibration(data); // 只有主憑證的真值才是校準樣本
    }
    return data;
  } catch (err) {
    if (err.retryAfterMs) st.blockedUntil = Date.now() + err.retryAfterMs;
    const data = _degraded(st, err.message);
    st.cache = { at: Date.now(), data };
    return data;
  }
}

// 只清 TTL cache，強制下一次呼叫重新打 API；lastGood（stale fallback 用）與 blockedUntil
// （限流冷卻）保留，讓「抓取失敗但有前一筆好資料」與「冷卻窗內不再打」兩個情境可測。
function _resetCacheForTesting() {
  _state.primary.cache = { at: 0, data: null };
  _state.backup.cache = { at: 0, data: null };
  _rateLimit = null;
}

module.exports = { getUsage, recordRateLimitEvent, getRateLimitState, _resetCacheForTesting };
