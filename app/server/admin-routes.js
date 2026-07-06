const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { query } = require('./db');
const { hashPassword } = require('./password');
const { encryptSafe } = require('./lib/crypto');
const { verifyToken } = require('./auth');
const { listAgents, loadAgent, updateAgent, getLabels } = require('./pipeline/agent-loader');

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

  // 中文名稱對照表（stage → label），供用量報表等全站顯示；一般登入即可讀
  app.get('/api/agents/labels', verifyToken, (_req, res) => {
    try { res.json(getLabels()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
