/**
 * auth.js — JWT authentication, all routes async/await with PostgreSQL
 *
 * Exports:
 *   verifyToken(req, res, next)  — Express middleware
 *   registerRoutes(app)          — mounts all auth routes
 */
const jwt = require('jsonwebtoken');
const { query } = require('./db');
const { hashPassword, checkPassword } = require('./password');
const { redactSettings } = require('./lib/user-settings');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');
const JWT_EXPIRES = '7d';

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// JWT 有效期 7 天且無狀態：只驗簽章的話，管理員刪掉離職者帳號後，對方手上的舊 token 仍能打
// 所有 API 最長 7 天＝「刪除帳號」對安全性等於沒發生。撤銷載體用 users 列本身（帳號一刪、
// 列就不在），不另造黑名單表——`sessions` 表雖然存在，但全庫沒有任何一處簽發或查詢它，
// 拿它當撤銷來源等於要先補一套 session 生命週期，改動面遠大於本問題。
// 代價是每個請求多一次主鍵查詢；index.js 的未核准閘門對所有 /api 本來就已經查一次 users，
// 量級相同。DB 查詢失敗一律 401（不 fallback 放行——那等於沒有檢查）。
async function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  let payload;
  try {
    payload = jwt.verify(header.slice(7), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  try {
    const { rows } = await query('SELECT role FROM users WHERE id = $1', [payload.userId]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid token' });
    req.role = rows[0].role;
    req.isAdmin = rows[0].role === 'admin';
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.userId = payload.userId;
  next();
}

function registerRoutes(app) {
  // GET /api/setup/status — returns whether first-time setup is needed
  app.get('/api/setup/status', async (req, res) => {
    try {
      const { rows } = await query('SELECT COUNT(*) AS n FROM users');
      const n = parseInt(rows[0].n, 10);
      res.json({ needsSetup: n === 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/auth/status — returns whether initial setup is complete
  app.get('/api/auth/status', async (req, res) => {
    try {
      const { rows } = await query('SELECT COUNT(*) AS n FROM users');
      const n = parseInt(rows[0].n, 10);
      res.json({ setup_done: n > 0 });
    } catch {
      res.json({ setup_done: false });
    }
  });

  // POST /api/auth/setup — create first admin (only when users table is empty)
  app.post('/api/auth/setup', async (req, res) => {
    try {
      const { rows } = await query('SELECT COUNT(*) AS n FROM users');
      if (parseInt(rows[0].n, 10) > 0) {
        return res.status(403).json({ error: 'Setup already completed' });
      }

      const { username, password, display_name } = req.body;
      if (!username || !password || !display_name) {
        return res.status(400).json({ error: 'username, password, display_name required' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: '密碼至少 8 個字元' });
      }

      const password_hash = await hashPassword(password);
      const { rows: inserted } = await query(
        'INSERT INTO users (username, password_hash, display_name, role) VALUES ($1, $2, $3, $4) RETURNING id',
        [username, password_hash, display_name, 'admin']
      );

      res.json({ token: signToken(inserted[0].id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/auth/register — 自助註冊（建 pending 帳號，回 token 供本次引導精靈設定憑證）。
  // 與 setup 不同：users 非空也可註冊；一律 role='user'、approved=false（唯一寫 false 的路徑）。
  app.post('/api/auth/register', async (req, res) => {
    try {
      const { username, password, display_name } = req.body;
      if (!username || !password || !display_name) {
        return res.status(400).json({ error: 'username, password, display_name required' });
      }
      if (password.length < 8) return res.status(400).json({ error: '密碼至少 8 個字元' });

      const password_hash = await hashPassword(password);
      const { rows: inserted } = await query(
        'INSERT INTO users (username, password_hash, display_name, role, approved) VALUES ($1, $2, $3, $4, false) RETURNING id',
        [username, password_hash, display_name, 'user']
      );
      res.status(201).json({ token: signToken(inserted[0].id) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '帳號已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/auth/login — authenticate and return token + user (no password_hash)
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      const { rows } = await query(
        'SELECT * FROM users WHERE username = $1',
        [username]
      );
      const user = rows[0];

      if (!user || !(await checkPassword(password, user.password_hash))) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      // 待審核帳號密碼對也不放行（管理員核准前）
      if (user.approved === false) {
        return res.status(403).json({ error: '帳號審核中，管理員核准後即可登入', pendingApproval: true });
      }

      const { password_hash, password_enc, ...safeUser } = user;
      res.json({ token: signToken(user.id), user: safeUser });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/auth/me — return current user (requires valid JWT)
  app.get('/api/auth/me', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, username, display_name, role, approved, odoo_settings, sync_interval FROM users WHERE id = $1',
        [req.userId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      // 密碼不回前端，只回 *_set 旗標（見 lib/user-settings 的 redactSettings）
      res.json({ ...rows[0], odoo_settings: redactSettings(rows[0].odoo_settings) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/auth/me — update display_name and/or password
  app.put('/api/auth/me', verifyToken, async (req, res) => {
    try {
      const { display_name, current_password, new_password } = req.body;
      const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
      if (!rows.length) return res.status(404).json({ error: 'User not found' });

      const fields = {};
      if (display_name !== undefined && display_name.trim()) {
        fields.display_name = display_name.trim();
      }
      if (new_password) {
        if (!current_password) return res.status(400).json({ error: '請提供目前密碼' });
        if (!(await checkPassword(current_password, rows[0].password_hash))) {
          return res.status(401).json({ error: '目前密碼不正確' });
        }
        if (new_password.length < 8) return res.status(400).json({ error: '新密碼至少 8 個字元' });
        fields.password_hash = await hashPassword(new_password);
      }
      if (!Object.keys(fields).length) return res.json({ ok: true });

      const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(', ');
      await query(`UPDATE users SET ${sets} WHERE id = $1`, [req.userId, ...Object.values(fields)]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { verifyToken, registerRoutes };
