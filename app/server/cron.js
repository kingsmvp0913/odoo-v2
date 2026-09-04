const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { query } = require('./db');
const { syncUser } = require('./pipeline/sync');
const { runPipeline } = require('./pipeline/runner');
const { acquireDispatchLease } = require('./dispatch-lease');
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
    // 維護中連同步都跳過：同步進來的新任務會立刻變成待派工，等維護結束一次湧出
    if (await require('./pipeline/maintenance').isMaintenance()) return;
    const result = await syncUser(userId);
    const total = result.odoo.added + result.service.added;
    if (total > 0) {
      notify.emitToUser(userId, 'task:synced', { count: total });
    }
    if (!skipPipeline) await runPipeline(userId, { auto: true });
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

// deploy／E2E 失敗 log（data/logs 下的 *.log）過去無任何清理機制——每失敗一次留一檔、永不回收。
// 掃 DEPLOY_LOG_DIR／E2E_LOG_DIR（預設同為 data/logs），刪 mtime 超過保留期的 .log。同步 fs 但檔量小、每小時一次。
const DEPLOY_LOG_RETENTION_DAYS = parseInt(process.env.DEPLOY_LOG_RETENTION_DAYS || '14', 10);
function cleanupOldDeployLogs() {
  const dirs = [...new Set([
    process.env.DEPLOY_LOG_DIR || path.join(__dirname, '..', '..', 'data', 'logs'),
    process.env.E2E_LOG_DIR || path.join(__dirname, '..', '..', 'data', 'logs'),
  ])];
  const cutoff = Date.now() - DEPLOY_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; } // 目錄不存在＝還沒產生過 log，略過
    for (const f of files) {
      if (!f.endsWith('.log')) continue;
      const fp = path.join(dir, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.rmSync(fp, { force: true }); } catch { /* 併發刪除/權限：best-effort */ }
    }
  }
}

// token_usage 每個 pipeline 關卡 INSERT 一列、只增不減（是計費歷史，刻意不隨任務刪）。
// 報表要長歷史故保留期設大（預設 180 天，env 可調）；只裁掉超過保留期的明細，避免單調暴增。
const TOKEN_USAGE_RETENTION_DAYS = parseInt(process.env.TOKEN_USAGE_RETENTION_DAYS || '180', 10);
async function cleanupOldTokenUsage() {
  const cutoff = new Date(Date.now() - TOKEN_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return query('DELETE FROM token_usage WHERE recorded_at < $1', [cutoff]);
}

// user_inbox 每個「輪到你」／「被退回」事件 INSERT 一列，過去 0 個 DELETE、無 TTL。
// 只裁已讀的：未讀代表還沒被看到（不管多舊），延後中的 read_at 也是 NULL，兩者都不能動。
// 以 read_at 而非 created_at 計期：一列若昨天才被讀到，它昨天才剛完成它的任務。
const INBOX_RETENTION_DAYS = parseInt(process.env.INBOX_RETENTION_DAYS || '90', 10);
async function cleanupOldInboxRows() {
  const cutoff = new Date(Date.now() - INBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return query('DELETE FROM user_inbox WHERE read_at IS NOT NULL AND read_at < $1', [cutoff]);
}

let _tickRunning = false;   // node-cron 不擋前一 tick 未結束就開下一個；重入會重複分類退回、重複觸發關機
let _clockForTesting = null;
let _lastShutdownDay = null; // 同一天只觸發一次夜間關機（過了預定時刻才補跑，見 tick 內說明）
let _lastArchiveDay = null;  // 同一天只封存一次（同上，過了預定時刻才補跑）
let _lastIdleSweepAt = 0; // 閒置掃描節流：tick 每分鐘跑，掃描只需每 10 分鐘一次
const IDLE_SWEEP_INTERVAL_MS = parseInt(process.env.ENV_IDLE_SWEEP_INTERVAL_MS || '600000', 10);

// 語意索引補算：觸發點共九處（wiki 五處、analysis_yaml 四處），漏掛任何一處的症狀是
// 那條路徑寫進去的內容永遠搜不到，而且沒有任何訊號。這一輪掃過去就會補上，是那九處的安全網。
// 只在夜間跑：補算要跑推論，而推論只有一個 worker，白天做會跟使用者的查詢搶。0 = 停用。
let _lastEmbeddingSweepAt = 0;
const EMBEDDING_SWEEP_INTERVAL_MS = parseInt(process.env.EMBEDDING_SWEEP_INTERVAL_MS || String(86400000), 10);
const EMBEDDING_SWEEP_HOUR = parseInt(process.env.EMBEDDING_SWEEP_HOUR || '3', 10);

// 工作流程健檢固定在臺灣時間每日 22:00 跑（Phase 7.3：23→22，騰出一小時給健檢完接著跑的
// 夜間批次 nightly-fix，讓它在 NIGHTLY_FIX_DEADLINE_HOUR=02:00 前有更完整的跑道）。
// 不能用「上一輪 + 24 小時」：手動健檢或第一次啟動的時刻會把排程永久帶到下午等非預期時段。
// 0 = 停用。
const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || String(86400000), 10);
const HEALTH_CHECK_TIME_ZONE = 'Asia/Taipei';
const HEALTH_CHECK_HOUR = 22;

function taipeiDateParts(now) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: HEALTH_CHECK_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
  }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  // hour 只有自動封存在用；健檢那幾處只取年月日。24 是 en-US 對午夜的表示法，正規化成 0。
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour) % 24 };
}

