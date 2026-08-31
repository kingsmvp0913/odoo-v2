const { query } = require('./db');
const { verifyToken } = require('./auth');
const { emitToUser } = require('./notify');
const {
  saveChatAttachmentFile, deleteChatDir, readAttachmentFile, sniffFile, uploadChatImages, isImageBuffer
} = require('./lib/attachments');

async function getOwnedChat(chatId, projectId, userId) {
  const { rows } = await query(
    'SELECT id, last_read_message_id FROM project_chats WHERE id = $1 AND project_id = $2 AND user_id = $3',
    [chatId, projectId, userId]
  );
  return rows[0] || null;
}

// pg-mem does not support correlated subqueries that reference outer aliases.
// Equivalent to the brief's nested scalar subquery SUM: compute per-chat
// unread counts via LEFT JOIN + GROUP BY, then SUM the counts.
async function projectUnread(projectId, userId) {
  const { rows: [{ unread }] } = await query(
    `SELECT COALESCE(SUM(cnt), 0) AS unread FROM (
       SELECT COUNT(m.id) AS cnt
       FROM project_chats c
       LEFT JOIN project_chat_messages m
         ON m.chat_id = c.id AND m.role = 'ai' AND m.id > c.last_read_message_id
       WHERE c.project_id = $1 AND c.user_id = $2
       GROUP BY c.id
     ) t`,
    [projectId, userId]
  );
  return Number(unread);
}

