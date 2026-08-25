const { newDb } = require('pg-mem');
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));

// Mock sync to avoid real HTTP/API calls
jest.mock('../pipeline/sync', () => ({
  syncUser: jest.fn().mockResolvedValue({ odoo: { added: 2 }, service: { added: 0 } })
}));
// node-cron 只保留「登記 callback」的行為，讓測試能直接手動跑一次 tick（不等真的到分鐘邊界）
jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ processed: 0 }) }));
jest.mock('../pipeline/usage-gate', () => ({ evaluateAndNotify: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/env-agent', () => ({
  nightlyShutdown: jest.fn().mockResolvedValue(undefined),
  sweepIdleEnvs: jest.fn().mockResolvedValue(undefined)
}));
// 健檢會呼叫 opus 並自己下 SQL 深挖，測試只驗「有沒有被啟動」，不真的跑
jest.mock('../pipeline/health-check-runner', () => ({
  runAudit: jest.fn().mockResolvedValue(undefined),
  auditWindowStart: jest.fn().mockResolvedValue(new Date(Date.now() - 86400000)),
  resumeInterruptedRuns: jest.fn().mockResolvedValue(0)
}));

let dbModule, cronModule, notifyModule;
let userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, sync_interval) VALUES ('crontest', $1, '測試', 'user', 1) RETURNING id",
    [hash]
  );
  userId = rows[0].id;

  notifyModule = require('../notify');
  cronModule = require('../cron');
});

afterAll(() => {
  cronModule.stopCron();
  dbModule._setPoolForTesting(null);
});

test('notify.emitToUser does not throw when io is not set', () => {
  expect(() => notifyModule.emitToUser(1, 'task:synced', { count: 3 })).not.toThrow();
});

test('notify.emitToUser calls io.to().emit() when io is set', () => {
  const mockEmit = jest.fn();
  const mockTo = jest.fn(() => ({ emit: mockEmit }));
  const mockIo = { to: mockTo, emit: jest.fn() };

  notifyModule.setIo(mockIo);
  notifyModule.emitToUser(42, 'task:updated', { taskId: 1, status: 'new' });

  expect(mockTo).toHaveBeenCalledWith('user:42');
  expect(mockEmit).toHaveBeenCalledWith('task:updated', { taskId: 1, status: 'new' });

  notifyModule.setIo(null);
});

test('notify.emitAll calls io.emit()', () => {
  const mockEmit = jest.fn();
  notifyModule.setIo({ to: jest.fn(() => ({ emit: jest.fn() })), emit: mockEmit });
  notifyModule.emitAll('notify:toast', { level: 'info', message: 'test' });
  expect(mockEmit).toHaveBeenCalledWith('notify:toast', { level: 'info', message: 'test' });
  notifyModule.setIo(null);
});

test('startCron returns a task object (cron job started)', () => {
  const job = cronModule.startCron();
  expect(job).toBeDefined();
  expect(typeof job.stop).toBe('function');
  cronModule.stopCron();
});

test('autoArchiveDone 封存完成滿 30 天的任務，保留較新完成的', async () => {
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const { rows: [a] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, done_at) VALUES ($1,'arch_old','odoo','O','done',$2) RETURNING id",
    [userId, old]
  );
  const { rows: [b] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, done_at) VALUES ($1,'arch_recent','odoo','R','done',$2) RETURNING id",
    [userId, recent]
  );
  await cronModule.autoArchiveDone();
  const { rows: [ra] } = await dbModule.query('SELECT is_hidden FROM tasks WHERE id=$1', [a.id]);
  const { rows: [rb] } = await dbModule.query('SELECT is_hidden FROM tasks WHERE id=$1', [b.id]);
  expect(ra.is_hidden).toBe(true);
  expect(rb.is_hidden).toBe(false);
});

