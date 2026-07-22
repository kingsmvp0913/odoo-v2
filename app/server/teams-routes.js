const { query } = require('./db');
const { verifyToken } = require('./auth');
const { sendTestMessage, resetTokenCache, isConfigured } = require('./teams');

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!rows.length || rows[0].role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function registerRoutes(app) {
  const auth = [verifyToken, requireAdmin];

  app.get('/api/admin/teams-settings', auth, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM teams_settings WHERE id = 1');
      const s = rows[0] || {};
      // Never return client_secret plaintext
      if (s.client_secret) s.client_secret = '••••••';
      res.json(s);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/admin/teams-settings', auth, async (req, res) => {
    try {
      const { tenant_id, client_id, client_secret, team_id, channel_id, mention_users, webhook_url, notify_webhook_url, odoo_sync_interval, service_sync_interval, odoo_url, odoo_db, service_url, service_db, test_mode, writeback_odoo_notes, env_mode, usage_gate_enabled, usage_gate_5h_threshold, usage_gate_7d_threshold } = req.body;
      await query(`
        INSERT INTO teams_settings (id, tenant_id, client_id, client_secret, team_id, channel_id, mention_users, webhook_url, notify_webhook_url, odoo_sync_interval, service_sync_interval, odoo_url, odoo_db, service_url, service_db, test_mode, writeback_odoo_notes, env_mode, usage_gate_enabled, usage_gate_5h_threshold, usage_gate_7d_threshold, updated_at)
        VALUES (1, $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, COALESCE($17,'venv'), COALESCE($18, true), COALESCE($19, 90), COALESCE($20, 95), NOW())
        ON CONFLICT (id) DO UPDATE SET
          tenant_id             = $1,
          client_id             = $2,
          client_secret         = CASE WHEN $3 = '' OR $3 IS NULL THEN teams_settings.client_secret ELSE $3 END,
          team_id               = $4,
          channel_id            = $5,
          mention_users         = $6::jsonb,
          webhook_url            = $7,
          notify_webhook_url    = $8,
          odoo_sync_interval    = COALESCE($9, teams_settings.odoo_sync_interval),
          service_sync_interval = COALESCE($10, teams_settings.service_sync_interval),
          odoo_url              = COALESCE($11, teams_settings.odoo_url),
          odoo_db               = COALESCE($12, teams_settings.odoo_db),
          service_url           = COALESCE($13, teams_settings.service_url),
          service_db            = COALESCE($14, teams_settings.service_db),
          test_mode             = $15,
          writeback_odoo_notes  = $16,
          env_mode              = COALESCE($17, teams_settings.env_mode),
          usage_gate_enabled       = COALESCE($18, teams_settings.usage_gate_enabled),
          usage_gate_5h_threshold  = COALESCE($19, teams_settings.usage_gate_5h_threshold),
          usage_gate_7d_threshold  = COALESCE($20, teams_settings.usage_gate_7d_threshold),
          updated_at            = NOW()
      `, [
        tenant_id || null, client_id || null, client_secret || null,
        team_id || null, channel_id || null,
        JSON.stringify(Array.isArray(mention_users) ? mention_users : []),
        webhook_url || null,
        notify_webhook_url || null,
        odoo_sync_interval != null ? parseInt(odoo_sync_interval) : null,
        service_sync_interval != null ? parseInt(service_sync_interval) : null,
        odoo_url || null, odoo_db || null,
        service_url || null, service_db || null,
        test_mode ? true : false,
        writeback_odoo_notes ? true : false,
        // 只接受 venv／docker；未帶（舊前端）傳 null 由 COALESCE 保留現值，不誤清
        env_mode === undefined ? null : (env_mode === 'docker' ? 'docker' : 'venv'),
        // 未帶（舊前端）傳 null 由 COALESCE 保留現值，不誤清；enabled 明確布林
        usage_gate_enabled == null ? null : !!usage_gate_enabled,
        usage_gate_5h_threshold != null ? parseInt(usage_gate_5h_threshold) : null,
        usage_gate_7d_threshold != null ? parseInt(usage_gate_7d_threshold) : null
      ]);
      resetTokenCache();
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/teams-settings/test', auth, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM teams_settings WHERE id = 1');
      const settings = rows[0];
      if (!isConfigured(settings)) {
        return res.status(400).json({ error: '請先完整設定 Teams 連線資料（Tenant、Client、Team、Channel）' });
      }
      const messageId = await sendTestMessage(settings);
      res.json({ ok: true, messageId });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Webhook stub — handles Graph validation handshake; processes replies in future
  app.post('/api/teams/webhook', (req, res) => {
    if (req.query.validationToken) {
      return res.status(200).contentType('text/plain').send(req.query.validationToken);
    }
    // TODO: parse notification, match to task, write task_logs, advance pipeline
    res.status(202).send();
  });
}

module.exports = { registerRoutes };
