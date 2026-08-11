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
 * 在單一連線上跑一個真交易。
 *
 * **不要用 `query('BEGIN')`。** `query` 是 `pool.query` 的薄包裝，每次呼叫都可能拿到
 * 池子裡不同的連線——`BEGIN` 落在連線 A、各個 `DELETE` 落在 B/C/D、`COMMIT` 落在 E，
 * 於是每個語句各自 autocommit（根本沒有交易），而那個 `BEGIN` 還會讓連線 A 帶著一個
 * 開啟中的交易被還回池子，污染之後拿到 A 的無關查詢。
 *
 * fn 收到專屬 client，交易內的每一條語句都必須用 `client.query`（用 `query` 就跑到池外了）。
 *
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>} fn 的回傳值（COMMIT 成功後）
 * @template T
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // ROLLBACK 本身失敗（連線已斷等）不該蓋掉真正的病因——往外丟的一律是原始錯誤。
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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

    // 收件匣：「發生過什麼」的事件流，與導覽列「輪到你」badge（當前狀態快照）互補。
    // 不複用 task_events／task_logs：前者存整段終端串流，一輪 coding 就數十到數百筆，全推進來
    // 等於沒有收件匣；後者承載對話內容，粒度同樣不對。
    // kind：'action'＝停在需人處理的閘門（要你動手）／'bounce'＝被退回重做（資訊性，看鬼打牆）
    //
    // ⚠ 這張表的兩個 FK 刻意帶 ON DELETE CASCADE，與本檔其他表不同。其他表靠呼叫端逐表手動
    // DELETE（admin-routes 刪使用者、project-routes 刪專案、tasks-routes 刪單張任務三處各一份
    // 清單，project-routes:494 的註解就是為了「DELETE FROM tasks 撞 FK」而寫的）。收件匣是純附屬
    // 資料、沒有獨立生命週期（任務沒了那則「這張任務等你處理」也就沒有意義），走 CASCADE 才不必
    // 在三份清單各補一行——漏補任何一處的症狀是「刪任務／刪專案／刪使用者直接失敗」。
    `CREATE TABLE IF NOT EXISTS user_inbox (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,
      status        TEXT,
      summary       TEXT,
      read_at       TIMESTAMPTZ,
      snoozed_until TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
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

    // 每人各自一份的「我的最愛」專案（專案列表置頂用）。無 project_members 表、專案共享是既有設計，
    // 故最愛只能是 per-user；複合主鍵即天然去重、同一人同一專案不會重複收藏。
    `CREATE TABLE IF NOT EXISTS project_favorites (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, project_id)
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

    // 「單一派工者」值班牌（見 dispatch-lease.js）：只會有 id=1 這一列。
    // 跨行程互斥必須放 DB——runner.js 的 _inFlight 只是行程內記憶體，兩個行程各記各的。
    `CREATE TABLE IF NOT EXISTS dispatcher_lease (
      id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      holder     TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
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
      sso_secret TEXT,
      e2e_password TEXT,
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
      applied_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // embedding_chunks：wiki 頁與任務規格切塊後的向量索引（語意檢索用）。
    // 刻意不用 pgvector：Windows 軌以 winget 裝 EDB PostgreSQL，pgvector 沒有能寫進 install.ps1
    // 的一鍵路徑，容器軌卻 apt 一行搞定——兩軌做法不同且只有一軌會壞，是最難查的那類 bug。
    // 資料量也用不到它：檢索一律 WHERE project_id=$1，單專案候選集是數十到數百個 chunk，
    // 純 JS cosine 是微秒級。
    //
    // 兩個 nullable FK 而非泛型 source_type+source_id：這樣 CASCADE 會自動清孤兒。用泛型就得
    // 自己寫清理，而刪除路徑散在三份手動清單裡（見上方 user_inbox 的註解），一定會漏。
    // vector 存 base64 TEXT 而非 BYTEA：BYTEA 的 Buffer 往返在 pg-mem 下不保證一致，代價只是
    // 33% 空間。model_id 是模型指紋，查詢必須過濾它——不同模型的座標系混著算，結果是垃圾且不報錯。
    // source_hash 比對來源內容而非 updated_at：後者會因無關欄位變動而更新，造成無謂重算。
    //
    // ⚠ 增量重算一律「先刪該來源全部 chunk 再整批插入」，不能 upsert：本表兩個來源欄位必有一個
    // 是 NULL，而 UNIQUE 對含 NULL 的列不去重（PG 標準行為，實測 pg-mem 一致），約束擋不住重複。
    // 只覆寫不刪的話，內容改短後尾巴的舊 chunk 會永遠留著，讓搜尋撈出已刪掉的內容且不報錯。
    `CREATE TABLE IF NOT EXISTS embedding_chunks (
      id           SERIAL PRIMARY KEY,
      project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      wiki_page_id INTEGER REFERENCES wiki_pages(id) ON DELETE CASCADE,
      task_id      INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      chunk_index  INTEGER NOT NULL DEFAULT 0,
      content      TEXT NOT NULL,
      vector       TEXT NOT NULL,
      model_id     TEXT NOT NULL,
      source_hash  TEXT NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // wiki_search_misses：`/ai/wiki/search` 回 0 筆時記下那次的查詢字串。
    // 「搜不到」本身沒有任何訊號——端點回 200＋空 hits，agent 讀成「wiki 沒有記載」就不再追。
    // 這張表是唯一能事後分辨「關鍵字猜不中」與「wiki 根本沒寫」的依據，也是語意檢索上線後
    // 判斷有沒有變好的對照組來源（wiki_drift 記的是「頁與碼矛盾」，不是這件事，別拿來當替代）。
    // 純觀測資料、無獨立生命週期，故走 CASCADE 而非呼叫端手動清（比照 user_inbox）。
    `CREATE TABLE IF NOT EXISTS wiki_search_misses (
      id          SERIAL PRIMARY KEY,
      project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      q           TEXT NOT NULL,
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

    // 企業版來源：Odoo 企業版只是一包額外的 addons 目錄，故不分 image、只按「大版本」各備一份。
    // odoo_version 存大版本數字字串（'17'）：17 的 enterprise addons 不能給 18 用，一版一列。
    `CREATE TABLE IF NOT EXISTS enterprise_sources (
      odoo_version   TEXT PRIMARY KEY,
      repo_url       TEXT NOT NULL,
      branch         TEXT,
      local_path     TEXT,
      clone_status   TEXT NOT NULL DEFAULT 'pending',   -- pending | syncing | done | error
      error_msg      TEXT,
      last_synced_at TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    // 「上正式」按鈕把 ai-dev 併進 main 並 push 成功的時間。approved_at 只代表併進 ai-dev，
    // 兩者的差集＝待上正式。若改在 GitHub 上手動合併，此欄不會被寫入（已知代價，見設計文件）。
    { table: 'tasks', col: 'merged_to_main_at',    sql: 'ALTER TABLE tasks ADD COLUMN merged_to_main_at TIMESTAMPTZ' },
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
    // 澄清關「更新規格書 QA」產出的題目草案（YAML 片段）：AI 不得直接覆蓋使用者正在看的題目，
    // 先落此欄供前端顯示新舊對照，使用者按套用才寫進 analysis_yaml。
    { table: 'tasks', col: 'clarify_draft',        sql: 'ALTER TABLE tasks ADD COLUMN clarify_draft TEXT' },
    // 澄清關這一輪走哪個入口（answer_or_proceed／ask／revise）：路由寫入、執行器讀取。
    // 不用參數傳遞是因為派工要經 runner 的 _inFlight 互斥，而 runner 的 SELECT 撈不到臨時參數。
    { table: 'tasks', col: 'clarify_mode',         sql: 'ALTER TABLE tasks ADD COLUMN clarify_mode TEXT' },
    // 對話式閘門的 session 續接（spec_review／clarify_pending／cs）：同一場問答續用同一個 claude session，
    // 省掉每輪重新探索程式碼。*_prompt_ver 存 fresh＋retry 兩個 agent 的組合指紋，任一 prompt 變更即強制 fresh。
    // 離開閘門時清空（見 pipeline-routes 核准端點／clarify-chat proceed 分支／cs-agent 進分析分支）。
    { table: 'tasks', col: 'spec_session_id',      sql: 'ALTER TABLE tasks ADD COLUMN spec_session_id TEXT' },
    { table: 'tasks', col: 'spec_prompt_ver',      sql: 'ALTER TABLE tasks ADD COLUMN spec_prompt_ver TEXT' },
    { table: 'tasks', col: 'clarify_session_id',   sql: 'ALTER TABLE tasks ADD COLUMN clarify_session_id TEXT' },
    { table: 'tasks', col: 'clarify_prompt_ver',   sql: 'ALTER TABLE tasks ADD COLUMN clarify_prompt_ver TEXT' },
    // cs 兩條重跑路徑（追問 cs_reply_pending→cs_running、補資料 cs_data_needed→cs_running）都續接：
    // 前一輪已查過正式區 DB／程式碼，無狀態重跑等於整包重查（實測單輪 2.4M cache_read）。
    { table: 'tasks', col: 'cs_session_id',        sql: 'ALTER TABLE tasks ADD COLUMN cs_session_id TEXT' },
    { table: 'tasks', col: 'cs_prompt_ver',        sql: 'ALTER TABLE tasks ADD COLUMN cs_prompt_ver TEXT' },
    // 澄清對話的回程狀態（confirm_pending／clarify_pending）。不能借用 resume_status——
    // 那欄已被 verdict-router／reject-triage 用來記「要回去哪一關」，覆寫會讓 QA 裁決導回 coding 的路徑消失。
    { table: 'tasks', col: 'clarify_from',         sql: 'ALTER TABLE tasks ADD COLUMN clarify_from TEXT' },
    // 分診關（reject_triage／resolve_triage）的「真正原關」。分診走 clarify 問人時，閘門會把
    // resume_status 寫成分診關自己（＝答完的回程），原關若不另存就永久遺失，任務答完會回到分診
    // 自己（死循環）或退化成 coding_running。同 clarify_from 的理由：不可共用 resume_status。
    { table: 'tasks', col: 'triage_home',          sql: 'ALTER TABLE tasks ADD COLUMN triage_home TEXT' },
    // 追加需求檢查點攔截推進時，「原本要去的那一關」。respec 若判定留言不含實質規格變更，
    // 就回這一關繼續，不必退回 coding 讓整條 pipeline 重跑。同 clarify_from／triage_home 的理由：
    // 不可共用 resume_status（那欄已被 verdict-router／reject-triage 佔用）。
    { table: 'tasks', col: 'respec_return_status', sql: 'ALTER TABLE tasks ADD COLUMN respec_return_status TEXT' },
    // 行程身分指紋（Linux /proc starttime；其他平台 NULL）：kill 前核對防 pid 重用誤殺
    { table: 'odoo_envs', col: 'pid_started_at',   sql: 'ALTER TABLE odoo_envs ADD COLUMN pid_started_at TEXT' },
    // 每環境憑證：SSO 密鑰、E2E 隨機密碼（測試區安全 hardening）
    { table: 'odoo_envs', col: 'sso_secret',       sql: 'ALTER TABLE odoo_envs ADD COLUMN sso_secret TEXT' },
    { table: 'odoo_envs', col: 'e2e_password',     sql: 'ALTER TABLE odoo_envs ADD COLUMN e2e_password TEXT' },
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
    // Claude 專屬長效憑證（claude setup-token 產生，綁訂閱、效期一年）：加密存放，
    // 由 lib/claude-auth 解密後注入每個 claude 子行程的 CLAUDE_CODE_OAUTH_TOKEN，
    // 取代共用互動式憑證檔（併發 spawn 撞刷新會印 Not logged in）
    { table: 'teams_settings', col: 'claude_oauth_token_enc', sql: 'ALTER TABLE teams_settings ADD COLUMN claude_oauth_token_enc TEXT' },
    { table: 'tasks', col: 'is_paused',  sql: 'ALTER TABLE tasks ADD COLUMN is_paused BOOLEAN NOT NULL DEFAULT false' },
    { table: 'tasks', col: 'is_hidden',  sql: 'ALTER TABLE tasks ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT false' },
    { table: 'project_repos', col: 'clone_status',    sql: 'ALTER TABLE project_repos ADD COLUMN clone_status TEXT' },
    { table: 'project_repos', col: 'clone_error',     sql: 'ALTER TABLE project_repos ADD COLUMN clone_error TEXT' },
    { table: 'project_repos', col: 'graphify_status', sql: "ALTER TABLE project_repos ADD COLUMN graphify_status TEXT DEFAULT 'idle'" },
    { table: 'project_repos', col: 'graphify_error',  sql: 'ALTER TABLE project_repos ADD COLUMN graphify_error TEXT' },
    // 主分支覆寫：NULL＝依 origin/HEAD 自動偵測（多數情況）。填值時以 git remote set-head 落到該
    // clone 的 origin/HEAD，getMainBranch 便自動吃到——DB 這欄只是 reclone 後要重新套用的真相來源。
    { table: 'project_repos', col: 'base_branch',     sql: 'ALTER TABLE project_repos ADD COLUMN base_branch TEXT' },
    // 這個 repo 實際落在哪條遠端 AI 分支。由 ensureAiBranch 決定後回寫（見 project-routes 的
    // recordRemoteAiBranch）——撞名守衛只能比對這個，不能拿 base_branch 現算：base_branch 為 null
    // 時執行期會用偵測到的主分支，兩者算出來的名字不一樣，守衛因此放行真正會互相覆蓋的組合。
    { table: 'project_repos', col: 'remote_ai_branch', sql: 'ALTER TABLE project_repos ADD COLUMN remote_ai_branch TEXT' },
    { table: 'projects', col: 'port', sql: 'ALTER TABLE projects ADD COLUMN port INTEGER' },
    { table: 'projects', col: 'odoo_project_name',      sql: 'ALTER TABLE projects ADD COLUMN odoo_project_name TEXT' },
    { table: 'projects', col: 'service_respondent_name', sql: 'ALTER TABLE projects ADD COLUMN service_respondent_name TEXT' },
    { table: 'projects', col: 'e2e_disabled', sql: 'ALTER TABLE projects ADD COLUMN e2e_disabled BOOLEAN NOT NULL DEFAULT false' },
    // ⚠ 已退役（2026-08-11）：已併入 e2e_disabled，程式各處不再讀寫。欄位保留是因為本框架
    // 只有 add-if-missing、沒有 drop column（rules/db-schema 41）——別再新增讀取它的程式碼。
    // 退役理由：它與 e2e_disabled 兩個獨立旗標有四種組合，其中「出考題但沒人考」實測讓鴻久
    // 每張任務固定燒滿一個逾時去寫一份永遠不會被執行的 tour。合併後那個狀態無法表達。
    { table: 'projects', col: 'spec_tour_enabled', sql: 'ALTER TABLE projects ADD COLUMN spec_tour_enabled BOOLEAN NOT NULL DEFAULT false' },
    // 分析關的 session：供續寫 tour 時 --resume（比照 spec_session_id 的用法）。
    { table: 'tasks', col: 'analysis_session_id', sql: 'ALTER TABLE tasks ADD COLUMN analysis_session_id TEXT' },
    { table: 'tasks', col: 'analysis_prompt_ver', sql: 'ALTER TABLE tasks ADD COLUMN analysis_prompt_ver TEXT' },
    { table: 'wiki_pages', col: 'parent_id', sql: 'ALTER TABLE wiki_pages ADD COLUMN parent_id INTEGER REFERENCES wiki_pages(id) ON DELETE CASCADE' },
    { table: 'wiki_pages', col: 'node_type', sql: "ALTER TABLE wiki_pages ADD COLUMN node_type TEXT NOT NULL DEFAULT 'function'" },
    // description：一行摘要，隨頁面清單一起回給 agent，讓它「看目錄就能判斷該不該打開這一頁」。
    // 舊行為只回 title，agent 只能靠標題猜哪頁相關——wiki 一多就必漏（而且漏了沒有任何訊號，
    // 端點回 200＋空結果，agent 會當成「這專案沒有相關記載」）。
    { table: 'wiki_pages', col: 'description', sql: 'ALTER TABLE wiki_pages ADD COLUMN description TEXT' },
    { table: 'project_chats', col: 'user_id', sql: 'ALTER TABLE project_chats ADD COLUMN user_id INTEGER REFERENCES users(id)' },
    { table: 'project_chats', col: 'last_read_message_id', sql: 'ALTER TABLE project_chats ADD COLUMN last_read_message_id INTEGER NOT NULL DEFAULT 0' },
    // 回覆進行中旗標：前端據此顯示持續動畫（server 狀態，離開對話再回來仍在）。唯一寫 true 的地方是
    // chatReply 開始跑 claude 前；成功／失敗／崩潰都會被清回 false（finally 或啟動時 recoverInterruptedChats）。
    { table: 'project_chats', col: 'reply_pending', sql: 'ALTER TABLE project_chats ADD COLUMN reply_pending BOOLEAN NOT NULL DEFAULT false' },
    // chat 的 session 續接（with-resume）：續接輪不必重查上一輪已經查過的 code／DB／log。
    // chat 的成本 98.8% 在 agentic 調查迴圈（prompt 只佔 0.9%），而無狀態讓同一個問題被反覆
    // 完整調查——實測一場九輪對話裡 AI 四次自我推翻，就是因為原始證據沒留在 context 裡。
    // prompt_ver 用來擋「agent prompt 改過卻續用舊 session」（見 with-resume.js 的護欄）。
    { table: 'project_chats', col: 'chat_session_id', sql: 'ALTER TABLE project_chats ADD COLUMN chat_session_id TEXT' },
    { table: 'project_chats', col: 'chat_prompt_ver', sql: 'ALTER TABLE project_chats ADD COLUMN chat_prompt_ver TEXT' },
    // 最後一次由這場對話轉出的 tasks.id（數字主鍵，非 task_id 文字欄）——對話列據此顯示「已轉任務」。
    // 刻意不宣告 FK：比照 token_usage.chat_id 的既有寫法，且帶 FK 卻漏 ON DELETE SET NULL 會反過來
    // 擋死刪任務。殘留的死 id 由列表 SQL 的 LEFT JOIN tasks 吸收（任務不在就回 null，徽章自動消失）。
    { table: 'project_chats', col: 'converted_task_id', sql: 'ALTER TABLE project_chats ADD COLUMN converted_task_id INTEGER' },
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
    // VPN 憑證上移專案層：一個專案＝一個客戶站點＝一組 VPN，同專案所有連線共用一條隧道。
    // db_connections 的同名欄位自此為死欄（不清空、不 drop，留作遷移出錯時的回頭路）。
    { table: 'projects', col: 'vpn_config_enc',   sql: 'ALTER TABLE projects ADD COLUMN vpn_config_enc TEXT' },
    { table: 'projects', col: 'vpn_username',     sql: 'ALTER TABLE projects ADD COLUMN vpn_username TEXT' },
    { table: 'projects', col: 'vpn_password_enc', sql: 'ALTER TABLE projects ADD COLUMN vpn_password_enc TEXT' },
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
    { table: 'task_rejections', col: 'source', sql: "ALTER TABLE task_rejections ADD COLUMN source TEXT NOT NULL DEFAULT 'human'" },
    { table: 'wiki_drift', col: 'applied_at', sql: 'ALTER TABLE wiki_drift ADD COLUMN applied_at TIMESTAMPTZ' },
    // port 租約制：閒置判定用（由 cron 解析容器 log 更新）
    { table: 'odoo_envs', col: 'last_active_at', sql: 'ALTER TABLE odoo_envs ADD COLUMN last_active_at TIMESTAMPTZ' },
    // 對外子網域名額（0..count-1）。刻意獨立於 port：port 是 pipeline 也在佔的內部資源，
    // 由 port 推導對外網址等於「只要有環境在跑就佔一個對外名額」，正是本次要消除的問題。
    { table: 'odoo_envs', col: 'external_slot', sql: 'ALTER TABLE odoo_envs ADD COLUMN external_slot INTEGER' },
    // 本次啟動時刻（壽命上限判定用）。不能拿 created_at 代替：odoo_envs 是 UNIQUE(project_id)，
    // 一個專案永遠只有一列，停機只改 status、重啟走 ON CONFLICT DO UPDATE，created_at 自始至終
    // 是「這專案第一次建環境」的時間。用它判壽命，會讓建立逾 8 小時的專案每次一開機就被下一輪
    // sweep 收掉（實測真人操作 3~7 分鐘即中斷），且只打真人——pipeline 有 deploy/E2E 任務擋著。
    { table: 'odoo_envs', col: 'started_at', sql: 'ALTER TABLE odoo_envs ADD COLUMN started_at TIMESTAMPTZ' },
    // 測試區 port 池範圍（管理員介面可設；NULL＝退回 env／預設值，既有部署行為不變）
    { table: 'teams_settings', col: 'port_pool_min', sql: 'ALTER TABLE teams_settings ADD COLUMN port_pool_min INTEGER' },
    { table: 'teams_settings', col: 'port_pool_max', sql: 'ALTER TABLE teams_settings ADD COLUMN port_pool_max INTEGER' },
    // 企業版：預設 community，既有專案升級後行為不變（不會突然要求 enterprise 來源）
    { table: 'projects', col: 'edition', sql: "ALTER TABLE projects ADD COLUMN edition TEXT NOT NULL DEFAULT 'community'" }
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

  // （原 projects.port 一次性回填已移除：埠改為租約制，載體是 odoo_envs.port；
  //   projects.port 欄位因 db.js 無 drop column 機制而保留，但不再讀寫。）

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

  // Backfill：專案備註（project-notes）補建。這個保留節點是後來才加進 initProjectWiki 的，
  // 既有專案不會回頭補；而 UI 的「新增頁面」端點不收 node_type（一律建成 'function'），
  // 使用者**沒有任何途徑**能自己建出這一頁——症狀是「wiki 裡就是沒有專案備註」，
  // 而那頁的內容本該被注入各開發關卡（實測鴻久 25 頁裡沒有，備註功能等同不存在）。
  // 只補「已經有 wiki 的專案」：一頁都沒有的專案還沒初始化，交給 initProjectWiki 建才有正確骨架。
  // 冪等：第二次跑時該 project_id 已在排除子查詢裡。NOT IN 而非相關子查詢是 pg-mem 相容需求，
  // 子查詢的 IS NOT NULL 不可省——真 PG 裡清單含一個 NULL 會讓整個條件恆為 UNKNOWN、靜默全失效。
  await query(
    `INSERT INTO wiki_pages (project_id, node_type, slug, title, content)
     SELECT DISTINCT project_id, 'notes', 'project-notes', '專案備註', ''
       FROM wiki_pages
      WHERE project_id IS NOT NULL
        AND project_id NOT IN (
          SELECT project_id FROM wiki_pages WHERE slug='project-notes' AND project_id IS NOT NULL
        )
     ON CONFLICT (project_id, slug) DO NOTHING`
  ).catch(() => {});

  // One-time status migration: pipeline 改版移除的狀態 → stopped（冪等，只影響殘留舊任務）
  await query(
    `UPDATE tasks SET status='stopped',
       blocker_content = COALESCE(blocker_content, '流程改版，請人工重新確認')
     WHERE status IN ('final_pending','deploy_pending','deploy_fixing','deploy_ready')`
  ).catch(() => {});

  // VPN 憑證上移專案層（同專案共用一條隧道）。獨立模組，見 lib/vpn-migrate.js 的註解。
  // 這是迴圈跑多筆 UPDATE、沒包交易，中途失敗可能半套（部分連線埠改到 22000 系列、部分留在
  // 舊值）——不能吞得無聲無息，至少要印出來讓人知道要去查；遷移失敗不該擋住整個 server 起動，故不 throw。
  await require('./lib/vpn-migrate').migrateVpnToProjects(query).catch(e => console.error('[vpn-migrate]', e.message));

  // started_at 上線前就在跑的環境沒有本次啟動時刻，留 NULL 會讓壽命判定 fallback 回 created_at
  // （＝首次建環境的時間）而在下一輪 sweep 被誤收。updated_at 在轉 running 時剛被設過，是現有
  // 資料裡最接近啟動時刻的值。idempotent：只補 NULL，跑幾次都一樣。
  // 靜默吞掉等於「壽命判定會誤收環境」這個病因永遠查不出來（沒補到值與沒跑過長得一模一樣）；
  // 但它只是補值，失敗不該擋住 server 起動，故比照上面的 vpn-migrate 只印不 throw。
  await query("UPDATE odoo_envs SET started_at=updated_at WHERE status='running' AND started_at IS NULL")
    .catch(e => console.error('[migrate] odoo_envs.started_at 補值失敗：', e.message));

  // Unique indexes (idempotent via IF NOT EXISTS)
  await query('CREATE UNIQUE INDEX IF NOT EXISTS project_repos_project_label_idx ON project_repos (project_id, label)').catch(() => {});
  // port 改為租約制（借還於 odoo_envs.port）後，projects.port 不再配發，其 UNIQUE 必須移除，
  // 否則舊資料殘留的埠會擋住新專案建立。欄位本身保留（db.js 無 drop column 機制，同 odoo_envs.pid 處境）。
  await query('DROP INDEX IF EXISTS projects_port_idx').catch(() => {});
  // 租約併發保護：兩個 setup 同時選到同埠時由 DB 擋下第二個，呼叫端重取（見 port-alloc.js leasePort）。
  // 必須是 partial——未租用的列 port 為 NULL 且可有多筆。
  await query('CREATE UNIQUE INDEX IF NOT EXISTS odoo_envs_port_idx ON odoo_envs (port) WHERE port IS NOT NULL').catch(() => {});
  // 對外名額併發保護：兩人同時開不同專案的測試區時由 DB 擋下第二個，呼叫端換下一個 slot
  // （見 lib/external-slot.js acquireExternalSlot）。必須是 partial——未曝露的列為 NULL 且可有多筆。
  await query('CREATE UNIQUE INDEX IF NOT EXISTS odoo_envs_extslot_idx ON odoo_envs (external_slot) WHERE external_slot IS NOT NULL').catch(() => {});

  // 執行歷程：依 task_id 取全部事件、以 id 排序回放
  await query('CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events (task_id, id)').catch(() => {});

  // 收件匣：查詢一律帶 user_id ＋未讀條件，再依時間新到舊排
  await query('CREATE INDEX IF NOT EXISTS idx_inbox_user ON user_inbox (user_id, read_at, created_at DESC)').catch(() => {});

  // 搜不到的查詢：一律「某專案最近一段時間」的撈法（效果驗收用）
  await query('CREATE INDEX IF NOT EXISTS idx_wiki_miss_project ON wiki_search_misses (project_id, created_at DESC)').catch(() => {});

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

  // embedding_chunks：三個 FK 全帶 CASCADE，沒有索引的話刪一頁 wiki／一張任務／一個專案都要
  // 全表掃描這張表（它是全庫最會長的表之一：每頁數塊、每張任務數塊）。增量索引的先刪後插、
  // isUnchanged 的比對也都以來源欄位為鍵；載入快取則一律 WHERE model_id=$1。
  await query('CREATE INDEX IF NOT EXISTS idx_embchunk_wiki    ON embedding_chunks (wiki_page_id)').catch(() => {});
  await query('CREATE INDEX IF NOT EXISTS idx_embchunk_task    ON embedding_chunks (task_id)').catch(() => {});
  await query('CREATE INDEX IF NOT EXISTS idx_embchunk_project ON embedding_chunks (project_id, model_id)').catch(() => {});
  // 同一來源的同一個 chunk_index 只能有一列。必須是 partial：兩個來源欄位必有一個是 NULL，
  // 而 UNIQUE 對含 NULL 的列不去重（PG 標準行為），不加 WHERE 的話這個約束等於不存在——
  // 那正是「並行 enqueue 同一頁 → 整頁的塊重複兩份」擋不住的原因（交易只擋得住半套，擋不住重複）。
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS embedding_chunks_wiki_uq
               ON embedding_chunks (wiki_page_id, chunk_index) WHERE wiki_page_id IS NOT NULL`).catch(() => {});
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS embedding_chunks_task_uq
               ON embedding_chunks (task_id, chunk_index) WHERE task_id IS NOT NULL`).catch(() => {});

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

module.exports = { getPool, migrate, query, withTransaction, _setPoolForTesting };
