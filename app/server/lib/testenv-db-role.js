/**
 * lib/testenv-db-role.js — 測試區自己的 PostgreSQL 角色（產品化規格 1 §10）
 *
 * 以前測試區 Odoo 拿的是平台 DATABASE_URL 的帳密，而那個帳號是超級使用者：進得了測試區的人
 * （客戶驗收時就是 Odoo admin，可寫伺服器動作跑 Python）或 AI 寫進模組的一段碼，都能讀平台 DB、
 * 改別家測試庫、COPY … TO PROGRAM 在平台容器執行指令。這條路不經過 AI 容器。
 *
 * ⚠ 禁用 REASSIGN OWNED（09-15 實測，規格 §10.6）：odoo 是 initdb 的 bootstrap 角色，直接報錯；
 *   而且 REASSIGN OWNED 會連「其他 DB 的擁有權」一起轉走。一律逐物件 ALTER … OWNER。
 */
const crypto = require('crypto');
const { Client } = require('pg');
const { query } = require('../db');
const { encrypt, decrypt } = require('./crypto');

function platformDbUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('沒有 DATABASE_URL，無法管理測試區資料庫帳號');
  return new URL(raw);
}

function platformDbUser() {
  try { return decodeURIComponent(new URL(process.env.DATABASE_URL).username) || null; } catch { return null; }
}

function roleNameFor(projectId) {
  const id = typeof projectId === 'string' && /^\d+$/.test(projectId) ? Number(projectId) : projectId;
  if (!Number.isInteger(id) || id <= 0) throw new Error(`不合法的專案 id：${projectId}`);
  return `testenv_p${id}`;
}

function quoteIdent(name) { return `"${String(name).replace(/"/g, '""')}"`; }
function quoteLiteral(s) { return `'${String(s).replace(/'/g, "''")}'`; }

// host／port 沿用平台 DB；沒有 DATABASE_URL 時不帶（容器端 remapDbHostForContainer 會補 host.docker.internal，
// 與舊 odooDbArgs 行為一致）。帳密永遠是測試區角色——這裡不需要 DATABASE_URL 才能保證不帶到平台帳號。
function testEnvDbArgs({ role, password }) {
  const args = [];
  let u = null;
  try { u = new URL(process.env.DATABASE_URL); } catch { /* 沒有或格式錯：只帶帳密 */ }
  if (u && u.hostname) args.push('--db_host', u.hostname);
  if (u && u.port) args.push('--db_port', u.port);
  args.push('--db_user', role, '--db_password', password);
  return args;
}

// 在「目標 DB 內」以超級使用者執行。擴充套件成員（deptype e）改不了也不該改；
// 被表擁有的序列（deptype a）與索引（i）會跟著表轉，單獨改會報錯。
function ownershipTransferSql({ from, to }) {
  const f = quoteLiteral(from);
  const t = quoteLiteral(to);
  return `DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND pg_get_userbyid(c.relowner) = ${f}
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('e', 'a', 'i'))
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO %I',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.nspname, r.relname, ${t});
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND pg_get_userbyid(p.proowner) = ${f}
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO %I', r.sig, ${t});
  END LOOP;
END
$$;`;
}

function defaultCreateClient(database) {
  const u = platformDbUrl();
  u.pathname = `/${encodeURIComponent(database)}`;
  return new Client({ connectionString: u.toString() });
}

async function loadTestEnvDbCreds(projectId) {
  const { rows: [env] } = await query('SELECT db_password_enc FROM odoo_envs WHERE project_id=$1', [projectId]);
  if (!env || !env.db_password_enc) return null;
  try { return { role: roleNameFor(projectId), password: decrypt(env.db_password_enc) }; } catch { return null; }
}

// 每次建置都跑：冪等。順序有意義——DB 要先存在（或轉好擁有者）才能連進去建擴充套件、轉物件。
async function ensureTestEnvDbRole({ projectId, dbName, createClient = defaultCreateClient }) {
  platformDbUrl();                                   // 沒有 DATABASE_URL 就在送任何 SQL 之前失敗
  const role = roleNameFor(projectId);
  const superuser = platformDbUser();
  const saved = await loadTestEnvDbCreds(projectId);
  const password = saved ? saved.password : crypto.randomBytes(24).toString('hex');

  const admin = createClient('postgres');
  await admin.connect();
  try {
    const { rows: roleRows } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    // 已存在也重設一次：密碼以 odoo_envs 為準，屬性不小心被改過也拉回來
    await admin.query(`${roleRows.length ? 'ALTER' : 'CREATE'} ROLE ${quoteIdent(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${quoteLiteral(password)}`);
    const { rows: dbRows } = await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [dbName]);
    if (!dbRows.length) {
      await admin.query(`CREATE DATABASE ${quoteIdent(dbName)} OWNER ${quoteIdent(role)} ENCODING 'UTF8' LC_COLLATE 'C' TEMPLATE template0`);
    } else if (dbRows[0].owner !== role) {
      await admin.query(`ALTER DATABASE ${quoteIdent(dbName)} OWNER TO ${quoteIdent(role)}`);
    }
    await admin.query(`REVOKE CONNECT ON DATABASE ${quoteIdent(dbName)} FROM PUBLIC`);
  } finally {
    await admin.end().catch(() => {});
  }

  const db = createClient(dbName);
  await db.connect();
  try {
    // DB 由平台先建時 Odoo 會跳過它自己的建擴充套件步驟（odoo/service/db.py _create_empty_database）
    await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    if (superuser && superuser !== role) await db.query(ownershipTransferSql({ from: superuser, to: role }));
  } finally {
    await db.end().catch(() => {});
  }

  await query('UPDATE odoo_envs SET db_password_enc=$2 WHERE project_id=$1', [projectId, encrypt(password)]);
  return { role, password };
}

// 平台啟動時跑：撤掉 PUBLIC 對每個 DB 的 CONNECT。超級使用者不受影響；測試區角色是自己 DB 的擁有者，照連。
async function revokePublicConnectAll({ createClient = defaultCreateClient } = {}) {
  const admin = createClient('postgres');
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname');
    for (const r of rows) await admin.query(`REVOKE CONNECT ON DATABASE ${quoteIdent(r.datname)} FROM PUBLIC`);
    return rows.length;
  } finally {
    await admin.end().catch(() => {});
  }
}

module.exports = {
  platformDbUser, roleNameFor, quoteIdent, quoteLiteral, testEnvDbArgs, ownershipTransferSql,
  ensureTestEnvDbRole, loadTestEnvDbCreds, revokePublicConnectAll,
};
