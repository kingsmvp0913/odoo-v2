/**
 * 夜間改善批次的「今晚已經跑過」必須撐得過重啟。
 *
 * 真實事故形狀：批次只要有合併就會呼叫 nightly-fix.js 的 restartSelf()（docker restart 自己的
 * 容器）。旗標若只存在記憶體，新 process 讀到 null，同一晚 22:00 之後的下一個 tick 立刻開第二批；
 * 第二批的候選來源只看 status='approved'，於是剛剛失敗的那一條被重新統整、重新改碼一遍——
 * 白花錢之外，noteFailedAttempt 會在同一晚把 fix_attempts 加兩次，NIGHTLY_FIX_MAX_ATTEMPTS=3
 * 的三振額度用一半的夜數就燒完，候選被提前退回人工。
 */
const { newDb } = require('pg-mem');

jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../pipeline/sync', () => ({
  syncUser: jest.fn().mockResolvedValue({ odoo: { added: 0 }, service: { added: 0 } })
}));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ processed: 0 }) }));
jest.mock('../pipeline/usage-gate', () => ({ evaluateAndNotify: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/env-agent', () => ({
  nightlyShutdown: jest.fn().mockResolvedValue(undefined),
  sweepIdleEnvs: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/health-check-runner', () => ({
  runAudit: jest.fn().mockResolvedValue(undefined),
  auditWindowStart: jest.fn().mockResolvedValue(new Date('2026-08-24T14:00:00.000Z')),
  resumeInterruptedRuns: jest.fn().mockResolvedValue(0)
}));
jest.mock('../pipeline/nightly-fix', () => ({
  runNightlyFix: jest.fn().mockResolvedValue({ attempted: 0, applied: 0, skipped: 0 })
}));
// 平台 DB 備份：tick 過了臺灣 04:00 就會觸發。測試進程繼承容器環境（夜間改善在平台行程底下跑測試時
// DATABASE_URL 是真的），不 mock 就會真的 pg_dump 正式 DB 寫進 data/backups/。只換掉會動外部的那一支。
jest.mock('../lib/platform-backup', () => ({
  ...jest.requireActual('../lib/platform-backup'),
  runDailyBackup: jest.fn().mockResolvedValue({ skipped: true })
}));

// 臺灣時間 2026-08-25 23:00（已過 HEALTH_CHECK_HOUR=22）
const NIGHT = '2026-08-25T15:00:00.000Z';

let memDb, PgPool, dbModule;

// 模擬「平台重啟」：清掉全部模組狀態重新載入，但 DB 是同一份 pg-mem。
// 這正是 restartSelf() 之後的狀態——記憶體全新、資料還在。
function loadCron() {
  jest.resetModules();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new PgPool());
  return { cron: require('../cron'), nightlyFix: require('../pipeline/nightly-fix'), nodeCron: require('node-cron') };
}

// 值班牌（dispatcher_lease）的持有者字串綁行程，重新載入模組＝換一個持有者，TTL 沒到就搶不到牌、
// tick 會在搶牌那關提早結束。每次「重啟」後清掉那一列，讓新 process 立刻值班——否則測出來的
// 「沒有第二批」是假綠（真正的原因是整個 tick 根本沒跑）。
async function clearLease() {
  await dbModule.query('DELETE FROM dispatcher_lease');
}

async function runTickAt(mods, iso) {
  mods.cron._setClockForTesting(() => new Date(iso));
  mods.cron.startCron();
  const tick = mods.nodeCron.schedule.mock.calls.at(-1)[1];
  try { await tick(); } finally { mods.cron.stopCron(); mods.cron._setClockForTesting(null); }
}

beforeAll(async () => {
  memDb = newDb();
  PgPool = memDb.adapters.createPg().Pool;
  dbModule = require('../db');
  dbModule._setPoolForTesting(new PgPool());
  await dbModule.migrate();
  // 今天的健檢已經跑完（due=false）→ 走批次自己那條獨立觸發分支
  await dbModule.query(
    "INSERT INTO health_check_runs (status, window_days, created_at, finished_at) VALUES ('done',30,'2026-08-25T14:30:00.000Z','2026-08-25T14:30:00.000Z')"
  );
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('migrate 加 teams_settings.nightly_fix_last_day 欄位（夜間批次的跨重啟節流記號）', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='teams_settings' AND column_name='nightly_fix_last_day'"
  );
  expect(rows.length).toBe(1);
});

test('夜間批次觸發後，「今晚跑過了」寫進 DB 而不是只留在記憶體', async () => {
  const mods = loadCron();
  await clearLease();
  await mods.cron._resetNightlyFixStateForTesting();
  await runTickAt(mods, NIGHT);

  expect(mods.nightlyFix.runNightlyFix).toHaveBeenCalledWith({ startedBy: null });
  const { rows } = await dbModule.query('SELECT nightly_fix_last_day FROM teams_settings WHERE id = 1');
  expect(rows[0].nightly_fix_last_day).toBe('2026-8-25');
});

test('批次合併後重啟：新 process 同一晚不再開第二批', async () => {
  const first = loadCron();
  await clearLease();
  await first.cron._resetNightlyFixStateForTesting();
  await runTickAt(first, NIGHT);
  expect(first.nightlyFix.runNightlyFix).toHaveBeenCalledTimes(1);

  // restartSelf() 之後的新 process：記憶體歸零，DB 還在
  const restarted = loadCron();
  await clearLease();
  await runTickAt(restarted, NIGHT);

  expect(restarted.nightlyFix.runNightlyFix).not.toHaveBeenCalled();
});
