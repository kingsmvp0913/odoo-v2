// scripts/lib/postgres.js
const { execFileSync: realExecFileSync } = require('child_process');

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function parseDatabaseUrl(databaseUrl) {
  const u = new URL(databaseUrl);
  const cfg = {
    pgHost: u.hostname,
    pgPort: u.port || '5432',
    pgUser: decodeURIComponent(u.username),
    pgPassword: decodeURIComponent(u.password),
    pgDb: u.pathname.replace(/^\//, ''),
  };
  if (!IDENT_RE.test(cfg.pgUser)) throw new Error(`PG_USER 格式不合法（僅允許英數與底線）：${cfg.pgUser}`);
  if (!IDENT_RE.test(cfg.pgDb)) throw new Error(`PG_DB 格式不合法（僅允許英數與底線）：${cfg.pgDb}`);
  return cfg;
}

// 用系統已裝的 psql CLI 而非 npm pg 套件：scripts/ 沒有自己的 node_modules，
// 若 require('pg') 會往上層目錄找不到 app/node_modules（node 模組解析不會跨到 app/）。
function ensurePostgres(databaseUrl, deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  const cfg = parseDatabaseUrl(databaseUrl);

  try {
    execFileSync('psql', [
      '-h', cfg.pgHost, '-p', cfg.pgPort, '-U', cfg.pgUser, '-d', cfg.pgDb,
      '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1',
    ], { env: { ...process.env, PGPASSWORD: cfg.pgPassword }, stdio: 'pipe' });
    return { created: false };
  } catch {
    // 直接連線失敗 → 換 admin 身分嘗試建立缺少的 role/db
  }

  const adminUser = process.env.PGADMIN_USER || 'postgres';
  const adminEnv = { ...process.env, PGPASSWORD: process.env.PGADMIN_PASSWORD || '' };
  const psqlAdmin = (sql) => execFileSync('psql', [
    '-h', cfg.pgHost, '-p', cfg.pgPort, '-U', adminUser, '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-tAc', sql,
  ], { env: adminEnv, encoding: 'utf8' });

  const roleExists = psqlAdmin(`SELECT 1 FROM pg_roles WHERE rolname='${cfg.pgUser}'`).trim();
  if (!roleExists) {
    psqlAdmin(`CREATE ROLE "${cfg.pgUser}" LOGIN PASSWORD '${cfg.pgPassword.replace(/'/g, "''")}'`);
  }
  const dbExists = psqlAdmin(`SELECT 1 FROM pg_database WHERE datname='${cfg.pgDb}'`).trim();
  if (!dbExists) {
    psqlAdmin(`CREATE DATABASE "${cfg.pgDb}" OWNER "${cfg.pgUser}"`);
  }
  return { created: true };
}

module.exports = { parseDatabaseUrl, ensurePostgres };
