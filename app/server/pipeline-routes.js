const { query } = require('./db');
const { verifyToken } = require('./auth');
const { runPipeline, getInflightTaskIds } = require('./pipeline/runner');

function registerRoutes(app) {
  app.post('/api/pipeline/run', verifyToken, async (req, res) => {
    try {
      const result = await runPipeline(req.userId);
      res.json({ dispatched: result?.dispatched ?? 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pipeline/inflight', verifyToken, (req, res) => {
    res.json({ inflight: getInflightTaskIds() });
  });

  // 最終人工審核通過：把 task 分支併回 main、清理 worktree 與分支，轉入 wiki 更新
  app.post('/api/tasks/:id/approve', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, task_id, status, git_branch, project_id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      const task = rows[0];
      if (task.status !== 'review_pending') {
        return res.status(400).json({ error: `Task status '${task.status}' cannot be approved; expected review_pending` });
      }
      if (!task.git_branch || !task.project_id) {
        return res.status(400).json({ error: '任務缺少分支或專案，無法合併' });
      }

      const { rows: repos } = await query(
        "SELECT local_path FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
        [task.project_id]
      );
      if (!repos.length) return res.status(400).json({ error: '專案未設定任何已完成 clone 的 Repo' });

      const path = require('path');
      const { mergeToMain, deleteBranchLocal, removeWorktree } = require('./pipeline/git');
      const { withProjectLock } = require('./pipeline/project-lock');
      const wtParent = path.join(path.dirname(repos[0].local_path), '.worktrees', task.task_id);

      // 併主線＋清理 worktree 動到共用主 clone → 持專案鎖，與 merge/deploy/analysis 序列化（健檢 U7）
      await withProjectLock(task.project_id, async () => {
        // 逐 repo 併入 main（任一失敗即中止，狀態不變）
        for (const repo of repos) {
          await mergeToMain(repo.local_path, task.git_branch);
        }
        // 清理各 repo 的 worktree 與任務分支（best-effort，不阻斷）
        for (const repo of repos) {
          const wtPath = path.join(wtParent, path.basename(repo.local_path));
          await removeWorktree(repo.local_path, wtPath).catch(() => {});
          await deleteBranchLocal(repo.local_path, task.git_branch).catch(() => {});
        }
      });

      await query(
        "UPDATE tasks SET status = 'wiki_updating', approved_at = NOW(), updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', '審核通過，已合併回主線並清理分支，正在更新文件')",
        [req.params.id]
      );
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: '合併主線失敗：' + err.message });
    }
  });

  // 最終人工審核退回：填原因 → 任務回 coding_running（原因當 feedback），原因落 task_rejections（健檢子專案 1）
  app.post('/api/tasks/:id/reject', verifyToken, async (req, res) => {
    try {
      const reason = ((req.body && req.body.reason) || '').trim();
      if (!reason) return res.status(400).json({ error: '請填寫退回原因' });
      const { rows } = await query(
        'SELECT id, task_id, status, project_id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      const task = rows[0];
      if (task.status !== 'review_pending') {
        return res.status(400).json({ error: `Task status '${task.status}' cannot be rejected; expected review_pending` });
      }
      // 回 coding 依原因修正；reentry_count 只累加做統計、不強制 stopped（人為刻意退回，不套自動 runaway 上限）
      await query(
        "UPDATE tasks SET status='coding_running', retry_feedback=$2, reentry_count=reentry_count+1, updated_at=NOW() WHERE id=$1",
        [req.params.id, `[人工退回]\n${reason}`]
      );
      // 落一筆 task_logs，讓退回原因跟 approve 一樣出現在任務詳細頁的對話時間軸（否則畫面上憑空消失）
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'system', $2)",
        [req.params.id, `[人工退回]\n${reason}`]
      );
      await query(
        "INSERT INTO task_rejections (task_id, project_id, user_id, reason, status) VALUES ($1,$2,$3,$4,'new')",
        [task.task_id, task.project_id, req.userId, reason]
      );
      require('./notify').emitToUser(req.userId, 'task:updated', { taskId: task.id, status: 'coding_running' });
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
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
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/tasks/:id/mark-conflict-resolved', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status, project_id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'merge_conflict') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' is not merge_conflict` });
      }
      // 轉 deploy 前驗證主 clone 已無未解衝突並了結 merge（commit）——
      // 否則半套 merge（MERGE_HEAD＋衝突標記）直接進部署，錯誤會被誤歸因為程式問題（健檢 U6）
      if (rows[0].project_id) {
        const { concludeMerge } = require('./pipeline/git');
        const { rows: repos } = await query(
          "SELECT local_path, label FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL",
          [rows[0].project_id]
        );
        for (const repo of repos) {
          try {
            await concludeMerge(repo.local_path);
          } catch (err) {
            return res.status(400).json({ error: `${repo.label}：${err.message}` });
          }
        }
      }
      await query(
        "UPDATE tasks SET status = 'deploy_testing', merge_conflict_data = NULL, updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
