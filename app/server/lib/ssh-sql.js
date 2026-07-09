const { Client } = require('ssh2');
const { ensureGatewayRunning } = require('./vpn-gateway');

function validateConnField(val, name) {
  if (val && !/^[A-Za-z0-9_.\-]+$/.test(String(val))) {
    throw new Error(`連線欄位 ${name} 包含不合法字元`);
  }
}

function stripSqlLiterals(sql) {
  let result = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
    } else if (sql[i] === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") { i++; break; }
        else i++;
      }
      result += "''";
    } else if (sql[i] === '$') {
      const m = /^\$([^$]*)\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end !== -1 ? end + tag.length : n;
        result += "''";
      } else { result += sql[i]; i++; }
    } else { result += sql[i]; i++; }
  }
  return result;
}

function validateSelectOnly(sql) {
  if (!sql) return 'SQL 不能為空';
  const cleaned = sql.trim().replace(/;+$/, '').trim();
  if (!cleaned) return 'SQL 不能為空';
  const firstWord = cleaned.split(/\s+/)[0].toUpperCase();
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') return `只允許 SELECT 查詢，不允許 ${firstWord}`;
  const stripped = stripSqlLiterals(cleaned);
  if (stripped.includes(';')) return '不允許多語句查詢（SQL 中不可包含分號）';
  const dangerous = [
    ['INSERT', 'INSERT'], ['UPDATE', 'UPDATE'], ['DELETE', 'DELETE'], ['DROP', 'DROP'],
    ['ALTER', 'ALTER'], ['TRUNCATE', 'TRUNCATE'], ['CREATE', 'CREATE'], ['GRANT', 'GRANT'],
    ['REVOKE', 'REVOKE'], ['COPY', 'COPY'], ['EXECUTE', 'EXECUTE'], ['CALL', 'CALL'], ['INTO', 'SELECT INTO'],
  ];
  for (const [kw, label] of dangerous) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(stripped)) return `不允許 ${label} 操作`;
  }
  return null;
}

function buildPsqlCmd(conn, sql) {
  validateConnField(conn.db_name, 'db_name');
  validateConnField(conn.docker_container, 'docker_container');
  validateConnField(conn.db_user, 'db_user');
  validateConnField(conn.sudo_user, 'sudo_user');
  const password = conn.ssh_password || '';
  const mode = conn.connect_mode || 'docker';
  const dbName = conn.db_name || 'odoo_prd';
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  if (mode === 'docker') {
    const container = conn.docker_container || 'odoo-db';
    const dbUser = conn.db_user || 'odoo';
    if (password) {
      const safePw = password.replace(/'/g, "'\\''");
      return `echo '${safePw}' | sudo -S bash -c 'echo ${encoded} | base64 -d | docker exec -i ${container} psql -U ${dbUser} -d ${dbName} --csv'`;
    }
    return `echo ${encoded} | base64 -d | sudo docker exec -i ${container} psql -U ${dbUser} -d ${dbName} --csv`;
  }
  const sudoUser = conn.sudo_user || 'odoo';
  if (password) {
    const safePw = password.replace(/'/g, "'\\''");
    return `echo '${safePw}' | sudo -S -u ${sudoUser} bash -c 'echo ${encoded} | base64 -d | psql -d ${dbName} --csv'`;
  }
  return `echo ${encoded} | base64 -d | sudo -u ${sudoUser} psql -d ${dbName} --csv`;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* skip */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function sshExec(conn, command) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let stdout = '', stderr = '';
    c.on('ready', () => {
      c.exec(command, (err, stream) => {
        if (err) { c.end(); return reject(err); }
        stream.on('close', (code) => { c.end(); resolve({ stdout, stderr, code }); })
          .on('data', d => { stdout += d; })
          .stderr.on('data', d => { stderr += d; });
      });
    }).on('error', reject);
    const cfg = { host: conn.ssh_host, port: conn.ssh_port || 22, username: conn.ssh_user, readyTimeout: 15000 };
    if (conn.auth_type === 'key' && conn.ssh_key) cfg.privateKey = Buffer.from(conn.ssh_key, 'utf8');
    else cfg.password = conn.ssh_password;
    c.connect(cfg);
  });
}

// 統一把 driver 回傳值正規化成字串（NULL→空字串，對齊 --csv 語意）
function normCell(c) { return (c === null || c === undefined) ? '' : String(c); }

// VPN 轉發：把要連的目標位址換成本機轉發 port，其餘欄位不變。
function applyVpnForward(conn, forwardPort) {
  if ((conn.connect_mode || 'docker') === 'direct') {
    return { ...conn, db_host: '127.0.0.1', db_port: forwardPort };
  }
  return { ...conn, ssh_host: '127.0.0.1', ssh_port: forwardPort };
}

