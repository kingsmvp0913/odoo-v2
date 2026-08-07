/**
 * inbox-routes.js — 收件匣讀取與已讀／延後
 *
 * 授權採「只動自己的資料」模式：每一支都 `WHERE user_id = req.userId`，資料範圍限縮本身就是防護，
 * 不需要額外的 admin 檢查（規則 92）。找不到列時回 404，不要 abort。
 *
 * 寫入不在這裡——`reentry.js`（pipeline）也要寫，共用邏輯在 `lib/inbox.js`（規則 89）。
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');

const LIST_LIMIT = 100;

function registerRoutes(app) {
  // 預設只回「還沒處理的」：未讀且未在 snooze 期間。?all=1 看全部（含已讀）。
  app.get('/api/inbox', verifyToken, async (req, res) => {
    try {
      const unreadOnly = req.query.all !== '1'
        ? 'AND i.read_at IS NULL AND (i.snoozed_until IS NULL OR i.snoozed_until <= NOW())'
        : '';
      const { rows } = await query(
        `SELECT i.id, i.task_id, i.kind, i.status, i.summary, i.read_at, i.snoozed_until, i.created_at,
                t.task_id AS task_ref, t.title
           FROM user_inbox i
           JOIN tasks t ON t.id = i.task_id
          WHERE i.user_id = $1 ${unreadOnly}
          ORDER BY i.created_at DESC
          LIMIT ${LIST_LIMIT}`,
        [req.userId]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 全部標記已讀。沒有未讀列也算成功——「清空收件匣」在已經空的時候不是錯誤。
  app.post('/api/inbox/read-all', verifyToken, async (req, res) => {
    try {
      await query('UPDATE user_inbox SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL', [req.userId]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // COALESCE 而非 `AND read_at IS NULL`：重複點同一則不該回 404，否則點兩下就跳錯誤。
  app.post('/api/inbox/:id/read', verifyToken, async (req, res) => {
    try {
      const { rowCount } = await query(
        'UPDATE user_inbox SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rowCount) return res.status(404).json({ error: '找不到這筆收件匣項目' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/inbox/:id/snooze', verifyToken, async (req, res) => {
    try {
      const { until } = req.body || {};
      const ts = until ? new Date(until) : null;
      if (!ts || isNaN(ts.getTime())) return res.status(400).json({ error: 'until 需為有效時間' });
      const { rowCount } = await query(
        'UPDATE user_inbox SET snoozed_until = $3 WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId, ts.toISOString()]
      );
      if (!rowCount) return res.status(404).json({ error: '找不到這筆收件匣項目' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
