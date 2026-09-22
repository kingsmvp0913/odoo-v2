// 意圖：這一支釘住的是「更版機制自己會動」的那條路徑，而它的每一種出錯都是靜默的——
// 沒有人會收到通知（這台沒有 webhook／Teams），只會在某個週一發現平台跑著舊碼，或是發現
// 客戶被無緣無故踢下線。所以這裡的斷言按「會發生什麼壞事」排，不是按函式分支排：
//   (1) 沒設定時段就什麼都不做——「預設每週六日自動重啟」是沒有人按下同意的行為；
//   (2) 不在時段內不動——上班時間把人踢下線；
//   (3) 沒有待更版的碼就不重啟——本子專案存在的理由就是這起事故；
//   (4) 同一場時段不會觸發第二次——旗標若在記憶體，重啟會把它帶走，同一場無限重啟；
//   (5) 在飛任務：還早就等、快結束才中止——中止太早＝白殺本來跑得完的任務，
//       太晚＝任務殺了時段也錯過，兩頭皆空；
//   (6) 全跑紅了不重啟，而且理由要留得下來讓事後查得到（裁決二的唯一落點）。
// ⚠ measureTests 一定要 mock：它會真的 spawn 一次 `npm run test:quiet`，症狀是整支跑不完（hang）
// 而不是紅燈。
const { newDb } = require('pg-mem');

const mockExecFile = jest.fn((cmd, args, cb) => cb && cb(null, { stdout: '', stderr: '' }));
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));

const mockSelfContainer = jest.fn();
const mockMeasure = jest.fn();
jest.mock('../pipeline/finding-fix', () => ({
  selfContainerName: (...a) => mockSelfContainer(...a),
  measureTests: (...a) => mockMeasure(...a),
}));

// runner 提供「誰在飛」與「怎麼中止」。runPipeline 是 cron tick 那一支測試要用的。
const mockInflight = jest.fn(() => []);
const mockAbort = jest.fn();
jest.mock('../pipeline/runner', () => ({
  getInflightInfo: (...a) => mockInflight(...a),
  abortTask: (...a) => mockAbort(...a),
  getInflightTaskIds: () => [],
  runPipeline: jest.fn().mockResolvedValue({ processed: 0 }),
}));

// 以下只為了讓 cron.js 那一支測試能真的跑一次 tick 而不碰外部世界（比照 cron.test.js）。
jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../pipeline/sync', () => ({ syncUser: jest.fn().mockResolvedValue({ odoo: { added: 0 }, service: { added: 0 } }) }));
jest.mock('../pipeline/usage-gate', () => ({ evaluateAndNotify: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/env-agent', () => ({
  nightlyShutdown: jest.fn().mockResolvedValue(undefined),
  sweepIdleEnvs: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../pipeline/health-check-runner', () => ({
  runAudit: jest.fn().mockResolvedValue(undefined),
  auditWindowStart: jest.fn().mockResolvedValue(new Date(Date.now() - 86400000)),
  resumeInterruptedRuns: jest.fn().mockResolvedValue(0),
}));
jest.mock('../pipeline/nightly-fix', () => ({
  runNightlyFix: jest.fn().mockResolvedValue({ attempted: 0, applied: 0, skipped: 0 }),
}));
jest.mock('../lib/platform-backup', () => ({
  ...jest.requireActual('../lib/platform-backup'),
  runDailyBackup: jest.fn().mockResolvedValue({ skipped: true }),
  describeBackups: jest.fn(() => '備份狀態說明（測試哨兵值）'),
}));

const GREEN = { ok: true, summary: 'Tests: 3 skipped, 5966 passed, 5969 total', failed: 0, passed: 5966, suiteFailed: 0 };
const RED = { ok: false, summary: 'Tests: 3 failed, 5963 passed, 5969 total', failed: 3, passed: 5963, suiteFailed: 0 };

// 已拍板的時段：每週六、日 02:00 起兩小時（02:00–04:00）。
const WINDOW = { weekdays: [6, 0], startHour: 2, durationHours: 2 };
// 用「本地時間的年月日時分」建日期，不用 ISO 字串：release-window.js 認的是機器本地時間，
// 寫死 +08:00 的話這支測試在別的時區就會假紅（而它要守的東西與時區無關）。
const at = (d, h, m) => new Date(2026, 8, d, h, m, 0);
const SAT_0230 = () => at(26, 2, 30);   // 週六 02:30，時段中段，離結束還有 90 分鐘
const SAT_0345 = () => at(26, 3, 45);   // 週六 03:45，離結束只剩 15 分鐘
const SUN_0230 = () => at(27, 2, 30);   // 隔天週日的同一場
const FRI_1000 = () => at(25, 10, 0);   // 週五上班時間