// direct 模式：不經 SSH/docker，依 db_engine 直連 TCP。
// SSL 開啟時一律驗證伺服器憑證（不提供「略過驗證」的預設路徑）；自簽憑證需讓系統信任。
async function runDirect(conn, sql) {
  const engine = conn.db_engine || 'postgres';
  if (engine === 'mssql') return runDirectMssql(conn, sql);
  if (engine === 'mysql') return runDirectMysql(conn, sql);
  return runDirectPg(conn, sql);
}

// PostgreSQL：pg，以 rowMode:'array' 讓回傳格式對齊 CSV 路徑。
async function runDirectPg(conn, sql) {
  const { Client } = require('pg');
  const client = new Client({
    host: conn.db_host,
    port: conn.db_port || 5432,
    user: conn.db_user,
    password: conn.db_password || '',
    database: conn.db_name,
    ssl: conn.db_ssl ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 15000,
    statement_timeout: 120000,
  });
  try {
    await client.connect();
    const res = await client.query({ text: sql, rowMode: 'array' });
    const columns = (res.fields || []).map(f => f.name);
    const rows = (res.rows || []).map(r => r.map(normCell));
    return { ok: true, columns, rows, row_count: rows.length };
  } catch (e) {
    return { ok: false, error: `[DIRECT] ${e.message}` };
  } finally {
    try { await client.end(); } catch { /* ignore close errors */ }
  }
}

// Microsoft SQL Server：mssql（TDS）。encrypt 由 db_ssl 決定，加密時仍驗證憑證。
async function runDirectMssql(conn, sql) {
  const mssql = require('mssql');
  const pool = new mssql.ConnectionPool({
    server: conn.db_host,
    port: conn.db_port || 1433,
    user: conn.db_user,
    password: conn.db_password || '',
    database: conn.db_name,
    options: { encrypt: !!conn.db_ssl, trustServerCertificate: false },
    connectionTimeout: 15000,
    requestTimeout: 120000,
  });
  try {
    await pool.connect();
    const res = await pool.request().query(sql);
    const rs = res.recordset || [];
    const columns = rs.columns ? Object.keys(rs.columns) : (rs.length ? Object.keys(rs[0]) : []);
    const rows = rs.map(o => columns.map(c => normCell(o[c])));
    return { ok: true, columns, rows, row_count: rows.length };
  } catch (e) {
    return { ok: false, error: `[DIRECT] ${e.message}` };
  } finally {
    try { await pool.close(); } catch { /* ignore close errors */ }
  }
}

// MySQL / MariaDB：mysql2/promise，以 rowsAsArray 取回陣列列。
async function runDirectMysql(conn, sql) {
  const mysql = require('mysql2/promise');
  let client;
  try {
    client = await mysql.createConnection({
      host: conn.db_host,
      port: conn.db_port || 3306,
      user: conn.db_user,
      password: conn.db_password || '',
      database: conn.db_name,
      ssl: conn.db_ssl ? { rejectUnauthorized: true } : undefined,
      connectTimeout: 15000,
    });
    const [rows, fields] = await client.query({ sql, rowsAsArray: true });
    const columns = (fields || []).map(f => f.name);
    const outRows = (rows || []).map(r => r.map(normCell));
    return { ok: true, columns, rows: outRows, row_count: outRows.length };
  } catch (e) {
    return { ok: false, error: `[DIRECT] ${e.message}` };
  } finally {
    try { if (client) await client.end(); } catch { /* ignore close errors */ }
  }
}

async function runSelect(conn, sql) {
  const err = validateSelectOnly(sql);
  if (err) return { ok: false, error: err };

  let effectiveConn = conn;
  if (conn.vpn_enabled) {
    let forwardPort;
    try {
      ({ forwardPort } = await ensureGatewayRunning(conn));
    } catch (e) {
      return { ok: false, error: `[VPN] ${e.message}` };
    }
    effectiveConn = applyVpnForward(conn, forwardPort);
  }

  if ((effectiveConn.connect_mode || 'docker') === 'direct') return runDirect(effectiveConn, sql);
  const cmd = buildPsqlCmd(effectiveConn, sql);
  let res;
  try { res = await sshExec(effectiveConn, cmd); }
  catch (e) { return { ok: false, error: `[SSH] ${e.message}` }; }
  const cleanErr = res.stderr.split('\n').filter(l => !l.trim().startsWith('[sudo]')).join('\n');
  if (res.code !== 0) return { ok: false, error: cleanErr.trim() || res.stdout.trim() || `exit ${res.code}` };
  if (!res.stdout.trim()) return { ok: true, columns: [], rows: [], row_count: 0 };
  const parsed = parseCsv(res.stdout.trim());
  return { ok: true, columns: parsed[0] || [], rows: parsed.slice(1), row_count: Math.max(0, parsed.length - 1) };
}

module.exports = { validateSelectOnly, stripSqlLiterals, buildPsqlCmd, parseCsv, runSelect, runDirect, applyVpnForward };
