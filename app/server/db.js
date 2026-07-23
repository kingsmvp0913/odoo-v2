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

    `CREATE TABLE IF NOT EXISTS task_events (
      id         SERIAL PRIMARY KEY,
      task_id    INTEGER NOT NULL REFERENCES tasks(id),
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
      pid_started_at TEXT,
      port       INTEGER,
      url        TEXT,
      error_msg  TEXT,
      setup_log  TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(project_id)
    )`,

    `CREATE TABLE IF NOT EXISTS db_connections (
      id                SERIAL PRIMARY KEY,
      project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      ssh_host          TEXT NOT NULL,
      ssh_port          INTEGER NOT NULL DEFAULT 22,
      ssh_user          TEXT NOT NULL,
      auth_type         TEXT NOT NULL DEFAULT 'password',
      ssh_password_enc  TEXT,
      ssh_key_path      TEXT,
      connect_mode      TEXT NOT NULL DEFAULT 'docker',
      docker_container  TEXT,
      db_user           TEXT,
      sudo_user         TEXT,
      db_name           TEXT NOT NULL,
      description       TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(project_id, name)
    )`,

    `CREATE TABLE IF NOT EXISTS token_usage (
      id                   SERIAL PRIMARY KEY,
      task_id              TEXT,
      project_id           INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
      agent_type           TEXT NOT NULL,
      model                TEXT,
      input_tokens         INTEGER NOT NULL DEFAULT 0,
      output_tokens        INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens  INTEGER NOT NULL DEFAULT 0,
      duration_ms          INTEGER,
      source               TEXT NOT NULL DEFAULT 'server' CHECK (source IN ('server','ps1')),
      recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // 送給 Claude 的完整 prompt 稽核記錄（管理員頁「Prompt 送出記錄」）：每次 runClaude 送出前落一筆，
    // 只保留最近 N 筆（送出路徑順手 prune），供確認實際送出內容。best-effort，寫入失敗不影響執行。
    `CREATE TABLE IF NOT EXISTS prompt_logs (
      id          SERIAL PRIMARY KEY,
      agent_type  TEXT,
      model       TEXT,
      task_id     TEXT,
      prompt      TEXT NOT NULL,
      char_len    INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // 退回原因表（工作流程健檢 agent 子專案 1）：review_pending 退回時記 raw 原因，
    // cron 慢慢跑分類 agent 拆成 rejection_items。以業務 task_id 為 key（硬刪/重置任務不失真）。
    `CREATE TABLE IF NOT EXISTS task_rejections (
      id          SERIAL PRIMARY KEY,
      task_id     TEXT,
      project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason      TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'new',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS rejection_items (
      id            SERIAL PRIMARY KEY,
      rejection_id  INTEGER NOT NULL REFERENCES task_rejections(id) ON DELETE CASCADE,
      description   TEXT NOT NULL,
      category      TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // wiki_drift：chat／cs 為回答而讀了程式碼、發現某 wiki 頁描述與程式碼矛盾（頁錯、碼對）時回報的佇列。
    // 仿 task_rejections——status='new' 進、cron 慢慢跑分類 agent 補 category、標 classified（供健檢分組彙整）。
    // 只回報不自動改文件（正典的修正走 ⟳ 重生／人工）。category 未分類前為 NULL。
    `CREATE TABLE IF NOT EXISTS wiki_drift (
      id          SERIAL PRIMARY KEY,
      project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      task_id     TEXT,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      source      TEXT NOT NULL DEFAULT 'chat',
      slug        TEXT,
      reason      TEXT NOT NULL,
      category    TEXT,
      status      TEXT NOT NULL DEFAULT 'new',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // classify_samples：failure-classifier 的 regex 判不出（unknown）、交 haiku 分類的案例留樣本
    // （真因文字＋最終判定＋haiku 是否真的判出）。用途：定期看高頻 pattern → 升級成零 token 的 regex，
    // 讓 haiku fallback 呼叫量單調下降（健檢：deploy-fix haiku fallback 缺回饋迴圈）。
    `CREATE TABLE IF NOT EXISTS classify_samples (
      id           SERIAL PRIMARY KEY,
      task_id      TEXT,
      project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      error_text   TEXT NOT NULL,
      verdict      TEXT NOT NULL,
      agent_ok     BOOLEAN NOT NULL DEFAULT false,
      recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // 外部溝通紀錄：sync 從 Odoo/eService mail.message 逐筆拉進來的聊天紀錄（source='sync'，
    // external_id=Odoo message id，供增量同步 dedup）＋使用者在詳情頁手動追加的留言（source='manual'）。
    // original_text 之後只存 ticket 靜態欄位，聊天紀錄改由這張表存，分析時動態組回（見 sync.js assembleTaskContext）。
    `CREATE TABLE IF NOT EXISTS task_messages (
      id             SERIAL PRIMARY KEY,
      task_id        INTEGER NOT NULL REFERENCES tasks(id),
      source         TEXT NOT NULL DEFAULT 'manual',
      external_id    TEXT,
      author         TEXT,
      content        TEXT NOT NULL,
      occurred_at    TIMESTAMPTZ NOT NULL,
      synced_to_odoo BOOLEAN NOT NULL DEFAULT false,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )`,

    // 附件：工單主附件（origin='ticket_main'，message_id 為 NULL）／同步訊息附件
    // （origin='synced_message'）／使用者回覆上傳（origin='manual_reply'）三種來源統一存放，
    // 檔案本體存本機磁碟（見 lib/attachments.js），這裡只存 metadata 與相對路徑。
    `CREATE TABLE IF NOT EXISTS task_attachments (
      id                     SERIAL PRIMARY KEY,
      task_id                INTEGER NOT NULL REFERENCES tasks(id),
      message_id             INTEGER REFERENCES task_messages(id),
      filename               TEXT NOT NULL,
      mimetype               TEXT,
      file_path              TEXT NOT NULL,
      origin                 TEXT NOT NULL,
      external_attachment_id TEXT,
      synced_to_odoo         BOOLEAN NOT NULL DEFAULT false,
      created_at             TIMESTAMPTZ DEFAULT NOW()
    )`,

    // 工作流程健檢 agent（子專案 2）：admin 一鍵健檢的一次執行＋每 agent 診斷 finding。
    `CREATE TABLE IF NOT EXISTS health_check_runs (
      id           SERIAL PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'running',   -- running | done | error
      window_days  INTEGER NOT NULL DEFAULT 30,
      started_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at  TIMESTAMPTZ
    )`,

    `CREATE TABLE IF NOT EXISTS health_check_findings (
      id                SERIAL PRIMARY KEY,
      run_id            INTEGER NOT NULL REFERENCES health_check_runs(id) ON DELETE CASCADE,
      agent_name        TEXT NOT NULL,
      agent_label       TEXT,
      diagnosis         TEXT NOT NULL,
      severity          TEXT NOT NULL,                -- ok | low | medium | high | error
      suggested_prompt  TEXT,
      rationale         TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    { table: 'tasks', col: 'project_id',  sql: 'ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id)' },
    { table: 'tasks', col: 'task_type',          sql: "ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT 'odoo'" },
    { table: 'tasks', col: 'cs_reply',           sql: 'ALTER TABLE tasks ADD COLUMN cs_reply TEXT' },
    { table: 'tasks', col: 'cs_question',        sql: 'ALTER TABLE tasks ADD COLUMN cs_question TEXT' },
    { table: 'tasks', col: 'cs_findings',        sql: 'ALTER TABLE tasks ADD COLUMN cs_findings TEXT' },
    { table: 'tasks', col: 'deploy_retry_count',   sql: 'ALTER TABLE tasks ADD COLUMN deploy_retry_count INTEGER DEFAULT 0' },
    { table: 'tasks', col: 'qa_retry_count',       sql: 'ALTER TABLE tasks ADD COLUMN qa_retry_count INTEGER DEFAULT 0' },
    { table: 'tasks', col: 'pw_retry_count',       sql: 'ALTER TABLE tasks ADD COLUMN pw_retry_count INTEGER DEFAULT 0' },
    { table: 'tasks', col: 'done_at',              sql: 'ALTER TABLE tasks ADD COLUMN done_at TIMESTAMPTZ' },
    { table: 'tasks', col: 'blocker_type',         sql: 'ALTER TABLE tasks ADD COLUMN blocker_type TEXT' },
    { table: 'tasks', col: 'resume_status',        sql: 'ALTER TABLE tasks ADD COLUMN resume_status TEXT' },
    { table: 'tasks', col: 'approved_at',          sql: 'ALTER TABLE tasks ADD COLUMN approved_at TIMESTAMPTZ' },
    { table: 'tasks', col: 'retry_feedback',       sql: 'ALTER TABLE tasks ADD COLUMN retry_feedback TEXT' },
    { table: 'tasks', col: 'coding_session_id',    sql: 'ALTER TABLE tasks ADD COLUMN coding_session_id TEXT' },
    { table: 'tasks', col: 'analysis_retry_count', sql: 'ALTER TABLE tasks ADD COLUMN analysis_retry_count INTEGER DEFAULT 0' },
    { table: 'tasks', col: 'qa_session_id',        sql: 'ALTER TABLE tasks ADD COLUMN qa_session_id TEXT' },
    { table: 'tasks', col: 'qa_resume_count',      sql: 'ALTER TABLE tasks ADD COLUMN qa_resume_count INTEGER DEFAULT 0' },
    // QA session 綁定的 prompt 版本指紋（agent-loader.promptVersion）：resume 前比對，qa prompt 變了就強制 fresh。
    // （coding 已改無狀態、無 session，不需此欄。）既有列為 NULL≠現版本 → 下次自動 fresh。
    { table: 'tasks', col: 'qa_prompt_ver',        sql: 'ALTER TABLE tasks ADD COLUMN qa_prompt_ver TEXT' },
    // 上輪 QA 審過的任務分支 HEAD commit（死結熔斷用）：本輪 HEAD 若與其相同＝coding 未提交任何修正，
    // QA 卻仍要 fail → 兩邊僵局，提早停下轉人工裁決，不燒到 QA_LIMIT。
    { table: 'tasks', col: 'qa_reviewed_commit',   sql: 'ALTER TABLE tasks ADD COLUMN qa_reviewed_commit TEXT' },
    // 行程身分指紋（Linux /proc starttime；其他平台 NULL）：kill 前核對防 pid 重用誤殺
    { table: 'odoo_envs', col: 'pid_started_at',   sql: 'ALTER TABLE odoo_envs ADD COLUMN pid_started_at TEXT' },
    { table: 'tasks', col: 'merge_conflict_data',  sql: 'ALTER TABLE tasks ADD COLUMN merge_conflict_data TEXT' },
    { table: 'tasks', col: 'merge_resolutions',    sql: 'ALTER TABLE tasks ADD COLUMN merge_resolutions TEXT' },
    { table: 'users', col: 'password_enc',         sql: 'ALTER TABLE users ADD COLUMN password_enc TEXT' },
    { table: 'tasks', col: 'teams_message_id',          sql: 'ALTER TABLE tasks ADD COLUMN teams_message_id TEXT' },
    { table: 'teams_settings', col: 'odoo_sync_interval',    sql: 'ALTER TABLE teams_settings ADD COLUMN odoo_sync_interval INTEGER DEFAULT 60' },
    { table: 'teams_settings', col: 'service_sync_interval', sql: 'ALTER TABLE teams_settings ADD COLUMN service_sync_interval INTEGER DEFAULT 60' },
    { table: 'projects', col: 'folder_name', sql: 'ALTER TABLE projects ADD COLUMN folder_name TEXT' },
    // 外部通知 webhook（outbound）：任務進入需人工動作狀態時 POST；與 webhook_url（Teams inbound）不同用途
    { table: 'teams_settings', col: 'notify_webhook_url', sql: 'ALTER TABLE teams_settings ADD COLUMN notify_webhook_url TEXT' },
    { table: 'teams_settings', col: 'odoo_url',  sql: 'ALTER TABLE teams_settings ADD COLUMN odoo_url TEXT' },
    { table: 'teams_settings', col: 'odoo_db',   sql: 'ALTER TABLE teams_settings ADD COLUMN odoo_db TEXT' },
    { table: 'teams_settings', col: 'service_url', sql: 'ALTER TABLE teams_settings ADD COLUMN service_url TEXT' },
    { table: 'teams_settings', col: 'service_db',  sql: 'ALTER TABLE teams_settings ADD COLUMN service_db TEXT' },
    { table: 'teams_settings', col: 'test_mode',   sql: 'ALTER TABLE teams_settings ADD COLUMN test_mode BOOLEAN DEFAULT false' },
    { table: 'teams_settings', col: 'writeback_odoo_notes', sql: 'ALTER TABLE teams_settings ADD COLUMN writeback_odoo_notes BOOLEAN DEFAULT false' },
    // 測試區建置模式：'venv'（預設，宿主 venv）或 'docker'（官方 odoo image，自動涵蓋 13→20+）。由管理設定切換。
    { table: 'teams_settings', col: 'env_mode', sql: "ALTER TABLE teams_settings ADD COLUMN env_mode TEXT DEFAULT 'venv'" },
    // Claude 用量閘門：超標停自動推進（全域單一，全台共用同一 claude 帳號）
    { table: 'teams_settings', col: 'usage_gate_enabled',     sql: 'ALTER TABLE teams_settings ADD COLUMN usage_gate_enabled BOOLEAN DEFAULT true' },
    { table: 'teams_settings', col: 'usage_gate_5h_threshold', sql: 'ALTER TABLE teams_settings ADD COLUMN usage_gate_5h_threshold INTEGER DEFAULT 90' },
    { table: 'teams_settings', col: 'usage_gate_7d_threshold', sql: 'ALTER TABLE teams_settings ADD COLUMN usage_gate_7d_threshold INTEGER DEFAULT 95' },
    { table: 'tasks', col: 'is_paused',  sql: 'ALTER TABLE tasks ADD COLUMN is_paused BOOLEAN NOT NULL DEFAULT false' },
    { table: 'tasks', col: 'is_hidden',  sql: 'ALTER TABLE tasks ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT false' },
    { table: 'project_repos', col: 'clone_status',    sql: 'ALTER TABLE project_repos ADD COLUMN clone_status TEXT' },
    { table: 'project_repos', col: 'clone_error',     sql: 'ALTER TABLE project_repos ADD COLUMN clone_error TEXT' },
    { table: 'project_repos', col: 'graphify_status', sql: "ALTER TABLE project_repos ADD COLUMN graphify_status TEXT DEFAULT 'idle'" },
    { table: 'project_repos', col: 'graphify_error',  sql: 'ALTER TABLE project_repos ADD COLUMN graphify_error TEXT' },
    { table: 'projects', col: 'port', sql: 'ALTER TABLE projects ADD COLUMN port INTEGER' },
    { table: 'projects', col: 'odoo_project_name',      sql: 'ALTER TABLE projects ADD COLUMN odoo_project_name TEXT' },
    { table: 'projects', col: 'service_respondent_name', sql: 'ALTER TABLE projects ADD COLUMN service_respondent_name TEXT' },
    { table: 'projects', col: 'e2e_disabled', sql: 'ALTER TABLE projects ADD COLUMN e2e_disabled BOOLEAN NOT NULL DEFAULT false' },
    { table: 'wiki_pages', col: 'parent_id', sql: 'ALTER TABLE wiki_pages ADD COLUMN parent_id INTEGER REFERENCES wiki_pages(id) ON DELETE CASCADE' },
    { table: 'wiki_pages', col: 'node_type', sql: "ALTER TABLE wiki_pages ADD COLUMN node_type TEXT NOT NULL DEFAULT 'function'" },
    { table: 'project_chats', col: 'user_id', sql: 'ALTER TABLE project_chats ADD COLUMN user_id INTEGER REFERENCES users(id)' },
    { table: 'project_chats', col: 'last_read_message_id', sql: 'ALTER TABLE project_chats ADD COLUMN last_read_message_id INTEGER NOT NULL DEFAULT 0' },
    { table: 'db_connections', col: 'ssh_key_enc', sql: 'ALTER TABLE db_connections ADD COLUMN ssh_key_enc TEXT' },
    // direct 連線模式（DBeaver 直連 TCP）：不經 SSH，pg 直連
    { table: 'db_connections', col: 'db_host',         sql: 'ALTER TABLE db_connections ADD COLUMN db_host TEXT' },
    { table: 'db_connections', col: 'db_port',         sql: 'ALTER TABLE db_connections ADD COLUMN db_port INTEGER DEFAULT 5432' },
    { table: 'db_connections', col: 'db_password_enc', sql: 'ALTER TABLE db_connections ADD COLUMN db_password_enc TEXT' },
    { table: 'db_connections', col: 'db_ssl',          sql: 'ALTER TABLE db_connections ADD COLUMN db_ssl BOOLEAN DEFAULT false' },
    { table: 'db_connections', col: 'db_engine',       sql: "ALTER TABLE db_connections ADD COLUMN db_engine TEXT DEFAULT 'postgres'" },
    // VPN Gateway：需要 VPN 才能連通的連線，經由 Docker 容器撥號 + TCP 轉發
    { table: 'db_connections', col: 'vpn_enabled',       sql: 'ALTER TABLE db_connections ADD COLUMN vpn_enabled BOOLEAN NOT NULL DEFAULT false' },
    { table: 'db_connections', col: 'vpn_config_enc',    sql: 'ALTER TABLE db_connections ADD COLUMN vpn_config_enc TEXT' },
    { table: 'db_connections', col: 'vpn_username',      sql: 'ALTER TABLE db_connections ADD COLUMN vpn_username TEXT' },
    { table: 'db_connections', col: 'vpn_password_enc',  sql: 'ALTER TABLE db_connections ADD COLUMN vpn_password_enc TEXT' },
    { table: 'db_connections', col: 'vpn_forward_port',  sql: 'ALTER TABLE db_connections ADD COLUMN vpn_forward_port INTEGER' },
    { table: 'db_connections', col: 'vpn_container_name', sql: 'ALTER TABLE db_connections ADD COLUMN vpn_container_name TEXT' },
    { table: 'token_usage', col: 'chat_id', sql: 'ALTER TABLE token_usage ADD COLUMN chat_id INTEGER' },
    { table: 'token_usage', col: 'status',  sql: "ALTER TABLE token_usage ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'" },
    // 每列記錄實際使用的 model（供報表按 model 單價算真實 USD 成本，對齊 ccusage 做法）
    { table: 'token_usage', col: 'model',   sql: 'ALTER TABLE token_usage ADD COLUMN model TEXT' },
    { table: 'tasks', col: 'stage_label',          sql: 'ALTER TABLE tasks ADD COLUMN stage_label TEXT' },
    { table: 'tasks', col: 'classification_label', sql: 'ALTER TABLE tasks ADD COLUMN classification_label TEXT' },
    { table: 'tasks', col: 'has_attachment',       sql: 'ALTER TABLE tasks ADD COLUMN has_attachment BOOLEAN NOT NULL DEFAULT false' },
    { table: 'users', col: 'github_pat_enc', sql: 'ALTER TABLE users ADD COLUMN github_pat_enc TEXT' },
    { table: 'users', col: 'github_login',   sql: 'ALTER TABLE users ADD COLUMN github_login TEXT' },
    { table: 'users', col: 'git_name',       sql: 'ALTER TABLE users ADD COLUMN git_name TEXT' },
    { table: 'users', col: 'git_email',      sql: 'ALTER TABLE users ADD COLUMN git_email TEXT' },
    // 自助註冊審核閘門：DEFAULT true → 既有帳號與所有可信建立路徑（setup/admin）自動核准；
    // 唯一寫 false 的是 /api/auth/register。故新增欄位即回填既有列 true，不需另做 backfill。
    { table: 'users', col: 'approved',       sql: 'ALTER TABLE users ADD COLUMN approved BOOLEAN NOT NULL DEFAULT true' },
    { table: 'task_rejections', col: 'source', sql: "ALTER TABLE task_rejections ADD COLUMN source TEXT NOT NULL DEFAULT 'human'" }
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

  // 追加需求佇列：task_messages.applied_at（NULL＝待吸收進規格，coding／QA 檢查點會撿起）。
  // 務必只在「欄位初次建立」時一次性把既有列回填為 occurred_at（＝視為已處理，不追溯重跑舊任務）；
  // 不可每次啟動都把 NULL 標記掉，否則會把「還沒被吸收的新留言」誤殺成已處理。
  {
    const { rows } = await query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='task_messages' AND column_name='applied_at'`
    );
    if (!rows.length) {
      await query('ALTER TABLE task_messages ADD COLUMN applied_at TIMESTAMPTZ');
      await query('UPDATE task_messages SET applied_at = occurred_at');
    }
  }

  // projects.port 一次性回填：每專案固定分配專屬測試埠（新欄位，既有專案初次皆為 NULL）。
  // 依 id 順序自既有最大埠之上連續配發（首次即 8069 起）；冪等（無 NULL 即跳過）。
  {
    const { rows: nullRows } = await query('SELECT id FROM projects WHERE port IS NULL ORDER BY id');
    if (nullRows.length) {
      const { rows: [mx] } = await query('SELECT MAX(port) AS m FROM projects');
      let next = Math.max(8069, mx && mx.m != null ? mx.m + 1 : 8069);
      for (const r of nullRows) {
        await query('UPDATE projects SET port=$1 WHERE id=$2', [next, r.id]);
        next++;
      }
    }
  }

  // 退場：E2E 改全域固定帳號（e2e-account.js），移除每專案欄位（存在才 drop，冪等）
  for (const col of ['e2e_test_login', 'e2e_test_password_enc']) {
    const { rows } = await query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name=$1`, [col]
    );
    if (rows.length) await query(`ALTER TABLE projects DROP COLUMN ${col}`);
  }

  // One-time backfill：token_usage.project_id 由 tasks 回填（任務被刪前先固化歸因，
  // 否則刪任務／re-sync 會讓專案別 token 報表持續漏計——健檢資料層 P2）。
  // 先用索引探針短路：無 NULL 列就跳過，避免每次啟動都全表 UPDATE（表變大後才有感）
  await query(
    `DO $$
     BEGIN
       IF EXISTS (SELECT 1 FROM token_usage WHERE project_id IS NULL LIMIT 1) THEN
         UPDATE token_usage tu SET project_id = t.project_id
         FROM tasks t
         WHERE tu.project_id IS NULL AND tu.task_id = t.task_id AND t.project_id IS NOT NULL;
       END IF;
     END $$;`
  ).catch(() => {});

  // 主題 E：停止持有使用者可還原密碼——清空既有 users.password_enc（E2E 改用每專案專用測試帳號）。
  // 索引探針短路：無非 NULL 列就跳過，避免每次啟動空跑 UPDATE。
  await query(
    `DO $$
     BEGIN
       IF EXISTS (SELECT 1 FROM users WHERE password_enc IS NOT NULL LIMIT 1) THEN
         UPDATE users SET password_enc = NULL WHERE password_enc IS NOT NULL;
       END IF;
     END $$;`
  ).catch(() => {});

  // One-time status migration: pipeline 改版移除的狀態 → stopped（冪等，只影響殘留舊任務）
  await query(
    `UPDATE tasks SET status='stopped',
       blocker_content = COALESCE(blocker_content, '流程改版，請人工重新確認')
     WHERE status IN ('final_pending','deploy_pending','deploy_fixing','deploy_ready')`
  ).catch(() => {});

  // Unique indexes (idempotent via IF NOT EXISTS)
  await query('CREATE UNIQUE INDEX IF NOT EXISTS project_repos_project_label_idx ON project_repos (project_id, label)').catch(() => {});
  // 專案專屬測試埠不得重複：並行建立撞同埠時由 DB 擋下，呼叫端重取（見 port-alloc.js）
  await query('CREATE UNIQUE INDEX IF NOT EXISTS projects_port_idx ON projects (port)').catch(() => {});

  // 執行歷程：依 task_id 取全部事件、以 id 排序回放
  await query('CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events (task_id, id)').catch(() => {});

  // token_usage indexes
  await query('CREATE INDEX IF NOT EXISTS idx_tu_recorded_at ON token_usage (recorded_at DESC)').catch(() => {});
  await query('CREATE INDEX IF NOT EXISTS idx_tu_task_id     ON token_usage (task_id)').catch(() => {});
  await query('CREATE INDEX IF NOT EXISTS idx_tu_user_id     ON token_usage (user_id)').catch(() => {});
  await query('CREATE INDEX IF NOT EXISTS idx_tu_project_id  ON token_usage (project_id)').catch(() => {});

  // task_rejections / rejection_items（退回原因表）
  await query('CREATE INDEX IF NOT EXISTS idx_rej_status     ON task_rejections (status)').catch(() => {});
  await query('CREATE INDEX IF NOT EXISTS idx_rej_project    ON task_rejections (project_id)').catch(() => {});
  await query('CREATE INDEX IF NOT EXISTS idx_rej_items_rid  ON rejection_items (rejection_id)').catch(() => {});

  // wiki_drift（wiki 頁與程式碼漂移回報表）
  await query('CREATE INDEX IF NOT EXISTS idx_wdrift_status  ON wiki_drift (status)').catch(() => {});
  await query('CREATE INDEX IF NOT EXISTS idx_wdrift_project ON wiki_drift (project_id)').catch(() => {});

  // classify_samples：依時間看近期案例、聚合高頻 pattern
  await query('CREATE INDEX IF NOT EXISTS idx_cs_recorded_at ON classify_samples (recorded_at DESC)').catch(() => {});

  // task_messages（外部溝通紀錄）：依 task_id 排序讀取；external_id 供增量同步 dedup（同一任務同一
  // Odoo message 只存一筆，manual 留言 external_id 為 NULL 不受此限制，可有多筆）
  await query('CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages (task_id, occurred_at)').catch(() => {});
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS task_messages_task_external_uq
               ON task_messages (task_id, external_id) WHERE external_id IS NOT NULL`).catch(() => {});

  // task_attachments：依 task_id／message_id 查詢附件清單
  await query('CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments (task_id)').catch(() => {});
  await query('CREATE INDEX IF NOT EXISTS idx_task_attachments_message ON task_attachments (message_id)').catch(() => {});

  // health_check_runs / health_check_findings（工作流程健檢）
  await query('CREATE INDEX IF NOT EXISTS idx_hcf_run ON health_check_findings (run_id)').catch(() => {});

  // wiki_pages indexes
  await query('CREATE INDEX IF NOT EXISTS idx_wiki_parent ON wiki_pages (parent_id)').catch(() => {});
  await query('CREATE INDEX IF NOT EXISTS idx_wiki_project ON wiki_pages (project_id)').catch(() => {});

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

  // One-time normalization: 舊專案的 project-notes 頁都寫著出廠樣板文字（非空），會被 getProjectNotes
  // 誤判「有內容」而注入無意義樣板到各關卡 prompt。樣板由 _ensureNode verbatim 寫入，故以精確比對命中、
  // 清成空字串；使用者已改的內容不相等→保留。idempotent（清成空後不再命中）。
  try {
    await query(
      `UPDATE wiki_pages SET content = ''
       WHERE node_type = 'notes' AND content = $1`,
      ['# 專案備註\n\n在此記錄專案注意事項、部署環境、聯絡窗口等人工維護的資訊。']
    );
  } catch { /* non-blocking */ }
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
