const http = require('http');
const https = require('https');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { fetchGitHubIdentity } = require('./lib/github-api');
const { encrypt } = require('./lib/crypto');

function odooRpc(baseUrl, path, body) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(path, baseUrl); } catch (e) { return reject(new Error('無效的網址')); }
    const data = JSON.stringify(body);
    const protocol = url.protocol === 'https:' ? https : http;
    const req = protocol.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 10000
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('伺服器回應無效')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('連線逾時')); });
    req.write(data);
    req.end();
  });
}

const SAVED_VIEWS_MAX = 10;   // JSONB 無限膨脹的上限；前端也擋，但真正的防線在這裡

function registerRoutes(app) {
  app.get('/api/settings', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT odoo_settings, sync_interval FROM users WHERE id = $1',
        [req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/settings', verifyToken, async (req, res) => {
    try {
      const { odoo_settings, sync_interval } = req.body;
      if (sync_interval !== undefined && sync_interval < 5) {
        return res.status(400).json({ error: 'sync_interval 最小為 5 分鐘' });
      }
      await query(
        `UPDATE users SET
           odoo_settings = COALESCE($2, odoo_settings),
           sync_interval = COALESCE($3, sync_interval)
         WHERE id = $1`,
        [req.userId,
         odoo_settings ? JSON.stringify(odoo_settings) : null,
         sync_interval ?? null]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 深色模式偏好：合併寫入 odoo_settings.theme（read-modify-write，不動其餘設定）
  app.put('/api/settings/theme', verifyToken, async (req, res) => {
    try {
      const { theme } = req.body || {};
      if (theme !== 'dark' && theme !== 'light') {
        return res.status(400).json({ error: 'theme 需為 dark 或 light' });
      }
      const { rows } = await query('SELECT odoo_settings FROM users WHERE id = $1', [req.userId]);
      const current = rows[0]?.odoo_settings || {};
      const merged = { ...current, theme };
      await query('UPDATE users SET odoo_settings = $2 WHERE id = $1', [req.userId, JSON.stringify(merged)]);
      res.json({ ok: true, theme });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 具名篩選 view：合併寫入 odoo_settings.saved_views（read-modify-write，不動其餘設定）。
  // 不可圖省事改走 PUT /api/settings——那支是整包覆寫，會把 theme 一起從後端刪掉（Settings.js 的
  // 註解記錄過這個事故：本機 localStorage 還在，要換裝置或開無痕才發現偏好永遠回淺色）。
  app.put('/api/settings/views', verifyToken, async (req, res) => {
    try {
      const { saved_views } = req.body || {};
      if (!Array.isArray(saved_views)) return res.status(400).json({ error: 'saved_views 需為陣列' });
      if (saved_views.length > SAVED_VIEWS_MAX) {
        return res.status(400).json({ error: `最多只能存 ${SAVED_VIEWS_MAX} 組` });
      }
      // 前端擋下只是提示，後端仍須擋：形狀壞掉的資料存進 JSONB，下次讀取時整排列表都會壞
      const clean = saved_views.map((v) => ({
        name: String((v && v.name) || '').trim(),
        filters: (v && typeof v.filters === 'object' && v.filters) || {}
      }));
      if (clean.some((v) => !v.name)) return res.status(400).json({ error: '每組 view 都需要名稱' });
      const { rows } = await query('SELECT odoo_settings FROM users WHERE id = $1', [req.userId]);
      const current = rows[0]?.odoo_settings || {};
      const merged = { ...current, saved_views: clean };
      await query('UPDATE users SET odoo_settings = $2 WHERE id = $1', [req.userId, JSON.stringify(merged)]);
      res.json({ ok: true, saved_views: clean });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Auto-fetch Odoo user_id — reads system URL+DB from teams_settings
  app.post('/api/settings/verify-odoo', verifyToken, async (req, res) => {
    const { odoo_username, odoo_password } = req.body;
    if (!odoo_username || !odoo_password) {
      return res.status(400).json({ error: '請填寫 Odoo 帳號和密碼' });
    }
    try {
      const { rows } = await query('SELECT odoo_url, odoo_db FROM teams_settings WHERE id = 1');
      const sys = rows[0] || {};
      if (!sys.odoo_url || !sys.odoo_db) {
        return res.status(400).json({ error: '管理員尚未設定 Odoo 網址和資料庫，請先至管理員設定填寫' });
      }
      const result = await odooRpc(sys.odoo_url, '/web/session/authenticate', {
        jsonrpc: '2.0', method: 'call', id: 1,
        params: { db: sys.odoo_db, login: odoo_username, password: odoo_password }
      });
      const uid = result?.result?.uid;
      if (!uid) return res.status(401).json({ error: '帳號或密碼錯誤' });
      res.json({ uid });
    } catch (err) {
      res.status(500).json({ error: `連線失敗：${err.message}` });
    }
  });

  // Auto-fetch eService user_id — reads system URL+DB from teams_settings
  app.post('/api/settings/verify-service', verifyToken, async (req, res) => {
    const { service_username, service_password } = req.body;
    if (!service_username || !service_password) {
      return res.status(400).json({ error: '請填寫 eService 帳號和密碼' });
    }
    try {
      const { rows } = await query('SELECT service_url, service_db FROM teams_settings WHERE id = 1');
      const sys = rows[0] || {};
      if (!sys.service_url || !sys.service_db) {
        return res.status(400).json({ error: '管理員尚未設定 eService 網址和資料庫，請先至管理員設定填寫' });
      }
      const result = await odooRpc(sys.service_url, '/web/session/authenticate', {
        jsonrpc: '2.0', method: 'call', id: 1,
        params: { db: sys.service_db, login: service_username, password: service_password }
      });
      const uid = result?.result?.uid;
      if (!uid) return res.status(401).json({ error: '帳號或密碼錯誤' });
      res.json({ uid });
    } catch (err) {
      res.status(500).json({ error: `連線失敗：${err.message}` });
    }
  });
  // 存個人 GitHub PAT：先呼叫 GitHub API 驗證並抓身分，通過才加密存。
  app.post('/api/settings/github-pat', verifyToken, async (req, res) => {
    const { pat } = req.body || {};
    if (!pat) return res.status(400).json({ error: '請貼上 GitHub PAT' });
    let identity;
    try {
      identity = await fetchGitHubIdentity(pat);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    try {
      const enc = encrypt(pat);
      await query(
        `UPDATE users SET github_pat_enc=$2, github_login=$3, git_name=$4, git_email=$5 WHERE id=$1`,
        [req.userId, enc, identity.login, identity.name, identity.email]
      );
      res.json({ login: identity.login });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/settings/github-pat', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT github_pat_enc, github_login FROM users WHERE id=$1', [req.userId]);
      const u = rows[0] || {};
      res.json({ configured: !!u.github_pat_enc, login: u.github_login || null });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/settings/github-pat', verifyToken, async (req, res) => {
    try {
      await query('UPDATE users SET github_pat_enc=NULL, github_login=NULL, git_name=NULL, git_email=NULL WHERE id=$1', [req.userId]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