// 意圖：deploy／E2E 失敗 log 過去無任何清理、只增不減把磁碟塞爆；超過保留期的 .log 必須被清、較新的與非 .log 保留。
test('cleanupOldDeployLogs 刪超過保留期的 .log，保留較新與非 log 檔', () => {
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-logclean-'));
  const oldMs = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 天前（超過預設 14 天保留）
  const mk = (name, ageMs) => {
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, 'x');
    if (ageMs != null) fs.utimesSync(fp, new Date(ageMs), new Date(ageMs));
    return fp;
  };
  const oldLog = mk('deploy-task1-1.log', oldMs);
  const oldE2e = mk('e2e-task2-999.log', oldMs);
  const freshLog = mk('deploy-task3-1.log', Date.now());
  const notLog = mk('deploy-task4-1.txt', oldMs); // 非 .log 不動

  const prevDeploy = process.env.DEPLOY_LOG_DIR, prevE2e = process.env.E2E_LOG_DIR;
  process.env.DEPLOY_LOG_DIR = dir; process.env.E2E_LOG_DIR = dir;
  try {
    cronModule.cleanupOldDeployLogs();
    expect(fs.existsSync(oldLog)).toBe(false);
    expect(fs.existsSync(oldE2e)).toBe(false);
    expect(fs.existsSync(freshLog)).toBe(true);
    expect(fs.existsSync(notLog)).toBe(true);
  } finally {
    if (prevDeploy == null) delete process.env.DEPLOY_LOG_DIR; else process.env.DEPLOY_LOG_DIR = prevDeploy;
    if (prevE2e == null) delete process.env.E2E_LOG_DIR; else process.env.E2E_LOG_DIR = prevE2e;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 意圖：token_usage 每個關卡 INSERT 一列、只增不減；超過保留期的明細必須裁掉，較新的保留（報表用）。
test('cleanupOldTokenUsage 裁掉超過保留期的列，保留較新的', async () => {
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(); // 超過預設 180 天
  const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  await dbModule.query(
    "INSERT INTO token_usage (task_id, agent_type, recorded_at) VALUES ('tu_old','coding',$1)", [old]
  );
  await dbModule.query(
    "INSERT INTO token_usage (task_id, agent_type, recorded_at) VALUES ('tu_recent','coding',$1)", [recent]
  );
  await cronModule.cleanupOldTokenUsage();
  const { rows: oldRows } = await dbModule.query("SELECT 1 FROM token_usage WHERE task_id='tu_old'");
  const { rows: newRows } = await dbModule.query("SELECT 1 FROM token_usage WHERE task_id='tu_recent'");
  expect(oldRows.length).toBe(0);
  expect(newRows.length).toBe(1);
});

// user_inbox 過去 0 個 DELETE、無 TTL，只靠刪任務／刪使用者的 CASCADE 才會少。
// 只裁已讀的：未讀不管多舊都代表「還沒被看到」，延後中的 read_at 同樣是 NULL——
// 兩者都不能碰，否則使用者會有事情永遠不知道。
test('cleanupOldInboxRows 只裁超過保留期的已讀列，未讀與延後中的一律留著', async () => {
  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(); // 超過預設 90 天
  const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'inbox_ret','odoo','I','done') RETURNING id",
    [userId]
  );
  const add = (kind, readAt, snoozed = null) => dbModule.query(
    'INSERT INTO user_inbox (user_id, task_id, kind, read_at, snoozed_until) VALUES ($1,$2,$3,$4,$5)',
    [userId, t.id, kind, readAt, snoozed]
  );
  await add('old_read', old);          // 該刪
  await add('recent_read', recent);    // 讀了但還沒滿保留期
  await add('old_unread', null);       // 很舊但沒讀過
  await add('old_snoozed', null, old); // 延後中：read_at 是 NULL

  await cronModule.cleanupOldInboxRows();
  const { rows } = await dbModule.query('SELECT kind FROM user_inbox WHERE task_id=$1', [t.id]);
  expect(rows.map(r => r.kind).sort()).toEqual(['old_snoozed', 'old_unread', 'recent_read']);
});

// 意圖：關閉 Odoo／eService 同步是「不要去撈單」，不該連帶停掉測試區的生命週期管理。
// 埠只借不還會讓池子單向耗盡，症狀是「沒幾個測試區卻說併發已滿」，完全不指向同步設定。
//
// ⚠ 順序有意義：閒置掃描的節流狀態 `_lastIdleSweepAt` 是 cron.js 的模組層變數，跑過一次 tick
// 就會用掉 10 分鐘額度。本測試必須是本檔中第一個跑完整 tick 的案例，否則會被節流擋掉而假紅。
test('兩個同步間隔都關閉時，閒置回收仍會執行', async () => {
  const nodeCron = require('node-cron');
  const envAgent = require('../pipeline/env-agent');
  await dbModule.query(
    'INSERT INTO teams_settings (id, odoo_sync_interval, service_sync_interval) VALUES (1, 0, 0) ' +
    'ON CONFLICT (id) DO UPDATE SET odoo_sync_interval=0, service_sync_interval=0'
  );
  envAgent.sweepIdleEnvs.mockClear();
  cronModule.startCron();
  const tick = nodeCron.schedule.mock.calls.at(-1)[1];
  try {
    await tick();
  } finally {
    cronModule.stopCron();
  }
  expect(envAgent.sweepIdleEnvs).toHaveBeenCalled();
});

