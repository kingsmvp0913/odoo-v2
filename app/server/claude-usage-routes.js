const os = require('os');
const path = require('path');
const fs = require('fs');
const { verifyToken } = require('./auth');
const { query } = require('./db');

// Claude Code stores its OAuth credentials here; the server runs `claude` on the
// same machine (see pipeline/claude-runner.js), so this is the account whose
// usage we report.
const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL_MS = 60 * 1000;
// Persist the last-good snapshot to disk so a server restart doesn't wipe it —
// otherwise, if the usage API is down at boot, the panel would have nothing to
// fall back to and disappear entirely.
const SNAPSHOT_PATH = process.env.CLAUDE_USAGE_CACHE
  || path.join(__dirname, '..', '..', 'data', 'claude-usage.json');

let cache = { at: 0, data: null };
// Last successful snapshot, kept indefinitely so we can still show figures
// (marked stale) when the usage API is unreachable, instead of the panel
// flickering away and back. Hydrated from disk on startup below.
let lastGood = null;

try {
  lastGood = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
} catch { /* no snapshot yet — first successful fetch will create one */ }

function saveSnapshot(data) {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(data));
  } catch { /* best-effort cache; a write failure must not break the response */ }
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

function pick(w) {
  return w && w.utilization != null
    ? { utilization: w.utilization, resets_at: w.resets_at }
    : null;
}

function registerRoutes(app) {
  app.get('/api/claude-usage', verifyToken, async (req, res) => {
    try {
      // 用量僅管理員可見（一般使用者看不到用量報表／側欄用量小工具）
      const { rows: [me] } = await query('SELECT role FROM users WHERE id=$1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
        return res.json(cache.data);
      }
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
      res.json(data);
    } catch (err) {
      // The usage endpoint frequently returns 429 (rate limited). Serve the
      // last known-good snapshot marked stale so the panel keeps showing
      // figures (with its update time) rather than vanishing, and cache it for
      // the TTL so we back off instead of hammering the rate-limited endpoint.
      // Only truly hide when we've never fetched successfully.
      if (lastGood) {
        const stale = { ...lastGood, stale: true };
        cache = { at: Date.now(), data: stale };
        return res.json(stale);
      }
      res.json({ available: false, error: err.message });
    }
  });
}

module.exports = { registerRoutes };
