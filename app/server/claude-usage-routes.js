const { verifyToken } = require('./auth');
const { query } = require('./db');
const { getUsage } = require('./lib/claude-usage');

function registerRoutes(app) {
  app.get('/api/claude-usage', verifyToken, async (req, res) => {
    try {
      // 用量僅管理員可見（一般使用者看不到用量報表／側欄用量小工具）
      const { rows: [me] } = await query('SELECT role FROM users WHERE id=$1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      res.json(await getUsage());
    } catch (err) {
      res.json({ available: false, error: err.message });
    }
  });

  // 閘門狀態（admin-only）：供設定頁顯示「正常／已暫停」與觸發視窗、現值、門檻、重置時間
  app.get('/api/usage-gate/status', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id=$1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      const { getGateState } = require('./pipeline/usage-gate');
      res.json(await getGateState());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
