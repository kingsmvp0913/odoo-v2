const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { runGraphify } = require('./pipeline/graphify-runner');
const { ensureTestingBranch, ensureMainBranch, pullBranch } = require('./pipeline/git');
const { withProjectLock } = require('./pipeline/project-lock');
const { buildGitEnv } = require('./lib/git-identity');

const REPOS_BASE = process.env.REPOS_BASE_DIR || path.resolve(__dirname, '..', '..', 'repos');

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!rows.length || rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function slugify(s) {
  return (s || 'repo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

// 來源對應欄位以「一行一個名稱」儲存
function parseSourceNames(text) {
  return String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
}

// 找出 text 中的名稱已被「其他專案」用於同一個對應欄位的衝突（防止同一來源名綁到多個專案）
async function findMappingConflicts(column, text, excludeId) {
  const names = parseSourceNames(text);
  if (!names.length) return [];
  const { rows } = await query(
    `SELECT name, ${column} AS names FROM projects WHERE ${column} IS NOT NULL AND id <> $1`,
    [excludeId]
  );
  const conflicts = [];
  for (const r of rows) {
    const used = new Set(parseSourceNames(r.names));
    for (const n of names) {
      if (used.has(n)) conflicts.push({ name: n, project: r.name });
    }
  }
  return conflicts;
}

function computeDestPath(projectFolder, label) {
  return path.join(REPOS_BASE, slugify(projectFolder), slugify(label));
}

function triggerClone(projectId, repoId, repoUrl, destPath, gitEnv, userId) {
  // projectId 來自 req.params.id（字串）；pipeline 的 withProjectLock 用 DB 數字 project_id 當 key。
  // Map key 字串≠數字會讓「更新 repo」與 pipeline 的 git 操作不互斥——coerce 成數字才真正序列化，
  // 否則 updateMainClone 內的 testing reset --hard 可能與 deploy/merge 併發壞掉共用主 clone。
  projectId = Number(projectId);
  // Security: validate URL scheme to prevent injection
  if (!/^(https?:\/\/|ssh:\/\/|git@)/.test(repoUrl)) {
    query(
      'UPDATE project_repos SET clone_status=$2, clone_error=$3 WHERE id=$1',
      [repoId, 'error', '不支援的 Git URL 格式']
    ).catch(() => {});
    return;
  }

  const isAlreadyCloned = fs.existsSync(path.join(destPath, '.git'));
  if (isAlreadyCloned) {
    // 更新既有主 clone：包 withProjectLock 與 pipeline 對同一主 clone 的 git 操作序列化。
    // 不能用 bare `git pull`——主 clone 常駐無 upstream 的 testing 分支，會報「no tracking information」。
    withProjectLock(projectId, () => updateMainClone(repoId, destPath, gitEnv, projectId, userId)).catch(() => {});
    return;
  }

  try { fs.mkdirSync(path.dirname(destPath), { recursive: true }); } catch {}
  // 初次 clone 沿用機器憑證（未帶 per-user gitEnv）——spec 明列的唯一例外；請勿誤加 gitEnv
  execFile('git', ['clone', '--', repoUrl, destPath], { timeout: 300000 }, async (err, _stdout, stderr) => {
    if (err) {
      const msg = (stderr || err.message || 'clone failed').slice(0, 500);
      await query(
        'UPDATE project_repos SET clone_status=$2, clone_error=$3 WHERE id=$1',
        [repoId, 'error', msg]
      ).catch(() => {});
    } else {
      // 主 clone 常駐 testing 分支（GitLab Flow 環境分支，測試環境 addons 來源）
      try { await ensureTestingBranch(destPath); } catch { /* 不擋 clone 完成 */ }
      await query(
        'UPDATE project_repos SET clone_status=$2, clone_error=NULL WHERE id=$1',
        [repoId, 'done']
      ).catch(() => {});
      runGraphify(repoId, destPath);
    }
  });
}

// 更新既有主 clone 到最新 main：checkout 主分支 + git pull origin <main>（帶明確 remote/branch），
// 拉完把 testing 重長到最新 main（測試環境 addons 來源分支）。沿用 pipeline task-agent 的更新 main 寫法。
async function updateMainClone(repoId, destPath, gitEnv, projectId, userId) {
  try {
    const base = await ensureMainBranch(destPath, gitEnv); // checkout main/master（僅遠端則建本地追蹤分支）
    await pullBranch(destPath, base, gitEnv);              // git pull origin <base>
    // pull 只更新 main；testing（deploy 實際部署的分支）不會自動跟上——單向往前併的流程從不把 main
    // 後來的新 commit 帶回 testing。故拉完主動重長 testing 到最新 main＋重併在飛任務，
    // 否則使用者 push 的依賴修正（如缺的 module）進了 main 卻不在 testing，deploy 仍找不到。
    // 已在 triggerClone 的 withProjectLock 內 → 用無鎖版避免重入死鎖。
    if (projectId) {
      const { rebuildTestingWithinLock } = require('./pipeline/rebuild-testing');
      await rebuildTestingWithinLock(projectId, userId).catch(() => {});
    } else {
      try { await ensureTestingBranch(destPath); } catch { /* 回常駐分支失敗不擋更新完成 */ }
    }
    await query(
      'UPDATE project_repos SET clone_status=$2, clone_error=NULL WHERE id=$1',
      [repoId, 'done']
    );
    runGraphify(repoId, destPath);
  } catch (err) {
    const msg = (err.stderr || err.message || 'update failed').slice(0, 500);
    await query(
      'UPDATE project_repos SET clone_status=$2, clone_error=$3 WHERE id=$1',
      [repoId, 'error', msg]
    ).catch(() => {});
  }
}

function registerRoutes(app) {
  // --- Projects ---

  app.get('/api/projects', verifyToken, async (req, res) => {
    try {
      const { rows: projects } = await query('SELECT * FROM projects ORDER BY name ASC');
      const { rows: counts } = await query('SELECT project_id, COUNT(*) AS cnt FROM project_repos GROUP BY project_id');
      const countMap = {};
      for (const c of counts) countMap[String(c.project_id)] = Number(c.cnt);
      const { rows: unreadRows } = await query(
        `SELECT c.project_id, COUNT(m.id) AS unread
         FROM project_chats c
         LEFT JOIN project_chat_messages m
           ON m.chat_id = c.id AND m.role = 'ai' AND m.id > c.last_read_message_id
         WHERE c.user_id = $1
         GROUP BY c.project_id`,
        [req.userId]
      );
      const unreadMap = {};
      for (const u of unreadRows) unreadMap[String(u.project_id)] = Number(u.unread);
      res.json(projects.map(p => ({
        ...p,
        repo_count: countMap[String(p.id)] || 0,
        unread_count: unreadMap[String(p.id)] || 0
      })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects', verifyToken, async (req, res) => {
    try {
      const { name, odoo_version, description, folder_name } = req.body;
      if (!name || !odoo_version) return res.status(400).json({ error: 'name and odoo_version required' });
      const { allocateProjectPort } = require('./port-alloc');
      // 建立時就固定分配專屬測試埠：不同專案永遠不同埠，消除執行期並行選埠相撞。
      // 並行建立偶爾撞同埠 → projects.port UNIQUE 擋下、重取再試（建立為低頻，retry 成本可忽略）。
      for (let attempt = 0; ; attempt++) {
        const port = await allocateProjectPort();
        try {
          const { rows } = await query(
            `INSERT INTO projects (name, odoo_version, description, folder_name, port) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [name, odoo_version, description || null, folder_name || null, port]
          );
          return res.status(201).json(rows[0]);
        } catch (err) {
          if (err.code === '23505' && err.constraint === 'projects_port_idx' && attempt < 5) continue; // 撞埠→重取
          throw err; // 名稱重複等其他違反 → 交由外層處理
        }
      }
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'project name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id', verifyToken, async (req, res) => {
    try {
      const { rows: [project] } = await query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
      if (!project) return res.status(404).json({ error: 'Not found' });
      const { rows: repos } = await query(
        'SELECT * FROM project_repos WHERE project_id = $1 ORDER BY is_primary DESC, label ASC',
        [req.params.id]
      );
      const { rows: [unreadRow] } = await query(
        `SELECT COUNT(m.id) AS unread
         FROM project_chats c
         LEFT JOIN project_chat_messages m
           ON m.chat_id = c.id AND m.role = 'ai' AND m.id > c.last_read_message_id
         WHERE c.project_id = $1 AND c.user_id = $2`,
        [req.params.id, req.userId]
      );
      res.json({ ...project, repos, unread_count: Number(unreadRow ? unreadRow.unread : 0) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/projects/:id', verifyToken, async (req, res) => {
    try {
      const { name, odoo_version, description } = req.body;
      const { rows } = await query(
        `UPDATE projects SET
           name = COALESCE($2, name),
           odoo_version = COALESCE($3, odoo_version),
           description = COALESCE($4, description),
           updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [req.params.id, name || null, odoo_version || null, description || null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/projects/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
      const { name, odoo_version, description, folder_name, odoo_project_name, service_respondent_name, e2e_disabled } = req.body;
      // 防重：來源對應名稱不可同時綁到多個專案
      const conflicts = [];
      if ('odoo_project_name' in req.body) {
        conflicts.push(...await findMappingConflicts('odoo_project_name', odoo_project_name, req.params.id));
      }
      if ('service_respondent_name' in req.body) {
        conflicts.push(...await findMappingConflicts('service_respondent_name', service_respondent_name, req.params.id));
      }
      if (conflicts.length) {
        const msg = conflicts.map(c => `「${c.name}」已被專案「${c.project}」使用`).join('；');
        return res.status(409).json({ error: `來源對應名稱衝突：${msg}` });
      }
      // 動態組 SET／params，佔位號永遠對齊實際引用（勿塞未被引用的參數——真・PostgreSQL 會報 bind 參數數不符）。
      const sets = [];
      const params = [req.params.id];
      // name/odoo_version/description/folder_name：COALESCE，未帶則保留現值（無法清空，符合現行語意）
      const setCoalesce = (col, val) => { params.push(val); sets.push(`${col} = COALESCE($${params.length}, ${col})`); };
      setCoalesce('name', name || null);
      setCoalesce('odoo_version', odoo_version || null);
      setCoalesce('description', description || null);
      setCoalesce('folder_name', folder_name || null);
      // 對應名稱：body 帶此鍵才更新，且用直接賦值（可用 null/空字串明確清空）；未帶則整欄不動
      const setDirect = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if ('odoo_project_name' in req.body) setDirect('odoo_project_name', odoo_project_name || null);
      if ('service_respondent_name' in req.body) setDirect('service_respondent_name', service_respondent_name || null);
      if ('e2e_disabled' in req.body) setDirect('e2e_disabled', !!e2e_disabled);
      sets.push('updated_at = NOW()');
      const { rows } = await query(
        `UPDATE projects SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
      // #4 刪專案前連帶清理：kill 環境 process、移除 env 與 clone 目錄（DB row 由 FK cascade 處理）
      const { cleanupProjectEnv } = require('./pipeline/env-agent');
      await cleanupProjectEnv(req.params.id);
      await query('BEGIN');
      const { rows: taskRows } = await query(
        'SELECT id, task_id FROM tasks WHERE project_id = $1', [req.params.id]
      );
      if (taskRows.length) {
        const taskDbIds   = taskRows.map(r => r.id);
        const taskTextIds = taskRows.map(r => r.task_id);
        await query('DELETE FROM task_events WHERE task_id = ANY($1::int[])', [taskDbIds]);
        await query('DELETE FROM task_logs WHERE task_id = ANY($1::int[])',  [taskDbIds]);
        await query('DELETE FROM task_messages WHERE task_id = ANY($1::int[])', [taskDbIds]);
        await query('DELETE FROM token_usage WHERE task_id = ANY($1::text[])', [taskTextIds]);
        await query('DELETE FROM tasks WHERE project_id = $1', [req.params.id]);
      }
      const { rows } = await query('DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows.length) {
        await query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
      await query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await query('ROLLBACK').catch(() => {});
      res.status(500).json({ error: err.message });
    }
  });

  // --- Repos ---

  app.get('/api/projects/:id/repos', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT * FROM project_repos WHERE project_id = $1 ORDER BY is_primary DESC, label ASC',
        [req.params.id]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/repos', verifyToken, async (req, res) => {
    try {
      const { label, repo_url, is_primary } = req.body;
      if (!label || !repo_url) return res.status(400).json({ error: 'label and repo_url required' });

      const { rows: [project] } = await query('SELECT folder_name, name FROM projects WHERE id=$1', [req.params.id]);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      if (is_primary) {
        await query('UPDATE project_repos SET is_primary = false WHERE project_id = $1', [req.params.id]);
      }

      const destPath = computeDestPath(project.folder_name || project.name, label);
      const { rows } = await query(
        `INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status)
         VALUES ($1, $2, $3, $4, $5, 'cloning') RETURNING *`,
        [req.params.id, label, repo_url, destPath, is_primary || false]
      );
      triggerClone(req.params.id, rows[0].id, repo_url, destPath);
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'label already exists in this project' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/projects/:id/repos/:repoId', verifyToken, async (req, res) => {
    try {
      const { label, repo_url, is_primary } = req.body;

      const { rows: [existing] } = await query(
        'SELECT * FROM project_repos WHERE id=$1 AND project_id=$2',
        [req.params.repoId, req.params.id]
      );
      if (!existing) return res.status(404).json({ error: 'Not found' });

      if (is_primary) {
        await query('UPDATE project_repos SET is_primary = false WHERE project_id = $1', [req.params.id]);
      }

      const urlChanged = repo_url && repo_url !== existing.repo_url;
      let newLocalPath = existing.local_path;
      let newCloneStatus = existing.clone_status;

      if (urlChanged) {
        const { rows: [project] } = await query('SELECT folder_name, name FROM projects WHERE id=$1', [req.params.id]);
        newLocalPath = computeDestPath(project.folder_name || project.name, label || existing.label);
        newCloneStatus = 'cloning';
      }

      const { rows } = await query(
        `UPDATE project_repos SET
           label = COALESCE($3, label),
           repo_url = COALESCE($4, repo_url),
           local_path = $5,
           clone_status = $6,
           is_primary = COALESCE($7, is_primary)
         WHERE id = $1 AND project_id = $2 RETURNING *`,
        [req.params.repoId, req.params.id, label || null, repo_url || null, newLocalPath, newCloneStatus, is_primary ?? null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });

      if (urlChanged) {
        triggerClone(req.params.id, rows[0].id, rows[0].repo_url, newLocalPath);
      }
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id/repos/:repoId', verifyToken, async (req, res) => {
    try {
      const { rows: [repo] } = await query(
        'SELECT clone_status, local_path FROM project_repos WHERE id=$1 AND project_id=$2',
        [req.params.repoId, req.params.id]
      );
      if (!repo) return res.status(404).json({ error: 'Not found' });
      // #2 clone/更新進行中不得移除
      if (repo.clone_status === 'cloning') {
        return res.status(409).json({ error: '正在 clone/更新中，請稍候再移除' });
      }
      // #1 測試環境使用中不得移除其掛載的 repo
      const { envIsActive } = require('./pipeline/env-agent');
      if (await envIsActive(req.params.id)) {
        return res.status(409).json({ error: '測試環境使用中，請先刪除測試環境再移除 repo' });
      }
      await query('DELETE FROM project_repos WHERE id = $1 AND project_id = $2', [req.params.repoId, req.params.id]);
      if (repo.local_path) {
        fs.rm(repo.local_path, { recursive: true, force: true }, () => {});
      }
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/repos/:repoId/reclone', verifyToken, async (req, res) => {
    try {
      const { rows: [repo] } = await query(
        'SELECT * FROM project_repos WHERE id=$1 AND project_id=$2',
        [req.params.repoId, req.params.id]
      );
      if (!repo) return res.status(404).json({ error: 'Not found' });
      if (!repo.local_path) return res.status(400).json({ error: 'No local_path set' });

      // 更新既有 clone 需用發起 user（reclone 按鈕操作者）的 PAT；無 PAT 直接擋下不進背景更新。
      const isAlreadyCloned = fs.existsSync(path.join(repo.local_path, '.git'));
      let gitEnv;
      if (isAlreadyCloned) {
        try {
          gitEnv = await buildGitEnv(req.userId);
        } catch (e) {
          if (e.code === 'NO_GIT_CRED') return res.status(400).json({ error: '請先到設定填個人 GitHub PAT' });
          throw e;
        }
      }

      await query(
        "UPDATE project_repos SET clone_status='cloning', clone_error=NULL WHERE id=$1",
        [repo.id]
      );
      triggerClone(req.params.id, repo.id, repo.repo_url, repo.local_path, gitEnv, req.userId);
      res.json({ ok: true, cloning: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Task ↔ Project assignment ---

  app.put('/api/tasks/:taskDbId/project', verifyToken, async (req, res) => {
    try {
      const { project_id } = req.body;
      const { rows } = await query(
        'UPDATE tasks SET project_id = $2 WHERE id = $1 AND user_id = $3 RETURNING id, project_id',
        [req.params.taskDbId, project_id || null, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
