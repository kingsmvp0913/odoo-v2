// app/server/lib/platform-readonly.js
/**
 * platform-readonly.js — /ai/platform/query 的唯讀 DB 帳號（子專案 0 §4.4；計畫 X13）
 *
 * 為什麼是另一個 LOGIN 角色而不是 SET ROLE：平台 DB 只有 superuser odoo。在 odoo 的連線上 SET ROLE 到唯讀角色，
 * 查詢裡一句 set_config('role','odoo',false) 就切回去（session_user 仍是 superuser）。另開連線、以唯讀角色登入，
 * session_user 本身就沒有權限，沒有東西可以切。
 * 密碼由 APP_SECRET 派生：不另存一份祕密，跨重啟穩定。
 * 欄位級授權：表層 GRANT 會蓋掉欄位層 REVOKE，所以先 REVOKE ALL 再逐欄 GRANT 非敏感欄位；敏感欄位另外明確 REVOKE，
 * 讓「以前授權過、後來規則變嚴」的欄位也收得回來。每次啟動重跑一次：新表、新欄位自動納入規則。
 */
const crypto = require('crypto');

const RO_ROLE = 'aidev_ai_ro';
const RO_PASSWORD_LABEL = 'aidev:ai-readonly-db:v1';
const MAX_ROWS = 500;
const SENSITIVE_RE = /(_enc$|password|passwd|secret|token_hash|ssh_key|private_key|api_key|_pat$)/i;

function isSensitiveColumn(column) { return SENSITIVE_RE.test(String(column)); }

function bad(msg) { return Object.assign(new Error(msg), { statusCode: 400 }); }

function assertReadOnlySql(sql) {
  const stripped = String(sql || '').replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!/^(SELECT|WITH|EXPLAIN|SHOW)\b/i.test(stripped)) throw bad('只允許唯讀查詢（SELECT／WITH／EXPLAIN／SHOW）');
  if (/;\s*\S/.test(stripped)) throw bad('一次只能送一個語句');
  return stripped;
}

function roPassword() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error('APP_SECRET 未設定，無法派生唯讀 DB 帳號密碼');
  return crypto.createHmac('sha256', secret).update(RO_PASSWORD_LABEL).digest('hex');
}

const qi = s => `"${String(s).replace(/"/g, '""')}"`;

function buildRoleSql(columns, password) {
  if (!/^[a-f0-9]+$/.test(String(password))) throw new Error('唯讀帳號密碼格式不正確');
  const byTable = new Map();
  for (const { table_name: t, column_name: c } of columns) {
    if (!byTable.has(t)) byTable.set(t, { allow: [], deny: [] });
    byTable.get(t)[isSensitiveColumn(c) ? 'deny' : 'allow'].push(c);
  }
  const out = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RO_ROLE}') THEN CREATE ROLE ${RO_ROLE} LOGIN; END IF; END $$`,
    `ALTER ROLE ${RO_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`,
    `ALTER ROLE ${RO_ROLE} SET default_transaction_read_only = on`,
    `ALTER ROLE ${RO_ROLE} SET statement_timeout = '15s'`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${RO_ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${RO_ROLE}`,
    // 2c（8ca9913d）啟動時對每個 DB REVOKE CONNECT FROM PUBLIC；唯讀角色要明確授權才連得上（計畫 X19）
    `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${RO_ROLE}', current_database()); END $$`,
  ];
  for (const [t, { allow, deny }] of byTable) {
    if (deny.length) out.push(`REVOKE SELECT (${deny.map(qi).join(', ')}) ON public.${qi(t)} FROM ${RO_ROLE}`);
    if (allow.length) out.push(`GRANT SELECT (${allow.map(qi).join(', ')}) ON public.${qi(t)} TO ${RO_ROLE}`);
  }
  return out;
}

async function ensureReadonlyRole(deps = {}) {
  const query = deps.query || require('../db').query;
  const { rows } = await query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`);
  for (const stmt of buildRoleSql(rows, roPassword())) await query(stmt);
  const tables = new Set(rows.map(x => x.table_name)).size;
  const denied = rows.filter(x => isSensitiveColumn(x.column_name)).map(x => `${x.table_name}.${x.column_name}`);
  return { tables, denied };
}

function roConnectionString(databaseUrl) {
  const u = new URL(databaseUrl);
  u.username = RO_ROLE;
  u.password = roPassword();
  return u.toString();
}

async function runReadonlyQuery(sql, deps = {}) {
  const text = assertReadOnlySql(sql);
  const Client = deps.Client || require('pg').Client;
  const databaseUrl = deps.databaseUrl || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL 未設定');
  const client = new Client({ connectionString: roConnectionString(databaseUrl) });
  await client.connect();
  try {
    // queryMode extended＝走 prepared statement，PG 只接受單一語句（pg 8.22：lib/query.js:19,36）
    const r = await client.query({ text, queryMode: 'extended' });
    const rows = r.rows || [];
    return {
      columns: (r.fields || []).map(f => f.name),
      rows: rows.slice(0, MAX_ROWS),
      row_count: rows.length,
      truncated: rows.length > MAX_ROWS,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = {
  RO_ROLE, RO_PASSWORD_LABEL, MAX_ROWS, isSensitiveColumn, assertReadOnlySql, roPassword,
  buildRoleSql, ensureReadonlyRole, roConnectionString, runReadonlyQuery,
};
