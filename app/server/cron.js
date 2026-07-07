const cron = require('node-cron');
const { query } = require('./db');
const { syncUser } = require('./pipeline/sync');
const { runPipeline } = require('./pipeline/runner');
const notify = require('./notify');

const lastOdooSync = new Map();
const lastServiceSync = new Map();
let _job = null;

async function getGlobalSettings() {
  try {
    const { rows } = await query('SELECT odoo_sync_interval, service_sync_interval, test_mode FROM teams_settings WHERE id = 1');
    return rows[0] || { odoo_sync_interval: 60, service_sync_interval: 60, test_mode: false };
  } catch { return { odoo_sync_interval: 60, service_sync_interval: 60, test_mode: false }; }
}

async function runForUser(userId, { skipPipeline = false } = {}) {
  try {
    const result = await syncUser(userId);
    const total = result.odoo.added + result.service.added;
    if (total > 0) {
      notify.emitToUser(userId, 'task:synced', { count: total });
    }
    if (!skipPipeline) await runPipeline(userId);
  } catch (err) {
    console.error(`[CRON] user ${userId}:`, err.message);
  }
}

// 完成滿 30 天的任務自動封存（is_hidden），移出主列表
async function autoArchiveDone() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return query(
    "UPDATE tasks SET is_hidden = true, updated_at = NOW() WHERE status = 'done' AND is_hidden = false AND done_at IS NOT NULL AND done_at < $1",
    [cutoff]
  );
}

function startCron() {
  _job = cron.schedule('* * * * *', async () => {
    try {
      const intervals = await getGlobalSettings();
      const odooMs    = (intervals.odoo_sync_interval || 60) * 60000;
      const serviceMs = (intervals.service_sync_interval || 60) * 60000;
      const testMode  = !!intervals.test_mode;

      // Only sync if at least one source is enabled
      if (!odooMs && !serviceMs) return;

      const { rows: users } = await query('SELECT id FROM users');
      const now = Date.now();
      for (const user of users) {
        const shouldSyncOdoo    = odooMs    > 0 && (now - (lastOdooSync.get(user.id) || 0)) >= odooMs;
        const shouldSyncService = serviceMs > 0 && (now - (lastServiceSync.get(user.id) || 0)) >= serviceMs;
        if (shouldSyncOdoo)    lastOdooSync.set(user.id, now);
        if (shouldSyncService) lastServiceSync.set(user.id, now);

        if (shouldSyncOdoo || shouldSyncService) {
          // 同步 + triage + pipeline
          runForUser(user.id, { skipPipeline: testMode });
        } else if (!testMode) {
          // 每分鐘仍推進 pipeline（不同步）；cs 分類已由 runPipeline 接手 new 狀態
          runPipeline(user.id)
            .catch(err => console.error(`[CRON] pipeline user ${user.id}:`, err.message));
        }
      }

      // 自動封存：完成滿一個月的任務移出主列表（冪等）
      await autoArchiveDone().catch(err => console.error('[CRON] auto-archive:', err.message));

      // Nightly env shutdown
      const shutdownTime = process.env.ODOO_ENV_SHUTDOWN_TIME || '23:00';
      const [sh, sm] = shutdownTime.split(':').map(Number);
      const nowDate = new Date();
      if (nowDate.getHours() === sh && nowDate.getMinutes() === sm) {
        const { nightlyShutdown } = require('./pipeline/env-agent');
        nightlyShutdown().catch(err => console.error('[CRON] nightly shutdown:', err.message));
      }
    } catch (err) {
      console.error('[CRON] tick error:', err.message);
    }
  });
  return _job;
}

function stopCron() {
  if (_job) { _job.stop(); _job = null; }
}

module.exports = { startCron, stopCron, runForUser, autoArchiveDone };
