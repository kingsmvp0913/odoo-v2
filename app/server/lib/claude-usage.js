const os = require('os');
const path = require('path');
const fs = require('fs');

// 本機互動式登入憑證：管理員沒在網頁設主憑證時的退路（既有行為）
const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL_MS = 60 * 1000;
// 磁碟 snapshot：server 重啟後 usage API 若當機仍能靠它判閘門／顯示。lib 在 app/server/lib/，
// 三個 .. 才回到 repo 根（app/server/lib → app/server → app → <repo>）。
// 只存主憑證的用量——備用是「撞閘門才用」的旁路，沒有跨重啟保存的必要。
const SNAPSHOT_PATH = process.env.CLAUDE_USAGE_CACHE
  || path.join(__dirname, '..', '..', '..', 'data', 'claude-usage.json');

// 主／備各一份快取：共用一份會讓「量過主帳號」的數字被當成備用帳號的回報
const _state = {
  primary: { cache: { at: 0, data: null }, lastGood: null },
  backup: { cache: { at: 0, data: null }, lastGood: null }
};

try {
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  // 只接受真正的 usage snapshot（saveSnapshot 存的一定帶 available:true），
  // 避免讀到格式不符的檔案內容時誤當成好資料。
  if (snap && snap.available) _state.primary.lastGood = snap;
} catch { /* 尚無 snapshot */ }

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
  if (!res.ok) throw new Error(`usage api ${res.status}`);
  return res.json();
}

// route 與閘門共用：60s TTL cache 內只打一次 API。抓失敗回上一筆 snapshot（標 stale）；
// 從未成功則 available:false（閘門據此 fail-open）。
async function getUsage(which = 'primary') {
  const st = _state[which === 'backup' ? 'backup' : 'primary'];
  if (st.cache.data && Date.now() - st.cache.at < CACHE_TTL_MS) return st.cache.data;
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
    if (which !== 'backup') saveSnapshot(data);
    return data;
  } catch (err) {
    if (st.lastGood) {
      const stale = { ...st.lastGood, stale: true };
      st.cache = { at: Date.now(), data: stale };
      return stale;
    }
    const data = { available: false, error: err.message };
    st.cache = { at: Date.now(), data };
    return data;
  }
}

// 只清 60s TTL cache，強制下一次呼叫重新打 API；lastGood（stale fallback 用）保留，
// 讓「抓取失敗但有前一筆好資料」的情境可測。
function _resetCacheForTesting() {
  _state.primary.cache = { at: 0, data: null };
  _state.backup.cache = { at: 0, data: null };
}

module.exports = { getUsage, _resetCacheForTesting };