// 完成滿 30 天才封存——這個條件一天之內不會有意義的變化，而原本每分鐘掃一次全表，
// 等於一天 1440 次註定沒有結果的 UPDATE。改成臺灣時間每日一次。
const AUTO_ARCHIVE_HOUR = parseInt(process.env.AUTO_ARCHIVE_HOUR || '1', 10);

function autoArchiveNextRunAt(now) {
  const { year, month, day, hour } = taipeiDateParts(now);
  // 今天的時刻已經過了就排明天：日期用 UTC 建再加天數，跨月與跨年由 Date 自己處理。
  const target = new Date(Date.UTC(year, month - 1, day + (hour >= AUTO_ARCHIVE_HOUR ? 1 : 0)));
  return new Date(`${target.toISOString().slice(0, 10)}T${String(AUTO_ARCHIVE_HOUR).padStart(2, '0')}:00:00+08:00`).toISOString();
}

function healthCheckTargetAt(now, dayOffset = 0) {
  const { year, month, day } = taipeiDateParts(now);
  const targetDay = new Date(Date.UTC(year, month - 1, day + dayOffset));
  const date = targetDay.toISOString().slice(0, 10);
  return new Date(`${date}T${String(HEALTH_CHECK_HOUR).padStart(2, '0')}:00:00+08:00`);
}

// 大健檢的節奏：每月 1 號回看 30 天（並額外做趨勢比對）、每週日回看 7 天，其餘日子維持增量視窗。
// 每天只有一個 HEALTH_CHECK_HOUR slot、due 每天也只會成立一次，所以「跑大健檢的那天就不跑當天的日健檢」
// 是天然互斥，不需要另外的抑制旗標。1 號剛好是週日時只跑 30 天那一份（大的吃掉小的）：同一個
// slot 連跑兩輪的話，先完成的那一輪會把 auditWindowStart 推到現在，後一輪等於掃到空視窗。
const HEALTH_CADENCE_DAYS = { weekly: 7, monthly: 30 };

function healthCheckCadence(now = _clockForTesting ? _clockForTesting() : new Date()) {
  const { year, month, day } = taipeiDateParts(now);
  if (day === 1) return 'monthly';
  // 用 UTC 建當天零點再取星期：taipeiDateParts 已把日期轉成臺灣當地的年月日，再套本機時區會漂掉一天
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0) return 'weekly';
  return 'daily';
}

// 排程判斷與健檢頁的「下次執行時間」共用，避免兩邊各算而漂移。晚於 HEALTH_CHECK_HOUR 但尚未跑過
// 當日自動健檢時，下一個 tick 會補跑；server 重啟或前一 tick 被略過也不會漏掉整天。
async function getHealthCheckSchedule(now = _clockForTesting ? _clockForTesting() : new Date()) {
  const intervalMs = HEALTH_CHECK_INTERVAL_MS;
  if (intervalMs <= 0) return { enabled: false, intervalMs, lastRunAt: null, nextRunAt: null, running: false, due: false };
  // 只認 cron 建的全平台健檢。task_db_id 排除單張任務健檢；started_by 排除 admin 手動全平台健檢，
  // 所以人工診斷不會重設晚上 HEALTH_CHECK_HOUR 的自動排程。
  const { rows } = await query(
    'SELECT status, created_at FROM health_check_runs WHERE task_db_id IS NULL AND started_by IS NULL ORDER BY id DESC LIMIT 1'
  );
  const last = rows[0];
  const lastRunAt = last && new Date(last.created_at);
  if (last && last.status === 'running') {
    return { enabled: true, intervalMs, lastRunAt: lastRunAt.toISOString(), nextRunAt: null, running: true, due: false };
  }

  const todayTarget = healthCheckTargetAt(now);
  const due = now.getTime() >= todayTarget.getTime() && (!lastRunAt || lastRunAt.getTime() < todayTarget.getTime());
  const nextRunAt = due ? null : (now.getTime() < todayTarget.getTime() ? todayTarget : healthCheckTargetAt(now, 1));
  return {
    enabled: true, intervalMs,
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    running: false,
    due,
  };
}

