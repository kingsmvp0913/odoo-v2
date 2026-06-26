const { query } = require('./db');
const { verifyToken } = require('./auth');

function registerRoutes(app) {
  app.get('/api/projects/:id/env', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status, pid, port, url, error_msg, setup_log, updated_at FROM odoo_envs WHERE project_id = $1',
        [req.params.id]
      );
      res.json(rows.length ? rows[0] : { status: 'idle' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/env/setup', verifyToken, async (req, res) => {
    try {
      const { runEnvSetup } = require('./pipeline/env-agent');
      runEnvSetup(req.params.id, req.body?.port).catch(err =>
        console.error('[ENV] setup error:', err.message)
      );
      res.json({ ok: true, message: '環境建立已開始' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/env/stop', verifyToken, async (req, res) => {
    try {
      const { stopEnv } = require('./pipeline/env-agent');
      await stopEnv(req.params.id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id/env', verifyToken, async (req, res) => {
    try {
      const { rows: [env] } = await query('SELECT pid FROM odoo_envs WHERE project_id=$1', [req.params.id]);
      if (env?.pid) { try { process.kill(env.pid, 'SIGTERM'); } catch {} }

      const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id=$1', [req.params.id]);
      if (project) {
        const fs = require('fs');
        const dirName = project.folder_name || project.name;
        const envDir = `${process.env.ODOO_ENV_BASE || '/opt/odoo-envs'}/${dirName}`;
        if (fs.existsSync(envDir)) fs.rmSync(envDir, { recursive: true, force: true });
      }

      await query(
        "UPDATE odoo_envs SET status='idle', pid=NULL, url=NULL, error_msg=NULL, setup_log=NULL, updated_at=NOW() WHERE project_id=$1",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
