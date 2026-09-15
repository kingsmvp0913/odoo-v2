/**
 * feedback-routes.js — 使用者意見回饋的入口與管理
 *
 * ⚠ 提交這一支**不得呼叫任何 agent**。統整與修正全部在管理員核准之後、
 * 由夜間批次執行——否則任何登入使用者都能單方面觸發無上限的 opus 成本。
 * 迴歸測試在 feedback-routes.test.js 的「提交時一個 agent 都不會被呼叫」。
 *
 * 授權：提交與看自己的走 verifyToken；管理端點另外查 role（比照 admin-routes 的 requireAdmin）。
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');
const {
  uploadChatImages, saveFeedbackAttachmentFile, sniffFile, isImageBuffer, readAttachmentFile,
  deleteFeedbackDir
} = require('./lib/attachments');

// 人工可以設的狀態只有這三個。done 由夜間批次寫，不開放從 API 設——
// 提早標 done 會讓那條意見從批次的候選裡消失，而畫面上看起來像已經處理完了。
// 人工可以指定的狀態。`done` 原本只有夜間批次寫得進去，於是「我自己動手修好了」在畫面上
// 無路可走：留著 approved 會讓批次每晚重撿一次（重付 triage、重跑兩次全套測試），改 rejected
// 又等於謊稱「決定不做」。所以人工也要能標完成——實際發生過，2026-09-10 只能直接寫 DB。
const HUMAN_STATUSES = ['approved', 'rejected', 'new', 'done'];

const parseId = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!rows.length || rows[0].role !== 'admin') return res.status(403).json({ error: '需要管理員權限' });
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      // verdict_note（駁回原因）原本沒選出來——使用者送出意見後除了 triage_note 之外看不到任何
      // 後續，包括自己的意見被駁回時「為什麼」。兩者一起帶出去，前端才有東西可顯示。
      const { rows } = await query(
        `SELECT id, content, status, triage_note, verdict_note, created_at FROM feedback
          WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.userId]);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/feedback', verifyToken, requireAdmin, async (req, res) => {
    try {
      const cond = HUMAN_STATUSES.includes(req.query.status) ? 'WHERE f.status = $1' : '';
      const params = cond ? [req.query.status] : [];
      // 分頁：前端先載一頁、往下捲才續載。上限仍鎖 200——limit 是外部輸入，沒有上限的話
      // 一個 ?limit=999999 就把整張表連同附件 json_agg 一次撈出來。
      //
      // ⚠ LIMIT／OFFSET 直接內插進 SQL 而不是走 $n：pg-mem 解析不了帶參數的 LIMIT
      // （`SELECT ... LIMIT $2` 直接拋 "Cannot read properties of null"，實測），整支測試會 500。
      // 這兩個值都已經過 parseInt + 夾範圍，型別上必定是整數，不是能挾帶字串的路徑。
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const { rows } = await query(
        `SELECT f.*, COALESCE(u.display_name, u.username) AS user_name,
                COALESCE(json_agg(json_build_object('id', a.id, 'filename', a.filename))
                         FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
           FROM feedback f
           LEFT JOIN users u ON u.id = f.user_id
           LEFT JOIN feedback_attachments a ON a.feedback_id = f.id
           ${cond}
          GROUP BY f.id, u.display_name, u.username
          ORDER BY f.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
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
      // done 是夜間批次合併完才會寫的終態；再核准一次會把它塞回 approved，
      // 讓下一輪夜間批次重跑整條已經做完的鏈（同一份 finding_fixes 再修一次）。
      const { rows: [cur] } = await query('SELECT status FROM feedback WHERE id=$1', [id]);
      if (!cur) return res.status(404).json({ error: '找不到這筆意見' });
      if (cur.status === 'done' && status === 'approved') {
        return res.status(400).json({ error: '已完成的意見不能重新核准' });
      }
      const { rowCount } = await query(
        `UPDATE feedback SET status=$2, verdict_note=$3, decided_by=$4, decided_at=NOW()
          WHERE id=$1`, [id, status, verdict_note || null, req.userId]);
      if (!rowCount) return res.status(404).json({ error: '找不到這筆意見' });
      // 健檢開的單有兩列：health_check_findings 那筆提案，與這裡的 feedback。人工標完成時
      // 只改一半的話，提案那列會一直停在 approved——健檢頁與提案統計都還當它沒處理完。
      // 夜間批次走 markDone 時本來就是兩列一起改（nightly-fix.js），這條路徑要跟它一致。
      if (status === 'done') {
        await query(
          `UPDATE health_check_findings
              SET status='done', decided_by=$2, decided_at=NOW(), applied_at=COALESCE(applied_at, NOW())
            WHERE id = (SELECT finding_id FROM feedback WHERE id=$1) `, [id, req.userId]);
      }
      // 核准也要兩列一起（09-15 R6：提案一律待人工核准）：單核准了、提案還掛 pending，健檢頁的待處理數就在說謊。
      // 只翻還在 pending 的提案，已結案（no_change／done）的不能被這裡翻回 approved。
      if (status === 'approved') {
        await query(
          `UPDATE health_check_findings SET status='approved', decided_by=$2, decided_at=NOW()
            WHERE id = (SELECT finding_id FROM feedback WHERE id=$1) AND status='pending'`, [id, req.userId]);
      }
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

  // 意見與附件原本只增不減：沒有刪除端點，deleteFeedbackDir（lib/attachments.js）唯一呼叫端是
  // 測試。每位登入者每次可傳 5×10MB，長期累積即無上限成長。feedback_attachments 靠 DB 層
  // ON DELETE CASCADE 清列，但實體檔要自己收——順序：先刪 DB（cascade 生效），DB 成功才刪目錄，
  // 避免刪錯目錄後 DB 那筆還在、附件連結卻已 404。
  app.delete('/api/admin/feedback/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id == null) return res.status(404).json({ error: '找不到這筆意見' });
      // 已完成＝碼已經合併進 master（或人工修好了）。刪掉它就等於把「這件事做過了」的唯一
      // 紀錄連同附件實體檔一起清掉，之後沒有任何地方查得到那份改動是為了什麼而做。
      const { rows: [cur] } = await query('SELECT status FROM feedback WHERE id=$1', [id]);
      if (!cur) return res.status(404).json({ error: '找不到這筆意見' });
      if (cur.status === 'done') {
        return res.status(400).json({ error: '已完成的意見不能刪除' });
      }
      const { rowCount } = await query('DELETE FROM feedback WHERE id=$1', [id]);
      if (!rowCount) return res.status(404).json({ error: '找不到這筆意見' });
      deleteFeedbackDir(id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 3-I2：手動補跑一次夜間批次。runNightlyFix 內部已有完整保險絲（維護旗標、token 預算、
  // 跑道上限、drain timeout、併發守衛回 already-running），這裡不重複判斷，單純轉發。
  // fire-and-forget：批次動輒數十分鐘到數小時，不 await。
  // startedBy 帶觸發者 userId（不是 null）——排程判斷（getHealthCheckSchedule 等）
  // 靠 started_by IS NULL 分辨自動排程與人工觸發，這裡是人工觸發。
  app.post('/api/admin/nightly-fix', verifyToken, requireAdmin, async (req, res) => {
    try {
      const { runNightlyFix } = require('./pipeline/nightly-fix');
      runNightlyFix({ startedBy: req.userId }).catch(err => console.error('[FEEDBACK] 手動觸發夜間批次:', err.message));
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
