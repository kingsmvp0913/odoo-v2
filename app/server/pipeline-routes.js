const fs = require('fs');
const path = require('path');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { runPipeline, getInflightTaskIds } = require('./pipeline/runner');

// approve 進行中的任務佔位：雙擊／前端重送會讓兩個請求都通過狀態檢查、都跑 mergeToMain
// （第二個在分支已刪後失敗回假 500）。單行程 in-memory 佔位＋結尾條件更新雙防護。
const _approving = new Set();

// repo 在舊開發環境的資料夾名＝git URL 最後一層去掉 .git（如 .../odoo17_hungjou.git → odoo17_hungjou）。
// 取不到 URL 時退回 clone 目錄名（local_path 最後一層）。
function repoDirName(repo) {
  const seg = String(repo.repo_url || '').replace(/\.git$/i, '').replace(/[\/\\]+$/, '').split(/[\/\\]/).pop();
  return seg || path.basename(repo.local_path);
}

// 從改動檔（相對 repo 根，git 用正斜線）往上找含 __manifest__.py 的祖先目錄＝Odoo 模組根。
// 回 { name, dir }（dir 為 worktree 內絕對路徑）；改動檔不屬任何模組（如 repo 根檔）回 null。
function findModuleDir(wtRepo, relFile) {
  let dir = path.dirname(relFile);
  while (dir && dir !== '.' && dir !== path.sep && dir !== '/') {
    if (fs.existsSync(path.join(wtRepo, dir, '__manifest__.py'))) {
      return { name: path.basename(dir), dir: path.join(wtRepo, dir) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

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
    const approveKey = String(req.params.id);
    if (_approving.has(approveKey)) return res.status(409).json({ error: '審核通過處理中，請勿重複送出' });
    _approving.add(approveKey);
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

      // 條件更新（WHERE status）：佔位之外的第二道防線，狀態已被他處改動就不再覆寫
      const { rowCount } = await query(
        "UPDATE tasks SET status = 'wiki_updating', approved_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'review_pending'",
        [req.params.id]
      );
      if (rowCount) {
        await query(
          "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', '審核通過，已合併回主線並清理分支，正在更新文件')",
          [req.params.id]
        );
      }
      runPipeline(req.userId).catch(err => console.error('[PIPELINE] pipeline error:', err.message));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: '合併主線失敗：' + err.message });
    } finally {
      _approving.delete(approveKey);
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
      // 條件更新防雙擊：輸掉競態的請求不再重複落 log／task_rejections
      const { rowCount } = await query(
        "UPDATE tasks SET status='reject_triage', retry_feedback=$2, reentry_count=reentry_count+1, updated_at=NOW() WHERE id=$1 AND status='review_pending'",
        [req.params.id, `[人工退回]\n${reason}`]
      );
      if (!rowCount) return res.json({ ok: true });
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

  // 過渡期手動佈署：管理員把 task 分支改動的模組整包複製到正式區 online_addons。
  // 純搬程式——不動任務狀態、不合併分支、不推進 pipeline（審核仍走 approve）。
  app.post('/api/tasks/:id/copy-to-online', verifyToken, async (req, res) => {
    try {
      const { rows: urows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (!urows.length || urows[0].role !== 'admin') {
        return res.status(403).json({ error: '僅管理員可複製到正式區' });
      }

      const { rows } = await query(
        'SELECT id, task_id, status, git_branch, project_id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Task not found' });
      const task = rows[0];
      // 不限任務狀態：只要分支還在（未併回主線清除）就能搬——過渡期讓管理員隨時手動佈署。
      if (!task.git_branch || !task.project_id) {
        return res.status(400).json({ error: '任務尚無分支或專案，無可複製的程式' });
      }

      const { rows: repos } = await query(
        "SELECT local_path, repo_url FROM project_repos WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL ORDER BY is_primary DESC, id",
        [task.project_id]
      );
      if (!repos.length) return res.status(400).json({ error: '專案未設定任何已完成 clone 的 Repo' });

      const base = process.env.ONLINE_ADDONS_DIR || 'C:/online_addons';
      const { getMainBranch, diffNameOnly, refExists } = require('./pipeline/git');
      const wtParent = path.join(path.dirname(repos[0].local_path), '.worktrees', task.task_id);

      const copied = [];
      const skipped = [];
      for (const repo of repos) {
        // 分支已清（多為已審核通過）→ 無 diff／worktree 可搬，略過該 repo
        if (!(await refExists(repo.local_path, `refs/heads/${task.git_branch}`))) continue;
        const mainBranch = await getMainBranch(repo.local_path);
        const wtRepo = path.join(wtParent, path.basename(repo.local_path));
        const repoDir = repoDirName(repo); // 依 repo（git URL 末段）放：<base>/<repoDir>/<module>
        const changed = await diffNameOnly(repo.local_path, mainBranch, task.git_branch);
        const modules = new Map(); // moduleName → worktree 內來源目錄（去重）
        for (const rel of changed) {
          const mod = findModuleDir(wtRepo, rel);
          if (mod) modules.set(mod.name, mod.dir);
          else skipped.push(rel); // 不屬任何模組的改動檔，明列不靜默略過（Fail loud）
        }
        for (const [name, srcDir] of modules) {
          const dest = path.join(base, repoDir, name);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.rmSync(dest, { recursive: true, force: true }); // 整包覆蓋：先刪再複製，正確反映新增/刪除/改名
          fs.cpSync(srcDir, dest, { recursive: true });
          const rel = `${repoDir}/${name}`;
          if (!copied.includes(rel)) copied.push(rel);
        }
      }

      res.json({ copied, skipped, base });
    } catch (err) {
      res.status(500).json({ error: '打包到舊開發環境失敗：' + err.message });
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
      // 條件更新防雙擊：檢查到更新之間狀態被改（另一請求已完成）就不動作
      await query(
        "UPDATE tasks SET status = 'done', updated_at = NOW() WHERE id = $1 AND status = 'cs_reply_pending'",
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
      // 條件更新防雙擊：輸掉競態的請求不再重複寫入回答（否則 cs-agent 會讀到重複答案）
      const { rowCount } = await query(
        "UPDATE tasks SET status = 'cs_running', updated_at = NOW() WHERE id = $1 AND status = 'cs_data_needed'",
        [req.params.id]
      );
      if (!rowCount) return res.json({ ok: true });
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
        const { withProjectLock } = require('./pipeline/project-lock');
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
        // concludeMerge 對主 clone commit → 持專案鎖，避免與同專案 merge/deploy/approve 交錯
        const concludeErr = await withProjectLock(rows[0].project_id, async () => {
          for (const repo of repos) {
            try {
              await concludeMerge(repo.local_path);
            } catch (err) {
              return `${repo.label}：${err.message}`;
            }
          }
          return null;
        });
        if (concludeErr) return res.status(400).json({ error: concludeErr });
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
