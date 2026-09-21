/**
 * company-routes.js — 公司管理員管自家帳號（規格 §5.3、§8 P6）。
 *
 * 公司 id 一律取自 req.actor.companyId，不從網址收——讓它變成路徑參數就等於
 * 開了一條「把數字改掉試試看」的路，然後每一支端點都得自己記得檢查。
 * 這裡只有一個正確答案（你自己的公司），所以不做成參數。
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { hashPassword } = require('./password');
const { canManageCompanyUsers, ROLES } = require('./lib/tenant-access');

// 公司管理員能指派的角色。刻意不含 admin——公司管理員能建平台管理員的話，
// 等於任何一家客戶都能替自己開一個全平台的後門。
const ASSIGNABLE = [ROLES.USER, ROLES.COMPANY_ADMIN];

// 取「我管的公司」。平台管理員沒有公司，他要管帳號是走 /api/admin/users，
// 訊息要講清楚要去哪裡，不然對方只會看到一個沒頭沒尾的錯誤。
function myCompany(req, res) {
  const companyId = req.actor && req.actor.companyId;
  if (!canManageCompanyUsers(req.actor, companyId)) {
    res.status(403).json({ error: '只有公司管理員能管理公司帳號' });
    return null;
  }
  if (!companyId) {
    res.status(400).json({ error: '這個帳號不屬於任何公司；平台管理員請用管理員設定的使用者管理' });
    return null;
  }
  return companyId;
}

function registerRoutes(app) {
  app.get('/api/company/users', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      const { rows } = await query(
        `SELECT id, username, display_name, role, company_id, approved, created_at
           FROM users WHERE company_id = $1 ORDER BY username`,
        [companyId]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/company/users', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      const { username, password, display_name, role } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: '缺帳號或密碼' });
      if (String(password).length < 8) return res.status(400).json({ error: '密碼至少 8 個字元' });
      const finalRole = role || ROLES.USER;
      if (!ASSIGNABLE.includes(finalRole)) {
        return res.status(400).json({ error: '只能建立一般使用者或公司管理員' });
      }
      // company_id 取自 actor，不看 req.body——body 給什麼都不算數。
      const { rows } = await query(
        `INSERT INTO users (username, password_hash, display_name, role, company_id, approved)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING id, username, display_name, role, company_id, approved`,
        [username, await hashPassword(password), display_name || username, finalRole, companyId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '帳號已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/company/users/:id', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      const { display_name, role } = req.body || {};
      if (role !== undefined && !ASSIGNABLE.includes(role)) {
        return res.status(400).json({ error: '只能在一般使用者與公司管理員之間調整' });
      }
      // WHERE 同時綁 company_id：別家的人一律當作不存在，回 404 而不是 403。
      const { rows } = await query(
        `UPDATE users SET display_name = COALESCE($3, display_name), role = COALESCE($4, role)
          WHERE id = $1 AND company_id = $2
        RETURNING id, username, display_name, role, company_id, approved`,
        [req.params.id, companyId, display_name || null, role || null]
      );
      if (!rows.length) return res.status(404).json({ error: '找不到這個帳號' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/company/users/:id/active', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      const active = req.body && req.body.active === true;
      // 規格 §8 P6：只能停用不能刪除——刪掉帳號，他建的任務與留過的話就失去歸屬。
      const { rows } = await query(
        `UPDATE users SET approved = $3 WHERE id = $1 AND company_id = $2
         RETURNING id, username, display_name, role, company_id, approved`,
        [req.params.id, companyId, active]
      );
      if (!rows.length) return res.status(404).json({ error: '找不到這個帳號' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
