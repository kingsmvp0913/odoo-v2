/**
 * feedback-routes.js — 使用者意見回饋的入口與管理
 *
 * ⚠ 提交這一支**不得呼叫任何 agent**。翻譯（feedback-triage）與統整全部在管理員核准之後、
 * 由夜間批次執行——否則任何登入使用者都能單方面觸發無上限的 opus 成本。
 * 迴歸測試在 feedback-routes.test.js 的「提交時一個 agent 都不會被呼叫」。
 *
 * 授權：提交與看自己的走 verifyToken；管理端點另外查 role（比照 admin-routes 的 requireAdmin）。
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');
const {
  uploadChatImages, saveFeedbackAttachmentFile, sniffFile, isImageBuffer, readAttachmentFile
} = require('./lib/attachments');

// 人工可以設的狀態只有這三個。done 由夜間批次寫，不開放從 API 設——
// 提早標 done 會讓那條意見從批次的候選裡消失，而畫面上看起來像已經處理完了。
const HUMAN_STATUSES = ['approved', 'rejected', 'new'];

const parseId = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };

async function requireAdmin(req, res, next) {
  const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
  if (!rows.length || rows[0].role !== 'admin') return res.status(403).json({ error: '需要管理員權限' });
  next();
}

function registerRoutes(app) {
  app.post('/api/feedback', verifyToken, uploadChatImages, async (req, res) => {
    try {
      const content = String(req.body.content || '').trim();
      if (!content) return res.status(400).json({ error: '請寫下你的意見' });
      const { rows: [fb] } = await query(
        'INSERT INTO feedback (user_id, content) VALUES ($1, $2) RETURNING id', [req.userId, content]);
      // 附件落地在 INSERT 之後：檔案路徑要帶 feedback id。
      // magic bytes 驗過才存——client 宣告的 mimetype 一概不信。
      for (const f of (req.files || [])) {
        if (!isImageBuffer(f.buffer)) continue;
        const rel = saveFeedbackAttachmentFile(fb.id, f.originalname, f.buffer);
        await query(
          'INSERT INTO feedback_attachments (feedback_id, filename, mimetype, file_path) VALUES ($1,$2,$3,$4)',
          [fb.id, f.originalname, sniffFile(f.buffer).mime, rel]);
      }
      res.json({ id: fb.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/feedback/mine', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, content, status, triage_note, created_at FROM feedback
          WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.userId]);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/feedback', verifyToken, requireAdmin, async (req, res) => {
    try {
      const cond = HUMAN_STATUSES.concat('done').includes(req.query.status)
        ? 'WHERE f.status = $1' : '';
      const params = cond ? [req.query.status] : [];
      const { rows } = await query(
        `SELECT f.*, COALESCE(u.display_name, u.username) AS user_name,
                COALESCE(json_agg(json_build_object('id', a.id, 'filename', a.filename))
                         FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
           FROM feedback f
           LEFT JOIN users u ON u.id = f.user_id
           LEFT JOIN feedback_attachments a ON a.feedback_id = f.id
           ${cond}
          GROUP BY f.id, u.display_name, u.username
          ORDER BY f.created_at DESC LIMIT 200`, params);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/admin/feedback/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id == null) return res.status(404).json({ error: '找不到這筆意見' });
      const { status, verdict_note } = req.body || {};
      if (!HUMAN_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status 只能是 ${HUMAN_STATUSES.join('／')}` });
      }
      const { rowCount } = await query(
        `UPDATE feedback SET status=$2, verdict_note=$3, decided_by=$4, decided_at=NOW()
          WHERE id=$1`, [id, status, verdict_note || null, req.userId]);
      if (!rowCount) return res.status(404).json({ error: '找不到這筆意見' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 圖片二進位：本人或 admin 才給
  app.get('/api/feedback/attachments/:id', verifyToken, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id == null) return res.status(404).end();
      const { rows } = await query(
        `SELECT a.file_path, a.mimetype, a.filename, f.user_id
           FROM feedback_attachments a JOIN feedback f ON f.id = a.feedback_id
          WHERE a.id = $1`, [id]);
      if (!rows.length) return res.status(404).end();
      const me = await query('SELECT role FROM users WHERE id=$1', [req.userId]);
      const isAdmin = me.rows[0] && me.rows[0].role === 'admin';
      if (!isAdmin && rows[0].user_id !== req.userId) return res.status(403).end();
      const buf = readAttachmentFile(rows[0].file_path);
      if (!buf) return res.status(404).end();
      res.setHeader('Content-Type', rows[0].mimetype || 'application/octet-stream');
      res.send(buf);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
