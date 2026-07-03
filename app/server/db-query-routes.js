const { query } = require('./db');
const { verifyToken } = require('./auth');
const { encrypt, decrypt } = require('./lib/crypto');
const { runSelect } = require('./lib/ssh-sql');

const PUBLIC_COLS = 'id, project_id, name, ssh_host, ssh_port, ssh_user, auth_type, ssh_key_path, connect_mode, docker_container, db_user, sudo_user, db_name, description, created_at';

function loopbackOnly(req, res, next) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  return res.status(403).json({ ok: false, error: 'AI endpoint 僅限本機' });
}

function registerRoutes(app) {
  app.get('/api/projects/:id/db-connections', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(`SELECT ${PUBLIC_COLS} FROM db_connections WHERE project_id=$1 ORDER BY name`, [req.params.id]);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/db-connections', verifyToken, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.name || !b.ssh_host || !b.ssh_user || !b.db_name) return res.status(400).json({ error: 'name/ssh_host/ssh_user/db_name 必填' });
      const enc = b.auth_type === 'key' ? null : (b.ssh_password ? encrypt(b.ssh_password) : null);
      const { rows } = await query(
        `INSERT INTO db_connections (project_id,name,ssh_host,ssh_port,ssh_user,auth_type,ssh_password_enc,ssh_key_path,connect_mode,docker_container,db_user,sudo_user,db_name,description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${PUBLIC_COLS}`,
        [req.params.id, b.name, b.ssh_host, b.ssh_port || 22, b.ssh_user, b.auth_type || 'password', enc, b.ssh_key_path || null,
         b.connect_mode || 'docker', b.docker_container || null, b.db_user || null, b.sudo_user || null, b.db_name, b.description || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '連線名稱已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/projects/:id/db-connections/:cid', verifyToken, async (req, res) => {
    try {
      const b = req.body || {};
      const set = [];
      const params = [];
      let idx = 1;
      for (const [col, val] of Object.entries({
        name: b.name, ssh_host: b.ssh_host, ssh_port: b.ssh_port, ssh_user: b.ssh_user, auth_type: b.auth_type,
        ssh_key_path: b.ssh_key_path, connect_mode: b.connect_mode, docker_container: b.docker_container,
        db_user: b.db_user, sudo_user: b.sudo_user, db_name: b.db_name, description: b.description
      })) {
        if (val !== undefined) { set.push(`${col}=$${idx++}`); params.push(val); }
      }
      if (b.ssh_password) { set.push(`ssh_password_enc=$${idx++}`); params.push(encrypt(b.ssh_password)); }
      if (!set.length) return res.status(400).json({ error: '無可更新欄位' });
      params.push(req.params.cid, req.params.id);
      const { rows } = await query(
        `UPDATE db_connections SET ${set.join(', ')} WHERE id=$${idx++} AND project_id=$${idx} RETURNING ${PUBLIC_COLS}`, params
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '連線名稱已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/projects/:id/db-connections/:cid', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('DELETE FROM db_connections WHERE id=$1 AND project_id=$2 RETURNING id', [req.params.cid, req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/db-connections/:cid/query', verifyToken, async (req, res) => {
    try {
      const conn = await loadDecryptedConn(req.params.cid, req.params.id);
      if (!conn) return res.status(404).json({ error: 'Not found' });
      const result = await runSelect(conn, (req.body && req.body.sql) || '');
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/ai/db/connections', loopbackOnly, async (req, res) => {
    try {
      const project = req.query.project;
      let rows;
      if (project) {
        ({ rows } = await query(
          `SELECT c.id, c.name, p.name AS project FROM db_connections c JOIN projects p ON p.id=c.project_id
           WHERE p.folder_name=$1 OR p.name=$1 ORDER BY c.name`, [project]));
      } else {
        ({ rows } = await query(
          `SELECT c.id, c.name, p.name AS project FROM db_connections c JOIN projects p ON p.id=c.project_id ORDER BY p.name, c.name`));
      }
      res.json({ ok: true, connections: rows });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });

  app.post('/ai/db/query', loopbackOnly, async (req, res) => {
    try {
      const { connection_id, sql } = req.body || {};
      const { rows: [c] } = await query('SELECT project_id FROM db_connections WHERE id=$1', [connection_id]);
      if (!c) return res.json({ ok: false, error: '找不到連線' });
      const conn = await loadDecryptedConn(connection_id, c.project_id);
      res.json(await runSelect(conn, sql || ''));
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });
}

async function loadDecryptedConn(cid, projectId) {
  const { rows: [c] } = await query('SELECT * FROM db_connections WHERE id=$1 AND project_id=$2', [cid, projectId]);
  if (!c) return null;
  c.ssh_password = c.ssh_password_enc ? decrypt(c.ssh_password_enc) : '';
  return c;
}

module.exports = { registerRoutes, loadDecryptedConn, loopbackOnly };
