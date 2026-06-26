const { query } = require('./db');
const { verifyToken } = require('./auth');
const { runPipeline, getInflightTaskIds } = require('./pipeline/runner');

function registerRoutes(app) {
  app.post('/api/pipeline/run', verifyToken, async (req, res) => {
    try {
      const result = await runPipeline(req.userId);
      res.json({ processed: result?.processed ?? 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pipeline/inflight', verifyToken, (req, res) => {
    res.json({ inflight: getInflightTaskIds() });
  });

  app.post('/api/tasks/:id/approve', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'final_pending') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' cannot be approved; expected final_pending` });
      }
      await query(
        "UPDATE tasks SET status = 'branch_pending', updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', '審核通過，開始實作')",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/tasks/:id/cs-confirm', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'cs_reply_pending') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' is not cs_reply_pending` });
      }
      await query(
        "UPDATE tasks SET status = 'done', updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/tasks/:id/cs-data-submit', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'cs_data_needed') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' is not cs_data_needed` });
      }
      await query(
        "UPDATE tasks SET status = 'cs_running', updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      const { answers, note } = req.body;
      let logContent = '';
      if (answers && typeof answers === 'object') {
        // Structured QA answers: { "問題文字": "回答文字" }
        logContent = Object.entries(answers)
          .map(([q, a]) => `Q：${q}\nA：${a}`)
          .join('\n\n');
      } else if (note?.trim()) {
        logContent = note.trim();
      }
      if (logContent) {
        await query(
          "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
          [req.params.id, logContent]
        );
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/tasks/:id/merge-to-main', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status, git_branch, project_id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      const task = rows[0];
      if (task.status !== 'deploy_ready') {
        return res.status(400).json({ error: `Task status '${task.status}' is not deploy_ready` });
      }
      if (!task.git_branch) return res.status(400).json({ error: 'Task has no git branch' });
      if (!task.project_id) return res.status(400).json({ error: 'Task has no project' });

      const { rows: repoRows } = await query(
        'SELECT local_path FROM project_repos WHERE project_id = $1 AND is_primary = true',
        [task.project_id]
      );
      if (!repoRows.length || !repoRows[0].local_path) {
        return res.status(400).json({ error: '專案未設定主要 Repo 路徑' });
      }

      const { mergeToMain, deleteBranchLocal } = require('./pipeline/git');
      await mergeToMain(repoRows[0].local_path, task.git_branch);
      await deleteBranchLocal(repoRows[0].local_path, task.git_branch);

      await query(
        "UPDATE tasks SET status = 'wiki_updating', updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'system', '分支已合併回主線並刪除，正在更新 Wiki')",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/tasks/:id/mark-conflict-resolved', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'merge_conflict') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' is not merge_conflict` });
      }
      await query(
        "UPDATE tasks SET status = 'deploy_ready', merge_conflict_data = NULL, updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