let dbModule, release, runId, taskId, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  release = require('../pipeline/release');
  const { rows: [run] } = await dbModule.query(
    `INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id`);
  runId = run.id;
  // 被中止的那張任務要是真的一列：task_logs 有 FK 指向 tasks，寫不進去的話「主人看得到什麼」
  // 這件事就測不出來（而那正是裁決三留下的唯一一個未決問題）。
  const bcrypt = require('bcryptjs');
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('releasetest',$1,'測試','user') RETURNING id",
    [await bcrypt.hash('pass', 4)]);
  userId = u.id;
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'rel_1','odoo','更版測試用','coding_running') RETURNING id",
    [userId]);
  taskId = t.id;
});
afterAll(() => dbModule._setPoolForTesting(null));

beforeEach(async () => {
  mockExecFile.mockClear();
  mockSelfContainer.mockReset();
  mockSelfContainer.mockResolvedValue('odoo-v2');
  mockMeasure.mockReset();
  mockMeasure.mockResolvedValue(GREEN);
  mockInflight.mockReset();
  mockInflight.mockReturnValue([]);
  mockAbort.mockReset();
  await dbModule.query('DELETE FROM finding_fixes');
  await dbModule.query('DELETE FROM health_check_findings');
  await dbModule.query('DELETE FROM task_logs');
  await dbModule.query(
    `INSERT INTO teams_settings (id, release_window, release_last_window, release_last_result)
     VALUES (1, NULL, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET release_window = NULL, release_last_window = NULL,
         release_last_result = NULL, maintenance_until = NULL`);
});

async function setWindow(cfg) {
  await dbModule.query('UPDATE teams_settings SET release_window = $1 WHERE id = 1',
    [cfg == null ? null : JSON.stringify(cfg)]);
}

// 一筆已合併、還沒上線的修正＝待更版
async function seedPending() {
  const { rows: [f] } = await dbModule.query(
    `INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity, kind, status)
     VALUES ($1,'__audit__','某條提案','medium','proposal','approved') RETURNING id`, [runId]);
  const { rows: [fix] } = await dbModule.query(
    `INSERT INTO finding_fixes (finding_id, status, branch) VALUES ($1,'merged',$2) RETURNING id`,
    [f.id, `fix/finding-${f.id}-1`]);
  return { findingId: f.id, fixId: fix.id };
}

// ⚠ 假時鐘要放過 setImmediate／nextTick：pg-mem 的 Pool 靠它們推進，一起假掉會讓每一句 query
// 永遠不 resolve，整支測試變成逾時而不是紅在斷言上。
const useFakeTimers = () =>
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });

const isMaintaining = () => require('../pipeline/maintenance').isMaintenance();

