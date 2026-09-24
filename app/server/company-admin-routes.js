/**
 * company-admin-routes.js — 平台管理員的公司管理（規格 §5.3「新增 公司管理（admin）」）。
 *
 * 為什麼另開一個檔案而不是塞進 admin-routes.js：admin-routes.js 已經很大，
 * 而公司管理是一整塊有自己生命週期的東西（公司、綁專案、公司 GIT、功能開關）。
 *
 * is_internal 在這個檔案裡永遠是唯讀的——它只在一次性遷移時被寫過一次。
 * 客戶公司被誤標成內部，平台就會拿自己的 AI 訂閱去跑客戶的工作，那是違約。
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { requirePlatformAdmin, isCompanyUsable } = require('./lib/tenant-access');
const { FEATURES, normalizeFeatures } = require('./lib/company-features');
const { encrypt } = require('./lib/crypto');
const { buildGitEnvFromPat } = require('./lib/git-identity');
const { listRemoteBranchesByUrl } = require('./pipeline/git');
const { abortCompanyTasks } = require('./pipeline/runner');
const { validTaskBudgetUsd } = require('./lib/task-budget');

// 新客戶公司的失控保險絲預設值（2026-09-24 使用者拍板）。依據見建立公司那支的註解。
const DEFAULT_TASK_BUDGET_USD = 50;
const { setCompanyAnthropicKey, clearCompanyAnthropicKey } = require('./lib/company-anthropic-key');
const { companyReadiness } = require('./lib/company-readiness');

const auth = [verifyToken, requirePlatformAdmin];

// 回給前端的公司形狀。git_pat_enc 永遠不出現——只回「有沒有設」。
// user_count／project_count 刻意不用相關子查詢——pg-mem 不支援（見 rules/always.md pg-mem 限制清單）。
// 也不能改用 LEFT JOIN + COUNT(DISTINCT ...)：pg-mem 對 COUNT(DISTINCT ...) 本身有 bug
// （已用最小重現案例查證，不是本檔寫法的問題）。改用「先各自聚合成獨立子查詢再 LEFT JOIN」
// ——這種子查詢不引用外層的 c，不算相關子查詢，兩邊都繞開了。
const listSql = `
  SELECT c.id, c.name, c.is_active, c.is_internal, c.active_from, c.active_until,
         c.features, c.git_login, c.git_name, c.git_email, c.task_budget_usd,
         (c.git_pat_enc IS NOT NULL) AS has_git_pat,
         -- 只回「有沒有」，永遠不回密文本身——與 has_git_pat 同一個理由。
         (c.anthropic_key_enc IS NOT NULL AND c.anthropic_key_enc <> '') AS has_anthropic_key,
         COALESCE(uc.cnt, 0)::int AS user_count,
         COALESCE(pc.cnt, 0)::int AS project_count
    FROM companies c
    LEFT JOIN (SELECT company_id, COUNT(*) AS cnt FROM users GROUP BY company_id) uc
      ON uc.company_id = c.id
    LEFT JOIN (SELECT company_id, COUNT(*) AS cnt FROM project_companies GROUP BY company_id) pc
      ON pc.company_id = c.id`;

function shape(row) {
  return { ...row, features: normalizeFeatures(typeof row.features === 'string' ? JSON.parse(row.features) : row.features) };
}

function registerRoutes(app) {
  app.get('/api/admin/companies/features', auth, async (req, res) => {
    res.json(Object.values(FEATURES).map(f => ({ key: f.key, label: f.label })));
  });

  app.get('/api/admin/companies', auth, async (req, res) => {
    try {
      const { rows } = await query(`${listSql} ORDER BY c.is_internal DESC, c.name`);
      res.json(rows.map(shape));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/companies', auth, async (req, res) => {
    try {
      const { name, is_active, active_from, active_until, features } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: '缺公司名稱' });
      // is_internal 刻意不從 req.body 取：只有遷移腳本寫過它，API 一律建一般公司。
      //
      // task_budget_usd 給預設值（2026-09-24 使用者拍板 50）。它**不是帳單上限**——
      // 客戶用的是訂閱憑證、不會被按量扣款——而是「這張任務燒得不合理，停下來讓人看一眼」
      // 的失控保險絲。50 這個數字有依據：實測 185 張任務的中位數 $2.93、p90 $14.17、
      // p99 $27.69、史上最貴 $31.97，所以 50 永遠不會誤擋正常工作，只攔真的跑瘋的迴圈。
      // 呼叫端可以覆寫，帶 null 表示明確停用上限。
      const budget = 'task_budget_usd' in (req.body || {}) ? req.body.task_budget_usd : DEFAULT_TASK_BUDGET_USD;
      if (!validTaskBudgetUsd(budget)) {
        return res.status(400).json({ error: '任務花費上限須為正數美元金額（最多小數兩位），或 null 表示停用' });
      }
      const { rows } = await query(
        `INSERT INTO companies (name, is_active, active_from, active_until, features, task_budget_usd)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [String(name).trim(), is_active === true, active_from || null, active_until || null,
         JSON.stringify(normalizeFeatures(features)), budget]
      );
      const { rows: out } = await query(`${listSql} WHERE c.id = $1`, [rows[0].id]);
      res.status(201).json(shape(out[0]));
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '公司名稱已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/companies/:id', auth, async (req, res) => {
    try {
      const { name, is_active, active_from, active_until, features } = req.body || {};
      // COALESCE 讓「沒帶的欄位不動」；features 要能被改成 {}，所以用「有沒有這個 key」判斷而不是 truthy。
      // ⚠ features 是整包取代，不是逐鍵合併：帶 {odoo_sync:true} 會把沒一起帶的 exam 關掉
      // （normalizeFeatures 只留 input 裡出現過的 key）。這是刻意的契約，不是漏合併——
      // 前端表單必須每次送出全部開關的現況，不能只送「這次改動的那一個」。
      const featuresArg = ('features' in (req.body || {})) ? JSON.stringify(normalizeFeatures(features)) : null;
      const { rows } = await query(
        `UPDATE companies SET
           name         = COALESCE($2, name),
           is_active    = COALESCE($3, is_active),
           active_from  = COALESCE($4, active_from),
           active_until = COALESCE($5, active_until),
           features     = COALESCE($6::jsonb, features),
           updated_at   = NOW()
         WHERE id = $1 RETURNING id`,
        [req.params.id,
         name ? String(name).trim() : null,
         typeof is_active === 'boolean' ? is_active : null,
         active_from || null, active_until || null, featuresArg]
      );
      if (!rows.length) return res.status(404).json({ error: '找不到這家公司' });
      const { rows: out } = await query(`${listSql} WHERE c.id = $1`, [req.params.id]);
      // 規格 §7 第五列：這次修改讓公司變成不可用時，立刻中止它正在跑的 AI。
      // 用改完的值判斷，不是用 req.body——只帶 active_until 也可能讓公司變成過期。
      // 判斷本體在 lib/tenant-access.js 的 isCompanyUsable，與全域閘門同一套答案。
      const after = out[0];
      if (!isCompanyUsable(after.is_active, after.active_from, after.active_until, new Date())) {
        await abortCompanyTasks(req.params.id);
      }
      res.json(shape(out[0]));
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '公司名稱已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/companies/:id/task-budget', auth, async (req, res) => {
    const amount = req.body?.task_budget_usd;
    if (!validTaskBudgetUsd(amount)) return res.status(400).json({ error: '任務花費上限須為正數美元金額（最多小數兩位），或 null 表示停用' });
    try {
      const { rows: company } = await query('SELECT is_internal FROM companies WHERE id=$1', [req.params.id]);
      if (!company.length) return res.status(404).json({ error: '找不到這家公司' });
      if (company[0].is_internal) return res.status(400).json({ error: '內部公司使用平台認證，不設定客戶任務上限' });
      const { rows } = await query(
        'UPDATE companies SET task_budget_usd=$2, updated_at=NOW() WHERE id=$1 RETURNING task_budget_usd',
        [req.params.id, amount]
      );
      res.json({ task_budget_usd: rows[0].task_budget_usd });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/companies/:id/projects', auth, async (req, res) => {
    try {
      // task_count 不用相關子查詢（`t.project_id = pc.project_id`）——pg-mem 不支援，
      // 已在檔案開頭 user_count/project_count 用過同一招：先聚合成獨立子查詢再 LEFT JOIN。
      const { rows } = await query(
        `SELECT pc.project_id, p.name, pc.can_release,
                COALESCE(tc.cnt, 0)::int AS task_count
           FROM project_companies pc
           JOIN projects p ON p.id = pc.project_id
           LEFT JOIN (SELECT project_id, COUNT(*) AS cnt FROM tasks GROUP BY project_id) tc
             ON tc.project_id = pc.project_id
          WHERE pc.company_id = $1 ORDER BY p.name`,
        [req.params.id]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/admin/companies/:id/projects/:projectId', auth, async (req, res) => {
    try {
      const wantRelease = req.body && req.body.can_release === true;
      const { rows: co } = await query('SELECT is_internal FROM companies WHERE id = $1', [req.params.id]);
      if (!co.length) return res.status(404).json({ error: '找不到這家公司' });
      const { rows: pj } = await query('SELECT 1 FROM projects WHERE id = $1', [req.params.projectId]);
      if (!pj.length) return res.status(404).json({ error: '找不到這個專案' });
      // 規格 §4.3：內部公司綁了全部專案，給它 can_release 等於每個內部成員都能按上正式。
      if (co[0].is_internal === true && wantRelease) {
        return res.status(400).json({ error: '內部公司的綁定不能勾「可上正式」' });
      }
      await query(
        `INSERT INTO project_companies (project_id, company_id, can_release) VALUES ($1,$2,$3)
         ON CONFLICT (project_id, company_id) DO UPDATE SET can_release = EXCLUDED.can_release`,
        [req.params.projectId, req.params.id, wantRelease]
      );
      // 不信任 ON CONFLICT ... RETURNING（pg-mem 在這個組合上回過錯的值），改重讀一次。
      const { rows } = await query(
        'SELECT project_id, company_id, can_release FROM project_companies WHERE project_id=$1 AND company_id=$2',
        [req.params.projectId, req.params.id]
      );
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/admin/companies/:id/projects/:projectId', auth, async (req, res) => {
    try {
      const { rows } = await query(
        'DELETE FROM project_companies WHERE project_id=$1 AND company_id=$2 RETURNING project_id',
        [req.params.projectId, req.params.id]
      );
      // 沒綁過卻回 204，操作的人會以為自己解除了某個東西。
      if (!rows.length) return res.status(404).json({ error: '這家公司沒有綁這個專案' });
      res.status(204).end();
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/admin/companies/:id/git', auth, async (req, res) => {
    try {
      const { pat, login, name, email } = req.body || {};
      if (!pat) return res.status(400).json({ error: '缺 PAT' });
      const { rows: co } = await query('SELECT id FROM companies WHERE id = $1', [req.params.id]);
      if (!co.length) return res.status(404).json({ error: '找不到這家公司' });

      // 規格 §6：存之前對這家公司綁到的每個 repo 跑一次 git ls-remote。
      // 一個失敗就整批不存——存一把沒權限的 PAT，症狀要到很久以後某次推送才出現。
      const { rows: repos } = await query(
        `SELECT DISTINCT r.repo_url FROM project_repos r
           JOIN project_companies pc ON pc.project_id = r.project_id
          WHERE pc.company_id = $1`,
        [req.params.id]
      );
      const gitEnv = buildGitEnvFromPat(pat, { login, name, email });
      const checked = [];
      for (const r of repos) {
        try {
          await listRemoteBranchesByUrl(r.repo_url, gitEnv);
          checked.push({ repo_url: r.repo_url, ok: true });
        } catch (err) {
          return res.status(400).json({
            error: `這把 PAT 連不上 ${r.repo_url}：${err.message}`,
            checked: [...checked, { repo_url: r.repo_url, ok: false }],
          });
        }
      }

      await query(
        `UPDATE companies SET git_pat_enc=$2, git_login=$3, git_name=$4, git_email=$5, updated_at=NOW()
          WHERE id=$1`,
        [req.params.id, encrypt(pat), login || null, name || null, email || null]
      );
      res.json({ ok: true, checked });   // 刻意不回 pat，也不回密文
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 階段 3：客戶公司自帶的 Anthropic API key。存檔前用「候選 key」實跑一次，形狀照抄同檔的
  // 公司 GIT 端點（先驗證再存、永不回傳原文）與 admin-routes.js 的 saveClaudeToken（怎麼驗）。
  //
  // ⚠ 驗證必須用候選 key 而非資料庫裡的舊值，否則換 key 等於沒驗。sandbox-run 的呼叫端覆寫
  // 在收到 ANTHROPIC_API_KEY 時會把平台那把刪掉，所以驗到的一定是這一把。
  // 兩支都只是薄殼：規則本體在 lib/company-anthropic-key.js，因為公司管理員那邊
  // （company-routes.js）也有同一組入口，規則必須是同一份（2026-09-24 裁決「兩邊都要能填」）。
  // 開通進度：唯讀，全部從現有的表算，不加欄位也不改任何流程（子專案 4 §4.1）。
  // 放在公司管理頁的詳細區而不是另開一頁——2026-09-22 使用者推翻過獨立的「平台更版」頁，
  // 理由同一個：不要為了一張檢查表多一個管理功能出來。
  app.get('/api/admin/companies/:id/readiness', auth, async (req, res) => {
    try {
      const r = await companyReadiness(req.params.id);
      if (!r) return res.status(404).json({ error: '找不到這家公司' });
      res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/admin/companies/:id/anthropic-key', auth, async (req, res) => {
    try {
      const { warning } = await setCompanyAnthropicKey({
        companyId: req.params.id, apiKey: (req.body || {}).api_key, actorUserId: req.userId });
      res.json({ ok: true, warning });   // 刻意不回 key，也不回密文
    } catch (err) {
      if (err.code === 'COMPANY_KEY') return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/admin/companies/:id/anthropic-key', auth, async (req, res) => {
    try {
      const found = await clearCompanyAnthropicKey(req.params.id);
      if (!found) return res.status(404).json({ error: '找不到這家公司' });
      res.status(204).end();
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/admin/companies/:id/git', auth, async (req, res) => {
    try {
      const { rows } = await query(
        `UPDATE companies SET git_pat_enc=NULL, git_login=NULL, git_name=NULL, git_email=NULL, updated_at=NOW()
          WHERE id=$1 RETURNING id`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: '找不到這家公司' });
      res.status(204).end();
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
