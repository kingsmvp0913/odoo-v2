const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { registerRoutes: registerAuthRoutes } = require('./auth');
const { registerRoutes: registerSettingsRoutes } = require('./settings');
const { registerRoutes: registerTasksRoutes } = require('./tasks-routes');
const { registerRoutes: registerPipelineRoutes } = require('./pipeline-routes');
const { registerRoutes: registerProjectRoutes } = require('./project-routes');
const { registerRoutes: registerWikiRoutes } = require('./wiki-routes');
const { registerRoutes: registerChatRoutes } = require('./chat-routes');
const { registerRoutes: registerEnvRoutes } = require('./env-routes');
const { registerRoutes: registerAdminRoutes } = require('./admin-routes');
const { registerRoutes: registerTeamsRoutes } = require('./teams-routes');
const { registerRoutes: registerTokenReportRoutes } = require('./token-report-routes');
const { registerRoutes: registerClaudeUsageRoutes } = require('./claude-usage-routes');
const { registerRoutes: registerDbQueryRoutes } = require('./db-query-routes');

const PORT = process.env.PORT || 3939;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  registerAuthRoutes(app);
  registerSettingsRoutes(app);
  registerTasksRoutes(app);
  registerPipelineRoutes(app);
  registerProjectRoutes(app);
  registerWikiRoutes(app);
  registerChatRoutes(app);
  registerEnvRoutes(app);
  registerAdminRoutes(app);
  registerTeamsRoutes(app);
  registerTokenReportRoutes(app);
  registerClaudeUsageRoutes(app);
  registerDbQueryRoutes(app);

  // Manual sync / pipeline endpoints
  const { verifyToken } = require('./auth');
  const { query } = require('./db');
  const { syncUser } = require('./pipeline/sync');
  const { runPipeline } = require('./pipeline/runner');
  app.post('/api/sync/now', verifyToken, async (req, res) => {
    try {
      const result = await syncUser(req.userId);
      const total = result.odoo.added + result.service.added;
      if (total > 0) {
        const notify = require('./notify');
        notify.emitToUser(req.userId, 'task:synced', { count: total });
      }
      // cs 分類已由 runPipeline 接手 new 狀態
      // Only run pipeline if test mode is off
      const { rows: [cfg] } = await query('SELECT test_mode FROM teams_settings WHERE id = 1');
      if (!cfg?.test_mode) {
        await runPipeline(req.userId);
      }
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Public (auth-only): get non-sensitive global config
  app.get('/api/system/config', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT test_mode, odoo_url, service_url, writeback_odoo_notes FROM teams_settings WHERE id = 1');
      res.json({
        test_mode: !!(rows[0]?.test_mode),
        odoo_url: rows[0]?.odoo_url || '',
        service_url: rows[0]?.service_url || '',
        writeback_odoo_notes: !!(rows[0]?.writeback_odoo_notes)
      });
    } catch { res.json({ test_mode: false, odoo_url: '', service_url: '', writeback_odoo_notes: false }); }
  });

  // User-level: advance pipeline one round for current user only
  app.post('/api/pipeline/step', verifyToken, async (req, res) => {
    try {
      // fire-and-forget：runPipeline 只派工（不 await 任務完成），立刻回應；進度靠 socket 即時更新。
      runPipeline(req.userId).catch(err => console.error('[STEP] pipeline error:', err.message));
      res.json({ ok: true, started: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Admin: manually advance pipeline one round (for test mode)
  app.post('/api/admin/pipeline/step', verifyToken, async (req, res) => {
    try {
      const { rows: [user] } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
      if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      const { rows: users } = await query('SELECT id FROM users');
      // fire-and-forget：同上，不 hold 住 HTTP 連線
      for (const u of users) {
        runPipeline(u.id).catch(err => console.error('[ADMIN-STEP] pipeline error:', err.message));
      }
      res.json({ ok: true, started: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.use('/api/', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
  return app;
}

if (require.main === module) {
  // 最後防線：漏接的例外（如子行程 stream 的 EPIPE）不可拖垮整個 pipeline server——
  // 任務狀態都在 DB，行程活著才能繼續派工；只記 log 供鑑識，不退出。
  process.on('uncaughtException', err => console.error('[FATAL] uncaughtException:', err));
  process.on('unhandledRejection', err => console.error('[FATAL] unhandledRejection:', err));

  const { migrate } = require('./db');
  const { setIo } = require('./notify');
  const { startCron } = require('./cron');

  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

  const app = createApp();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Unauthorized'));
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (!payload.userId) return next(new Error('Unauthorized'));
      socket.userId = payload.userId;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    console.log('connected:', socket.id, 'userId:', socket.userId);
    socket.join(`user:${socket.userId}`);
  });

  migrate().then(async () => {
    // Reset any envs stuck in setting_up from a previous crashed/restarted process
    const { query: q } = require('./db');
    await q(
      "UPDATE odoo_envs SET status='error', error_msg='伺服器重啟，建立程序中斷', updated_at=NOW() WHERE status='setting_up'"
    ).catch(() => {});
    // 同理重置其他 fire-and-forget 的 running 殘留（無人續跑，會永遠顯示執行中）
    await q(
      "UPDATE health_check_runs SET status='error', finished_at=NOW() WHERE status='running'"
    ).catch(() => {});
    await q(
      "UPDATE project_repos SET graphify_status='error' WHERE graphify_status='running'"
    ).catch(() => {});

    setIo(io);
    // 離線通知：需人工動作的狀態變更 POST 到 admin 設定的 notify_webhook_url（未設定則靜默不動作）
    require('./notify-webhook').registerWebhookChannel();
    startCron();
    httpServer.listen(PORT, () => console.log(`AI Dev http://localhost:${PORT}`));
  }).catch(err => {
    console.error('DB migration failed:', err);
    process.exit(1);
  });
}

module.exports = { createApp };
