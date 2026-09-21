const { verifyToken } = require('./auth');
const { requirePlatformAdmin } = require('./lib/tenant-access');
const { getUsage } = require('./lib/claude-usage');

function registerRoutes(app) {
  // 平台管理員限定（規格外「今日裁決」：內部營運資訊收成平台管理員限定）。
  // 改用共用的 requirePlatformAdmin（比照本分支其他新掛守衛的既有寫法），不再各自查一次 role——
  // 舊寫法（各自 SELECT role FROM users）本來就已把 role !== 'admin' 擋在 403，行為不變，
  // 純粹是把三處重複的 ad-hoc 查詢換成 verifyToken 已經算好的 req.actor，少一次 DB 往返。
  app.get('/api/claude-usage', verifyToken, requirePlatformAdmin, async (req, res) => {
    try {
      res.json(await getUsage());
    } catch (err) {
      res.json({ available: false, error: err.message });
    }
  });

  // Codex app-server 的訂閱登入可正式讀取 ChatGPT rate limits；這不是平台自行估算的 token。
  app.get('/api/codex-usage', verifyToken, requirePlatformAdmin, async (req, res) => {
    try {
      const { rateLimits } = await require('./lib/codex-app-server').rateLimits();
      const mapWindow = window => window && window.usedPercent != null ? {
        used_percent: window.usedPercent,
        remaining_percent: Math.max(0, 100 - window.usedPercent),
        window_minutes: window.windowDurationMins,
        resets_at: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null
      } : null;
      res.json({ available: true, updated_at: new Date().toISOString(), primary: mapWindow(rateLimits?.primary), secondary: mapWindow(rateLimits?.secondary) });
    } catch (err) {
      res.json({ available: false, error: err.message });
    }
  });

  // 閘門狀態（admin-only）：供設定頁顯示「正常／已暫停」與觸發視窗、現值、門檻、重置時間
  app.get('/api/usage-gate/status', verifyToken, requirePlatformAdmin, async (req, res) => {
    try {
      const { getGateState } = require('./pipeline/usage-gate');
      res.json(await getGateState());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
