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

// task_events（agent 終端輸出回放）無上限成長；done/stopped 滿保留期的任務清掉 events。
// stopped 任務仍可 resume，但滿 N 天未動的 stopped 已屬棄置，回放價值低於磁碟成本。
const TASK_EVENTS_RETENTION_DAYS = parseInt(process.env.TASK_EVENTS_RETENTION_DAYS || '30', 10);
async function cleanupOldTaskEvents() {
  const cutoff = new Date(Date.now() - TASK_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return query(
    `DELETE FROM task_events WHERE task_id IN (
       SELECT id FROM tasks WHERE status IN ('done','stopped') AND updated_at < $1
     )`,
    [cutoff]
  );
}

let _tickRunning = false;   // node-cron 不擋前一 tick 未結束就開下一個；重入會重複分類退回、重複觸發關機
let _lastShutdownMinute = null; // 同一分鐘只觸發一次夜間關機（tick 延遲時的重複防護）

function startCron() {
  _job = cron.schedule('* * * * *', async () => {
    if (_tickRunning) return;
    _tickRunning = true;
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

      // 每小時第 0 分清一次過期 task_events（冪等；重入鎖已保證單飛）
      if (new Date().getMinutes() === 0) {
        await cleanupOldTaskEvents().catch(err => console.error('[CRON] events-cleanup:', err.message));
      }

      // 退回原因慢慢整理：每 tick 撈一小批 status='new' 的退回跑分類 agent（工作流程健檢子專案 1）
      if (!testMode) {
        const { classifyPendingRejections } = require('./pipeline/classify-rejections');
        await classifyPendingRejections().catch(err => console.error('[CRON] reject-classify:', err.message));
      }

      // Nightly env shutdown。時區：預設 server 本機；容器跑 UTC 而維運預期台灣時間時，
      // 設 ODOO_ENV_SHUTDOWN_TZ=Asia/Taipei（IANA 名稱）即可，不必動系統 TZ。
      const shutdownTime = process.env.ODOO_ENV_SHUTDOWN_TIME || '23:00';
      const [sh, sm] = shutdownTime.split(':').map(Number);
      const tz = process.env.ODOO_ENV_SHUTDOWN_TZ || '';
      const nowDate = new Date();
      let curH = nowDate.getHours(), curM = nowDate.getMinutes();
      if (tz) {
        try {
          const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(nowDate);
          [curH, curM] = parts.split(':').map(Number);
        } catch (e) { console.error('[CRON] 無效的 ODOO_ENV_SHUTDOWN_TZ，退回本機時區:', e.message); }
      }
      const minuteKey = `${nowDate.getFullYear()}-${nowDate.getMonth()}-${nowDate.getDate()} ${curH}:${curM}`;
      if (curH === sh && curM === sm && _lastShutdownMinute !== minuteKey) {
        _lastShutdownMinute = minuteKey;
        const { nightlyShutdown } = require('./pipeline/env-agent');
        nightlyShutdown().catch(err => console.error('[CRON] nightly shutdown:', err.message));
      }
    } catch (err) {
      console.error('[CRON] tick error:', err.message);
    } finally {
      _tickRunning = false;
    }
  });
  return _job;
}

function stopCron() {
  if (_job) { _job.stop(); _job = null; }
}

module.exports = { startCron, stopCron, runForUser, autoArchiveDone, cleanupOldTaskEvents };
