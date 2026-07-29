const { query } = require('./db');
const { verifyToken } = require('./auth');
const { encrypt } = require('./lib/crypto');
const { runSelect } = require('./lib/ssh-sql');
const { allocateForwardPort, targetHostPort, removeGateway, projectContainerName } = require('./lib/vpn-gateway');
const { loadDecryptedConn } = require('./lib/db-connections');

const PUBLIC_COLS = 'id, project_id, name, ssh_host, ssh_port, ssh_user, auth_type, connect_mode, docker_container, db_user, sudo_user, db_name, db_host, db_port, db_ssl, db_engine, description, created_at, vpn_enabled';

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

// 轉發埠以「專案 × 目標」為單位：同專案已有連線指向同一台機器就沿用它的埠，
// 這樣新增連線多半不必重建容器（容器的 -p 在建立時就固定，重建＝斷線重撥）。
async function assignForwardPort(projectId, conn) {
  const { rows: usedRows } = await query('SELECT vpn_forward_port FROM db_connections WHERE vpn_forward_port IS NOT NULL');
  // 不濾 vpn_enabled：停用中的連線一樣佔著全域名額（見上面 usedRows 查詢），若這裡濾掉
  // 停用連線，新連線就看不到它、拿不到同一個埠，之後這個目標的埠會在兩條連線間發散。
  const { rows: peers } = await query(
    `SELECT connect_mode, ssh_host, ssh_port, db_host, db_port, vpn_forward_port
       FROM db_connections
      WHERE project_id=$1 AND vpn_forward_port IS NOT NULL AND id<>$2`,
    [projectId, conn.id]
  );
  const projectTargets = peers.map(p => ({ ...targetHostPort(p), forwardPort: p.vpn_forward_port }));
  return allocateForwardPort(usedRows.map(r => r.vpn_forward_port), projectTargets, targetHostPort(conn));
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
      const vpnEnabled = !!b.vpn_enabled;
      const { rows } = await query(
        `INSERT INTO db_connections (project_id,name,ssh_host,ssh_port,ssh_user,auth_type,ssh_password_enc,ssh_key_enc,connect_mode,docker_container,db_user,sudo_user,db_name,db_host,db_port,db_password_enc,db_ssl,db_engine,description,vpn_enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING ${PUBLIC_COLS}`,
        [req.params.id, b.name, isDirect ? '' : b.ssh_host, b.ssh_port || 22, isDirect ? '' : b.ssh_user, authType, pwEnc, keyEnc,
         mode, b.docker_container || null, b.db_user || null, b.sudo_user || null, b.db_name,
         isDirect ? b.db_host : null, isDirect ? (b.db_port || 5432) : null, dbPwEnc, isDirect ? !!b.db_ssl : false,
         isDirect ? (b.db_engine || 'postgres') : 'postgres', b.description || null, vpnEnabled]
      );
      let conn = rows[0];
      if (vpnEnabled) {
        const forwardPort = await assignForwardPort(req.params.id, conn);
        const { rows: updated } = await query(
          `UPDATE db_connections SET vpn_forward_port=$1 WHERE id=$2 RETURNING ${PUBLIC_COLS}`,
          [forwardPort, conn.id]
        );
        conn = updated[0];
      }
      res.status(201).json(conn);
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
      // 改前的目標(host:port)與 vpn_enabled 先存起來：改完若目標變了，舊轉發埠不能留著沿用；
      // vpn_enabled 從 false 變 true 也要重配，見下方判斷。
      const { rows: beforeRows } = await query(
        'SELECT connect_mode, ssh_host, ssh_port, db_host, db_port, vpn_enabled FROM db_connections WHERE id=$1 AND project_id=$2',
        [req.params.cid, req.params.id]
      );
      const before = beforeRows[0];
      const set = [];
      const params = [];
      let idx = 1;
      for (const [col, val] of Object.entries({
        name: b.name, ssh_host: b.ssh_host, ssh_port: b.ssh_port, ssh_user: b.ssh_user, auth_type: b.auth_type,
        connect_mode: b.connect_mode, docker_container: b.docker_container,
        db_user: b.db_user, sudo_user: b.sudo_user, db_name: b.db_name,
        db_host: b.db_host, db_port: b.db_port, db_ssl: b.db_ssl, db_engine: b.db_engine, description: b.description
      })) {
        if (val !== undefined) { set.push(`${col}=$${idx++}`); params.push(val); }
      }
      if (b.ssh_password) { set.push(`ssh_password_enc=$${idx++}`); params.push(encrypt(b.ssh_password)); }
      if (b.ssh_key_content) { set.push(`ssh_key_enc=$${idx++}`); params.push(encrypt(b.ssh_key_content)); }
      if (b.db_password) { set.push(`db_password_enc=$${idx++}`); params.push(encrypt(b.db_password)); }
      if (b.vpn_enabled !== undefined) { set.push(`vpn_enabled=$${idx++}`); params.push(!!b.vpn_enabled); }
      if (!set.length) return res.status(400).json({ error: '無可更新欄位' });
      params.push(req.params.cid, req.params.id);
      let { rows } = await query(
        `UPDATE db_connections SET ${set.join(', ')} WHERE id=$${idx++} AND project_id=$${idx} RETURNING ${PUBLIC_COLS}, vpn_forward_port`, params
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      // 剛把 vpn_enabled 從 false 打開就一律重配，不是只在「之前沒配過埠」才配：停用期間
      // 同目標的埠名額可能已被別條連線佔走，或這條自己的目標被改過。重配後若同專案已有同目標
      // 的連線，assignForwardPort 本來就會沿用它的埠，不會造成無謂的容器重建。
      const becameEnabled = rows[0].vpn_enabled && !(before && before.vpn_enabled);
      // 目標(host:port)真的變了才重配：同專案共用一個容器，舊埠若沒跟著換，改過主機的這條連線
      // 會跟另一條連線搶同一個轉發埠的 listen（docker -p 同埠掛兩個目標），容器起不來。
      // 反過來若目標沒變、也沒有 false→true 轉換就不能重配，否則每次存檔都可能換埠＝每次都重建容器＝斷線重撥。
      const beforeTarget = before && targetHostPort(before);
      const afterTarget = targetHostPort(rows[0]);
      const targetMoved = rows[0].vpn_enabled && rows[0].vpn_forward_port && beforeTarget &&
        (beforeTarget.host !== afterTarget.host || Number(beforeTarget.port) !== Number(afterTarget.port));
      if (becameEnabled || targetMoved) {
        const forwardPort = await assignForwardPort(req.params.id, { ...rows[0], id: req.params.cid });
        ({ rows } = await query(
          `UPDATE db_connections SET vpn_forward_port=$1 WHERE id=$2 RETURNING ${PUBLIC_COLS}`,
          [forwardPort, req.params.cid]
        ));
      }
      res.json(rows[0]);
    } catch (err) {
      if (err.statusCode === 400) return res.status(400).json({ error: err.message });
      if (err.code === '23505') return res.status(409).json({ error: '連線名稱已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/projects/:id/db-connections/:cid', verifyToken, requireAdmin, async (req, res) => {
    try {
      const { rows: [existing] } = await query('SELECT id FROM db_connections WHERE id=$1 AND project_id=$2', [req.params.cid, req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      // 刪連線不再直接動 docker：容器是整個專案共用的，砍掉會連累其他連線。
      // 少了這個目標之後，下次用到時 label 指紋對不上會自動重建，不需要在這裡處理。
      await query('DELETE FROM db_connections WHERE id=$1 AND project_id=$2', [req.params.cid, req.params.id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 專案層 VPN 設定：一個專案（＝一個客戶站點）一組憑證，該專案所有連線共用一條隧道。
  // GET 只回「有沒有設定」與帳號，不含設定檔與密碼，故比照連線列表開放給一般使用者。
  app.get('/api/projects/:id/vpn', verifyToken, async (req, res) => {
    try {
      const { rows: [p] } = await query('SELECT vpn_config_enc, vpn_username FROM projects WHERE id=$1', [req.params.id]);
      if (!p) return res.status(404).json({ error: 'Not found' });
      res.json({ has_config: !!p.vpn_config_enc, vpn_username: p.vpn_username || '' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 留空＝不變（比照連線表單既有慣例）：使用者只改帳號時不該把 .ovpn 或密碼清掉。
  app.put('/api/projects/:id/vpn', verifyToken, requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const set = [];
      const params = [];
      let idx = 1;
      if (b.vpn_config) { set.push(`vpn_config_enc=$${idx++}`); params.push(encrypt(b.vpn_config)); }
      if (b.vpn_username !== undefined) { set.push(`vpn_username=$${idx++}`); params.push(b.vpn_username || null); }
      if (b.vpn_password) { set.push(`vpn_password_enc=$${idx++}`); params.push(encrypt(b.vpn_password)); }
      if (!set.length) return res.status(400).json({ error: '無可更新欄位' });
      params.push(req.params.id);
      const { rowCount } = await query(`UPDATE projects SET ${set.join(', ')} WHERE id=$${idx}`, params);
      if (!rowCount) return res.status(404).json({ error: 'Not found' });
      // 容器 label 指紋只涵蓋 targets、不涵蓋憑證，ensureGatewayRunning 光看指紋相符就早退，
      // 換帳密／設定檔不會讓執行中的容器換憑證。砍掉舊容器，下次用到時自然會用新憑證重建。
      // removeGateway 內部已 try/catch（容器不存在不丟錯），這裡再包一層是為了保險：
      // 改憑證這件事不該因為 docker 沒裝／沒跑而變成 500。
      try { removeGateway({ containerName: projectContainerName(req.params.id) }); } catch { /* 不擋這次設定更新 */ }
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
        db_host: b.db_host, db_port: b.db_port, db_ssl: b.db_ssl, db_engine: b.db_engine, db_password: b.db_password || '',
      };
      if (b.id) {
        const stored = await loadDecryptedConn(b.id, req.params.id);
        if (stored) {
          // 安全：只有「表單目標主機＝已存連線主機」時才沿用已存密碼，
          // 否則可拿別的連線的密碼連向被改過的主機 → 憑證外洩
          const sameSshHost = !!conn.ssh_host && conn.ssh_host === stored.ssh_host;
          const sameDbHost = !!conn.db_host && conn.db_host === stored.db_host;
          if (!conn.ssh_password && sameSshHost) conn.ssh_password = stored.ssh_password;
          if (!conn.ssh_key && sameSshHost) conn.ssh_key = stored.ssh_key;
          if (!conn.db_password && sameDbHost) conn.db_password = stored.db_password;
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
          `SELECT c.id, c.name, c.db_engine, p.name AS project FROM db_connections c JOIN projects p ON p.id=c.project_id
           WHERE p.folder_name=$1 OR p.name=$1 ORDER BY c.name`, [project]));
      } else {
        ({ rows } = await query(
          `SELECT c.id, c.name, c.db_engine, p.name AS project FROM db_connections c JOIN projects p ON p.id=c.project_id ORDER BY p.name, c.name`));
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

module.exports = { registerRoutes, loadDecryptedConn, loopbackOnly };
