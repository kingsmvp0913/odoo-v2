const http = require('http');
const https = require('https');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { fetchGitHubIdentity } = require('./lib/github-api');
const { encrypt } = require('./lib/crypto');
const { encryptSettings, decryptSettings, redactSettings, preserveSecrets } = require('./lib/user-settings');
const { requireFeature, companyHasFeature } = require('./lib/company-features');

// 客戶端 GET /api/settings 的 odoo_settings 只回這些鍵、PUT /api/settings 也只讓客戶寫這些鍵
// ——白名單，不是黑名單（P3-4：閘門遇到模稜兩可一律落在「關」）。黑名單的失敗模式是「以後誰
// 往 odoo_settings 加新欄位，預設就外洩給客戶」——加欄位的人在改別的功能，根本不會想到這裡有
// 一道過濾，而且外洩沒有任何徵狀，客戶看到不該看的東西，我們永遠不會知道。白名單則相反：漏列
// 的新欄位客戶看不到，這種疏漏當天就會有人來抱怨「我的欄位不見了」——同一個疏忽，白名單壞的
// 方向是安全的方向。teams_user_id 是 MS Teams 提及通知用的 id（非 Odoo／eService 憑證），規格
// 要藏的只有 Odoo／eService 帳密，這個沒有藏的理由，故列入。
const CUSTOMER_SETTINGS_WHITELIST = ['theme', 'saved_views', 'teams_user_id'];

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
// 筆數有上限、單筆大小沒有＝上限形同虛設：odoo_settings 每次 GET /api/settings 與 auth/me 都整包
// 回前端（auth/me 每次導覽都打），單筆塞幾 MB 就足以拖垮每一個請求。前端的 maxlength 只是提示。
const VIEW_NAME_MAX = 20;        // 與 TaskList 具名輸入框的 maxlength 同值
const VIEW_FILTERS_MAX = 500;    // filters 序列化後的字元數；8 個篩選欄位遠遠用不到

function registerRoutes(app) {
  app.get('/api/settings', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT odoo_settings, sync_interval FROM users WHERE id = $1',
        [req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      // 密碼不回前端，只回 *_set 旗標（見 lib/user-settings 的 redactSettings）
      const result = { ...rows[0], odoo_settings: redactSettings(rows[0].odoo_settings) };
      const canSync = await companyHasFeature(req.actor && req.actor.companyId, 'odoo_sync');
      if (!canSync) {
        // 客戶看不到 Odoo／eService 相關鍵（規格 §8 P2）：那是我們連客戶系統用的憑證，不是他的東西。
        // 白名單過濾，見 CUSTOMER_SETTINGS_WHITELIST 的註解。odoo_settings 可能是 null（從未存過設定）。
        if (result.odoo_settings && typeof result.odoo_settings === 'object') {
          const filtered = {};
          for (const key of CUSTOMER_SETTINGS_WHITELIST) {
            if (key in result.odoo_settings) filtered[key] = result.odoo_settings[key];
          }
          result.odoo_settings = filtered;
        }
        delete result.sync_interval;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/settings', verifyToken, async (req, res) => {
    try {
      const { odoo_settings, sync_interval } = req.body;
      const canSync = await companyHasFeature(req.actor && req.actor.companyId, 'odoo_sync');
      let toStore = null;
      let cleanSyncInterval = sync_interval;

      if (!canSync) {
        // 客戶按的是同一顆儲存鈕：不可回 403，只能忽略 Odoo／eService 欄位、其餘照常寫入
        // （規格 §8 P2）。sync_interval 對客戶整條不存在，一律丟棄、不驗證、不寫入。
        cleanSyncInterval = undefined;
        if (odoo_settings) {
          // P3-11(b)：客戶這條路不可以整包覆寫。前端是整包來回的契約（load() 從 GET 拿、
          // save() 整包送回，frontend-settings-theme.test.js 記錄了這個契約），而 GET 對客戶
          // 用白名單濾掉的鍵（例如未被列入白名單的 Odoo 帳密），如果 PUT 仍整包覆寫，客戶下次
          // 存檔時就會被前端鋪回來的空值蓋掉——客戶只是換個主題，看不到的資料就悄悄不見了，
          // 而且沒有任何錯誤訊息。修法：從 DB 現有值出發合併，只套用白名單允許客戶寫的鍵，
          // 其餘鍵原封不動保留。
          const { rows } = await query('SELECT odoo_settings FROM users WHERE id = $1', [req.userId]);
          const current = (rows[0] && rows[0].odoo_settings && typeof rows[0].odoo_settings === 'object')
            ? rows[0].odoo_settings : {};
          const merged = { ...current };
          for (const key of CUSTOMER_SETTINGS_WHITELIST) {
            if (key in odoo_settings) merged[key] = odoo_settings[key];
          }
          toStore = JSON.stringify(encryptSettings(preserveSecrets(merged, current)));
        }
      } else {
        if (sync_interval !== undefined && sync_interval < 5) {
          return res.status(400).json({ error: 'sync_interval 最小為 5 分鐘' });
        }
        // 這支仍是整包覆寫（theme／saved_views 靠前端鋪回，見下方兩支端點的註解），唯獨密碼欄位
        // 例外：GET 已不再回密碼，前端鋪不回來，故未提供者一律沿用 DB 現值（preserveSecrets）。
        // 內部公司與平台管理員的語意不動——「對現在平台上的人零改變」。
        if (odoo_settings) {
          const { rows } = await query('SELECT odoo_settings FROM users WHERE id = $1', [req.userId]);
          toStore = JSON.stringify(encryptSettings(preserveSecrets(odoo_settings, rows[0]?.odoo_settings)));
        }
      }

      await query(
        `UPDATE users SET
           odoo_settings = COALESCE($2, odoo_settings),
           sync_interval = COALESCE($3, sync_interval)
         WHERE id = $1`,
        [req.userId, toStore, cleanSyncInterval ?? null]
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
      if (clean.some((v) => v.name.length > VIEW_NAME_MAX)) {
        return res.status(400).json({ error: `名稱最多 ${VIEW_NAME_MAX} 個字` });
      }
      if (clean.some((v) => JSON.stringify(v.filters).length > VIEW_FILTERS_MAX)) {
        return res.status(400).json({ error: '篩選條件內容過長' });
      }
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
  app.post('/api/settings/verify-odoo', verifyToken, requireFeature('odoo_sync'), async (req, res) => {
    const { odoo_username } = req.body;
    // 密碼留空＝沿用已存的（GET 不再回密碼，使用者沒改密碼時輸入框本來就是空的，
    // 不補這條的話「只改帳號按驗證」會逼人把密碼重打一次）。
    let { odoo_password } = req.body;
    if (!odoo_password) {
      const { rows } = await query('SELECT odoo_settings FROM users WHERE id = $1', [req.userId]);
      odoo_password = decryptSettings(rows[0]?.odoo_settings)?.odoo_password || '';
    }
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
  app.post('/api/settings/verify-service', verifyToken, requireFeature('odoo_sync'), async (req, res) => {
    const { service_username } = req.body;
    let { service_password } = req.body;   // 留空＝沿用已存的，同 verify-odoo
    if (!service_password) {
      const { rows } = await query('SELECT odoo_settings FROM users WHERE id = $1', [req.userId]);
      service_password = decryptSettings(rows[0]?.odoo_settings)?.service_password || '';
    }
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
