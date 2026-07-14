const path = require('path');
const { query } = require('./db');
const { verifyToken } = require('./auth');

function registerRoutes(app) {
  app.get('/api/projects/:id/env', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, status, pid, port, url, error_msg, setup_log, updated_at FROM odoo_envs WHERE project_id = $1',
        [req.params.id]
      );
      const env = rows.length ? rows[0] : { status: 'idle' };
      // 若 DB 顯示 running 但 PID 已死（app 重啟、process crash），自動修正為 idle
      if (env.status === 'running' && env.pid) {
        let alive = true;
        try { process.kill(env.pid, 0); } catch { alive = false; }
        if (!alive) {
          await query(
            "UPDATE odoo_envs SET status='idle', pid=NULL, url=NULL, updated_at=NOW() WHERE project_id=$1",
            [req.params.id]
          );
          env.status = 'idle';
          env.pid = null;
          env.url = null;
        }
      }
      // built = 環境目錄已完整建置（.ready 標記存在），前端據此顯示「重新啟動」而非「一鍵建立環境」
      try {
        const fs = require('fs');
        const { ENV_BASE: base } = require('./pipeline/env-agent');
        const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id=$1', [req.params.id]);
        const dirName = project ? (project.folder_name || project.name) : null;
        env.built = !!(dirName && fs.existsSync(path.join(base, dirName, '.ready')));
      } catch { env.built = false; }
      res.json(env);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/env/setup', verifyToken, async (req, res) => {
    try {
      const { runEnvSetup } = require('./pipeline/env-agent');
      // 併發防護在 runEnvSetup 內（同專案 in-flight 去重），連按建立不會 spawn 兩個 Odoo
      runEnvSetup(req.params.id).catch(err =>
        console.error('[ENV] setup error:', err.message)
      );
      res.json({ ok: true, message: '環境建立已開始' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 讀取常駐 Odoo server 的 runtime log（尾端），供前端「查看 log」除錯（asset 503／崩潰 traceback 等）。
  app.get('/api/projects/:id/env/log', verifyToken, async (req, res) => {
    try {
      const fs = require('fs');
      const { ENV_BASE: base, runtimeLogPath } = require('./pipeline/env-agent');
      const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id=$1', [req.params.id]);
      if (!project) return res.status(404).json({ error: 'project not found' });
      const dirName = project.folder_name || project.name;
      const logPath = runtimeLogPath(path.join(base, dirName));
      if (!fs.existsSync(logPath)) return res.json({ log: '', exists: false });
      // 只回尾端 256KB，避免大 log 撐爆前端與網路
      const MAX = 256 * 1024;
      const { size } = fs.statSync(logPath);
      const start = size > MAX ? size - MAX : 0;
      const fd = fs.openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        let log = buf.toString('utf8');
        if (start > 0) log = '…（前段省略）\n' + log.slice(log.indexOf('\n') + 1);
        res.json({ log, exists: true, truncated: start > 0 });
      } finally { fs.closeSync(fd); }
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/env/stop', verifyToken, async (req, res) => {
    try {
      const { stopEnv } = require('./pipeline/env-agent');
      await stopEnv(req.params.id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/env/sync-users', verifyToken, async (req, res) => {
    try {
      // #3 建立中不得同步（DB 正在 init，避免撞在一起）
      const { rows: [env] } = await query('SELECT status FROM odoo_envs WHERE project_id=$1', [req.params.id]);
      if (env?.status === 'setting_up') {
        return res.status(409).json({ error: '環境建立中，請待建立完成再同步' });
      }
      const { syncUsers } = require('./pipeline/env-agent');
      const log = await syncUsers(req.params.id);
      res.json({ ok: true, log });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id/env', verifyToken, async (req, res) => {
    try {
      const { rows: [env] } = await query('SELECT pid FROM odoo_envs WHERE project_id=$1', [req.params.id]);
      if (env?.pid) { try { process.kill(env.pid, 'SIGTERM'); } catch {} }

      const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id=$1', [req.params.id]);
      if (project) {
        const fs = require('fs');
        const { ENV_BASE: base } = require('./pipeline/env-agent');
        const dirName = project.folder_name || project.name;
        const envDir = path.join(base, dirName);
        const resolved = path.resolve(envDir);
        if (!resolved.startsWith(path.resolve(base) + path.sep)) {
          return res.status(400).json({ error: 'Invalid env path' });
        }
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