describe('releaseTick 的判斷順序', () => {
  test('日期前提：2026-09-26 是週六、09-27 是週日（整支測試的時段都建立在這上面）', () => {
    expect(`${SAT_0230().getDay()}/${SUN_0230().getDay()}/${FRI_1000().getDay()}`).toBe('6/0/5');
  });

  test('沒設定時段就什麼都不做——「預設每週六日自動重啟」是沒有人按下同意的行為', async () => {
    await seedPending();
    const r = await release.releaseTick({ now: SAT_0230() });
    expect(r.reason).toBe('no-window-config');
    expect(mockMeasure).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('設定壞掉（startHour 超出 0-23）一律當成沒設定：setHours 會靜默滾進隔天，算出看似合理的錯日期', async () => {
    await setWindow({ weekdays: [6], startHour: 26, durationHours: 2 });
    await seedPending();
    const r = await release.releaseTick({ now: SAT_0230() });
    expect(r.reason).toBe('no-window-config');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('不在時段內不動——週五上班時間有待更版的碼也不准重啟', async () => {
    await setWindow(WINDOW);
    await seedPending();
    const r = await release.releaseTick({ now: FRI_1000() });
    expect(r.reason).toBe('outside-window');
    expect(mockMeasure).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('在時段內但沒有待更版的碼：不重啟、連全跑都不跑（沒東西要上就不要打擾客戶）', async () => {
    await setWindow(WINDOW);
    const r = await release.releaseTick({ now: SAT_0230() });
    expect(r.reason).toBe('nothing-pending');
    expect(mockMeasure).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(await isMaintaining()).toBe(false);   // 也不該掛維護旗標把派工停掉
  });

  test('在時段內、有待更版、全跑綠：重啟，並把那一筆從待更版收掉', async () => {
    useFakeTimers();
    try {
      await setWindow(WINDOW);
      const { findingId, fixId } = await seedPending();
      const r = await release.releaseTick({ now: SAT_0230() });
      expect(`ran: ${r.ran} / restarted: ${r.restarted} / testsPassed: ${r.testsPassed}`)
        .toBe('ran: true / restarted: true / testsPassed: true');
      jest.runAllTimers();
      expect(mockExecFile.mock.calls[0].slice(0, 2)).toEqual(['docker', ['restart', 'odoo-v2']]);
      const { rows: [fix] } = await dbModule.query('SELECT status FROM finding_fixes WHERE id=$1', [fixId]);
      const { rows: [f] } = await dbModule.query('SELECT status FROM health_check_findings WHERE id=$1', [findingId]);
      expect(`${fix.status} / ${f.status}`).toBe('released / done');
    } finally { jest.useRealTimers(); }
  });

  test('同一場時段不會觸發第二次：旗標落 DB，重啟把行程帶走也還在（記憶體旗標會讓同一場無限重啟）', async () => {
    useFakeTimers();
    try {
      await setWindow(WINDOW);
      await seedPending();
      const first = await release.releaseTick({ now: SAT_0230() });
      expect(first.restarted).toBe(true);
      // 第二個 tick：晚一點，同一場時段，而且刻意再放一筆新的待更版進來——
      // 「有東西要上」不是重跑的理由，「同一場已經試過」才是判準。
      await seedPending();
      const second = await release.releaseTick({ now: at(26, 2, 40) });
      expect(second.reason).toBe('already-ran');
      jest.runAllTimers();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });

  test('旗標記的是「哪一場」不是「哪一天」：跑過週六那場，週日那場照樣要能上', async () => {
    useFakeTimers();
    try {
      await setWindow(WINDOW);
      await seedPending();
      await release.releaseTick({ now: SAT_0230() });
      await seedPending();
      const sunday = await release.releaseTick({ now: SUN_0230() });
      expect(`ran: ${sunday.ran} / restarted: ${sunday.restarted}`).toBe('ran: true / restarted: true');
      jest.runAllTimers();
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });
});

describe('在飛任務（裁決三：快結束時強制中止）', () => {
  test('離時段結束還早（剩 90 分鐘）：不中止、不重啟，等下一個 tick 讓任務自己跑完', async () => {
    await setWindow(WINDOW);
    await seedPending();
    mockInflight.mockReturnValue([{ taskId, userId, startedAt: Date.now() }]);
    const r = await release.releaseTick({ now: SAT_0230() });
    expect(`${r.reason} / inflight: ${r.inflight}`).toBe('inflight-waiting / inflight: 1');
    expect(mockAbort).not.toHaveBeenCalled();
    expect(mockMeasure).not.toHaveBeenCalled();
    // ⚠ 這一輪不算「這一場跑過了」：下一個 tick 還要再判一次，否則等於這一場被白白放棄
    expect(await release.readLastWindow()).toBeNull();
  });

  test('離時段結束只剩 15 分鐘：中止在飛任務後照常重啟', async () => {
    useFakeTimers();
    try {
      await setWindow(WINDOW);
      await seedPending();
      mockInflight.mockReturnValue([{ taskId, userId, startedAt: Date.now() }]);
      const r = await release.releaseTick({ now: SAT_0345() });
      expect(`aborted: ${r.aborted} / restarted: ${r.restarted}`).toBe(`aborted: ${taskId} / restarted: true`);
      expect(mockAbort).toHaveBeenCalledWith(taskId);
      jest.runAllTimers();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });

  test('被中止的任務要留下一句話說「會自動重跑」——那是它的主人週一早上唯一看得到的東西', async () => {
    useFakeTimers();
    try {
      await setWindow(WINDOW);
      await seedPending();
      mockInflight.mockReturnValue([{ taskId, userId, startedAt: Date.now() }]);
      await release.releaseTick({ now: SAT_0345() });
      const { rows } = await dbModule.query('SELECT role, content FROM task_logs WHERE task_id=$1', [taskId]);
      expect(rows.length).toBe(1);
      expect(`${rows[0].role} / 自動重跑=${/自動從同一關重跑/.test(rows[0].content)}`)
        .toBe('ai / 自動重跑=true');
    } finally { jest.useRealTimers(); }
  });

  test('先掛維護旗標才中止：反過來的話被中止的任務會在下一個 tick 被重派，跑到一半又被重啟砍掉', async () => {
    useFakeTimers();
    try {
      await setWindow(WINDOW);
      await seedPending();
      let maintainingWhenAborted = null;
      mockInflight.mockReturnValue([{ taskId, userId, startedAt: Date.now() }]);
      mockAbort.mockImplementation(async () => { maintainingWhenAborted = await isMaintaining(); });
      await release.releaseTick({ now: SAT_0345() });
      expect(maintainingWhenAborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });
});

describe('全跑紅燈（裁決二：只在畫面上通知，所以記錄就是唯一的痕跡）', () => {
  test('紅了不重啟，碼留在待更版等下一個時段', async () => {
    useFakeTimers();
    try {
      mockMeasure.mockResolvedValue(RED);
      await setWindow(WINDOW);
      const { fixId } = await seedPending();
      const r = await release.releaseTick({ now: SAT_0230() });
      expect(`restarted: ${r.restarted} / testsPassed: ${r.testsPassed}`)
        .toBe('restarted: false / testsPassed: false');
      jest.runAllTimers();
      expect(mockExecFile).not.toHaveBeenCalled();
      const { rows: [fix] } = await dbModule.query('SELECT status FROM finding_fixes WHERE id=$1', [fixId]);
      expect(fix.status).toBe('merged');
    } finally { jest.useRealTimers(); }
  });

  test('紅燈理由落 DB 供事後查：這台沒有 webhook／Teams，不寫下來就只剩一行會被輪替掉的 stdout', async () => {
    useFakeTimers();
    try {
      mockMeasure.mockResolvedValue(RED);
      await setWindow(WINDOW);
      await seedPending();
      await release.releaseTick({ now: SAT_0230() });
      const last = await release.lastReleaseResult();
      expect(`restarted: ${last.restarted} / 有理由: ${/3 支測試紅/.test(last.reason || '')}`)
        .toBe('restarted: false / 有理由: true');
      expect(last.windowStart).toBe(new Date(2026, 8, 26, 2, 0, 0).toISOString());
    } finally { jest.useRealTimers(); }
  });

  test('紅了要把維護旗標收回來，否則派工會一路停到到期時間才自己恢復', async () => {
    useFakeTimers();
    try {
      mockMeasure.mockResolvedValue(RED);
      await setWindow(WINDOW);
      await seedPending();
      await release.releaseTick({ now: SAT_0230() });
      expect(await isMaintaining()).toBe(false);
    } finally { jest.useRealTimers(); }
  });

  test('紅了這一場就不再重試：一次全跑十幾分鐘，每分鐘重試一次只會把機器跑垮，而紅燈不會自己變綠', async () => {
    useFakeTimers();
    try {
      mockMeasure.mockResolvedValue(RED);
      await setWindow(WINDOW);
      await seedPending();
      await release.releaseTick({ now: SAT_0230() });
      const again = await release.releaseTick({ now: at(26, 2, 40) });
      expect(again.reason).toBe('already-ran');
      expect(mockMeasure).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });
});

describe('排程頁看得到下一次維護時段（裁決二在畫面上的落點）', () => {
  let cronModule;
  beforeAll(() => { cronModule = require('../cron'); });
  afterAll(() => { cronModule.stopCron(); cronModule._setClockForTesting(null); });

  const releaseRow = async now => (await cronModule.getCronSchedules(now)).find(r => r.id === 'release-window');

  test('沒設定時段：列得出來但標示未設定，並說明碼會一直停在待更版', async () => {
    const row = await releaseRow(FRI_1000());
    expect(`${row.enabled} / ${row.timing}`).toBe('false / 未設定');
    expect(row.note).toMatch(/尚未設定維護時段/);
  });

  test('設定了就要顯示下一次是什麼時候——這是「下一次維護時段」在畫面上唯一的來源', async () => {
    await setWindow(WINDOW);
    const row = await releaseRow(FRI_1000());
    expect(`${row.enabled} / ${row.timing}`).toBe('true / 每週六、日 02:00 起 2 小時');
    expect(row.nextRunAt).toBe(new Date(2026, 8, 26, 2, 0, 0).toISOString());
  });

  test('上一次紅燈要出現在排程頁上：這台不會有任何通知送出去', async () => {
    useFakeTimers();
    try {
      mockMeasure.mockResolvedValue(RED);
      await setWindow(WINDOW);
      await seedPending();
      await release.releaseTick({ now: SAT_0230() });
      const row = await releaseRow(SUN_0230());
      expect(row.note).toMatch(/⚠ 上一次.*沒有重啟.*3 支測試紅/);
    } finally { jest.useRealTimers(); }
  });

  test('cron 的每分鐘 tick 真的會打這一通（接線斷掉的話整套機制就只是躺在那裡的碼）', async () => {
    const nodeCron = require('node-cron');
    await setWindow(WINDOW);
    await seedPending();
    mockInflight.mockReturnValue([{ taskId, userId, startedAt: Date.now() }]);
    cronModule._setClockForTesting(() => SAT_0345());
    cronModule.startCron();
    const tick = nodeCron.schedule.mock.calls.at(-1)[1];
    try {
      await tick();
      await cronModule._pendingReleaseTickForTesting();
      expect(await release.readLastWindow()).toBe(new Date(2026, 8, 26, 2, 0, 0).toISOString());
      expect(mockAbort).toHaveBeenCalledWith(taskId);   // 03:45＝快結束，所以在飛的那張被中止
    } finally {
      cronModule.stopCron();
      cronModule._setClockForTesting(null);
    }
  });
});