// 意圖：管理員設定頁明寫「同步間隔（分鐘，0 停用）」。若用 `|| 60`，0 會被算成 60——
// 使用者以為關掉了卻照樣每小時撈單，而畫面上那個 0 看起來完全正常。這種「設定假裝生效」
// 的 bug 沒有任何症狀指向成因，只能靠測試釘住。
test('同步間隔設 0 → 真的停用，不去撈單', async () => {
  const nodeCron = require('node-cron');
  const { syncUser } = require('../pipeline/sync');
  await dbModule.query(
    'INSERT INTO teams_settings (id, odoo_sync_interval, service_sync_interval) VALUES (1, 0, 0) ' +
    'ON CONFLICT (id) DO UPDATE SET odoo_sync_interval=0, service_sync_interval=0'
  );
  syncUser.mockClear();
  cronModule.startCron();
  const tick = nodeCron.schedule.mock.calls.at(-1)[1];
  try {
    await tick();
  } finally {
    cronModule.stopCron();
  }
  expect(syncUser).not.toHaveBeenCalled();
});

// 意圖：關閉來源同步（兩個間隔都 0）＝「不要去外部撈單」，與「要不要推進 pipeline」「要不要做
// 清理排程」是三件無關的事。原本這三者共用同一個提前 return（`if (!odooMs && !serviceMs) return;`），
// 於是管理員一把同步關掉，整個平台就停止推進任務——任務全部凍在原狀態、自動封存與各項清理
// 也一起停掉，而症狀完全不指向「同步設定」。
// （同段上方的註解已經為「測試區生命週期」講過同一個道理並把它移到 return 之前，但只搬了那一項；
// 這裡是把剩下的 pipeline 推進與清理一併從那個 return 底下救出來。）
// 這支測試鎖住：同步關閉時，pipeline 仍須被推進。
test('同步全關（間隔皆 0）仍要推進 pipeline，不得被同步的提前 return 一起關掉', async () => {
  const nodeCron = require('node-cron');
  const { runPipeline } = require('../pipeline/runner');
  const { syncUser } = require('../pipeline/sync');
  await dbModule.query(
    'INSERT INTO teams_settings (id, odoo_sync_interval, service_sync_interval) VALUES (1, 0, 0) ' +
    'ON CONFLICT (id) DO UPDATE SET odoo_sync_interval=0, service_sync_interval=0'
  );
  runPipeline.mockClear();
  syncUser.mockClear();
  cronModule.startCron();
  const tick = nodeCron.schedule.mock.calls.at(-1)[1];
  try {
    await tick();
  } finally {
    cronModule.stopCron();
  }
  expect(runPipeline).toHaveBeenCalled();
  // 同時確認沒有修過頭：同步關閉就是不該去撈單
  expect(syncUser).not.toHaveBeenCalled();
});

