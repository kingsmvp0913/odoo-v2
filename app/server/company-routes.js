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
const { validTaskBudgetUsd } = require('./lib/task-budget');
const { setCompanyAnthropicKey, clearCompanyAnthropicKey, companyKeyConfigured } = require('./lib/company-anthropic-key');

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
  app.get('/api/company/subscription', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      const { rows } = await query('SELECT active_until, is_internal FROM companies WHERE id=$1', [companyId]);
      if (!rows.length) return res.status(404).json({ error: '找不到所屬公司' });
      res.json({ active_until: rows[0].active_until, is_internal: rows[0].is_internal });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/company/task-budget', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      const { rows } = await query('SELECT task_budget_usd, is_internal FROM companies WHERE id=$1', [companyId]);
      if (!rows.length) return res.status(404).json({ error: '找不到所屬公司' });
      res.json({ task_budget_usd: rows[0].task_budget_usd, is_internal: rows[0].is_internal });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/company/task-budget', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    const amount = req.body?.task_budget_usd;
    if (!validTaskBudgetUsd(amount)) return res.status(400).json({ error: '任務花費上限須為正數美元金額（最多小數兩位），或 null 表示停用' });
    try {
      const { rows: company } = await query('SELECT is_internal FROM companies WHERE id=$1', [companyId]);
      if (!company.length) return res.status(404).json({ error: '找不到所屬公司' });
      if (company[0].is_internal) return res.status(400).json({ error: '內部公司使用平台認證，不設定客戶任務上限' });
      const { rows } = await query(
        'UPDATE companies SET task_budget_usd=$2, updated_at=NOW() WHERE id=$1 RETURNING task_budget_usd',
        [companyId, amount]
      );
      res.json({ task_budget_usd: rows[0].task_budget_usd });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 公司管理員自己換 Anthropic API key（2026-09-24 裁決「兩邊都要能填」）。
  //
  // 為什麼客戶這邊也要有：key 會過期、會被旋轉，每次都得找平台代填等於把客戶卡在我們的
  // 工時上；而客戶公司沒有有效的 key 時，他們的每一個 AI 動作都直接失敗
  // （buildClaudeAuthEnv 丟 NO_ANTHROPIC_KEY，刻意不退回平台訂閱）。
  //
  // 規則本體在 lib/company-anthropic-key.js，與平台管理員那組共用同一份——兩份一定分岔，
  // 而分岔的症狀是「同一把壞 key，從這個入口被擋、從那個入口存進去了」。
  //
  // ⚠ 公司 id 一律走 myCompany（＝req.actor.companyId），**不收任何參數**：
  // 收了就等於讓公司管理員填別家公司的 key。見本檔檔頭。
  app.get('/api/company/anthropic-key', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      res.json(await companyKeyConfigured(companyId));   // 只回「有沒有設」
    } catch (err) {
      if (err.code === 'COMPANY_KEY') return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/company/anthropic-key', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      const { warning } = await setCompanyAnthropicKey({
        companyId, apiKey: (req.body || {}).api_key, actorUserId: req.userId });
      res.json({ ok: true, warning });
    } catch (err) {
      if (err.code === 'COMPANY_KEY') return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/company/anthropic-key', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      const found = await clearCompanyAnthropicKey(companyId);
      if (!found) return res.status(404).json({ error: '找不到所屬公司' });
      res.status(204).end();
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

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
      // active 必須明確帶布林值——沒帶或型別不對，原本會被當成 false（停用）。
      // 一個「漏帶欄位」的請求就把人停用掉是危險的預設值，得擋在 400，不能靜默照做。
      if (typeof (req.body && req.body.active) !== 'boolean') {
        return res.status(400).json({ error: '請明確指定 active（布林值）' });
      }
      const active = req.body.active;
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
