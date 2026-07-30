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
const { registerRoutes: registerPortPoolRoutes } = require('./port-pool-routes');
const { registerRoutes: registerEnterpriseRoutes } = require('./enterprise-routes');

const PORT = process.env.PORT || 3939;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  // 未核准閘門：擋「已登入但 approved=false」的自助註冊帳號碰工作台 API。
  // 白名單（auth/setup/settings/system config）放行——註冊精靈要能靠 register token 設定憑證。
  // 無 token／壞 token 不在此擋（交各路由 verifyToken 回 401），只認得出、且未核准的才 403。
  {
    const jwt = require('jsonwebtoken');
    const { query } = require('./db');
    // req.path 在 app.use('/api',…) 下已剝除 /api 前綴（如 /tasks、/settings/github-pat）
    const whitelisted = p =>
      p.startsWith('/auth/') || p.startsWith('/setup/') ||
      p === '/settings' || p.startsWith('/settings/') || p === '/system/config';
    app.use('/api', async (req, res, next) => {
      if (whitelisted(req.path)) return next();
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) return next();
      let userId;
      try { userId = jwt.verify(header.slice(7), process.env.JWT_SECRET).userId; } catch { return next(); }
      try {
        const { rows } = await query('SELECT role, approved FROM users WHERE id=$1', [userId]);
        if (rows[0] && rows[0].role !== 'admin' && rows[0].approved === false) {
          return res.status(403).json({ error: '帳號審核中，管理員核准後即可使用', pendingApproval: true });
        }
      } catch { /* 查詢失敗不阻斷：交下游處理 */ }
      next();
    });
  }

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
  registerPortPoolRoutes(app);
  registerEnterpriseRoutes(app);

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

  const { migrate, query } = require('./db');
  const { setIo } = require('./notify');
  const { startCron } = require('./cron');

  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

  const app = createApp();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });

  // 與 auth.js 的 verifyToken 同一條規則：簽章有效不等於帳號還在。JWT 最長 7 天，
  // 帳號被刪之後舊 token 仍驗得過——HTTP 端已補上「users 列是否還在」的檢查，這裡若不補，
  // 被停權的人照樣連得上 socket 繼續收所有推播，撤銷等於只做一半。
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Unauthorized'));
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (!payload.userId) return next(new Error('Unauthorized'));
      // 查詢失敗一律拒絕，不 fallback 放行——DB 掛掉時寧可連不上，也不要變成無認證通道。
      const { rows } = await query('SELECT 1 FROM users WHERE id = $1', [payload.userId]);
      if (!rows.length) return next(new Error('Unauthorized'));
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
    // fire-and-forget 的 running 殘留：可續跑的直接續跑（健檢從中斷點接續、graphify 冪等重建），
    // 不再一律標 error 作廢
    try {
      const { resumeInterruptedRuns } = require('./pipeline/health-check-runner');
      await resumeInterruptedRuns();
    } catch (e) { console.error('[STARTUP] health-check resume:', e.message); }
    try {
      const { rows: stuck } = await q(
        "SELECT id, local_path FROM project_repos WHERE graphify_status='running' AND local_path IS NOT NULL"
      );
      const { runGraphify } = require('./pipeline/graphify-runner');
      for (const r of stuck) runGraphify(r.id, r.local_path);
    } catch (e) { console.error('[STARTUP] graphify resume:', e.message); }

    setIo(io);
    // Claude 長效憑證載入快取：runClaude 同步取用，故必須在派工開始前備妥（未設定則沿用本機憑證檔）
    await require('./lib/claude-auth').loadClaudeToken();
    // 離線通知：需人工動作的狀態變更 POST 到 admin 設定的 notify_webhook_url（未設定則靜默不動作）
    require('./notify-webhook').registerWebhookChannel();
    // 綁埠失敗必須讓行程結束，且 cron 只在綁到埠之後才起。
    // 舊順序（先 startCron() 再 listen()）踩過一次實際事故：重複啟動時 listen 的 EADDRINUSE 以
    // 'error' 事件丟出、沒人接 → 變成 uncaughtException → 被上面那道「最後防線」吞掉、行程活下來，
    // 於是留下一個沒有 HTTP 埠、前端完全看不到、卻每分鐘照樣 runPipeline 派工的隱形派工者。
    // 兩個 cron 共用同一個 DB 而 _inFlight 只是行程內記憶體 → 同一任務同一關被派兩次、
    // 兩支 claude 並行寫同一個 worktree，reentry_count 也被記兩次（MAX_REENTRY 一次彈跳就打滿）。
    // 只在「還沒 listening」時退出：綁到埠之後的執行期錯誤照舊只記 log，不因偶發錯誤殺掉在飛任務。
    let listening = false;
    httpServer.on('error', err => {
      if (listening) return console.error('[SERVER] error:', err.message);
      console.error(`[FATAL] 無法綁定埠 ${PORT}（${err.code || err.message}）——很可能已有另一個 server 在跑。`);
      console.error('[FATAL] 行程結束，避免留下一個看不見但照樣派工的 cron。');
      process.exit(1);
    });
    httpServer.listen(PORT, () => {
      listening = true;
      console.log(`AI Dev http://localhost:${PORT}`);
      startCron();
    });
  }).catch(err => {
    console.error('DB migration failed:', err);
    process.exit(1);
  });
}

module.exports = { createApp };