// --- 23:00 統一關機 ---
// 意圖：同一個 tick 內 classifyPendingRejections 每筆要跑一次 runClaude，有積壓時輕易超過 60 秒，
// 下一個 tick 直接撞 `if (_tickRunning) return`。舊條件是「時與分都剛好吻合」，被跳過的若正是
// 23:00 那一分鐘，當天就整天不關機、也沒有任何補跑（背景閒置回收已預設關閉，兜底只剩 20 小時
// 壽命上限）。條件必須是「過了預定時刻且今天還沒關過」。
// 取值有鑑別力：預定時刻設在「現在之前、且不是現在這一分鐘」——舊條件必定不觸發。
function pastShutdownTime() {
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const d = new Date(now.getTime() - 5 * 60000);
  // 往前 5 分鐘若跨回昨天，改用 00:00（今天必定已過，且同樣不會等於現在這一分鐘）
  if (d.getDate() !== now.getDate()) return '00:00';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

test('tick 錯過預定關機的那一分鐘 → 下一個 tick 補跑（不是整天不關）', async () => {
  const nodeCron = require('node-cron');
  const envAgent = require('../pipeline/env-agent');
  const prev = process.env.ODOO_ENV_SHUTDOWN_TIME;
  process.env.ODOO_ENV_SHUTDOWN_TIME = pastShutdownTime();
  cronModule._resetShutdownStateForTesting();
  envAgent.nightlyShutdown.mockClear();
  cronModule.startCron();
  const tick = nodeCron.schedule.mock.calls.at(-1)[1];
  try { await tick(); } finally {
    cronModule.stopCron();
    if (prev == null) delete process.env.ODOO_ENV_SHUTDOWN_TIME; else process.env.ODOO_ENV_SHUTDOWN_TIME = prev;
  }
  expect(envAgent.nightlyShutdown).toHaveBeenCalled();
});

// 補跑不能變成「過了 23:00 之後每分鐘都關一次」——每 tick 重關會不斷打斷白天重開的環境。
test('同一天已補跑過 → 後續 tick 不再重複關機', async () => {
  const nodeCron = require('node-cron');
  const envAgent = require('../pipeline/env-agent');
  const prev = process.env.ODOO_ENV_SHUTDOWN_TIME;
  process.env.ODOO_ENV_SHUTDOWN_TIME = pastShutdownTime();
  cronModule._resetShutdownStateForTesting();
  envAgent.nightlyShutdown.mockClear();
  cronModule.startCron();
  const tick = nodeCron.schedule.mock.calls.at(-1)[1];
  try { await tick(); await tick(); } finally {
    cronModule.stopCron();
    if (prev == null) delete process.env.ODOO_ENV_SHUTDOWN_TIME; else process.env.ODOO_ENV_SHUTDOWN_TIME = prev;
  }
  expect(envAgent.nightlyShutdown).toHaveBeenCalledTimes(1);
});

// 還沒到預定時刻就不該關：補跑的條件是「過了」，不是「無條件關」。
test('尚未到預定關機時刻 → 不關機', async () => {
  const nodeCron = require('node-cron');
  const envAgent = require('../pipeline/env-agent');
  const prev = process.env.ODOO_ENV_SHUTDOWN_TIME;
  process.env.ODOO_ENV_SHUTDOWN_TIME = '23:59';
  cronModule._resetShutdownStateForTesting();
  envAgent.nightlyShutdown.mockClear();
  cronModule.startCron();
  const tick = nodeCron.schedule.mock.calls.at(-1)[1];
  try { await tick(); } finally {
    cronModule.stopCron();
    if (prev == null) delete process.env.ODOO_ENV_SHUTDOWN_TIME; else process.env.ODOO_ENV_SHUTDOWN_TIME = prev;
  }
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() >= 23 * 60 + 59) return; // 23:59 之後跑本測試無鑑別力
  expect(envAgent.nightlyShutdown).not.toHaveBeenCalled();
});

// --- 每日工作流程健檢 ---
// 意圖：健檢原本只有 admin 手動觸發，而上線後從沒被按過一次（run#1 是平台史上第一次執行）。
// 再好的診斷不跑就沒有價值。節流以 DB 的 started_at 為準而非行程內變數——server 常重啟，
// 用記憶體節流會變成「每次重啟後不久又跑一次」，而一次健檢要燒 20+ 個 opus。
test('健檢固定臺灣時間 23:00，手動全平台健檢不會帶偏排程', async () => {
  await dbModule.query('DELETE FROM health_check_runs');
  const beforeTarget = new Date('2026-08-25T14:00:00.000Z'); // 臺灣時間 22:00
  let schedule = await cronModule.getHealthCheckSchedule(beforeTarget);
  expect(schedule).toMatchObject({ due: false, nextRunAt: '2026-08-25T15:00:00.000Z' });

  // started_by 有值是 admin 手動執行，必須忽略，否則每次人工健檢又會重設排程。
  await dbModule.query(
    "INSERT INTO health_check_runs (status, window_days, started_by, created_at) VALUES ('done',1,$1,'2026-08-25T14:30:00.000Z')", [userId]);
  schedule = await cronModule.getHealthCheckSchedule(beforeTarget);
  expect(schedule).toMatchObject({ due: false, nextRunAt: '2026-08-25T15:00:00.000Z', lastRunAt: null });

  await dbModule.query(
    "INSERT INTO health_check_runs (status, window_days, created_at) VALUES ('done',1,'2026-08-25T15:01:00.000Z')");
  schedule = await cronModule.getHealthCheckSchedule(new Date('2026-08-26T14:00:00.000Z'));
  expect(schedule).toMatchObject({ due: false, nextRunAt: '2026-08-26T15:00:00.000Z' });
});

test('cron tick：從沒跑過健檢 → 建立 run 並啟動', async () => {
  const nodeCron = require('node-cron');
  const runner = require('../pipeline/health-check-runner');
  await dbModule.query('DELETE FROM health_check_runs');
  await dbModule.query(
    'INSERT INTO teams_settings (id, odoo_sync_interval, service_sync_interval) VALUES (1, 0, 0) ' +
    'ON CONFLICT (id) DO UPDATE SET odoo_sync_interval=0, service_sync_interval=0'
  );
  runner.runAudit.mockClear();
  cronModule._setClockForTesting(() => new Date('2026-08-25T15:00:00.000Z')); // 臺灣時間 23:00
  cronModule.startCron();
  const tick = nodeCron.schedule.mock.calls.at(-1)[1];
  try { await tick(); } finally { cronModule.stopCron(); cronModule._setClockForTesting(null); }

  const { rows } = await dbModule.query('SELECT status, window_days FROM health_check_runs');
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('running');
  expect(runner.runAudit).toHaveBeenCalled();
});

