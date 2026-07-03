const cron = require('node-cron');
const { query } = require('./db');
const { syncUser } = require('./pipeline/sync');
const { triageNewTasks } = require('./pipeline/triage');
const { runPipeline, resetLoopCounter } = require('./pipeline/runner');
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
      await resetLoopCounter(userId);
    }
    await triageNewTasks(userId);
    if (!skipPipeline) await runPipeline(userId);
  } catch (err) {
    console.error(`[CRON] user ${userId}:`, err.message);
  }
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
          // 每分鐘仍推進 pipeline（不同步）
          triageNewTasks(user.id)
            .then(() => runPipeline(user.id))
            .catch(err => console.error(`[CRON] pipeline user ${user.id}:`, err.message));
        }
      }

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

module.exports = { startCron, stopCron, runForUser };