function registerRoutes(app) {
  // GET /api/chats/unread
  // 目前使用者跨所有專案的未讀 map（{ [projectId]: count }），供左側 menu 的專案 badge
  // 在登入後首屏即準確填入 UnreadStore。沿用與 /api/projects 相同的 GROUP BY 寫法
  // （非關聯子查詢，pg-mem 相容）。
  app.get('/api/chats/unread', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT c.project_id, COUNT(m.id) AS unread
         FROM project_chats c
         LEFT JOIN project_chat_messages m
           ON m.chat_id = c.id AND m.role = 'ai' AND m.id > c.last_read_message_id
         WHERE c.user_id = $1
         GROUP BY c.project_id`,
        [req.userId]
      );
      const byProject = {};
      for (const r of rows) byProject[String(r.project_id)] = Number(r.unread);
      res.json({ byProject });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Sidebar 專案清單只需判斷「哪些專案最近有實際對話」，不可為每個專案各打
  // /chats 而形成 N+1。這個端點不回傳訊息內容，且空 Chat 不會被列入。
  app.get('/api/chats/sidebar-projects', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT c.project_id, c.id AS chat_id, c.title, MAX(m.created_at) AS last_message_at
         FROM project_chats c
         JOIN project_chat_messages m ON m.chat_id = c.id
         WHERE c.user_id = $1
         GROUP BY c.project_id, c.id, c.title
         ORDER BY last_message_at DESC`,
        [req.userId]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/projects/:projectId/chats
  // Returns only chats owned by req.userId; each row includes unread count.
  // Uses LEFT JOIN instead of correlated subquery for pg-mem compatibility.
  app.get('/api/projects/:projectId/chats', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        // chat_session_id 一併吐出：那是 claude CLI 的 session，排障時可用 `claude --resume <id>`
        // 直接接上該場對話，看 AI 實際查了什麼（回覆文字只留結論，工具呼叫過程只存在 session 裡）。
        // converted_task_id 取自 JOIN 後的 t.id 而非 c.converted_task_id：任務被刪除後該欄仍留著死 id
        // （欄位無 FK，見 db.js），JOIN 不到就回 null，前端徽章自動消失、不會產生點不開的連結。
        // MAX(t.id) 而非裸選 t.id：JOIN 打在主鍵上最多配一列，兩者在 PostgreSQL 語意等價，但裸選就得把
        // t.id 放進 GROUP BY，而 pg-mem 一旦 GROUP BY 含 t.id 就會把同名的 c.id 一起解析成 t.id
        //（實測 chat id 被吐成 task id，整份清單的 id 全錯）。聚合掉可讓 GROUP BY 不含 t.id，繞開該缺陷。
        `SELECT c.id, c.title, c.created_at, c.reply_pending, c.chat_session_id,
                MAX(t.id) AS converted_task_id,
                COUNT(m.id) AS unread
         FROM project_chats c
         LEFT JOIN project_chat_messages m
           ON m.chat_id = c.id AND m.role = 'ai' AND m.id > c.last_read_message_id
         LEFT JOIN tasks t ON t.id = c.converted_task_id
         WHERE c.project_id = $1 AND c.user_id = $2
         GROUP BY c.id, c.title, c.created_at, c.reply_pending, c.chat_session_id
         ORDER BY c.created_at DESC`,
        [req.params.projectId, req.userId]
      );
      res.json(rows.map(r => ({ ...r, unread: Number(r.unread) })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:projectId/chats', verifyToken, async (req, res) => {
    try {
      const title = (req.body.title || '').trim() || '新對話';
      const { rows: [chat] } = await query(
        'INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, $2, $3) RETURNING id, title, created_at',
        [req.params.projectId, title, req.userId]
      );
      res.status(201).json(chat);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:projectId/chats/:id', verifyToken, async (req, res) => {
    try {
      const { rowCount } = await query(
        'DELETE FROM project_chats WHERE id = $1 AND project_id = $2 AND user_id = $3',
        [req.params.id, req.params.projectId, req.userId]
      );
      // 附件列靠 ON DELETE CASCADE 自己清掉，磁碟上的實體檔沒人管——不刪就是永久孤兒
      if (rowCount) deleteChatDir(req.params.id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/projects/:projectId/chats/:id/messages', verifyToken, async (req, res) => {
    try {
      const chat = await getOwnedChat(req.params.id, req.params.projectId, req.userId);
      if (!chat) return res.status(404).json({ error: 'Not found' });
      const { rows } = await query(
        'SELECT id, role, content, created_at FROM project_chat_messages WHERE chat_id = $1 ORDER BY created_at ASC',
        [req.params.id]
      );
      // 附件另撈一次後在記憶體分組（不用相關子查詢，pg-mem 吃不下；比照 tasks-routes 的 byMessage）
      const { rows: atts } = await query(
        'SELECT id, message_id, filename, mimetype FROM project_chat_attachments WHERE chat_id = $1 AND message_id IS NOT NULL ORDER BY id',
        [req.params.id]
      );
      const byMessage = {};
      atts.forEach(a => { (byMessage[a.message_id] = byMessage[a.message_id] || []).push(a); });
      res.json(rows.map(m => ({ ...m, attachments: byMessage[m.id] || [] })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // uploadChatImages：multer 遇非 multipart 直接放行、req.files 為空，既有純 JSON 呼叫零影響。
  app.post('/api/projects/:projectId/chats/:id/messages', verifyToken, uploadChatImages, async (req, res) => {
    try {
      const content = (req.body.content || '').trim();
      const files = req.files || [];
      // 只貼一張截圖不打字是對話裡很自然的行為，所以圖也算內容；兩者皆空才是空訊息。
      if (!content && !files.length) return res.status(400).json({ error: 'content required' });
      // client 宣告的 mimetype 可偽造，以 magic bytes 為準（multer 的 fileFilter 只是省下先吃進記憶體）
      const bad = files.find(f => !isImageBuffer(f.buffer));
      if (bad) return res.status(400).json({ error: `「${bad.originalname}」不是圖片檔` });
      const chat = await getOwnedChat(req.params.id, req.params.projectId, req.userId);
      if (!chat) return res.status(404).json({ error: 'Not found' });
      // 原子搶佔這一輪：回覆要跑數分鐘，期間 F5 或換分頁再送一則就會有兩個 claude 帶著同一個
      // resumeSessionId 併發跑、各自覆寫 chat_session_id，transcript 交錯、token 白燒，而且無聲。
      // 條件式 UPDATE 才擋得住——chatReply 內那次是無條件設定，沒有佔位語意。
      const claim = await query(
        'UPDATE project_chats SET reply_pending = true WHERE id = $1 AND reply_pending = false',
        [req.params.id]
      );
      if (!claim.rowCount) return res.status(409).json({ error: '這則對話正在回覆中，請等它完成再送下一則' });
      try {
        // 落地必須在搶佔之後：搶不到就 409 回頭，先寫檔會留下一批沒有訊息可掛的孤兒檔。
        // message_id 這裡留空，由 chatReply 插完使用者訊息後回填（它才知道那則的 id）。
        const attachments = [];
        for (const f of files) {
          const mimetype = sniffFile(f.buffer).mime;
          const filePath = saveChatAttachmentFile(req.params.id, f.originalname, f.buffer);
          const { rows: [att] } = await query(
            `INSERT INTO project_chat_attachments (chat_id, filename, mimetype, file_path)
             VALUES ($1, $2, $3, $4) RETURNING id, filename, mimetype, file_path`,
            [req.params.id, f.originalname, mimetype, filePath]
          );
          attachments.push(att);
        }
        const { chatReply } = require('./pipeline/chat-agent');
        const reply = await chatReply(req.params.projectId, req.params.id, content, req.userId, attachments);
        emitToUser(req.userId, 'chat:reply', {
          projectId: Number(req.params.projectId),
          chatId: Number(req.params.id)
        });
        res.json({ reply });
      } catch (err) {
        // 搶佔成功後才失敗的話得自己還回去，否則這場對話永遠送不出下一則
        //（啟動時的 recoverInterruptedChats 只兜得到進程崩潰那種）
        await query('UPDATE project_chats SET reply_pending = false WHERE id = $1', [req.params.id]).catch(() => {});
        throw err;
      }
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 對話圖片下載／inline 顯示。前端不能直接把這個 URL 塞進 <img src>——認證走 Authorization
  // header，瀏覽器原生載圖不會帶上，只會拿到 401；前端是 fetch 成 blob 再轉 objectURL。
  app.get('/api/projects/:projectId/chats/:id/attachments/:attId/download', verifyToken, async (req, res) => {
    try {
      const chat = await getOwnedChat(req.params.id, req.params.projectId, req.userId);
      if (!chat) return res.status(404).json({ error: 'Not found' });
      const { rows } = await query(
        // 不取存下來的 mimetype：一律以當下嗅測的結果為準（下面那行），取了也是死欄位
        'SELECT filename, file_path FROM project_chat_attachments WHERE id = $1 AND chat_id = $2',
        [req.params.attId, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });
      const att = rows[0];
      const buffer = readAttachmentFile(att.file_path);
      const sniff = sniffFile(buffer);
      // 落地前已驗過 magic bytes，這裡再擋一次純屬防禦：非圖片一律不 inline，避免變成 XSS 載體
      const safeMimetype = /^image\//.test(sniff.mime) ? sniff.mime : 'application/octet-stream';
      const fname = /\.[a-z0-9]+$/i.test(att.filename) ? att.filename : att.filename + sniff.ext;
      res.setHeader('Content-Type', safeMimetype);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fname)}"`);
      res.send(buffer);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 把整串排障對話摘要成任務草稿（不建任務）——前端拿去讓使用者編輯確認後才走 POST /api/tasks
  app.post('/api/projects/:projectId/chats/:id/draft-task', verifyToken, async (req, res) => {
    try {
      const chat = await getOwnedChat(req.params.id, req.params.projectId, req.userId);
      if (!chat) return res.status(404).json({ error: 'Not found' });
      const { draftTaskFromChat } = require('./pipeline/chat-to-task');
      const draft = await draftTaskFromChat(req.params.projectId, req.params.id, req.userId);
      res.json(draft);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:projectId/chats/:id/read', verifyToken, async (req, res) => {
    try {
      const chat = await getOwnedChat(req.params.id, req.params.projectId, req.userId);
      if (!chat) return res.status(404).json({ error: 'Not found' });
      await query(
        `UPDATE project_chats
         SET last_read_message_id = COALESCE((SELECT MAX(id) FROM project_chat_messages WHERE chat_id = $1), 0)
         WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.userId]
      );
      res.json({ projectUnread: await projectUnread(req.params.projectId, req.userId) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
