const { query } = require('./db');
const { verifyToken } = require('./auth');
const { emitToUser } = require('./notify');

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
  // GET /api/projects/:projectId/chats
  // Returns only chats owned by req.userId; each row includes unread count.
  // Uses LEFT JOIN instead of correlated subquery for pg-mem compatibility.
  app.get('/api/projects/:projectId/chats', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT c.id, c.title, c.created_at,
                COUNT(m.id) AS unread
         FROM project_chats c
         LEFT JOIN project_chat_messages m
           ON m.chat_id = c.id AND m.role = 'ai' AND m.id > c.last_read_message_id
         WHERE c.project_id = $1 AND c.user_id = $2
         GROUP BY c.id, c.title, c.created_at
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
      await query(
        'DELETE FROM project_chats WHERE id = $1 AND project_id = $2 AND user_id = $3',
        [req.params.id, req.params.projectId, req.userId]
      );
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
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:projectId/chats/:id/messages', verifyToken, async (req, res) => {
    try {
      const content = (req.body.content || '').trim();
      if (!content) return res.status(400).json({ error: 'content required' });
      const chat = await getOwnedChat(req.params.id, req.params.projectId, req.userId);
      if (!chat) return res.status(404).json({ error: 'Not found' });
      const { chatReply } = require('./pipeline/chat-agent');
      const reply = await chatReply(req.params.projectId, req.params.id, content, req.userId);
      emitToUser(req.userId, 'chat:reply', {
        projectId: Number(req.params.projectId),
        chatId: Number(req.params.id)
      });
      res.json({ reply });
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
