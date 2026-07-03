const os = require('os');
const path = require('path');
const fs = require('fs');
const { verifyToken } = require('./auth');

// Claude Code stores its OAuth credentials here; the server runs `claude` on the
// same machine (see pipeline/claude-runner.js), so this is the account whose
// usage we report.
const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL_MS = 60 * 1000;

let cache = { at: 0, data: null };

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
      if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
        return res.json(cache.data);
      }
      const u = await fetchUsage();
      const data = {
        available: true,
        five_hour: pick(u.five_hour),
        seven_day: pick(u.seven_day),
        seven_day_opus: pick(u.seven_day_opus),
        seven_day_sonnet: pick(u.seven_day_sonnet)
      };
      cache = { at: Date.now(), data };
      res.json(data);
    } catch (err) {
      // Degrade gracefully: the sidebar panel just hides itself.
      res.json({ available: false, error: err.message });
    }
  });
}

module.exports = { registerRoutes };