// 不疊加：上一輪還在跑就跳過。健檢是 20+ 個 opus 的長工，重複啟動會讓同一份診斷跑兩遍。
test('cron tick：上一輪健檢仍在 running → 不重複啟動', async () => {
  const nodeCron = require('node-cron');
  const runner = require('../pipeline/health-check-runner');
  await dbModule.query('DELETE FROM health_check_runs');
  await dbModule.query("INSERT INTO health_check_runs (status, window_days, created_at) VALUES ('running',30,NOW())");
  runner.runAudit.mockClear();
  cronModule.startCron();
  const tick = nodeCron.schedule.mock.calls.at(-1)[1];
  try { await tick(); } finally { cronModule.stopCron(); }

  expect(runner.runAudit).not.toHaveBeenCalled();
  const { rows } = await dbModule.query('SELECT id FROM health_check_runs');
  expect(rows).toHaveLength(1);   // 沒有多建一筆
});

// 單張任務健檢不參與週期節流：它是人工隨手按的（一天可能好幾次），算進來會把每週的平台健檢
// 一路往後推，而且完全沒有訊號——畫面上的「下次自動健檢」照樣顯示一個看起來合理的時間。
test('cron tick：最後一筆是單張任務健檢 → 平台健檢照樣依平台那筆的時間判斷', async () => {
  const nodeCron = require('node-cron');
  const runner = require('../pipeline/health-check-runner');
  await dbModule.query('DELETE FROM health_check_runs');
  await dbModule.query(
    "INSERT INTO health_check_runs (status, window_days, created_at, finished_at) VALUES ('done',30,NOW() - INTERVAL '9 days',NOW() - INTERVAL '9 days')");
  await dbModule.query(
    "INSERT INTO health_check_runs (status, window_days, created_at, task_db_id) VALUES ('running',30,NOW(),12345)");
  runner.runAudit.mockClear();
  cronModule._setClockForTesting(() => new Date('2026-08-25T15:00:00.000Z'));
  cronModule.startCron();
  const tick = nodeCron.schedule.mock.calls.at(-1)[1];
  try { await tick(); } finally { cronModule.stopCron(); cronModule._setClockForTesting(null); }

  expect(runner.runAudit).toHaveBeenCalled();   // 平台那筆已超過一週，不因剛按過任務健檢而跳過
});

// 已在本次晚間時段跑過就不重跑：否則每分鐘一 tick 就是每分鐘一次健檢。
test('cron tick：上次健檢在一個週期內 → 不跑', async () => {
  const nodeCron = require('node-cron');
  const runner = require('../pipeline/health-check-runner');
  await dbModule.query('DELETE FROM health_check_runs');
  await dbModule.query(
    "INSERT INTO health_check_runs (status, window_days, created_at, finished_at) VALUES ('done',30,NOW() - INTERVAL '2 hours',NOW())");
  runner.runAudit.mockClear();
  cronModule.startCron();
  const tick = nodeCron.schedule.mock.calls.at(-1)[1];
  try { await tick(); } finally { cronModule.stopCron(); }

  expect(runner.runAudit).not.toHaveBeenCalled();
});

// 超過一週就跑：這是這個排程存在的理由，不能只驗「不跑」的三種情況。
test('cron tick：上次健檢超過一個週期 → 再跑一次', async () => {
  const nodeCron = require('node-cron');
  const runner = require('../pipeline/health-check-runner');
  await dbModule.query('DELETE FROM health_check_runs');
  await dbModule.query(
    "INSERT INTO health_check_runs (status, window_days, created_at, finished_at) VALUES ('done',30,NOW() - INTERVAL '8 days',NOW())");
  runner.runAudit.mockClear();
  cronModule._setClockForTesting(() => new Date('2026-08-25T15:00:00.000Z'));
  cronModule.startCron();
  const tick = nodeCron.schedule.mock.calls.at(-1)[1];
  try { await tick(); } finally { cronModule.stopCron(); cronModule._setClockForTesting(null); }

  expect(runner.runAudit).toHaveBeenCalled();
  const { rows } = await dbModule.query('SELECT id FROM health_check_runs');
  expect(rows).toHaveLength(2);   // 舊的保留、新的建立
});
