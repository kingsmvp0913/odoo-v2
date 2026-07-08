const { query } = require('./db');
const { verifyToken } = require('./auth');
const { encrypt, decrypt } = require('./lib/crypto');
const { runSelect } = require('./lib/ssh-sql');

const PUBLIC_COLS = 'id, project_id, name, ssh_host, ssh_port, ssh_user, auth_type, connect_mode, docker_container, db_user, sudo_user, db_name, db_host, db_port, db_ssl, description, created_at';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
function validateIdentifiers(b) {
  const checks = { docker_container: b.docker_container, db_user: b.db_user, sudo_user: b.sudo_user, db_name: b.db_name };
  for (const [k, v] of Object.entries(checks)) {
    if (v !== undefined && v !== null && v !== '' && !SAFE_ID_RE.test(String(v)))
      throw Object.assign(new Error(`欄位「${k}」包含不允許的字元（只允許英數、底線、點、連字號）`), { statusCode: 400 });
  }
}

// 主題 E：DB 連線管理與對正式庫查詢限管理員（一般 user 不該全權直達正式 PG）
async function requireAdmin(req, res, next) {
  try {
    const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!rows.length || rows[0].role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

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

  app.post('/api/projects/:id/db-connections', verifyToken, requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const mode = b.connect_mode || 'docker';
      const isDirect = mode === 'direct';
      if (isDirect) {
        if (!b.name || !b.db_host || !b.db_user || !b.db_password || !b.db_name) return res.status(400).json({ error: 'name/db_host/db_user/db_password/db_name 必填' });
      } else if (!b.name || !b.ssh_host || !b.ssh_user || !b.db_name) {
        return res.status(400).json({ error: 'name/ssh_host/ssh_user/db_name 必填' });
      }
      validateIdentifiers(b);
      const authType = b.auth_type || 'password';
      const pwEnc = authType === 'key' ? null : (b.ssh_password ? encrypt(b.ssh_password) : null);
      const keyEnc = authType === 'key' ? (b.ssh_key_content ? encrypt(b.ssh_key_content) : null) : null;
      const dbPwEnc = b.db_password ? encrypt(b.db_password) : null;
      const { rows } = await query(
        `INSERT INTO db_connections (project_id,name,ssh_host,ssh_port,ssh_user,auth_type,ssh_password_enc,ssh_key_enc,connect_mode,docker_container,db_user,sudo_user,db_name,db_host,db_port,db_password_enc,db_ssl,description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING ${PUBLIC_COLS}`,
        [req.params.id, b.name, isDirect ? '' : b.ssh_host, b.ssh_port || 22, isDirect ? '' : b.ssh_user, authType, pwEnc, keyEnc,
         mode, b.docker_container || null, b.db_user || null, b.sudo_user || null, b.db_name,
         isDirect ? b.db_host : null, isDirect ? (b.db_port || 5432) : null, dbPwEnc, isDirect ? !!b.db_ssl : false, b.description || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.statusCode === 400) return res.status(400).json({ error: err.message });
      if (err.code === '23505') return res.status(409).json({ error: '連線名稱已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/projects/:id/db-connections/:cid', verifyToken, requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      validateIdentifiers(b);
      const set = [];
      const params = [];
      let idx = 1;
      for (const [col, val] of Object.entries({
        name: b.name, ssh_host: b.ssh_host, ssh_port: b.ssh_port, ssh_user: b.ssh_user, auth_type: b.auth_type,
        connect_mode: b.connect_mode, docker_container: b.docker_container,
        db_user: b.db_user, sudo_user: b.sudo_user, db_name: b.db_name,
        db_host: b.db_host, db_port: b.db_port, db_ssl: b.db_ssl, description: b.description
      })) {
        if (val !== undefined) { set.push(`${col}=$${idx++}`); params.push(val); }
      }
      if (b.ssh_password) { set.push(`ssh_password_enc=$${idx++}`); params.push(encrypt(b.ssh_password)); }
      if (b.ssh_key_content) { set.push(`ssh_key_enc=$${idx++}`); params.push(encrypt(b.ssh_key_content)); }
      if (b.db_password) { set.push(`db_password_enc=$${idx++}`); params.push(encrypt(b.db_password)); }
      if (!set.length) return res.status(400).json({ error: '無可更新欄位' });
      params.push(req.params.cid, req.params.id);
      const { rows } = await query(
        `UPDATE db_connections SET ${set.join(', ')} WHERE id=$${idx++} AND project_id=$${idx} RETURNING ${PUBLIC_COLS}`, params
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) {
      if (err.statusCode === 400) return res.status(400).json({ error: err.message });
      if (err.code === '23505') return res.status(409).json({ error: '連線名稱已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/projects/:id/db-connections/:cid', verifyToken, requireAdmin, async (req, res) => {
    try {
      const { rows } = await query('DELETE FROM db_connections WHERE id=$1 AND project_id=$2 RETURNING id', [req.params.cid, req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 連線測試：以表單值直接試連（跑 SELECT 1），與正式查詢走同一條 runSelect 路徑。
  // 密碼欄留空且帶 id → 回填該連線已存密碼（比照「留空＝不變」）。
  app.post('/api/projects/:id/db-connections/test', verifyToken, requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const conn = {
        connect_mode: b.connect_mode || 'docker',
        ssh_host: b.ssh_host, ssh_port: b.ssh_port, ssh_user: b.ssh_user, auth_type: b.auth_type || 'password',
        ssh_password: b.ssh_password || '', ssh_key: b.ssh_key_content || '',
        docker_container: b.docker_container, db_user: b.db_user, sudo_user: b.sudo_user, db_name: b.db_name,
        db_host: b.db_host, db_port: b.db_port, db_ssl: b.db_ssl, db_password: b.db_password || '',
      };
      if (b.id && (!conn.ssh_password || !conn.ssh_key || !conn.db_password)) {
        const stored = await loadDecryptedConn(b.id, req.params.id);
        if (stored) {
          if (!conn.ssh_password) conn.ssh_password = stored.ssh_password;
          if (!conn.ssh_key) conn.ssh_key = stored.ssh_key;
          if (!conn.db_password) conn.db_password = stored.db_password;
        }
      }
      res.json(await runSelect(conn, 'SELECT 1'));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/db-connections/:cid/query', verifyToken, requireAdmin, async (req, res) => {
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
  c.ssh_key = c.ssh_key_enc ? decrypt(c.ssh_key_enc) : '';
  c.db_password = c.db_password_enc ? decrypt(c.db_password_enc) : '';
  return c;
}

module.exports = { registerRoutes, loadDecryptedConn, loopbackOnly };
