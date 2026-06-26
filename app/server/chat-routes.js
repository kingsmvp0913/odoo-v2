const { query } = require('./db');
const { verifyToken } = require('./auth');

function registerRoutes(app) {
  app.get('/api/projects/:projectId/chats', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, title, created_at FROM project_chats WHERE project_id = $1 ORDER BY created_at DESC',
        [req.params.projectId]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:projectId/chats', verifyToken, async (req, res) => {
    try {
      const title = (req.body.title || '').trim() || '新對話';
      const { rows: [chat] } = await query(
        'INSERT INTO project_chats (project_id, title) VALUES ($1, $2) RETURNING id, title, created_at',
        [req.params.projectId, title]
      );
      res.status(201).json(chat);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:projectId/chats/:id', verifyToken, async (req, res) => {
    try {
      await query(
        'DELETE FROM project_chats WHERE id = $1 AND project_id = $2',
        [req.params.id, req.params.projectId]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/projects/:projectId/chats/:id/messages', verifyToken, async (req, res) => {
    try {
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
      const { chatReply } = require('./pipeline/chat-agent');
      const reply = await chatReply(req.params.projectId, req.params.id, content, req.userId);
      res.json({ reply });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