async function shouldRunHealthCheck() {
  const s = await getHealthCheckSchedule();
  return s.due;
}

function nextMinuteAt(now) {
  return new Date(Math.floor(now.getTime() / 60000 + 1) * 60000).toISOString();
}

function minuteLabel(ms) {
  const minutes = Math.round(ms / 60000);
  return minutes % 60 === 0 ? `每 ${minutes / 60} 小時` : `每 ${minutes} 分鐘`;
}

// 管理工具的排程清單：cron 內的行為才列入，不把 API 的人工觸發誤寫成排程。
// 各使用者同步與閒置回收的精確下次時間只存在記憶體且各自不同，因此明確標示無單一時刻。
async function getCronSchedules(now = new Date()) {
  const settings = await getGlobalSettings();
  const testMode = !!settings.test_mode;
  const health = await getHealthCheckSchedule(now);
  const shutdownTime = process.env.ODOO_ENV_SHUTDOWN_TIME || '23:00';
  const shutdownTz = process.env.ODOO_ENV_SHUTDOWN_TZ || '伺服器本機時區';
  const hourlyAt = new Date(now);
  hourlyAt.setMinutes(0, 0, 0);
  hourlyAt.setHours(hourlyAt.getHours() + 1);
  return [
    { id: 'cron-tick', name: '排程主迴圈', timing: '每分鐘', enabled: true, nextRunAt: nextMinuteAt(now), note: '所有背景工作的派送入口。' },
    { id: 'usage-gate', name: '用量閘門檢查', timing: '每分鐘', enabled: true, nextRunAt: nextMinuteAt(now), note: '跨過用量門檻時發出通知。' },
    { id: 'odoo-sync', name: 'Odoo 任務同步', timing: settings.odoo_sync_interval > 0 ? minuteLabel(settings.odoo_sync_interval * 60000) : '已停用', enabled: settings.odoo_sync_interval > 0, nextRunAt: null, note: '依每位使用者上次同步時間分別計算。' },
    { id: 'service-sync', name: 'Service 任務同步', timing: settings.service_sync_interval > 0 ? minuteLabel(settings.service_sync_interval * 60000) : '已停用', enabled: settings.service_sync_interval > 0, nextRunAt: null, note: '依每位使用者上次同步時間分別計算。' },
    { id: 'pipeline', name: 'Pipeline 自動推進', timing: '每分鐘', enabled: !testMode, nextRunAt: !testMode ? nextMinuteAt(now) : null, note: testMode ? '測試模式已停用自動推進。' : '同步未執行時仍會推進可執行任務。' },
    { id: 'health-check', name: '工作流程健檢', timing: '每日 22:00（臺灣時間）；週日回看 7 天、每月 1 號回看 30 天；跑完接著觸發夜間批次', enabled: health.enabled, nextRunAt: health.nextRunAt, note: health.running ? '本輪執行中。' : (health.due ? '已到排程時刻，下一個 cron tick 會補跑。' : '大健檢當天不另跑當日健檢；手動健檢不影響此排程。') },
    { id: 'nightly-shutdown', name: '測試區夜間關機', timing: `每日 ${shutdownTime}（${shutdownTz}）`, enabled: true, nextRunAt: null, note: '每天只執行一次；若錯過整點，之後的 tick 會補跑。' },
    { id: 'idle-sweep', name: '閒置測試區回收', timing: minuteLabel(IDLE_SWEEP_INTERVAL_MS), enabled: IDLE_SWEEP_INTERVAL_MS > 0, nextRunAt: null, note: '只回收沒有進行中任務的測試區。' },
    { id: 'hourly-maintenance', name: '每小時維護', timing: '每小時整點', enabled: true, nextRunAt: hourlyAt.toISOString(), note: '清理過期事件、log、token 用量與收件匣；非測試模式時套用已分類 wiki 漂移。' },
    { id: 'classification', name: '退回與 wiki 漂移分類', timing: '每分鐘', enabled: !testMode, nextRunAt: !testMode ? nextMinuteAt(now) : null, note: testMode ? '測試模式已停用分類。' : '每次僅處理小批待分類資料。' },
    { id: 'auto-archive', name: '完成任務自動封存', timing: `每日 ${String(AUTO_ARCHIVE_HOUR).padStart(2, '0')}:00（臺灣時間）`, enabled: true, nextRunAt: autoArchiveNextRunAt(now), note: '封存完成已滿 30 天的任務；錯過整點會由之後的 tick 補跑。' },
    { id: 'embedding-sweep', name: '語意索引補算', timing: `每日 ${String(EMBEDDING_SWEEP_HOUR).padStart(2, '0')}:00（伺服器本機時區）`, enabled: !testMode && EMBEDDING_SWEEP_INTERVAL_MS > 0, nextRunAt: null, note: !testMode && EMBEDDING_SWEEP_INTERVAL_MS > 0 ? '僅在向量模型可用時執行。' : '測試模式或設定已停用。' }
  ];
}

