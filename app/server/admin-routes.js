const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { query } = require('./db');
const { hashPassword } = require('./password');
const { encryptSafe } = require('./lib/crypto');
const { verifyToken } = require('./auth');
const { listAgents, loadAgent, updateAgent, getLabels } = require('./pipeline/agent-loader');
const { getInflightInfo, abortTask } = require('./pipeline/runner');
const { runHealthCheck } = require('./pipeline/health-check-runner');
const { E2E_LOGIN, E2E_PASSWORD } = require('./pipeline/e2e-account');

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

  // --- 固定 E2E 測試帳號（唯讀顯示；建立環境／同步使用者時自動寫入測試區）---

  app.get('/api/admin/e2e-account', auth, (_req, res) => {
    res.json({ login: E2E_LOGIN, password: E2E_PASSWORD });
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
      const { rows } = await query('SELECT id, username, display_name, role, created_at FROM users ORDER BY id ASC');
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/users', auth, async (req, res) => {
    try {
      const { username, password, display_name, role } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'username and password required' });
      if (password.length < 8) return res.status(400).json({ error: '密碼至少 8 個字元' });
      const password_hash = await hashPassword(password);
      const { rows } = await query(
        `INSERT INTO users (username, password_hash, display_name, role, password_enc)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, username, display_name, role`,
        [username, password_hash, display_name || username, role || 'user', encryptSafe(password)]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '帳號已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/users/:id', auth, async (req, res) => {
    try {
      const { role, display_name } = req.body;
      const { rows } = await query(
        `UPDATE users SET
           role = COALESCE($2, role),
           display_name = COALESCE($3, display_name)
         WHERE id = $1 RETURNING id, username, display_name, role`,
        [req.params.id, role || null, display_name || null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/admin/users/:id', auth, async (req, res) => {
    try {
      if (parseInt(req.params.id) === req.userId) return res.status(400).json({ error: '不能刪除自己的帳號' });
      const { rows } = await query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
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

  app.post('/api/admin/health-check', auth, async (req, res) => {
    try {
      const windowDays = Math.max(1, parseInt(req.body?.windowDays, 10) || 30);
      const { rows: [r] } = await query(
        "INSERT INTO health_check_runs (status, window_days, started_by) VALUES ('running',$1,$2) RETURNING id",
        [windowDays, req.userId]
      );
      // fire-and-forget：不 await，runner 自行落 status='done'/'error'
      runHealthCheck(r.id, { windowDays, startedBy: req.userId }).catch(() => {});
      res.json({ runId: r.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/health-check', auth, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT r.id, r.status, r.window_days, r.started_by, r.created_at, r.finished_at,
                COUNT(f.id)::int AS findings_count
           FROM health_check_runs r
           LEFT JOIN health_check_findings f ON f.run_id = r.id
          GROUP BY r.id, r.status, r.window_days, r.started_by, r.created_at, r.finished_at
          ORDER BY r.id DESC LIMIT 20`
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/health-check/:runId', auth, async (req, res) => {
    try {
      const { rows: [run] } = await query('SELECT * FROM health_check_runs WHERE id=$1', [req.params.runId]);
      if (!run) return res.status(404).json({ error: 'run 不存在' });
      const { rows: findings } = await query(
        'SELECT * FROM health_check_findings WHERE run_id=$1 ORDER BY id', [req.params.runId]);
      res.json({ run, findings });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 中文名稱對照表（stage → label），供用量報表等全站顯示；一般登入即可讀
  app.get('/api/agents/labels', verifyToken, (_req, res) => {
    try { res.json(getLabels()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- 進行中 Pipeline 監控（跨使用者，僅 admin）---

  // 真正在飛（有活著的 process）的 task，非撈 status='*_running'（那可能是殘留）。以 _inFlight 為準。
  app.get('/api/admin/pipeline/active', auth, async (req, res) => {
    try {
      const info = getInflightInfo();
      if (!info.length) return res.json([]);
      const byId = new Map(info.map(i => [Number(i.taskId), i.startedAt]));
      const ids = [...byId.keys()];
      const ph = ids.map((_, i) => '$' + (i + 1)).join(',');
      const { rows } = await query(
        `SELECT t.id, t.task_id, t.title, t.status, t.project_id,
                p.name AS project_name, t.user_id, u.username, u.display_name
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u ON u.id = t.user_id
         WHERE t.id IN (${ph})`,
        ids
      );
      const now = Date.now();
      const list = rows.map(r => ({ ...r, elapsed_ms: now - (byId.get(r.id) || now) }));
      list.sort((a, b) => b.elapsed_ms - a.elapsed_ms); // 執行最久的在最上
      res.json(list);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 暫停並 kill 指定 task 的行程（不綁 owner，跨使用者）。is_paused=true 使之後不再派工。
  app.post('/api/admin/pipeline/tasks/:id/pause', auth, async (req, res) => {
    try {
      const { rowCount } = await query(
        'UPDATE tasks SET is_paused = true, updated_at = NOW() WHERE id = $1',
        [req.params.id]
      );
      if (!rowCount) return res.status(404).json({ error: 'Task not found' });
      abortTask(req.params.id);
      res.json({ ok: true });
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
