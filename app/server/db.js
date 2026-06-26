/**
 * db.js — PostgreSQL connection pool + schema migration
 *
 * Exports:
 *   getPool()              → pg.Pool singleton
 *   migrate()              → Promise<void>, CREATE TABLE IF NOT EXISTS (idempotent)
 *   query(text, params)    → Promise<{ rows }>, thin wrapper over pool.query
 *   _setPoolForTesting(p)  → inject a pg-mem pool in tests
 */
const { Pool } = require('pg');

let _pool = null;

/**
 * Returns the pg.Pool singleton.
 * In production, reads DATABASE_URL from env.
 * In tests, use _setPoolForTesting() to inject a pg-mem pool.
 */
function getPool() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  _pool = new Pool(connectionString ? { connectionString } : undefined);
  return _pool;
}

/**
 * Thin query wrapper — always use this instead of pool.query directly
 * so tests can inject a mock pool transparently.
 *
 * @param {string} text    SQL text with $1/$2 placeholders
 * @param {any[]}  [params] Query parameters
 * @returns {Promise<{ rows: any[] }>}
 */
async function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Creates all 7 application tables if they don't exist.
 * Safe to call multiple times (idempotent via IF NOT EXISTS).
 *
 * @returns {Promise<void>}
 */
async function migrate() {
  // Run each statement separately so pg-mem handles them without issues
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      odoo_settings JSONB,
      sync_interval INTEGER DEFAULT 15,
      deploy_cmd    TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS tasks (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      task_id         TEXT NOT NULL,
      source          TEXT NOT NULL,
      title           TEXT,
      original_text   TEXT,
      analysis_yaml   TEXT,
      status          TEXT NOT NULL DEFAULT 'new',
      git_branch      TEXT,
      reentry_count   INTEGER DEFAULT 0,
      blocker_content TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, task_id)
    )`,

    `CREATE TABLE IF NOT EXISTS task_logs (
      id         SERIAL PRIMARY KEY,
      task_id    INTEGER NOT NULL REFERENCES tasks(id),
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS loop_counter (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) UNIQUE,
      run_started_at TIMESTAMPTZ,
      loop_count     INTEGER DEFAULT 0
    )`,

    `CREATE TABLE IF NOT EXISTS sessions (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      token_hash  TEXT UNIQUE NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS project_maps (
      id           SERIAL PRIMARY KEY,
      project_name TEXT UNIQUE NOT NULL,
      odoo_version TEXT NOT NULL,
      project_dir  TEXT,
      notes        TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS odoo_version_configs (
      id             SERIAL PRIMARY KEY,
      odoo_version   TEXT UNIQUE NOT NULL,
      python_bin     TEXT NOT NULL,
      venv_base_path TEXT,
      odoo_bin_path  TEXT,
      notes          TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS projects (
      id           SERIAL PRIMARY KEY,
      name         TEXT UNIQUE NOT NULL,
      odoo_version TEXT NOT NULL,
      description  TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS project_repos (
      id          SERIAL PRIMARY KEY,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label       TEXT NOT NULL,
      repo_url    TEXT NOT NULL,
      local_path  TEXT,
      is_primary  BOOLEAN DEFAULT false,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS wiki_pages (
      id         SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      slug       TEXT NOT NULL,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(project_id, slug)
    )`,

    `CREATE TABLE IF NOT EXISTS project_chats (
      id         SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title      TEXT NOT NULL DEFAULT '新對話',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS project_chat_messages (
      id         SERIAL PRIMARY KEY,
      chat_id    INTEGER NOT NULL REFERENCES project_chats(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS teams_settings (
      id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      tenant_id       TEXT,
      client_id       TEXT,
      client_secret   TEXT,
      team_id         TEXT,
      channel_id      TEXT,
      odoo_base_url   TEXT,
      eservice_base_url TEXT,
      mention_users   JSONB NOT NULL DEFAULT '[]',
      webhook_url     TEXT,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS odoo_envs (
      id         SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status     TEXT NOT NULL DEFAULT 'idle',
      pid        INTEGER,
      port       INTEGER,
      url        TEXT,
      error_msg  TEXT,
      setup_log  TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(project_id)
    )`,
  ];

  // Build set of tables that already exist so we can skip them.
  // This makes migrate() idempotent even in pg-mem, which has limited
  // support for IF NOT EXISTS with DEFAULT constraints on re-run.
  const { rows: existingRows } = await query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  );
  const existing = new Set(existingRows.map(r => r.table_name));

  // Extract table name from "CREATE TABLE IF NOT EXISTS <name>" DDL
  const tableNameRe = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i;

  for (const sql of statements) {
    const match = sql.match(tableNameRe);
    if (match && existing.has(match[1])) {
      continue; // table already exists, skip
    }
    try {
      await query(sql);
    } catch (err) {
      // Ignore "table already exists" (pg code 42P07)
      if (err.code !== '42P07') throw err;
    }
  }

  // Column migrations — check information_schema first to stay idempotent
  const colMigrations = [
    { table: 'users', col: 'coding_cmd',  sql: 'ALTER TABLE users ADD COLUMN coding_cmd TEXT' },
    { table: 'users', col: 'qa_cmd',      sql: 'ALTER TABLE users ADD COLUMN qa_cmd TEXT' },
    { table: 'tasks', col: 'project_id',  sql: 'ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id)' },
    { table: 'tasks', col: 'task_type',          sql: "ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT 'odoo'" },
    { table: 'tasks', col: 'cs_reply',           sql: 'ALTER TABLE tasks ADD COLUMN cs_reply TEXT' },
    { table: 'tasks', col: 'cs_question',        sql: 'ALTER TABLE tasks ADD COLUMN cs_question TEXT' },
    { table: 'tasks', col: 'deploy_retry_count',   sql: 'ALTER TABLE tasks ADD COLUMN deploy_retry_count INTEGER DEFAULT 0' },
    { table: 'tasks', col: 'merge_conflict_data',  sql: 'ALTER TABLE tasks ADD COLUMN merge_conflict_data TEXT' },
    { table: 'tasks', col: 'teams_message_id',          sql: 'ALTER TABLE tasks ADD COLUMN teams_message_id TEXT' },
    { table: 'teams_settings', col: 'odoo_sync_interval',    sql: 'ALTER TABLE teams_settings ADD COLUMN odoo_sync_interval INTEGER DEFAULT 60' },
    { table: 'teams_settings', col: 'service_sync_interval', sql: 'ALTER TABLE teams_settings ADD COLUMN service_sync_interval INTEGER DEFAULT 60' },
    { table: 'projects', col: 'folder_name', sql: 'ALTER TABLE projects ADD COLUMN folder_name TEXT' },
    { table: 'teams_settings', col: 'odoo_url',  sql: 'ALTER TABLE teams_settings ADD COLUMN odoo_url TEXT' },
    { table: 'teams_settings', col: 'odoo_db',   sql: 'ALTER TABLE teams_settings ADD COLUMN odoo_db TEXT' },
    { table: 'teams_settings', col: 'service_url', sql: 'ALTER TABLE teams_settings ADD COLUMN service_url TEXT' },
    { table: 'teams_settings', col: 'service_db',  sql: 'ALTER TABLE teams_settings ADD COLUMN service_db TEXT' },
    { table: 'teams_settings', col: 'test_mode',   sql: 'ALTER TABLE teams_settings ADD COLUMN test_mode BOOLEAN DEFAULT false' },
    { table: 'tasks', col: 'is_paused',  sql: 'ALTER TABLE tasks ADD COLUMN is_paused BOOLEAN NOT NULL DEFAULT false' },
    { table: 'tasks', col: 'is_hidden',  sql: 'ALTER TABLE tasks ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT false' },
    { table: 'project_repos', col: 'clone_status',    sql: 'ALTER TABLE project_repos ADD COLUMN clone_status TEXT' },
    { table: 'project_repos', col: 'clone_error',     sql: 'ALTER TABLE project_repos ADD COLUMN clone_error TEXT' },
    { table: 'project_repos', col: 'graphify_status', sql: "ALTER TABLE project_repos ADD COLUMN graphify_status TEXT DEFAULT 'idle'" },
    { table: 'project_repos', col: 'graphify_error',  sql: 'ALTER TABLE project_repos ADD COLUMN graphify_error TEXT' }
  ];
  const tableColsCache = {};
  for (const { table, col, sql } of colMigrations) {
    if (!tableColsCache[table]) {
      const { rows } = await query(
        `SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [table]
      );
      tableColsCache[table] = new Set(rows.map(r => r.column_name));
    }
    if (!tableColsCache[table].has(col)) await query(sql);
  }

  // Unique indexes (idempotent via IF NOT EXISTS)
  await query('CREATE UNIQUE INDEX IF NOT EXISTS project_repos_project_label_idx ON project_repos (project_id, label)').catch(() => {});

  // One-time data migration: copy URL+DB from first admin user's odoo_settings into teams_settings
  try {
    const { rows: [ts] } = await query('SELECT odoo_url FROM teams_settings WHERE id = 1');
    if (!ts?.odoo_url) {
      const { rows: [admin] } = await query(
        "SELECT odoo_settings FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1"
      );
      if (admin?.odoo_settings) {
        const s = typeof admin.odoo_settings === 'string'
          ? JSON.parse(admin.odoo_settings)
          : admin.odoo_settings;
        if (s.odoo_url || s.service_url) {
          await query(`
            INSERT INTO teams_settings (id, odoo_url, odoo_db, service_url, service_db)
            VALUES (1, $1, $2, $3, $4)
            ON CONFLICT (id) DO UPDATE SET
              odoo_url    = COALESCE(NULLIF($1,''), teams_settings.odoo_url),
              odoo_db     = COALESCE(NULLIF($2,''), teams_settings.odoo_db),
              service_url = COALESCE(NULLIF($3,''), teams_settings.service_url),
              service_db  = COALESCE(NULLIF($4,''), teams_settings.service_db)
          `, [s.odoo_url || null, s.odoo_db || null, s.service_url || null, s.service_db || null]);
        }
      }
    }
  } catch { /* non-blocking, skip if tables not ready */ }
}

/**
 * Test-only: inject a pre-built pool (e.g. from pg-mem).
 * Pass null to reset to default behaviour.
 *
 * @param {object|null} pool
 */
function _setPoolForTesting(pool) {
  _pool = pool;
}

module.exports = { getPool, migrate, query, _setPoolForTesting };
