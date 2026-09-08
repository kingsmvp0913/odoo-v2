// 自動部署的 HTTP 介面。
//
// 每一支都掛 requireAutoDeploy——前端隱藏分頁不是授權，使用者照樣打得到 API。
// 所有查詢都帶 project_id 條件：此 repo 沒有 project_members 表，專案端點多半只驗 token，
// 跨專案隔離要端點自己做。
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { requireAutoDeploy } = require('./lib/auto-deploy-switch');
const { runProbe } = require('./lib/deploy-probe');

const TARGET_COLS = `id, project_id, repo_id, env, conn_id, runtime, compose_dir, compose_service,
       service_name, container_name, addons_dir, conf_path, db_name, http_port,
       modules, branch, sudo_mode, enabled, last_deployed_sha, last_probe_at`;

function registerRoutes(app) {
  const guard = [verifyToken, requireAutoDeploy];

  app.get('/api/projects/:id/deploy-targets', guard, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT ${TARGET_COLS} FROM project_deploy_targets WHERE project_id = $1 ORDER BY env, id`,
        [req.params.id]
      );
      res.json({ targets: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/deploy-probe', guard, async (req, res) => {
    try {
      const connId = Number(req.body && req.body.conn_id);
      if (!connId) return res.status(400).json({ error: '缺少 conn_id' });
      // 探測會連進客戶機，連線必須屬於這個專案才准跑
      const { rows: [c] } = await query(
        'SELECT id FROM db_connections WHERE id = $1 AND project_id = $2', [connId, req.params.id]
      );
      if (!c) return res.status(404).json({ error: '找不到這筆連線設定' });
      res.json(await runProbe(connId, Number(req.params.id)));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/deploy-targets', guard, async (req, res) => {
    try {
      const b = req.body || {};
      if (!['test', 'prod'].includes(b.env)) return res.status(400).json({ error: 'env 只能是 test 或 prod' });
      if (!b.runtime) return res.status(400).json({ error: '缺少 runtime' });
      if (!b.addons_dir || !b.db_name || !b.branch) return res.status(400).json({ error: '缺少必填欄位（addons_dir／db_name／branch）' });
      const { rows } = await query(
        `INSERT INTO project_deploy_targets
           (project_id, repo_id, env, conn_id, runtime, compose_dir, compose_service, service_name,
            container_name, addons_dir, conf_path, db_name, http_port, modules, branch, sudo_mode,
            enabled, last_probe_at, probe_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18)
         RETURNING id`,
        [req.params.id, b.repo_id || null, b.env, b.conn_id || null, b.runtime,
         b.compose_dir || null, b.compose_service || null, b.service_name || null,
         b.container_name || null, b.addons_dir, b.conf_path || null, b.db_name,
         b.http_port || null, Array.isArray(b.modules) ? b.modules : [], b.branch,
         b.sudo_mode || 'none',
         // 新建一律不自動啟用，要人再按一次——這個功能會動客戶的機器
         b.enabled === true, b.probe_json || null]
      );
      res.json({ ok: true, id: rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
