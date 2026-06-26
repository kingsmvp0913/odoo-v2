const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { runGraphify } = require('./pipeline/graphify-runner');

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

function computeDestPath(projectFolder, label) {
  return path.join(REPOS_BASE, slugify(projectFolder), slugify(label));
}

function triggerClone(repoId, repoUrl, destPath) {
  // Security: validate URL scheme to prevent injection
  if (!/^(https?:\/\/|ssh:\/\/|git@)/.test(repoUrl)) {
    query(
      'UPDATE project_repos SET clone_status=$2, clone_error=$3 WHERE id=$1',
      [repoId, 'error', '不支援的 Git URL 格式']
    ).catch(() => {});
    return;
  }

  const isAlreadyCloned = fs.existsSync(path.join(destPath, '.git'));
  if (!isAlreadyCloned) {
    try { fs.mkdirSync(path.dirname(destPath), { recursive: true }); } catch {}
  }
  const gitArgs = isAlreadyCloned
    ? ['-C', destPath, 'pull', '--ff-only']
    : ['clone', '--', repoUrl, destPath];

  execFile('git', gitArgs, { timeout: 300000 }, async (err, _stdout, stderr) => {
    if (err) {
      const msg = (stderr || err.message || 'clone failed').slice(0, 500);
      await query(
        'UPDATE project_repos SET clone_status=$2, clone_error=$3 WHERE id=$1',
        [repoId, 'error', msg]
      ).catch(() => {});
    } else {
      await query(
        'UPDATE project_repos SET clone_status=$2, clone_error=NULL WHERE id=$1',
        [repoId, 'done']
      ).catch(() => {});
      runGraphify(repoId, destPath);
    }
  });
}

function registerRoutes(app) {
  // --- Projects ---

  app.get('/api/projects', verifyToken, async (req, res) => {
    try {
      const { rows: projects } = await query('SELECT * FROM projects ORDER BY name ASC');
      const { rows: counts } = await query('SELECT project_id, COUNT(*) AS cnt FROM project_repos GROUP BY project_id');
      const countMap = {};
      for (const c of counts) countMap[String(c.project_id)] = Number(c.cnt);
      res.json(projects.map(p => ({ ...p, repo_count: countMap[String(p.id)] || 0 })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects', verifyToken, async (req, res) => {
    try {
      const { name, odoo_version, description, folder_name } = req.body;
      if (!name || !odoo_version) return res.status(400).json({ error: 'name and odoo_version required' });
      const { rows } = await query(
        `INSERT INTO projects (name, odoo_version, description, folder_name) VALUES ($1, $2, $3, $4) RETURNING *`,
        [name, odoo_version, description || null, folder_name || null]
      );
      res.status(201).json(rows[0]);
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
      res.json({ ...project, repos });
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
      const { name, odoo_version, description, folder_name, odoo_project_name, service_respondent_name } = req.body;
      const { rows } = await query(
        `UPDATE projects SET
           name                    = COALESCE($2, name),
           odoo_version            = COALESCE($3, odoo_version),
           description             = COALESCE($4, description),
           folder_name             = COALESCE($5, folder_name),
           odoo_project_name       = COALESCE($6, odoo_project_name),
           service_respondent_name = COALESCE($7, service_respondent_name),
           updated_at              = NOW()
         WHERE id = $1 RETURNING *`,
        [req.params.id, name || null, odoo_version || null, description || null,
         folder_name || null, odoo_project_name !== undefined ? odoo_project_name : null,
         service_respondent_name !== undefined ? service_respondent_name : null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
      await query('BEGIN');
      const { rows: taskRows } = await query(
        'SELECT id, task_id FROM tasks WHERE project_id = $1', [req.params.id]
      );
      if (taskRows.length) {
        const taskDbIds   = taskRows.map(r => r.id);
        const taskTextIds = taskRows.map(r => r.task_id);
        await query('DELETE FROM task_logs WHERE task_id = ANY($1::int[])',  [taskDbIds]);
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
      triggerClone(rows[0].id, repo_url, destPath);
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
        triggerClone(rows[0].id, rows[0].repo_url, newLocalPath);
      }
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id/repos/:repoId', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'DELETE FROM project_repos WHERE id = $1 AND project_id = $2 RETURNING id, local_path',
        [req.params.repoId, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const localPath = rows[0].local_path;
      if (localPath) {
        fs.rm(localPath, { recursive: true, force: true }, () => {});
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
      await query(
        "UPDATE project_repos SET clone_status='cloning', clone_error=NULL WHERE id=$1",
        [repo.id]
      );
      triggerClone(repo.id, repo.repo_url, repo.local_path);
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
