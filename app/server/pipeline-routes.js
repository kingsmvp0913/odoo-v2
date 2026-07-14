const fs = require('fs');
const path = require('path');
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
      const { buildGitEnv } = require('./lib/git-identity');
      const wtParent = path.join(path.dirname(repos[0].local_path), '.worktrees', task.task_id);

      // push 回 main 要歸屬到審核者（任務發起人）本人，非平台服務帳號
      let gitEnv;
      try {
        gitEnv = await buildGitEnv(req.userId);
      } catch (e) {
        if (e.code === 'NO_GIT_CRED') return res.status(400).json({ error: '請先到設定填個人 GitHub PAT' });
        throw e;
      }

      // 併主線＋清理 worktree 動到共用主 clone → 持專案鎖，與 merge/deploy/analysis 序列化（健檢 U7）
      await withProjectLock(task.project_id, async () => {
        // 逐 repo 併入 main（任一失敗即中止，狀態不變）
        for (const repo of repos) {
          await mergeToMain(repo.local_path, task.git_branch, gitEnv);
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

  // 最終人工審核退回：填原因 → 任務進 reject_triage 分診（不再直進 coding），原因落 task_rejections（健檢子專案 1）
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
      // 回退回分診（reject_triage）：由 analysis-reject 判 bug/clarify/respec，不再瞎猜式直進 coding。
      // reentry_count 只累加做統計、不強制 stopped（人為刻意退回，不套自動 runaway 上限）
      await query(
        "UPDATE tasks SET status='reject_triage', retry_feedback=$2, reentry_count=reentry_count+1, updated_at=NOW() WHERE id=$1",
        [req.params.id, `[人工退回]\n${reason}`]
      );
      // 時間軸只落「[人工退回]」標記，不塞原因本文（審核者常整包貼錯誤 log，全灌進畫面沒意義）。
      // 完整原因仍在 retry_feedback（分診 agent 讀）與 task_rejections.reason（分類 agent 讀），
      // 使用者面的原因總結＋結論改由 reject-triage 的 AI 泡泡呈現。
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'system', '[人工退回]')",
        [req.params.id]
      );
      await query(
        "INSERT INTO task_rejections (task_id, project_id, user_id, reason, status) VALUES ($1,$2,$3,$4,'new')",
        [task.task_id, task.project_id, req.userId, reason]
      );
      require('./notify').emitToUser(req.userId, 'task:updated', { taskId: task.id, status: 'reject_triage' });
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
        'SELECT id, status, project_id, merge_conflict_data, merge_resolutions FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].status !== 'merge_conflict') {
        return res.status(400).json({ error: `Task status '${rows[0].status}' is not merge_conflict` });
      }
      let cd = null;
      try { cd = rows[0].merge_conflict_data ? JSON.parse(rows[0].merge_conflict_data) : null; } catch { cd = null; }
      const isRebuild = !!(cd && cd.rebuild); // 來自刪任務觸發的 testing 重建，而非正常 merge_running

      // 轉 deploy 前驗證主 clone 已無未解衝突並了結 merge（commit）——
      // 否則半套 merge（MERGE_HEAD＋衝突標記）直接進部署，錯誤會被誤歸因為程式問題（健檢 U6）
      if (rows[0].project_id) {
        const { concludeMerge } = require('./pipeline/git');
        const { rows: repos } = await query(
          "SELECT local_path, label FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL",
          [rows[0].project_id]
        );
        // 重建來源：了結前先把人解好的檔案內容記進 merge_resolutions，供之後重演預帶（best-effort，讀不到略過）
        if (isRebuild) {
          let map = {};
          try { map = rows[0].merge_resolutions ? JSON.parse(rows[0].merge_resolutions) : {}; } catch { map = {}; }
          for (const r of (cd.repos || [])) {
            const repo = repos.find(x => x.label === r.repo);
            if (!repo) continue;
            map[r.repo] = map[r.repo] || {};
            for (const f of (r.files || [])) {
              try { map[r.repo][f] = fs.readFileSync(path.join(repo.local_path, f), 'utf8'); } catch { /* 讀不到就略過 */ }
            }
          }
          await query('UPDATE tasks SET merge_resolutions = $2 WHERE id = $1', [rows[0].id, JSON.stringify(map)]);
        }
        for (const repo of repos) {
          try {
            await concludeMerge(repo.local_path);
          } catch (err) {
            return res.status(400).json({ error: `${repo.label}：${err.message}` });
          }
        }
      }

      if (isRebuild) {
        // 還原原關卡、清 conflict data，再冪等重跑重建（可能再度停在下一個衝突）
        await query(
          "UPDATE tasks SET status = $2, merge_conflict_data = NULL, updated_at = NOW() WHERE id = $1",
          [rows[0].id, cd.prior_status || 'deploy_testing']
        );
        const { rebuildTesting } = require('./pipeline/rebuild-testing');
        const warn = await rebuildTesting(rows[0].project_id, req.userId).catch(e => `testing 重建異常（已略過）：${e.message}`);
        return res.json({ ok: true, warnings: warn ? [warn] : [] });
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