function startCron() {
  _job = cron.schedule('* * * * *', async () => {
    if (_tickRunning) return;
    _tickRunning = true;
    try {
      // 單一派工者：搶不到值班牌就整個 tick 不做事（見 dispatch-lease.js）。
      // ⚠ 這是本檔唯一一個「共用的提前結束」，且與下方刻意避免的那種 early return 性質不同：
      // 那些是「某項工作失敗／被關閉」不該連坐其他工作；這裡是「本行程根本不該是值班者」——
      // 同步撈單、自動封存、夜間關機、閒置回收、wiki 分類全部都只能由值班者做一次，
      // 否則就是今天那個事故：兩個行程對同一個 DB 把整組排程副作用各做一遍。
      if (!(await acquireDispatchLease())) return;

      const intervals = await getGlobalSettings();
      // 必須是 ?? 而非 ||：管理員設定頁明寫「同步間隔（分鐘，0 停用）」，而 0 || 60 會算成 60
      // ——使用者以為關掉了，實際照樣每小時撈單，且畫面顯示的 0 看起來完全正常。
      // 只有未設定（NULL）才退回預設 60。
      const odooMs    = (intervals.odoo_sync_interval ?? 60) * 60000;
      const serviceMs = (intervals.service_sync_interval ?? 60) * 60000;
      const testMode  = !!intervals.test_mode;

      // 用量閘門：每 tick 評估一次，未 blocked→blocked 的邊緣發一次通知（旁路，失敗只記 log）
      try {
        const { evaluateAndNotify } = require('./pipeline/usage-gate');
        await evaluateAndNotify();
      } catch (err) { console.error('[CRON] usage-gate:', err.message); }

      // Nightly env shutdown。時區：預設 server 本機；容器跑 UTC 而維運預期台灣時間時，
      // 設 ODOO_ENV_SHUTDOWN_TZ=Asia/Taipei（IANA 名稱）即可，不必動系統 TZ。
      const shutdownTime = process.env.ODOO_ENV_SHUTDOWN_TIME || '23:00';
      const [sh, sm] = shutdownTime.split(':').map(Number);
      const tz = process.env.ODOO_ENV_SHUTDOWN_TZ || '';
      const nowDate = new Date();
      let curH = nowDate.getHours(), curM = nowDate.getMinutes();
      let dayKey = `${nowDate.getFullYear()}-${nowDate.getMonth()}-${nowDate.getDate()}`;
      if (tz) {
        try {
          const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(nowDate);
          [curH, curM] = parts.split(':').map(Number);
          // 日界線也要用同一個時區算，否則跨午夜時「今天」的認定會與時／分不同源
          dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(nowDate);
        } catch (e) { console.error('[CRON] 無效的 ODOO_ENV_SHUTDOWN_TZ，退回本機時區:', e.message); }
      }
      // 條件是「過了預定時刻且今天還沒關過」，不是「剛好落在那一分鐘」。同一個 tick 內
      // classifyPendingRejections 每筆要跑一次 runClaude，有積壓時輕易超過 60 秒，下一個 tick 直接
      // 撞 `if (_tickRunning) return`——被跳過的若正是 23:00 那一分鐘，當天就整天不關機而且沒有補跑
      // （閒置回收已於 2026-08-07 預設關閉，兜底只剩 MAX_LIFETIME_HOURS=20）。
      if (curH * 60 + curM >= sh * 60 + sm && _lastShutdownDay !== dayKey) {
        _lastShutdownDay = dayKey;
        const { nightlyShutdown } = require('./pipeline/env-agent');
        nightlyShutdown().catch(err => console.error('[CRON] nightly shutdown:', err.message));
      }

      // 閒置測試區回收：釋放 port 租約，讓小段埠能支撐大量專案。與夜間關機互不重疊
      // （後者是全面清場，此處只收閒置的），兩者都跳過有進行中任務的專案。
      if (Date.now() - _lastIdleSweepAt >= IDLE_SWEEP_INTERVAL_MS) {
        _lastIdleSweepAt = Date.now();
        const { sweepIdleEnvs } = require('./pipeline/env-agent');
        sweepIdleEnvs().catch(err => console.error('[CRON] idle sweep:', err.message));
      }

      // 每日系統健檢（fire-and-forget，比照 admin 手動觸發那條路徑）。
      // 獨立 try：健檢排程壞掉不得連坐同步／關機／回收——本檔刻意不共用 early return。
      try {
        if (await shouldRunHealthCheck()) {
          const { runAudit, auditWindowStart } = require('./pipeline/health-check-runner');
          const cadence = healthCheckCadence();
          const fixedDays = HEALTH_CADENCE_DAYS[cadence];
          const sinceAt = fixedDays ? new Date(Date.now() - fixedDays * 86400000) : await auditWindowStart();
          const windowDays = Math.max(1, Math.round((Date.now() - sinceAt.getTime()) / 86400000));
          const { rows: [run] } = await query(
            "INSERT INTO health_check_runs (status, window_days, started_by, since_at, cadence) VALUES ('running',$1,NULL,$2,$3) RETURNING id",
            [windowDays, sinceAt, cadence]
          );
          console.log(`[CRON] 啟動系統健檢 run ${run.id}（${cadence}，視窗自 ${sinceAt.toISOString()}）`);
          // 健檢跑完（不論成功失敗）才觸發夜間批次：runNightlyFix 自己重撈 DB 裡所有 approved
          // 候選（意見回饋＋健檢提案），不是只吃這一輪 runAudit 的產出，所以健檢這輪失敗
          // 不影響候選池的完整性——沒有理由因為當晚健檢掛了就連帶跳過整條修正通道。
          // 用 .finally 而非序列化 await：runAudit 是背景長工（20+ 個 opus），cron tick 本身
          // 不等它，nightly-fix 的觸發要接在 runAudit 的 promise chain 尾端、不是 tick 主體內。
          runAudit(run.id, { sinceAt, cadence })
            .catch(err => console.error('[CRON] health check:', err.message))
            .finally(() => {
              const { runNightlyFix } = require('./pipeline/nightly-fix');
              // startedBy: null＝系統自動排程觸發（比照上面 health_check_runs 的 started_by），
              // 與 admin 手動觸發區分——getHealthCheckSchedule 等排程判斷同樣只認 started_by IS NULL。
              runNightlyFix({ startedBy: null })
                .catch(err => console.error('[CRON] nightly fix:', err.message));
            });
        }
      } catch (err) { console.error('[CRON] health check schedule:', err.message); }

      // 這裡刻意沒有「兩個同步都關就 return」的提前結束。關閉同步是「不要去外部撈單」，與
      // 「要不要推進 pipeline」「要不要做清理排程」「要不要管理測試區」都無關——共用一個 return
      // 會讓管理員把同步關掉的同時，整個平台停止推進任務（任務凍在原狀態）、自動封存與各項清理
      // 也一起停掉，而症狀完全不指向同步設定。
      // 不需要額外的守衛：下面每個 user 的 shouldSyncOdoo／shouldSyncService 各自帶 `> 0` 判斷，
      // 兩個間隔都是 0 時自然全部落到 else 分支（只推進 pipeline、不撈單）。
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
          runPipeline(user.id, { auto: true })
            .catch(err => console.error(`[CRON] pipeline user ${user.id}:`, err.message));
        }
      }

      // 自動封存：完成滿一個月的任務移出主列表（冪等）。臺灣時間每日 AUTO_ARCHIVE_HOUR 點一次；
      // 判斷是「過了那個鐘點且今天還沒跑」而不是「剛好落在那一分鐘」——tick 被上一輪佔住時
      // （分類每筆要跑一次 runClaude，積壓時輕易超過 60 秒）那一分鐘會整個被跳過。
      const archiveNow = _clockForTesting ? _clockForTesting() : new Date();
      const archiveParts = taipeiDateParts(archiveNow);
      const archiveDayKey = `${archiveParts.year}-${archiveParts.month}-${archiveParts.day}`;
      if (archiveParts.hour >= AUTO_ARCHIVE_HOUR && _lastArchiveDay !== archiveDayKey) {
        _lastArchiveDay = archiveDayKey;
        await autoArchiveDone().catch(err => console.error('[CRON] auto-archive:', err.message));
      }

      // 每小時第 0 分清一次過期 task_events／deploy-E2E log 檔／token_usage（冪等；重入鎖已保證單飛）
      if (new Date().getMinutes() === 0) {
        await cleanupOldTaskEvents().catch(err => console.error('[CRON] events-cleanup:', err.message));
        try { cleanupOldDeployLogs(); } catch (err) { console.error('[CRON] deploy-log-cleanup:', err.message); }
        await cleanupOldTokenUsage().catch(err => console.error('[CRON] token-usage-cleanup:', err.message));
        await cleanupOldInboxRows().catch(err => console.error('[CRON] inbox-cleanup:', err.message));
        // 每小時把已分類的 wiki 漂移套用成「從程式碼重生該頁」的更新（獨立 runner；同頁去重不重複更新）
        if (!testMode) {
          const { applyPendingWikiDrift } = require('./pipeline/wiki-drift-runner');
          await applyPendingWikiDrift().catch(err => console.error('[CRON] wiki-drift-apply:', err.message));
        }
      }

      // 退回原因慢慢整理：每 tick 撈一小批 status='new' 的退回跑分類 agent（工作流程健檢子專案 1）
      if (!testMode) {
        const { classifyPendingRejections } = require('./pipeline/classify-rejections');
        await classifyPendingRejections().catch(err => console.error('[CRON] reject-classify:', err.message));
        // 同理：chat／cs 回報的「wiki 頁與程式碼漂移」慢慢分類，供健檢彙整
        const { classifyPendingWikiDrift } = require('./pipeline/wiki-drift');
        await classifyPendingWikiDrift().catch(err => console.error('[CRON] wiki-drift-classify:', err.message));
      }

      // 語意索引補算（見檔頭常數處的說明）。模型沒就緒就跳過——那代表向量腿本來就是關的，
      // 硬跑只會把失敗計數推到停用門檻。
      if (!testMode && EMBEDDING_SWEEP_INTERVAL_MS > 0
          && new Date().getHours() === EMBEDDING_SWEEP_HOUR
          && Date.now() - _lastEmbeddingSweepAt >= EMBEDDING_SWEEP_INTERVAL_MS) {
        _lastEmbeddingSweepAt = Date.now();
        const embedding = require('./lib/embedding');
        if (embedding.isReady()) {
          const { sweepStale } = require('./lib/embedding-index');
          await sweepStale()
            .then(n => { if (n) console.log(`[CRON] 語意索引補算 ${n} 筆`); })
            .catch(err => console.error('[CRON] embedding-sweep:', err.message));
        }
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

// 測試用：「今天已經關過機」是模組層變數，跨 test 累積。補跑改成「過了預定時刻就跑」之後，
// 任何在 23:00 之後跑的 tick 都會把當天用掉——不重設的話，補跑那支測試在晚上執行會假紅。
function _resetShutdownStateForTesting() { _lastShutdownDay = null; }
function _resetArchiveStateForTesting() { _lastArchiveDay = null; }
function _setClockForTesting(clock) { _clockForTesting = clock; }

module.exports = { startCron, stopCron, runForUser, autoArchiveDone, cleanupOldTaskEvents, cleanupOldDeployLogs, cleanupOldTokenUsage, cleanupOldInboxRows, getHealthCheckSchedule, healthCheckCadence, getCronSchedules, _resetShutdownStateForTesting, _resetArchiveStateForTesting, _setClockForTesting };
