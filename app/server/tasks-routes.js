const path = require('path');
const yaml = require('js-yaml');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { abortTask, runPipeline } = require('./pipeline/runner');
const { removeWorktree, deleteBranchLocal } = require('./pipeline/git');
const { writebackTaskMessage } = require('./pipeline/sync');
const { uninstallModule } = require('./pipeline/env-agent');
const { rebuildTesting } = require('./pipeline/rebuild-testing');
const { withProjectLock } = require('./pipeline/project-lock');

// 刪除任務時清掉該任務的 worktree 與分支（task/<task_id>）。best-effort，不阻斷刪除。
async function cleanupTaskGit(task) {
  if (!task.project_id || !task.git_branch) return;
  const { rows: repos } = await query(
    "SELECT local_path FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
    [task.project_id]
  );
  if (!repos.length) return;
  const wtParent = path.join(path.dirname(repos[0].local_path), '.worktrees', task.task_id);
  for (const repo of repos) {
    const wtPath = path.join(wtParent, path.basename(repo.local_path));
    await removeWorktree(repo.local_path, wtPath).catch(() => {});
    await deleteBranchLocal(repo.local_path, task.git_branch, true).catch(() => {});
  }
}

// 從任務 analysis_yaml 取 module 名（與 deploy-testing 同套解析）；取不到回空字串。
function taskModule(task) {
  if (!task || !task.analysis_yaml) return '';
  try { return (yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {}).module || ''; }
  catch { return ''; }
}

// 刪任務時卸載其測試區 module（子系統 A）。best-effort，回警告字串或 null，永不 throw、不擋刪除。
// excludeIds：本次一併刪除的任務 id（含自己）——同專案其他「未隱藏且不在此清單」的任務若也用同一 module，
// 代表還有人在用 → 跳過卸載。依存判斷在 JS 端做，避開 pg-mem 對 ANY(int[]) 的限制。
async function uninstallTaskModule(task, excludeIds) {
  const moduleName = taskModule(task);
  if (!task.project_id || !moduleName) return null;
  const { rows: siblings } = await query(
    'SELECT id, analysis_yaml FROM tasks WHERE project_id = $1 AND is_hidden = false',
    [task.project_id]
  );
  const ex = new Set(excludeIds);
  if (siblings.some(s => !ex.has(s.id) && taskModule(s) === moduleName)) return null;
  try {
    const r = await withProjectLock(task.project_id, () => uninstallModule(task.project_id, moduleName));
    if (r && r.result === 'skipped_dependents') {
      return `模組 ${moduleName} 因有其他模組依存（${(r.dependents || []).join('、')}），已保留未卸載，請自行處理。`;
    }
    return null;
  } catch (err) {
    return `模組 ${moduleName} 卸載失敗（已略過，不影響刪除）：${err.message}`;
  }
}

