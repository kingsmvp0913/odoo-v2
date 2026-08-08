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
const { resolveInboxActions } = require('./lib/inbox');

const LIST_LIMIT = 100;
// 「還沒處理」的定義只有一份：清單與未讀數各寫一次就會漂移，而漂移的症狀正是 badge 與畫面對不上。
const unreadWhere = (p = '') => `${p}read_at IS NULL AND (${p}snoozed_until IS NULL OR ${p}snoozed_until <= NOW())`;

// 路徑參數一律先收斂成整數再進 SQL：非數字的 id 會讓 Postgres 拋型別錯，被 catch 包成 500 並把
// DB 的錯誤訊息原樣回給前端（既洩漏內部細節，也讓使用者看到看不懂的英文）。收斂後走既有的 404。
const parseId = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };

function registerRoutes(app) {
  // 預設只回「還沒處理的」：未讀且未在 snooze 期間。?all=1 看全部（含已讀）。
  app.get('/api/inbox', verifyToken, async (req, res) => {
    try {
      await resolveInboxActions(req.userId);
      const unreadOnly = req.query.all !== '1' ? `AND ${unreadWhere('i.')}` : '';
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

  // 側欄 badge 專用。不可改回「抓清單算 length」：上面那支有 LIMIT 100，未讀破百後 badge 會被
  // 靜默封頂在 100，而 socket 的樂觀 +1 又會把它推過 100 → 數字在 100 與 100+n 之間來回跳。
  app.get('/api/inbox/unread-count', verifyToken, async (req, res) => {
    try {
      await resolveInboxActions(req.userId);
      const { rows } = await query(
        `SELECT COUNT(*)::int AS count FROM user_inbox WHERE user_id = $1 AND ${unreadWhere()}`,
        [req.userId]
      );
      res.json({ count: rows[0].count });
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
      const id = parseId(req.params.id);
      if (id === null) return res.status(404).json({ error: '找不到這筆收件匣項目' });
      const { rowCount } = await query(
        'UPDATE user_inbox SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2',
        [id, req.userId]
      );
      if (!rowCount) return res.status(404).json({ error: '找不到這筆收件匣項目' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/inbox/:id/snooze', verifyToken, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(404).json({ error: '找不到這筆收件匣項目' });
      const { until } = req.body || {};
      const ts = until ? new Date(until) : null;
      if (!ts || isNaN(ts.getTime())) return res.status(400).json({ error: 'until 需為有效時間' });
      const { rowCount } = await query(
        'UPDATE user_inbox SET snoozed_until = $3 WHERE id = $1 AND user_id = $2',
        [id, req.userId, ts.toISOString()]
      );
      if (!rowCount) return res.status(404).json({ error: '找不到這筆收件匣項目' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
