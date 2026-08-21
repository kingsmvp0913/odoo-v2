const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { query, withTransaction } = require('./db');
const { deleteTaskDir } = require('./lib/attachments');
const { hashPassword } = require('./password');
const { encrypt } = require('./lib/crypto');
const { verifyToken } = require('./auth');
const { shadowingEnvVar, resetClaudeTokenCache } = require('./lib/claude-auth');
const { resetContext7KeyCache } = require('./lib/context7-auth');
const { looksLikeAuthFailure } = require('./pipeline/auth-signature');
const { runClaude } = require('./pipeline/claude-runner');
const { listAgents, loadAgent, updateAgent, getLabels } = require('./pipeline/agent-loader');
const { getInflightInfo, abortTask } = require('./pipeline/runner');
const { runTaskHealthCheck, runAudit, auditWindowStart } = require('./pipeline/health-check-runner');
const { runFix, adoptFix, pushFix, discardFix, applyFix } = require('./pipeline/finding-fix');
const { getHealthCheckSchedule } = require('./cron');

function getSshPubKey() {
  const sshDir = path.join(os.homedir(), '.ssh');
  for (const name of ['id_ed25519.pub', 'id_rsa.pub', 'id_ecdsa.pub']) {
    const p = path.join(sshDir, name);
    if (fs.existsSync(p)) return { key: fs.readFileSync(p, 'utf8').trim(), type: name.replace('.pub', '') };
  }
  return null;
}

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!rows.length || rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function registerRoutes(app) {
  const auth = [verifyToken, requireAdmin];

  // --- Claude 長效憑證（全平台一把）---
  // 由 claude setup-token 產生，取代共用的互動式憑證檔（併發 spawn 撞刷新會印 Not logged in）。
  // 走專屬端點而非 teams-settings 的全量 upsert：那支 PUT 漏帶欄位就清空，且沒有自然的驗證時機。

  app.get('/api/admin/claude-token', auth, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT claude_oauth_token_enc, claude_oauth_token_backup_enc, usage_gate_fallback_enabled
         FROM teams_settings WHERE id = 1`
      );
      // 只回布林：token 不論明文密文都不得回流前端。兩把憑證與備援開關一次回齊，前端只打一支。
      res.json({
        configured: !!rows[0]?.claude_oauth_token_enc,
        backup_configured: !!rows[0]?.claude_oauth_token_backup_enc,
        fallback_enabled: !!rows[0]?.usage_gate_fallback_enabled,
        shadowed_by: shadowingEnvVar()
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 主／備兩把憑證的存放欄位。備用憑證是「另一份訂閱」，主帳號撞用量閘門時由 usage-gate 切過去用。
  const TOKEN_COLS = { primary: 'claude_oauth_token_enc', backup: 'claude_oauth_token_backup_enc' };

  async function saveClaudeToken(col, token, res) {
    if (!token) return res.status(400).json({ error: '請貼上 Claude token' });
    if (!process.env.APP_SECRET) return res.status(500).json({ error: '伺服器未設定 APP_SECRET，無法安全存放 token' });
    // 先驗證再存（比照 GitHub PAT）：貼錯或過期當場擋下，不必等下一張任務炸掉。
    // 驗證必須用「候選 token」而非快取裡的舊值，否則換帳號等於沒驗——env 在 runner 內排最後，會覆蓋快取值。
    let warning = null;
    try {
      await runClaude('回覆 ok', { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, timeoutMs: 60000 });
    } catch (err) {
      if (err.claudeStatus === 'auth' || looksLikeAuthFailure(err.message)) {
        return res.status(400).json({ error: 'token 無效或已過期，未儲存' });
      }
      // 非認證失敗（API 過載、網路抖動）仍然存：換 token 的時機往往正是服務不穩的時候，
      // 因為一次 529 就把管理員鎖在外面才是更糟的失敗模式。據實回報沒驗成功。
      warning = `已儲存，但驗證未能完成：${err.message}`;
    }
    try {
      await query(
        `INSERT INTO teams_settings (id, ${col}, updated_at) VALUES (1, $1, NOW())
         ON CONFLICT (id) DO UPDATE SET ${col} = $1, updated_at = NOW()`,
        [encrypt(token)]
      );
      await resetClaudeTokenCache(); // 下一個 spawn 即生效，不必重啟 server
      res.json(warning ? { ok: true, warning } : { ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }

  async function clearClaudeToken(col, res) {
    try {
      await query(`UPDATE teams_settings SET ${col} = NULL, updated_at = NOW() WHERE id = 1`);
      await resetClaudeTokenCache(); // 主憑證清掉即退回本機憑證檔行為
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }

  app.post('/api/admin/claude-token', auth, (req, res) =>
    saveClaudeToken(TOKEN_COLS.primary, String(req.body?.token || '').trim(), res));

  app.post('/api/admin/claude-token/backup', auth, (req, res) =>
    saveClaudeToken(TOKEN_COLS.backup, String(req.body?.token || '').trim(), res));

  app.delete('/api/admin/claude-token', auth, (req, res) => clearClaudeToken(TOKEN_COLS.primary, res));

  app.delete('/api/admin/claude-token/backup', auth, (req, res) => clearClaudeToken(TOKEN_COLS.backup, res));

  // 備援總開關。關閉（預設）時主帳號撞門檻就暫停推進，與備用憑證存不存在無關——
  // 管理員要能在不刪掉憑證的前提下停用第二份訂閱。
  app.put('/api/admin/claude-fallback', auth, async (req, res) => {
    const enabled = !!req.body?.enabled;
    try {
      await query(
        `INSERT INTO teams_settings (id, usage_gate_fallback_enabled, updated_at) VALUES (1, $1, NOW())
         ON CONFLICT (id) DO UPDATE SET usage_gate_fallback_enabled = $1, updated_at = NOW()`,
        [enabled]
      );
      res.json({ ok: true, enabled });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- context7 API key（全平台一把）---
  // 未設定時走匿名額度，配額用盡不會報錯、只會讓各關靜默改用 WebSearch 抓 Odoo 原始碼
  //（見 lib/context7-auth 的說明）。同樣走專屬端點而非 teams-settings 的全量 upsert。

  app.get('/api/admin/context7-key', auth, async (req, res) => {
    try {
      const { rows } = await query('SELECT context7_api_key_enc FROM teams_settings WHERE id = 1');
      // 只回布林：key 不論明文密文都不得回流前端
      res.json({ configured: !!rows[0]?.context7_api_key_enc });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/context7-key', auth, async (req, res) => {
    const key = String(req.body?.key || '').trim();
    if (!key) return res.status(400).json({ error: '請貼上 context7 API key' });
    if (!process.env.APP_SECRET) return res.status(500).json({ error: '伺服器未設定 APP_SECRET，無法安全存放 key' });
    // 先驗證再存（比照 Claude token）：貼錯當場擋下，不必等下一張任務靜默退回匿名額度。
    // 打的是 MCP server 自己會打的那支搜尋端點（dist/lib/api.js），認證同為 Bearer。
    let warning = null;
    try {
      const r = await fetch('https://context7.com/api/v2/libs/search?query=odoo', {
        headers: { Authorization: `Bearer ${key}`, 'X-Context7-Source': 'mcp-server' },
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 401 || r.status === 403) return res.status(400).json({ error: 'key 無效或已被停用，未儲存' });
      if (!r.ok) warning = `已儲存，但驗證未能完成：context7 回 ${r.status}`;
    } catch (err) {
      // 網路不通／逾時仍然存：換 key 的時機往往正是服務不穩的時候，把管理員鎖在外面是更糟的失敗模式
      warning = `已儲存，但驗證未能完成：${err.message}`;
    }
    try {
      await query(
        `INSERT INTO teams_settings (id, context7_api_key_enc, updated_at) VALUES (1, $1, NOW())
         ON CONFLICT (id) DO UPDATE SET context7_api_key_enc = $1, updated_at = NOW()`,
        [encrypt(key)]
      );
      await resetContext7KeyCache(); // 下一個 spawn 重寫 MCP 設定檔即生效，不必重啟 server
      res.json(warning ? { ok: true, warning } : { ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/admin/context7-key', auth, async (req, res) => {
    try {
      await query('UPDATE teams_settings SET context7_api_key_enc = NULL, updated_at = NOW() WHERE id = 1');
      await resetContext7KeyCache(); // 退回匿名額度
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Prompt 送出記錄（最近 N 筆送給 Claude 的完整 prompt）---

  app.get('/api/admin/prompt-logs', auth, async (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const { rows } = await query(
        `SELECT id, agent_type, model, task_id, prompt, char_len, created_at
           FROM prompt_logs ORDER BY id DESC LIMIT $1`,
        [limit]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Token 原始四欄拆解（判斷成本是「讀取快取」還是「寫入快取」）---
  // token-report 只吐加權後的合計，看不出 cache 是命中還是重寫——但兩者差 12.5 倍
  //（cache_read 0.1×／cache_create 1.25× input 單價），是決定「要不要把更多內容塞進 prompt」
  // 的唯一依據。沒有這支端點就只能從 total 與加權值反推，而反推需要對 output 佔比做假設。
  app.get('/api/admin/token-breakdown', auth, async (req, res) => {
    try {
      const start = req.query.start ? new Date(req.query.start) : new Date(Date.now() - 7 * 86400000);
      // 日界：date-only 補到當日結束，否則查當天會拿到空的
      const end = req.query.end
        ? new Date(/T/.test(req.query.end) ? req.query.end : req.query.end + 'T23:59:59.999Z')
        : new Date();
      const params = [start, end];
      let where = 'WHERE recorded_at >= $1 AND recorded_at <= $2';
      if (req.query.agent_type) { params.push(req.query.agent_type); where += ` AND agent_type = $${params.length}`; }
      const { rows } = await query(
        `SELECT agent_type,
                COUNT(*)                        AS calls,
                SUM(input_tokens)               AS input_tokens,
                SUM(output_tokens)              AS output_tokens,
                SUM(cache_read_tokens)          AS cache_read_tokens,
                SUM(cache_create_tokens)        AS cache_create_tokens
           FROM token_usage ${where}
          GROUP BY agent_type
          ORDER BY SUM(cache_create_tokens) DESC`,
        params
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- odoo_version_configs ---

  app.get('/api/admin/version-configs', auth, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM odoo_version_configs ORDER BY odoo_version ASC');
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/version-configs', auth, async (req, res) => {
    try {
      const { odoo_version, python_bin, venv_base_path, odoo_bin_path, notes } = req.body;
      if (!odoo_version || !python_bin) return res.status(400).json({ error: 'odoo_version and python_bin required' });
      const { rows } = await query(
        `INSERT INTO odoo_version_configs (odoo_version, python_bin, venv_base_path, odoo_bin_path, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [odoo_version, python_bin, venv_base_path || null, odoo_bin_path || null, notes || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'odoo_version already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/version-configs/:id', auth, async (req, res) => {
    try {
      const { python_bin, venv_base_path, odoo_bin_path, notes } = req.body;
      const { rows } = await query(
        `UPDATE odoo_version_configs SET
           python_bin = COALESCE($2, python_bin),
           venv_base_path = COALESCE($3, venv_base_path),
           odoo_bin_path = COALESCE($4, odoo_bin_path),
           notes = COALESCE($5, notes)
         WHERE id = $1 RETURNING *`,
        [req.params.id, python_bin || null, venv_base_path || null, odoo_bin_path || null, notes || null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/admin/version-configs/:id', auth, async (req, res) => {
    try {
      const { rows } = await query('DELETE FROM odoo_version_configs WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- users ---

  app.get('/api/admin/users', auth, async (req, res) => {
    try {
      const { rows } = await query('SELECT id, username, display_name, role, approved, created_at FROM users ORDER BY id ASC');
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/users', auth, async (req, res) => {
    try {
      const { username, password, display_name, role } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'username and password required' });
      if (password.length < 8) return res.status(400).json({ error: '密碼至少 8 個字元' });
      const password_hash = await hashPassword(password);
      // 不寫 password_enc：那欄是「可用 APP_SECRET 解回明文的登入密碼」，原為 E2E 借用使用者密碼
      // 而存，E2E 改全域測試帳號後已退場——auth.js 的 setup／改密碼／登入都不再寫，db.js 每次
      // 啟動還會把既有值清成 NULL。這裡是最後一條殘留的寫入路徑（寫了下次重啟就沒了，只剩外洩面）。
      // 欄位本身依 db.js 無 drop column 機制的慣例保留。
      const { rows } = await query(
        `INSERT INTO users (username, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4) RETURNING id, username, display_name, role`,
        [username, password_hash, display_name || username, role || 'user']
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '帳號已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/users/:id', auth, async (req, res) => {
    try {
      const { role, display_name, approved } = req.body;
      const { rows } = await query(
        `UPDATE users SET
           role = COALESCE($2, role),
           display_name = COALESCE($3, display_name),
           approved = COALESCE($4, approved)
         WHERE id = $1 RETURNING id, username, display_name, role, approved`,
        [req.params.id, role || null, display_name || null, typeof approved === 'boolean' ? approved : null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/admin/users/:id', auth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (id === req.userId) return res.status(400).json({ error: '不能刪除自己的帳號' });
      // 參照 users(id) 的外鍵多數無 ON DELETE，直接刪 users 會違反 tasks_user_id_fkey 等外鍵，
      // 故先依相依順序清該使用者的關聯資料再刪帳號。token_usage／task_rejections 等已設 ON DELETE SET NULL
      // （保留為跨任務計費／訓練歷史），不在此手動刪。
      // 交易走 withTransaction 取專屬連線：透過共用的 query 包裝下交易指令，會讓開始與提交
      // 落在池子裡不同連線上＝根本沒有交易（詳見 db.js withTransaction 的說明）。
      // 子表刪除用 IN (SELECT ...) 而非 = ANY($1::int[])：後者在 pg-mem 上只要目標欄位有索引
      // 就靜默匹配 0 列，測試會證明不了子列真的被清掉。
      const taskIds = await withTransaction(async (client) => {
        const { rows: taskRows } = await client.query('SELECT id FROM tasks WHERE user_id = $1', [id]);
        const ids = taskRows.map(r => r.id);
        if (ids.length) {
          // task_attachments 參照 task_messages(id)，必須排在 task_messages 之前
          await client.query('DELETE FROM task_attachments WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [id]);
          await client.query('DELETE FROM task_events      WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [id]);
          await client.query('DELETE FROM task_logs        WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [id]);
          await client.query('DELETE FROM task_messages    WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [id]);
          await client.query('DELETE FROM tasks WHERE user_id = $1', [id]);
        }
        await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
        await client.query('DELETE FROM loop_counter WHERE user_id = $1', [id]);
        await client.query('UPDATE project_chats SET user_id = NULL WHERE user_id = $1', [id]); // 對話留給專案，僅解除建立者關聯
        const { rows } = await client.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
        if (!rows.length) {
          const e = new Error('Not found');
          e.status = 404;
          throw e;
        }
        return ids;
      });
      // 不可逆，只在 COMMIT 成功後做：各任務磁碟上的 uploads/task_<id>
      taskIds.forEach(tid => deleteTaskDir(tid));
      res.json({ ok: true });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: 'Not found' });
      res.status(500).json({ error: err.message });
    }
  });

  // --- project_maps ---

  app.get('/api/admin/project-maps', auth, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM project_maps ORDER BY project_name ASC');
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/project-maps', auth, async (req, res) => {
    try {
      const { project_name, odoo_version, project_dir, notes } = req.body;
      if (!project_name || !odoo_version) return res.status(400).json({ error: 'project_name and odoo_version required' });
      const { rows } = await query(
        `INSERT INTO project_maps (project_name, odoo_version, project_dir, notes)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [project_name, odoo_version, project_dir || null, notes || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'project_name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/project-maps/:id', auth, async (req, res) => {
    try {
      const { odoo_version, project_dir, notes } = req.body;
      const { rows } = await query(
        `UPDATE project_maps SET
           odoo_version = COALESCE($2, odoo_version),
           project_dir = COALESCE($3, project_dir),
           notes = COALESCE($4, notes),
           updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [req.params.id, odoo_version || null, project_dir || null, notes || null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/admin/project-maps/:id', auth, async (req, res) => {
    try {
      const { rows } = await query('DELETE FROM project_maps WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  // --- Git SSH Key Management ---

  app.get('/api/admin/git/ssh-pubkey', auth, (req, res) => {
    const result = getSshPubKey();
    if (!result) return res.json({ key: null });
    res.json(result);
  });

  app.post('/api/admin/git/ssh-key/generate', auth, (req, res) => {
    const existing = getSshPubKey();
    if (existing) return res.status(409).json({ error: '已存在 SSH 金鑰，請先手動刪除再重新產生', key: existing.key });

    const sshDir = path.join(os.homedir(), '.ssh');
    const keyPath = path.join(sshDir, 'id_ed25519');
    try { fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 }); } catch {}

    execFile('ssh-keygen', ['-t', 'ed25519', '-C', 'odoo-v2@server', '-f', keyPath, '-N', ''],
      { timeout: 30000 },
      (err, _stdout, stderr) => {
        if (err) return res.status(500).json({ error: stderr || err.message });
        const pubKey = fs.readFileSync(keyPath + '.pub', 'utf8').trim();
        // Pre-add github.com to known_hosts
        execFile('ssh-keyscan', ['-H', 'github.com'], { timeout: 30000 }, (e, out) => {
          if (!e && out) {
            const khPath = path.join(sshDir, 'known_hosts');
            try { fs.appendFileSync(khPath, out); } catch {}
          }
        });
        res.json({ key: pubKey, type: 'id_ed25519' });
      }
    );
  });

  app.post('/api/admin/git/ssh-scan-github', auth, (_req, res) => {
    const sshDir = path.join(os.homedir(), '.ssh');
    try { fs.mkdirSync(sshDir, { recursive: true }); } catch {}
    execFile('ssh-keyscan', ['-H', 'github.com'], { timeout: 30000 }, (err, out) => {
      if (err) return res.status(500).json({ error: err.message });
      const khPath = path.join(sshDir, 'known_hosts');
      try { fs.appendFileSync(khPath, out); } catch (e) {
        return res.status(500).json({ error: e.message });
      }
      res.json({ ok: true });
    });
  });

  // --- Agent 管理 ---

  // 全域規則 CLAUDE.md：非單一 agent，只有內容可編（無 model）
  const CLAUDE_MD = path.join(__dirname, '..', '..', '.claude', 'CLAUDE.md');
  function claudeEntry(withBody) {
    const e = {
      name: 'CLAUDE', role: '全域', label: '全域規則 (CLAUDE.md)',
      description: '所有開發共用的規則，非單一 agent', model: null, stage: null
    };
    if (withBody) e.prompt = fs.existsSync(CLAUDE_MD) ? fs.readFileSync(CLAUDE_MD, 'utf8') : '';
    return e;
  }

  // 列出所有 agent（不含 prompt body）；置頂全域規則
  app.get('/api/admin/agents', auth, (_req, res) => {
    try { res.json([claudeEntry(false), ...listAgents()]); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 單一 agent（含 prompt body）
  app.get('/api/admin/agents/:name', auth, (req, res) => {
    try {
      if (req.params.name === 'CLAUDE') return res.json(claudeEntry(true));
      const a = loadAgent(req.params.name);
      res.json({ name: a.name, role: a.role, label: a.label, description: a.description, model: a.model, stage: a.stage, prompt: a.body });
    } catch (err) {
      res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: err.message });
    }
  });

  // 更新 model 與 prompt（僅此兩者可改）；CLAUDE 只寫內容
  app.put('/api/admin/agents/:name', auth, (req, res) => {
    try {
      const { model, prompt } = req.body || {};
      if (req.params.name === 'CLAUDE') {
        if (typeof prompt === 'string') fs.writeFileSync(CLAUDE_MD, prompt);
        return res.json(claudeEntry(true));
      }
      const a = updateAgent(req.params.name, { model, prompt });
      res.json({ name: a.name, role: a.role, label: a.label, description: a.description, model: a.model, stage: a.stage, prompt: a.body });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // --- 工作流程健檢（子專案 2）：admin 一鍵，背景對每個 pipeline agent 出診斷 ---

  // 全平台健檢＝主導型審計，視窗是「上一輪健檢完成之後到現在」的增量。
  // 不再收 windowDays 當主要參數：固定視窗量到的指標多半由已被取代的舊版提示詞產生，判讀時整批
  // 要打折；增量視窗量到的正好是「上次改動之後的表現」。sinceDays 是例外出口——想重掃更久以前
  // （例如剛接手、或想回頭補一段）時才用。
  app.post('/api/admin/health-check', auth, async (req, res) => {
    try {
      const sinceDays = parseInt(req.body?.sinceDays, 10);
      const sinceAt = sinceDays > 0
        ? new Date(Date.now() - sinceDays * 86400000)
        : await auditWindowStart();
      const windowDays = Math.max(1, Math.round((Date.now() - sinceAt.getTime()) / 86400000));
      const { rows: [r] } = await query(
        "INSERT INTO health_check_runs (status, window_days, started_by, since_at) VALUES ('running',$1,$2,$3) RETURNING id",
        [windowDays, req.userId, sinceAt]
      );
      // fire-and-forget：不 await，runner 自行落 status='done'/'error'
      runAudit(r.id, { sinceAt, startedBy: req.userId }).catch(() => {});
      res.json({ runId: r.id, sinceAt });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 提案的處置狀態。這支存在的理由是「跨輪記憶」：沒有它，健檢每輪都會把同一件事重講一次，
  // 而你上輪的裁決沒有任何地方記得住；下一輪的 previousProposals() 就是讀這裡。
  const FINDING_STATUS = new Set(['pending', 'no_change', 'done']);
  app.patch('/api/admin/health-check/findings/:id', auth, async (req, res) => {
    try {
      const status = String(req.body?.status || '').trim();
      if (!FINDING_STATUS.has(status)) return res.status(400).json({ error: '狀態不合法' });
      const note = req.body?.verdict_note ? String(req.body.verdict_note) : null;
      // applied_at 只在「處理完成」時補上，且只補一次：它是下一輪回頭驗成效的起算點，
      // 反覆改狀態不該把它往後推（否則成效永遠「還沒累積到樣本」）。
      const { rows } = await query(
        `UPDATE health_check_findings
            SET status=$2, verdict_note=$3, decided_by=$4, decided_at=NOW(),
                applied_at = CASE WHEN $2='done' AND applied_at IS NULL THEN NOW() ELSE applied_at END
          WHERE id=$1 RETURNING id, status, verdict_note, decided_at, applied_at`,
        [req.params.id, status, note, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'finding 不存在' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // scope=task：只健檢一張任務（入口在任務詳情頁）。與上面那支共用 runs／findings 表，
  // 差別只在餵進 runner 的資料範圍——判準是同一份（.claude/skills/healthCheck）。
  // window_days 對單張任務無意義（它的歷程就是全部），留欄位預設值不填。
  app.post('/api/admin/health-check/task', auth, async (req, res) => {
    try {
      const taskDbId = parseInt(req.body?.taskDbId, 10);
      if (!taskDbId) return res.status(400).json({ error: '缺少 taskDbId' });
      // 先擋不存在的任務：不擋的話會建出一個註定 error 的 run，使用者得等它跑完才看得到「找不到」
      const { rows: [t] } = await query('SELECT id FROM tasks WHERE id=$1', [taskDbId]);
      if (!t) return res.status(404).json({ error: '任務不存在' });
      const { rows: [r] } = await query(
        "INSERT INTO health_check_runs (status, started_by, task_db_id) VALUES ('running',$1,$2) RETURNING id",
        [req.userId, taskDbId]
      );
      runTaskHealthCheck(r.id, { taskDbId, startedBy: req.userId }).catch(() => {});
      res.json({ runId: r.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/health-check', auth, async (_req, res) => {
    try {
      // LEFT JOIN tasks：task_db_id 刻意不帶 FK（見 db.js），任務被刪掉時這裡回 null，
      // 前端就顯示成「全平台」以外的一般列而不是壞掉的連結。
      const { rows } = await query(
        `SELECT r.id, r.status, r.window_days, r.started_by, r.created_at, r.finished_at,
                r.task_db_id, t.task_id, t.title,
                COUNT(f.id)::int AS findings_count
           FROM health_check_runs r
           LEFT JOIN health_check_findings f ON f.run_id = r.id
           LEFT JOIN tasks t ON t.id = r.task_db_id
          GROUP BY r.id, r.status, r.window_days, r.started_by, r.created_at, r.finished_at,
                   r.task_db_id, t.task_id, t.title
          ORDER BY r.id DESC LIMIT 20`
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 下次自動健檢時刻。刻意不掛在 /health-check/ 底下：那層已有吃任意字串的 :runId，
  // 排在它後面會被當成 runId 吞掉，得靠路由順序才正確——換成獨立路徑就不必依賴順序。
  app.get('/api/admin/health-check-schedule', auth, async (_req, res) => {
    try { res.json(await getHealthCheckSchedule()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/health-check/:runId', auth, async (req, res) => {
    try {
      const { rows: [run] } = await query('SELECT * FROM health_check_runs WHERE id=$1', [req.params.runId]);
      if (!run) return res.status(404).json({ error: 'run 不存在' });
      // scope=task 的 run 要帶出是哪一張任務，否則畫面上一份診斷認不出診斷的是誰。
      // 分開查而不是 JOIN：這支只回一列，JOIN 進來反而要處理任務已刪的欄位命名衝突。
      if (run.task_db_id) {
        const { rows: [t] } = await query('SELECT task_id, title FROM tasks WHERE id=$1', [run.task_db_id]);
        run.task = t || null;
      }
      const { rows: findings } = await query(
        'SELECT * FROM health_check_findings WHERE run_id=$1 ORDER BY id', [req.params.runId]);
      res.json({ run, findings });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- 健檢提案的「修這條」：獨立工作區改碼 → 自己跑測試 → 人審 diff → 採用 → 再按一次才推 ---
  // 三段刻意分開，任何一段都可以停在那裡不往前。平台自己的修正不走客戶任務的 pipeline，
  // 理由見 pipeline/finding-fix.js 檔頭。

  app.post('/api/admin/health-check/findings/:id/fix', auth, async (req, res) => {
    try {
      const { rows: [f] } = await query('SELECT id, kind FROM health_check_findings WHERE id=$1', [req.params.id]);
      if (!f) return res.status(404).json({ error: '提案不存在' });
      // 只有提案能修：候選訊號證據還不夠、總結不是可動手的東西，對它們開修正等於在沒有結論時動手。
      if (f.kind !== 'proposal') return res.status(400).json({ error: '只有提案可以修正' });
      // 同一條提案不並發：兩個工作區同時改同一件事，最後兩份 diff 都是半套。
      const { rows: running } = await query(
        "SELECT id FROM finding_fixes WHERE finding_id=$1 AND status IN ('running','ready','adopted')", [f.id]);
      if (running.length) return res.status(409).json({ error: '這條已有進行中或待審的修正', fixId: running[0].id });

      const { rows: [fix] } = await query(
        "INSERT INTO finding_fixes (finding_id, status, created_by) VALUES ($1,'running',$2) RETURNING id",
        [f.id, req.userId]
      );
      runFix(fix.id, { findingId: f.id, startedBy: req.userId }).catch(() => {});
      res.json({ fixId: fix.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/health-check/findings/:id/fix', auth, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, finding_id, status, branch, notes, test_result, reject_reason, diff, commit_sha, created_at, finished_at
           FROM finding_fixes WHERE finding_id=$1 ORDER BY id DESC LIMIT 1`, [req.params.id]);
      res.json(rows[0] || null);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/fixes/:fixId/adopt', auth, async (req, res) => {
    try { res.json(await adoptFix(parseInt(req.params.fixId, 10), req.userId)); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  // 套用＝合併進主分支＋推 origin＋重啟平台。在飛任務由這裡查（pipeline 不得反向 require route，
  // 但 runner 的在飛清單本來就在 route 層可得）並傳進去，applyFix 只負責依它決定重不重啟。
  app.post('/api/admin/fixes/:fixId/apply', auth, async (req, res) => {
    try { res.json(await applyFix(parseInt(req.params.fixId, 10), req.userId, getInflightInfo())); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/admin/fixes/:fixId/push', auth, async (req, res) => {
    try { res.json(await pushFix(parseInt(req.params.fixId, 10), req.userId)); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/admin/fixes/:fixId/discard', auth, async (req, res) => {
    try { await discardFix(parseInt(req.params.fixId, 10)); res.json({ ok: true }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });

  // --- 語意檢索索引：admin 一鍵全量重建 ---

  // fire-and-forget，比照上面的健檢：全量重建實測 10–20 秒，但那是在單一 worker 上排隊跑推論，
  // 沒有理由讓 HTTP 連線掛著等。進度靠下面的 status 端點輪詢（只在記憶體，重啟即歸零——
  // 20 秒的工作不需要撐過重啟，見 lib/embedding-index.js 的檔頭註解）。
  app.post('/api/admin/embedding/rebuild', auth, async (_req, res) => {
    try {
      const { rebuildAll, getIndexStatus } = require('./lib/embedding-index');
      rebuildAll().catch(err => console.error('[ADMIN] embedding-rebuild:', err.message));
      res.json(getIndexStatus());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/embedding/status', auth, (_req, res) => {
    try {
      const { getIndexStatus } = require('./lib/embedding-index');
      res.json(getIndexStatus());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 中文名稱對照表（stage → label），供用量報表等全站顯示；一般登入即可讀
  app.get('/api/agents/labels', verifyToken, (_req, res) => {
    try { res.json(getLabels()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- 進行中 Pipeline 監控：admin 看全部，一般使用者只看自己的 ---

  // 真正在飛（有活著的 process）的 task，非撈 status='*_running'（那可能是殘留）。以 _inFlight 為準。
  app.get('/api/admin/pipeline/active', verifyToken, async (req, res) => {
    try {
      const info = getInflightInfo();
      if (!info.length) return res.json([]);
      const byId = new Map(info.map(i => [Number(i.taskId), i.startedAt]));
      const ids = [...byId.keys()];
      const { rows: [me] } = await query('SELECT role FROM users WHERE id=$1', [req.userId]);
      const isAdmin = me?.role === 'admin';
      const ph = ids.map((_, i) => '$' + (i + 1)).join(',');
      // 一般使用者只看自己的在飛任務（多綁一個 user_id 參數）；admin 看全部
      const { rows } = await query(
        `SELECT t.id, t.task_id, t.title, t.status, t.project_id,
                p.name AS project_name, t.user_id, u.username, u.display_name
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u ON u.id = t.user_id
         WHERE t.id IN (${ph})${isAdmin ? '' : ` AND t.user_id = $${ids.length + 1}`}`,
        isAdmin ? ids : [...ids, req.userId]
      );
      const now = Date.now();
      const list = rows.map(r => ({ ...r, elapsed_ms: now - (byId.get(r.id) || now) }));
      list.sort((a, b) => b.elapsed_ms - a.elapsed_ms); // 執行最久的在最上
      res.json(list);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 暫停並 kill 指定 task 的行程。is_paused=true 使之後不再派工。
  // 一般使用者只能暫停自己的任務（非自己的 → rowCount 0 → 404，不會 kill 到別人的行程）。
  app.post('/api/admin/pipeline/tasks/:id/pause', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id=$1', [req.userId]);
      const isAdmin = me?.role === 'admin';
      const { rowCount } = await query(
        isAdmin
          ? 'UPDATE tasks SET is_paused = true, updated_at = NOW() WHERE id = $1'
          : 'UPDATE tasks SET is_paused = true, updated_at = NOW() WHERE id = $1 AND user_id = $2',
        isAdmin ? [req.params.id] : [req.params.id, req.userId]
      );
      if (!rowCount) return res.status(404).json({ error: 'Task not found' });
      abortTask(req.params.id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 正在等 AI 回覆的排障對話。chat 不經 runner，沒有 _inFlight 可查——server 端唯一的進行中
  // 訊號就是 reply_pending（chatReply 開頭設、finally 清、崩潰後由 recoverInterruptedChats 收）。
  // 順帶效果：卡住的 pending 會以「等很久」的形式浮上來，否則只有進到那場對話才看得到。
  // 等待時間錨在最後一則 user 訊息——chatReply 是先 INSERT 該訊息才跑 agent，故＝本輪提問時刻。
  // （chat-routes 的原子搶佔比那次 INSERT 早幾毫秒，該瞬間會取到上一輪的時間而顯示偏長，無害。）
  // 相關子查詢改 LEFT JOIN 是 pg-mem 相容需求，同 chat-routes.js:55。
  app.get('/api/admin/chat/active', verifyToken, async (req, res) => {
    try {
      const { rows: [me] } = await query('SELECT role FROM users WHERE id=$1', [req.userId]);
      const isAdmin = me?.role === 'admin';
      // 這頁的路由沒有 requiresAdmin（一般使用者進得來），故非 admin 一律限縮到自己的對話
      const { rows } = await query(
        `SELECT c.id, c.project_id, c.title, p.name AS project_name,
                c.user_id, u.username, u.display_name,
                MAX(m.created_at) AS asked_at
         FROM project_chats c
         LEFT JOIN projects p ON p.id = c.project_id
         LEFT JOIN users u ON u.id = c.user_id
         LEFT JOIN project_chat_messages m ON m.chat_id = c.id AND m.role = 'user'
         WHERE c.reply_pending = true${isAdmin ? '' : ' AND c.user_id = $1'}
         GROUP BY c.id, c.project_id, c.title, p.name, c.user_id, u.username, u.display_name`,
        isAdmin ? [] : [req.userId]
      );
      const now = Date.now();
      const list = rows.map(r => ({
        ...r,
        waited_ms: r.asked_at ? now - new Date(r.asked_at).getTime() : 0
      }));
      list.sort((a, b) => b.waited_ms - a.waited_ms); // 等最久的在最上，與上面的在飛任務同一個排法
      res.json(list);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- 退回原因管理（task_rejections / rejection_items）---

  // 一列一筆退回，join 專案名＋聚合分類條目數，created_at DESC，分頁回傳 total
  app.get('/api/admin/rejections', auth, async (req, res) => {
    try {
      let limit = parseInt(req.query.limit, 10); if (!Number.isInteger(limit) || limit <= 0) limit = 50;
      limit = Math.min(limit, 200);
      let offset = parseInt(req.query.offset, 10); if (!Number.isInteger(offset) || offset < 0) offset = 0;
      const { rows } = await query(
        `SELECT tr.id, tr.task_id, tr.project_id, p.name AS project_name, tr.reason, tr.status, tr.source, tr.created_at,
                COUNT(ri.id)::int AS item_count
           FROM task_rejections tr
           LEFT JOIN projects p ON p.id = tr.project_id
           LEFT JOIN rejection_items ri ON ri.rejection_id = tr.id
          GROUP BY tr.id, p.name, tr.source
          ORDER BY tr.created_at DESC, tr.id DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      // 帶出本頁每筆退回的分類條目（description＋category）。動態 IN 佔位避開 pg-mem ANY(int[]) 限制。
      const ids = rows.map(r => r.id);
      if (ids.length) {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
        const { rows: items } = await query(
          `SELECT rejection_id, description, category FROM rejection_items
            WHERE rejection_id IN (${placeholders}) ORDER BY id`,
          ids
        );
        const byRej = {};
        for (const it of items) {
          (byRej[it.rejection_id] = byRej[it.rejection_id] || []).push({ description: it.description, category: it.category });
        }
        for (const r of rows) r.items = byRej[r.id] || [];
      }
      const { rows: [{ total }] } = await query('SELECT COUNT(*)::int AS total FROM task_rejections');
      res.json({ rows, total });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 批次刪除（rejection_items 靠 FK ON DELETE CASCADE 一併清）。用動態 IN 佔位避開 pg-mem ANY(int[]) 限制。
  app.post('/api/admin/rejections/delete', auth, async (req, res) => {
    try {
      const ids = req.body && req.body.ids;
      if (!Array.isArray(ids) || !ids.length || !ids.every(Number.isInteger)) {
        return res.status(400).json({ error: 'ids 必須為非空整數陣列' });
      }
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rowCount } = await query(`DELETE FROM task_rejections WHERE id IN (${placeholders})`, ids);
      res.json({ deleted: rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- 失敗分類樣本（classify_samples）：failure-classifier 的 regex 判不出、交 haiku 的案例 ---
  // read-only 聚合供人工把高頻 pattern 升級成零 token regex（健檢：haiku fallback 回饋迴圈）。
  // 高頻 pattern 在 JS 聚合（取前 80 字），避開 pg-mem 對 LEFT()/substring 的支援落差。
  app.get('/api/admin/classify-samples', auth, async (req, res) => {
    try {
      let days = parseInt(req.query.days, 10); if (!Number.isInteger(days) || days <= 0) days = 14;
      days = Math.min(days, 90);
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();

      // 判定分佈：haiku 真的判出各類（agent_ok=true）vs 沒判出只落預設 env（agent_ok=false）。
      // agent_ok 全是 false 時代表 haiku 幾乎沒幫上忙，這關可考慮省掉直接 unknown→env。
      const { rows: byVerdict } = await query(
        `SELECT verdict, agent_ok, COUNT(*)::int AS n FROM classify_samples
          WHERE recorded_at >= $1 GROUP BY verdict, agent_ok ORDER BY n DESC`,
        [cutoff]
      );

      // 近期樣本（看實際文字）
      const { rows: recent } = await query(
        `SELECT id, task_id, error_text, verdict, agent_ok, recorded_at FROM classify_samples
          WHERE recorded_at >= $1 ORDER BY recorded_at DESC, id DESC LIMIT 50`,
        [cutoff]
      );

      // 高頻真因（前 80 字聚合）：復發最多的就該補進 regex。窗內全撈上限 5000 筆在 JS 聚合。
      const { rows: texts } = await query(
        `SELECT error_text, recorded_at FROM classify_samples WHERE recorded_at >= $1 LIMIT 5000`,
        [cutoff]
      );
      const bucket = new Map();
      for (const t of texts) {
        const key = String(t.error_text || '').slice(0, 80);
        const cur = bucket.get(key) || { pattern: key, n: 0, last_seen: t.recorded_at };
        cur.n += 1;
        if (t.recorded_at > cur.last_seen) cur.last_seen = t.recorded_at;
        bucket.set(key, cur);
      }
      const topPatterns = [...bucket.values()].sort((a, b) => b.n - a.n).slice(0, 20);

      res.json({ days, total: texts.length, byVerdict, topPatterns, recent });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
