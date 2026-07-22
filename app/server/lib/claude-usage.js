const os = require('os');
const path = require('path');
const fs = require('fs');

// Claude Code 的 OAuth 憑證（本機 pipeline 用同一帳號跑 claude CLI）
const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL_MS = 60 * 1000;
// 磁碟 snapshot：server 重啟後 usage API 若當機仍能靠它判閘門／顯示。lib 在 app/server/lib/，
// 三個 .. 才回到 repo 根（app/server/lib → app/server → app → <repo>）。
const SNAPSHOT_PATH = process.env.CLAUDE_USAGE_CACHE
  || path.join(__dirname, '..', '..', '..', 'data', 'claude-usage.json');

let cache = { at: 0, data: null };
let lastGood = null;
try {
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  // 只接受真正的 usage snapshot（saveSnapshot 存的一定帶 available:true），
  // 避免讀到格式不符的檔案內容時誤當成好資料。
  if (snap && snap.available) lastGood = snap;
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

async function fetchUsage() {
  const raw = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const token = raw?.claudeAiOauth?.accessToken;
  if (!token) throw new Error('no oauth token');
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`usage api ${res.status}`);
  return res.json();
}

// route 與閘門共用：60s TTL cache 內只打一次 API。抓失敗回上一筆 snapshot（標 stale）；
// 從未成功則 available:false（閘門據此 fail-open）。
async function getUsage() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  try {
    const u = await fetchUsage();
    const data = {
      available: true,
      updated_at: new Date().toISOString(),
      five_hour: pick(u.five_hour),
      seven_day: pick(u.seven_day),
      seven_day_opus: pick(u.seven_day_opus),
      seven_day_sonnet: pick(u.seven_day_sonnet)
    };
    cache = { at: Date.now(), data };
    lastGood = data;
    saveSnapshot(data);
    return data;
  } catch (err) {
    if (lastGood) {
      const stale = { ...lastGood, stale: true };
      cache = { at: Date.now(), data: stale };
      return stale;
    }
    return { available: false, error: err.message };
  }
}

// 只清 60s TTL cache，強制下一次呼叫重新打 API；lastGood（stale fallback 用）保留，
// 讓「抓取失敗但有前一筆好資料」的情境可測。
function _resetCacheForTesting() { cache = { at: 0, data: null }; }

module.exports = { getUsage, _resetCacheForTesting };
