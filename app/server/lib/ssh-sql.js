const { Client } = require('ssh2');
const fs = require('fs');

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
  if (cleaned.includes(';')) return '不允許多語句查詢（SQL 中不可包含分號）';
  const firstWord = cleaned.split(/\s+/)[0].toUpperCase();
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') return `只允許 SELECT 查詢，不允許 ${firstWord}`;
  const stripped = stripSqlLiterals(cleaned);
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
    if (conn.auth_type === 'key' && conn.ssh_key_path) cfg.privateKey = fs.readFileSync(conn.ssh_key_path);
    else cfg.password = conn.ssh_password;
    c.connect(cfg);
  });
}

async function runSelect(conn, sql) {
  const err = validateSelectOnly(sql);
  if (err) return { ok: false, error: err };
  const cmd = buildPsqlCmd(conn, sql);
  let res;
  try { res = await sshExec(conn, cmd); }
  catch (e) { return { ok: false, error: `[SSH] ${e.message}` }; }
  const cleanErr = res.stderr.split('\n').filter(l => !l.trim().startsWith('[sudo]')).join('\n');
  if (res.code !== 0) return { ok: false, error: cleanErr.trim() || res.stdout.trim() || `exit ${res.code}` };
  if (!res.stdout.trim()) return { ok: true, columns: [], rows: [], row_count: 0 };
  const parsed = parseCsv(res.stdout.trim());
  return { ok: true, columns: parsed[0] || [], rows: parsed.slice(1), row_count: Math.max(0, parsed.length - 1) };
}

module.exports = { validateSelectOnly, stripSqlLiterals, buildPsqlCmd, parseCsv, runSelect };