const NEEDS_ACTION_STATUSES = ['confirm_pending', 'cs_data_needed', 'cs_reply_pending', 'merge_conflict', 'review_pending', 'stopped'];
const ANSWER_ALLOWED_STATUSES = ['confirm_pending'];

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

      const sql = `SELECT t.id, t.task_id, t.source, t.title, t.status, t.is_paused, t.project_id, t.git_branch, t.reentry_count, t.approved_at, t.created_at, t.updated_at,
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

  // Manually create a task → enters pipeline as 'new'（立刻觸發 triage，不等下一輪排程）
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
      runPipeline(req.userId).catch(err => console.error('[TASKS] pipeline error:', err.message));
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

  // Edit task content — only while status='new'（尚未進 pipeline，之後分析/開發已依此內容展開，不再允許改）
  app.put('/api/tasks/:id', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
      if (tasks[0].status !== 'new') {
        return res.status(400).json({ error: '任務已進入處理流程，無法修改內容' });
      }
      const { original_text } = req.body || {};
      if (!original_text || !String(original_text).trim()) {
        return res.status(400).json({ error: '請填寫內容' });
      }
      await query(
        'UPDATE tasks SET original_text = $2, updated_at = NOW() WHERE id = $1',
        [req.params.id, String(original_text)]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 外部溝通紀錄：sync 拉進來的聊天紀錄 + 使用者手動追加的留言，新到舊排序（畫面顯示用）
  app.get('/api/tasks/:id/messages', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
      const { rows } = await query(
        'SELECT id, source, author, content, occurred_at, synced_to_odoo FROM task_messages WHERE task_id = $1 ORDER BY occurred_at DESC',
        [req.params.id]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 新增留言（不限任務狀態，逐步累積的補充資訊）；管理者開關開啟時 best-effort 回寫來源系統記錄備註
  app.post('/api/tasks/:id/messages', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id, task_id, source FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
      const { content } = req.body || {};
      if (!content || !String(content).trim()) return res.status(400).json({ error: '請填寫內容' });
      const trimmed = String(content).trim();

      const { rows: [me] } = await query('SELECT display_name FROM users WHERE id = $1', [req.userId]);
      const { rows: [inserted] } = await query(
        `INSERT INTO task_messages (task_id, source, author, content, occurred_at)
         VALUES ($1, 'manual', $2, $3, NOW())
         RETURNING id, source, author, content, occurred_at, synced_to_odoo`,
        [req.params.id, me?.display_name || null, trimmed]
      );

      const { rows: [cfg] } = await query('SELECT writeback_odoo_notes FROM teams_settings WHERE id = 1');
      // 沒帶 writeback 欄位時預設 true（維持現況行為）；前端明確傳 false 才跳過這則的回寫
      const wantsWriteback = req.body?.writeback !== false;
      if (cfg?.writeback_odoo_notes && wantsWriteback) {
        try {
          const newExternalId = await writebackTaskMessage(req.userId, tasks[0], trimmed);
          if (newExternalId) {
            await query(
              'UPDATE task_messages SET external_id = $2, synced_to_odoo = true WHERE id = $1',
              [inserted.id, String(newExternalId)]
            );
            inserted.synced_to_odoo = true;
          }
        } catch (e) { /* best-effort：回寫失敗不影響本地已儲存的留言 */ }
      }
      res.json(inserted);
    } catch (err) { res.status(500).json({ error: err.message }); }
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

  // 執行歷程：該任務所有事件（依序回放，供 Terminal 頁載入歷史）
  app.get('/api/tasks/:id/events', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });

      // 無 limit → 全部（Terminal 全頁）；有 limit → 取最新 N 筆，before=<id> 再往前撈舊的（詳情頁即時歷程用）
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit) || 10, 200) : null;
      const before = parseInt(req.query.before) || 0;
      let rows;
      if (limit === null) {
        ({ rows } = await query('SELECT id, content, created_at FROM task_events WHERE task_id = $1 ORDER BY id', [req.params.id]));
      } else if (before > 0) {
        ({ rows } = await query('SELECT id, content, created_at FROM task_events WHERE task_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3', [req.params.id, before, limit]));
        rows.reverse();
      } else {
        ({ rows } = await query('SELECT id, content, created_at FROM task_events WHERE task_id = $1 ORDER BY id DESC LIMIT $2', [req.params.id, limit]));
        rows.reverse();
      }
      res.json(rows);
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
      else runPipeline(req.userId).catch(err => console.error('[TASKS] pipeline error:', err.message));
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
      const { rows } = await query('SELECT id, task_id, project_id, git_branch, approved_at, analysis_yaml FROM tasks WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      if (rows[0].approved_at) return res.status(403).json({ error: '已人工審核通過的任務不可刪除' });
      const warnings = [];
      const uw = await uninstallTaskModule(rows[0], [rows[0].id]);
      if (uw) warnings.push(uw);
      await cleanupTaskGit(rows[0]);
      await query('DELETE FROM task_events WHERE task_id = $1', [req.params.id]);
      await query('DELETE FROM task_logs WHERE task_id = $1', [req.params.id]);
      await query('DELETE FROM task_messages WHERE task_id = $1', [req.params.id]);
      await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
      // 刪除後重建 testing 分支（清掉被刪任務留在 testing 的 source）；best-effort，警告併回
      if (rows[0].project_id) {
        const rw = await rebuildTesting(rows[0].project_id, req.userId).catch(e => `testing 重建異常（已略過）：${e.message}`);
        if (rw) warnings.push(rw);
      }
      res.json({ ok: true, warnings });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Batch operations (admin only)
  app.post('/api/tasks/batch/delete', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (me?.role !== 'admin') return res.status(403).json({ error: '僅管理員可刪除任務' });
      const ids = (req.body.ids || []).map(Number).filter(Boolean);
      if (!ids.length) return res.json({ ok: true, affected: 0 });
      // 已審核通過的任務跳過不刪；其餘先清 worktree/分支再刪
      const { rows: ts } = await query(
        'SELECT id, task_id, project_id, git_branch, approved_at, analysis_yaml FROM tasks WHERE id = ANY($1::int[]) AND user_id = $2',
        [ids, req.userId]
      );
      const deletable = ts.filter(t => !t.approved_at);
      const delIds = deletable.map(t => t.id);
      if (!delIds.length) return res.json({ ok: true, affected: 0 });
      // 卸載各任務的測試區 module（互相排除整批 delIds：同批要刪的任務不算「還有人在用」）
      const warnings = [];
      for (const t of deletable) {
        const w = await uninstallTaskModule(t, delIds);
        if (w) warnings.push(w);
      }
      for (const t of deletable) await cleanupTaskGit(t);
      await query('DELETE FROM task_events WHERE task_id = ANY($1::int[])', [delIds]);
      await query('DELETE FROM task_logs WHERE task_id = ANY($1::int[])', [delIds]);
      await query('DELETE FROM task_messages WHERE task_id = ANY($1::int[])', [delIds]);
      const { rowCount } = await query('DELETE FROM tasks WHERE id = ANY($1::int[])', [delIds]);
      // 刪除後每個涉及專案重建一次 testing（去重）
      const projectIds = [...new Set(deletable.map(t => t.project_id).filter(Boolean))];
      for (const pid of projectIds) {
        const rw = await rebuildTesting(pid, req.userId).catch(e => `testing 重建異常（已略過）：${e.message}`);
        if (rw) warnings.push(rw);
      }
      res.json({ ok: true, affected: rowCount, warnings });
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
      else runPipeline(req.userId).catch(err => console.error('[TASKS] pipeline error:', err.message));
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
      runPipeline(req.userId).catch(err => console.error('[TASKS] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  // Resolve a blocked task — saves user's resolution note, resets status to new for retriage
  app.post('/api/tasks/:id/resolve-blocker', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id, status, resume_status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
      if (!['stopped'].includes(tasks[0].status)) {
        return res.status(400).json({ error: '只有失敗待確認的任務可以重新處理' });
      }
      const { resolution } = req.body;
      if (!resolution?.trim()) return res.status(400).json({ error: '請填寫解決說明' });

      // 回到中斷的那一關續跑（resume_status）；沒有記錄則退回 new 重新分診。
      // 只歸零與續跑關卡對應的計數器——全歸零會讓「繼續」一鍵繳械所有重試上限，
      // 同樣的失敗可無上限重演（健檢 U2，任務 52 無限循環的直接機制）
      const RESUME_COUNTER = {
        qa_running: 'qa_retry_count',
        deploy_testing: 'deploy_retry_count',
        playwright_running: 'pw_retry_count'
      };
      const counterCol = RESUME_COUNTER[tasks[0].resume_status];
      await query(
        `UPDATE tasks SET status = COALESCE(resume_status, 'new'),
         blocker_content = NULL, blocker_type = NULL, resume_status = NULL,
         ${counterCol ? counterCol + ' = 0,' : ''} updated_at = NOW() WHERE id = $1`,
        [req.params.id]
      );
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
        [req.params.id, `[修正指示] ${resolution.trim()}`]
      );
      runPipeline(req.userId).catch(err => console.error('[TASKS] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes, NEEDS_ACTION_STATUSES };
