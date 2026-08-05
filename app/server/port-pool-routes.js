const { query } = require('./db');
const { verifyToken } = require('./auth');
const portAlloc = require('./port-alloc');

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!rows.length || rows[0].role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

const isValidPort = v => Number.isInteger(v) && v >= 1 && v <= 65535;

function registerRoutes(app) {
  const auth = [verifyToken, requireAdmin];

  // 池狀態儀表板。只回「平台看得到的事實」——誰在租、宿主綁不綁得起來。
  // 這段埠不對外（只給反向代理從宿主端連），故無「對外是否放行」的落差要說明。
  app.get('/api/admin/port-pool', auth, async (req, res) => {
    try {
      const { min, max } = await portAlloc.getPoolRange();
      const { rows: leases } = await query(
        `SELECT e.port, e.project_id, e.last_active_at, e.external_slot, p.name AS project_name
           FROM odoo_envs e JOIN projects p ON p.id = e.project_id
          WHERE e.port IS NOT NULL`
      );
      const byPort = new Map(leases.map(l => [l.port, l]));
      const slots = [];
      for (let port = min; port <= max; port++) {
        const lease = byPort.get(port);
        if (lease) {
          slots.push({
            port, state: 'leased',
            project_id: lease.project_id, project_name: lease.project_name,
            last_active_at: lease.last_active_at,
            // 網域模式：有人在看的環境才持有對外名額（external_slot）→ 走子網域曝露；
            // 只有 port、沒 slot 的是 pipeline 在跑但沒人看，只在內網、無對外子網域。
            external_slot: lease.external_slot,
            external_url: portAlloc.envExternalUrl(lease.external_slot),
          });
          continue;
        }
        const free = await portAlloc.isPortFree(portAlloc.loopbackHostForPort(port), port);
        slots.push({ port, state: free ? 'free' : 'blocked', project_id: null, project_name: null, last_active_at: null, external_slot: null, external_url: null });
      }
      res.json({ min, max, slots });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/admin/port-pool', auth, async (req, res) => {
    try {
      const min = Number(req.body?.min), max = Number(req.body?.max);
      if (!isValidPort(min) || !isValidPort(max)) return res.status(400).json({ error: '埠號需為 1-65535 的整數' });
      if (min > max) return res.status(400).json({ error: '下限不可大於上限' });
      // 縮小範圍時，已租用但落在新範圍外的環境會變成孤兒（平台不再管理該埠，卻仍有容器綁著）。
      // 未租用（port 為 NULL）的列由比較運算本身排除（NULL 比較結果為 NULL），故不另寫 IS NOT NULL——
      // 寫了反而會踩到 pg-mem 對 odoo_envs_port_idx（partial index）的錯誤最佳化，測試環境查不到列。
      const { rows: orphans } = await query(
        `SELECT p.name FROM odoo_envs e JOIN projects p ON p.id = e.project_id
          WHERE e.port < $1 OR e.port > $2`,
        [min, max]
      );
      if (orphans.length) {
        return res.status(400).json({
          error: `新範圍會排除到使用中的測試區：${orphans.map(o => o.name).join('、')}。請先停止這些專案的測試區再調整。`,
        });
      }
      await query(
        `INSERT INTO teams_settings (id, port_pool_min, port_pool_max, updated_at) VALUES (1, $1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET port_pool_min=$1, port_pool_max=$2, updated_at=NOW()`,
        [min, max]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
