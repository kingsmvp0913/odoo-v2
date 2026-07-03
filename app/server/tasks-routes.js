const { query } = require('./db');
const { verifyToken } = require('./auth');
const { abortTask } = require('./pipeline/runner');

const NEEDS_ACTION_STATUSES = ['confirm_pending', 'final_pending', 'stopped', 'triage_blocked', 'cs_data_needed', 'cs_reply_pending', 'merge_conflict'];
const ANSWER_ALLOWED_STATUSES = ['confirm_pending', 'final_pending'];

function registerRoutes(app) {
  // List tasks with optional filters
  app.get('/api/tasks', verifyToken, async (req, res) => {
    try {
      const { needs_action, source, status, archived } = req.query;
      const conditions = ['user_id = $1'];
      const params = [req.userId];
      conditions.push(archived === 'true' ? 'is_hidden = true' : 'is_hidden = false');

      if (needs_action === 'true') {
        conditions.push(`status = ANY($${params.length + 1}::text[])`);
        params.push(NEEDS_ACTION_STATUSES);
      } else if (status) {
        conditions.push(`status = $${params.length + 1}`);
        params.push(status);
      }
      if (source) {
        conditions.push(`source = $${params.length + 1}`);
        params.push(source);
      }

      const sql = `SELECT t.id, t.task_id, t.source, t.title, t.status, t.is_paused, t.project_id, t.git_branch, t.reentry_count, t.created_at, t.updated_at,
                          e.url AS env_url,
                          p.name AS project_name
                   FROM tasks t
                   LEFT JOIN odoo_envs e ON e.project_id = t.project_id AND e.status = 'running'
                   LEFT JOIN projects p ON p.id = t.project_id
                   WHERE t.${conditions.join(' AND t.')} ORDER BY t.updated_at DESC`;
      const { rows } = await query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manually create a task → enters pipeline as 'new'（下輪 triage 自動接手）
  app.post('/api/tasks', verifyToken, async (req, res) => {
    try {
      const { title, original_text, project_id } = req.body || {};
      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: '請填寫標題' });
      }
      const taskId = `manual_${Date.now()}`;
      const { rows } = await query(
        `INSERT INTO tasks (user_id, task_id, source, title, original_text, project_id, status)
         VALUES ($1, $2, 'manual', $3, $4, $5, 'new')
         RETURNING id, task_id, source, title, status, project_id, created_at, updated_at`,
        [req.userId, taskId, String(title).trim(), original_text || '', project_id || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Task detail + last 5 logs
  app.get('/api/tasks/:id', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT * FROM tasks WHERE id = $1 AND user_id = $2 AND is_hidden = false',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });

      const { rows: logs } = await query(
        'SELECT id, role, content, created_at FROM task_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 5',
        [req.params.id]
      );
      res.json({ task: tasks[0], logs: logs.reverse() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Paginated logs
  app.get('/api/tasks/:id/logs', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });

      const offset = parseInt(req.query.offset) || 0;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const { rows } = await query(
        'SELECT id, role, content, created_at FROM task_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [req.params.id, limit, offset]
      );
      res.json(rows.reverse());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Toggle pause on a task
  app.put('/api/tasks/:id/pause', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, is_paused FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      const newPaused = !rows[0].is_paused;
      await query(
        'UPDATE tasks SET is_paused = $2, updated_at = NOW() WHERE id = $1',
        [req.params.id, newPaused]
      );
      if (newPaused) abortTask(req.params.id);
      res.json({ ok: true, is_paused: newPaused });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Archive task (admin only — hides from main view, visible in archived tab)
  app.post('/api/tasks/:id/archive', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: '僅管理員可封存任務' });
      const { rows } = await query('SELECT id FROM tasks WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      await query(
        "UPDATE tasks SET is_hidden = true, is_paused = false, updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Unarchive task (admin only — restores to active list)
  app.post('/api/tasks/:id/unarchive', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: '僅管理員可解除封存' });
      const { rows } = await query('SELECT id FROM tasks WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      await query(
        "UPDATE tasks SET is_hidden = false, updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Delete task permanently (admin only — removes from DB; re-sync will re-import)
  app.delete('/api/tasks/:id', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: '僅管理員可刪除任務' });
      const { rows } = await query('SELECT id FROM tasks WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      await query('DELETE FROM task_logs WHERE task_id = $1', [req.params.id]);
      await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Batch operations (admin only)
  app.post('/api/tasks/batch/delete', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: '僅管理員可刪除任務' });
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.json({ ok: true, affected: 0 });
      await query('DELETE FROM task_logs WHERE task_id = ANY($1::int[])', [ids]);
      const { rowCount } = await query(
        'DELETE FROM tasks WHERE id = ANY($1::int[]) AND user_id = $2',
        [ids, req.userId]
      );
      res.json({ ok: true, affected: rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/tasks/batch/pause', verifyToken, async (req, res) => {
    try {
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.json({ ok: true, affected: 0 });
      const paused = req.body.paused !== false; // default true (pause)
      const { rowCount } = await query(
        'UPDATE tasks SET is_paused = $2, updated_at = NOW() WHERE id = ANY($1::int[]) AND user_id = $3',
        [ids, paused, req.userId]
      );
      if (paused) ids.forEach(id => abortTask(id));
      res.json({ ok: true, affected: rowCount, is_paused: paused });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/tasks/batch/archive', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: '僅管理員可封存任務' });
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.json({ ok: true, affected: 0 });
      const { rowCount } = await query(
        'UPDATE tasks SET is_hidden = true, is_paused = false, updated_at = NOW() WHERE id = ANY($1::int[]) AND user_id = $2',
        [ids, req.userId]
      );
      res.json({ ok: true, affected: rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/tasks/batch/unarchive', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: '僅管理員可解除封存' });
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.json({ ok: true, affected: 0 });
      const { rowCount } = await query(
        'UPDATE tasks SET is_hidden = false, updated_at = NOW() WHERE id = ANY($1::int[]) AND user_id = $2',
        [ids, req.userId]
      );
      res.json({ ok: true, affected: rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // User answer to clarification question
  app.post('/api/tasks/:id/answer', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
      if (!ANSWER_ALLOWED_STATUSES.includes(tasks[0].status)) {
        return res.status(400).json({ error: `Task status '${tasks[0].status}' does not accept answers` });
      }

      const { user_answer } = req.body;
      if (!user_answer) return res.status(400).json({ error: 'user_answer required' });

      await query(
        "UPDATE tasks SET status = 'confirm_answered', updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
        [req.params.id, user_answer]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  // Resolve a blocked task — saves user's resolution note, resets status to new for retriage
  app.post('/api/tasks/:id/resolve-blocker', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
      if (!['stopped', 'triage_blocked'].includes(tasks[0].status)) {
        return res.status(400).json({ error: '只有阻塞中的任務可以解決阻塞' });
      }
      const { resolution } = req.body;
      if (!resolution?.trim()) return res.status(400).json({ error: '請填寫解決說明' });

      await query(
        `UPDATE tasks SET status = 'new', blocker_content = NULL, blocker_type = NULL,
         reentry_count = 0, updated_at = NOW() WHERE id = $1`,
        [req.params.id]
      );
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
        [req.params.id, `[解決阻塞] ${resolution.trim()}`]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes, NEEDS_ACTION_STATUSES };
