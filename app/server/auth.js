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

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');
const JWT_EXPIRES = '7d';

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
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
        'SELECT id, username, display_name, role, odoo_settings, sync_interval FROM users WHERE id = $1',
        [req.userId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      res.json(rows[0]);
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
