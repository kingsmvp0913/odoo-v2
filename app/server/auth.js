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

// 由 verifyToken 撈到的那一列算出 actor（規格 §5.1）。抽成純函式是為了能單獨測期間判斷。
// companyUsable 的判斷只在「有公司」時才可能是 false——沒有公司一律算可用。
// 把「沒有公司」當成不可用的話，合併之後、tools/migrate-tenants.js 跑之前，
// 現有 6 個一般使用者（company_id 還是 NULL）會全部被 403 鎖在門外。
function buildActor(userId, row, now = new Date()) {
  const companyId = row.company_id ?? null;
  let companyUsable = true;
  if (companyId !== null) {
    const from = row.active_from ? new Date(row.active_from) : null;
    const until = row.active_until ? new Date(row.active_until) : null;
    companyUsable = row.is_active === true
      && (from === null || now >= from)
      && (until === null || now <= until);
  }
  return {
    userId,
    role: row.role,
    companyId,
    companyName: row.company_name ?? null,
    isPlatformAdmin: row.role === 'admin',
    isCompanyAdmin: row.role === 'company_admin',
    isInternal: row.is_internal === true,
    companyUsable,
  };
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
    // 租戶隔離（規格 §5.1）：一次把身分與公司狀態撈齊，後面的路由不必各自再查一次。
    // LEFT JOIN 而不是 JOIN——平台管理員沒有公司，遷移跑完之前一般使用者也還沒有。
    const { rows } = await query(
      `SELECT u.role, u.company_id, u.approved, c.name AS company_name, c.is_active, c.is_internal,
              c.active_from, c.active_until
         FROM users u
         LEFT JOIN companies c ON c.id = u.company_id
        WHERE u.id = $1`,
      [payload.userId]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid token' });
    const r = rows[0];
    // 停用（規格 §8 P6 補充，2026-09-21 盤查）：公司管理員按下停用只把 approved 設 false，
    // 若這裡不擋，對方手上還沒過期的 token（最長 7 天）照樣能打通所有 API——停用等於做半套。
    // 判斷式必須是 `=== false`：這欄多數既有帳號是 NULL（含平台管理員），`!r.approved` 會把
    // 從沒被寫過這欄的人全部鎖在外面，寫法照抄下面 auth.js 登入檢查的既有寫法。
    if (r.approved === false) return res.status(403).json({ error: '帳號已停用' });
    req.role = r.role;
    // 語意不變：全平台至少 6 處自己查 role === 'admin'，這裡改了就會全面走樣
    req.isAdmin = r.role === 'admin';
    req.actor = buildActor(payload.userId, r);
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

  // 規格 §8 P3：多租戶之後帳號一律由平台管理員或公司管理員建立，自助註冊關閉。
  // 保留這支路由只為了回一個講得清楚的訊息——整支移除的話舊前端會拿到 404，
  // 看起來像壞掉而不是像被關閉。
  // ⚠ 不要因為這支關了就順手動 POST /api/auth/setup：那是全新安裝建第一個管理員的唯一入口，
  //    它自己的守衛是「users 表不是空的就 403」，與本規則無關。
  app.post('/api/auth/register', (req, res) => {
    res.status(403).json({ error: '本平台不開放自助註冊，請聯絡貴公司的管理員開通帳號' });
  });

  // POST /api/auth/login — authenticate and return token + user (no password_hash)
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      // 失敗次數限制（見 lib/login-guard.js）。鎖的是 (帳號, 來源) 這一對：只鎖帳號會讓人能故意
      // 把所有管理員封鎖掉。失敗不論帳號存不存在都記——否則「有沒有被鎖」就成了帳號列舉的管道。
      const guard = require('./lib/login-guard');
      const source = guard.clientSource(req);
      if (username) {
        const gate = await guard.checkLogin({ username, source });
        if (!gate.allowed) {
          return res.status(429).json({
            error: gate.reason === 'blocked'
              ? '這個帳號從這個位置已被封鎖，請聯絡平台管理員解除'
              : '密碼錯誤太多次，請稍後再試',
            reason: gate.reason,
            until: gate.until || null,
          });
        }
      }
      const { rows } = await query(
        'SELECT * FROM users WHERE username = $1',
        [username]
      );
      const user = rows[0];

      if (!user || !(await checkPassword(password, user.password_hash))) {
        if (username) await guard.recordFailure({ username, source });
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      // 密碼對了 → 這一對的打錯次數歸零（裁決 R17），否則長期零星打錯會累積到永久封鎖。
      // 已封鎖的一對在上面就被擋掉，走不到這裡，所以不會順手解掉封鎖。
      await guard.recordSuccess({ username, source });
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
      // 前端要靠這三個欄位決定顯示什麼（規格 §5.5），以及公司停用時顯示原因
      res.json({
        ...rows[0],
        odoo_settings: redactSettings(rows[0].odoo_settings),
        company_id: req.actor.companyId,
        company_name: req.actor.companyName,
        company_usable: req.actor.companyUsable,
      });
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

module.exports = { verifyToken, registerRoutes, buildActor, JWT_SECRET };
