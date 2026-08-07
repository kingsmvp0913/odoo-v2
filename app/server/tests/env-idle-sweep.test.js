// 意圖：閒置回收是 port 池能用小段埠支撐大量專案的前提。門檻分兩段——背景掃描用寬鬆的 60 分
// （沒人等就別打擾），池滿徵收才用 15 分（見 port-reclaim）。絕對上限是保底：輪詢類請求
// 若有漏擋，環境會永遠不閒置，靠壽命上限收掉。
const { newDb } = require('pg-mem');

jest.mock('../pipeline/git', () => ({ ensureTestingBranch: jest.fn() }));
jest.mock('../lib/project-vpn', () => ({ startProjectVpns: jest.fn().mockResolvedValue(), stopProjectVpns: jest.fn().mockResolvedValue() }));
// nginx 同步在單元測試不該真的跑（會排一個防抖 timer 再去讀 env gate）；改 mock 以便斷言
// 「停機／歸還名額後有沒有去同步 conf」——漏了的話 conf 會留著指向已消失容器的那一段。
jest.mock('../lib/nginx-map', () => ({
  syncNginxMap: jest.fn().mockResolvedValue({ ok: true }),
  syncNginxMapDebounced: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../lib/docker-env', () => {
  const actual = jest.requireActual('../lib/docker-env');
  return {
    ...actual,
    stopContainer: jest.fn().mockResolvedValue({ code: 0 }),
    removeContainer: jest.fn().mockResolvedValue(undefined),
    containerLogs: jest.fn().mockResolvedValue(''),
  };
});

let dbModule, sweepIdleEnvs, stopEnv, dockerEnv, nginxMap, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('is','h','I') RETURNING id"
  );
  userId = u.id;
  dockerEnv = require('../lib/docker-env');
  nginxMap = require('../lib/nginx-map');
  ({ sweepIdleEnvs, stopEnv } = require('../pipeline/env-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  await dbModule.query('DELETE FROM tasks');
  await dbModule.query('DELETE FROM odoo_envs');
  await dbModule.query('DELETE FROM projects');
  dockerEnv.containerLogs.mockReset().mockResolvedValue('');
  nginxMap.syncNginxMapDebounced.mockClear();
});

// startedMinAgo：本次啟動多久前（started_at/updated_at）；lastActiveMinAgo：null 表示 last_active_at 為 NULL
// createdMinAgo：這一列多久前首次建立（created_at）。odoo_envs 是 UNIQUE(project_id)、停機不刪列，
//   所以真實資料裡 created_at 幾乎都遠早於 started_at（實測 1~14 天）。預設對齊 startedMinAgo 是為了
//   讓既有案例語意不變；要測「舊列剛啟動」必須明確給值——兩者綁在一起就永遠測不出壽命上限誤殺。
// startedNull：模擬 started_at 欄位上線前就存在的列（fallback 路徑）。
async function mkEnv(name, port, { startedMinAgo = 5, lastActiveMinAgo = 0, createdMinAgo = null, startedNull = false } = {}) {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ($1,'17.0',$1) RETURNING id", [name]
  );
  await dbModule.query(
    `INSERT INTO odoo_envs (project_id, status, port, created_at, started_at, updated_at, last_active_at)
     VALUES ($1,'running',$2,
             NOW() - ($5 || ' minutes')::interval,
             CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() - ($3 || ' minutes')::interval END,
             NOW() - ($3 || ' minutes')::interval,
             CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() - ($4 || ' minutes')::interval END)`,
    [p.id, port, String(startedMinAgo), lastActiveMinAgo === null ? null : String(lastActiveMinAgo),
     String(createdMinAgo ?? startedMinAgo), startedNull ? null : '1']
  );
  return p.id;
}

function logAt(minutesAgo) {
  const d = new Date(Date.now() - minutesAgo * 60000);
  const pad = n => String(n).padStart(2, '0');
  const ts = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())},000`;
  return `${ts} 1 INFO test werkzeug: 127.0.0.1 - - [x] "GET /web HTTP/1.1" 200 -`;
}

test('log 有真實請求 → 更新 last_active_at', async () => {
  const pid = await mkEnv('a', 21000, { lastActiveMinAgo: null });
  dockerEnv.containerLogs.mockResolvedValue(logAt(3));
  await sweepIdleEnvs();
  const { rows: [e] } = await dbModule.query('SELECT last_active_at FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.last_active_at).not.toBeNull();
});

test('log 只有輪詢 → 不更新 last_active_at，且不因此保住環境', async () => {
  const pid = await mkEnv('a', 21000, { startedMinAgo: 90, lastActiveMinAgo: 90 });
  dockerEnv.containerLogs.mockResolvedValue(
    '2026-07-28 23:59:59,000 1 INFO test werkzeug: 127.0.0.1 - - [x] "POST /longpolling/poll HTTP/1.1" 200 -'
  );
  await sweepIdleEnvs();
  const { rows: [e] } = await dbModule.query('SELECT status, port FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('idle');
  expect(e.port).toBeNull();
});

test('閒置超過 60 分 → 停機並歸還租約', async () => {
  const pid = await mkEnv('a', 21000, { startedMinAgo: 90, lastActiveMinAgo: 75 });
  await sweepIdleEnvs();
  const { rows: [e] } = await dbModule.query('SELECT status, port FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('idle');
  expect(e.port).toBeNull();
});

// 意圖：門檻要真的分兩段。閒置 20 分的環境背景掃描不該碰它（那是 port-reclaim 在池滿時才做的事）。
test('閒置 20 分（未達 60 分）→ 背景掃描不停它', async () => {
  const pid = await mkEnv('a', 21000, { startedMinAgo: 30, lastActiveMinAgo: 20 });
  await sweepIdleEnvs();
  const { rows: [e] } = await dbModule.query('SELECT status, port FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('running');
  expect(e.port).toBe(21000);
});

test('未達閒置門檻但已啟動超過 8 小時 → 仍停機（保底）', async () => {
  const pid = await mkEnv('a', 21000, { startedMinAgo: 9 * 60, lastActiveMinAgo: 1 });
  await sweepIdleEnvs();
  const { rows: [e] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('idle');
});

// 意圖：壽命上限管的是「這次開機開多久了」，不是「這個專案第一次建環境是多久以前」。
// odoo_envs 每個專案只有一列、停機只改 status 不刪列，created_at 因此永遠停在首次建立的時刻
// （實測正式資料 1~14 天前）。若拿 created_at 判壽命，所有建立逾 8 小時的專案一開機就滿足條件，
// 下一輪 sweep（每 10 分）立刻收掉——實測真人操作 3~7 分鐘就被踢，且只打真人：pipeline 有
// deploy/E2E 任務擋在上面，真人在畫面上點不會產生任何任務。這是使用者回報「一直中斷」的根因。
test('列建立於 30 天前但本次剛啟動 5 分鐘 → 不得因壽命上限被收', async () => {
  const pid = await mkEnv('a', 21000, { createdMinAgo: 30 * 24 * 60, startedMinAgo: 5, lastActiveMinAgo: 1 });
  await sweepIdleEnvs();
  const { rows: [e] } = await dbModule.query('SELECT status, port FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('running');
  expect(e.port).toBe(21000);
});

// 意圖：舊列（started_at 欄位上線前就在跑）沒有本次啟動時刻可比，此時退回 created_at 從嚴處理。
// 保底條款寧可誤收一次也不能失效——輪詢類請求若有漏擋，環境會永遠不閒置。
test('started_at 為 NULL → 退回 created_at 判壽命（保底不失效）', async () => {
  const pid = await mkEnv('a', 21000, { startedNull: true, createdMinAgo: 9 * 60, startedMinAgo: 5, lastActiveMinAgo: 1 });
  await sweepIdleEnvs();
  const { rows: [e] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('idle');
});

test('有進行中 pipeline 任務 → 兩種條件都跳過', async () => {
  const pid = await mkEnv('busy', 21000, { startedMinAgo: 20 * 60, lastActiveMinAgo: 600 });
  await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'is_busy','odoo','T','deploy_testing',$2)",
    [userId, pid]
  );
  await sweepIdleEnvs();
  const { rows: [e] } = await dbModule.query('SELECT status, port FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('running');
  expect(e.port).toBe(21000);
});

// 意圖：抓 log 失敗（容器已消失／docker 暫時不通）不得讓整輪掃描中斷，否則一個壞環境會讓
// 所有環境都收不掉，池子照樣耗盡。
test('某個環境抓 log 失敗 → 不中斷整輪，其餘照常處理', async () => {
  const bad = await mkEnv('bad', 21000, { startedMinAgo: 90, lastActiveMinAgo: 75 });
  const good = await mkEnv('good', 21001, { startedMinAgo: 90, lastActiveMinAgo: 75 });
  dockerEnv.containerLogs.mockImplementation(async (name) => {
    if (name.includes('bad')) throw new Error('no such container');
    return '';
  });
  await sweepIdleEnvs();
  const { rows } = await dbModule.query('SELECT project_id, status FROM odoo_envs ORDER BY project_id');
  expect(rows.find(r => r.project_id === good).status).toBe('idle');
  expect(rows.find(r => r.project_id === bad).status).toBe('idle'); // 抓不到 log 不影響「閒太久該收」的判定
});

// 意圖：對外名額與環境本身的去留是兩件事。pipeline 可能還要用這個環境（不能停），
// 但沒人在看就該把稀缺的對外名額還回去——N=10 量的是「同時幾個人在看」，不是「幾個環境活著」。
test('對外閒置逾時 → 只收回名額，環境維持 running', async () => {
  const pid = await mkEnv('a', 21000);
  await dbModule.query(
    "UPDATE odoo_envs SET external_slot=0, last_active_at=NOW() - interval '45 minutes' WHERE project_id=$1",
    [pid]
  );
  const r = await sweepIdleEnvs({ idleMin: 999, maxHours: 999, externalIdleMin: 20 });
  const { rows: [env] } = await dbModule.query(
    'SELECT external_slot, status FROM odoo_envs WHERE project_id=$1', [pid]
  );
  expect(env.external_slot).toBeNull();
  expect(env.status).toBe('running');
  expect(r.slotsReleased).toBe(1);
});

test('對外還很活躍 → 名額不動', async () => {
  const pid = await mkEnv('a', 21000);
  await dbModule.query("UPDATE odoo_envs SET external_slot=0, last_active_at=NOW() WHERE project_id=$1", [pid]);
  const r = await sweepIdleEnvs({ idleMin: 999, maxHours: 999, externalIdleMin: 20 });
  const { rows: [env] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(env.external_slot).toBe(0);
  expect(r.slotsReleased).toBe(0);
});

// 意圖：借名額時會把 last_active_at 推到現在（那就是「有人要看」的證據），但同一輪 sweep 的主迴圈
// 緊接著用容器 log 解析出的時間戳「無條件覆寫」同一個欄位。log 反映的是「上一次真的有請求」，
// 在「剛借到名額、瀏覽器還沒打第一個請求」的數秒空窗裡它必然比較舊——覆寫下去等於把時間往回撥，
// 同一輪的對外回收就立刻把剛借出的名額收走，使用者當下拿到 502。時間只能往前，不能往後。
test('log 的活動時間比 last_active_at 舊 → 不得往回撥，剛借出的名額不能被同一輪收走', async () => {
  const pid = await mkEnv('a', 21000, { startedMinAgo: 5, lastActiveMinAgo: 0 });
  await dbModule.query('UPDATE odoo_envs SET external_slot=0, last_active_at=NOW() WHERE project_id=$1', [pid]);
  dockerEnv.containerLogs.mockResolvedValue(logAt(45));   // 上一次真請求在 45 分鐘前
  const r = await sweepIdleEnvs({ idleMin: 999, maxHours: 999, externalIdleMin: 20 });
  const { rows: [env] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(env.external_slot).toBe(0);
  expect(r.slotsReleased).toBe(0);
});

// 意圖：往前推的方向必須照舊生效——只擋回撥，不是整個停掉更新。
test('log 的活動時間比 last_active_at 新 → 照常往前更新', async () => {
  const pid = await mkEnv('a', 21000, { startedMinAgo: 90, lastActiveMinAgo: 80 });
  dockerEnv.containerLogs.mockResolvedValue(logAt(1));
  await sweepIdleEnvs({ idleMin: 60, maxHours: 999 });
  const { rows: [env] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(env.status).toBe('running');   // 剛剛才有人操作，不該被當成閒置 80 分收掉
});

// 意圖：stopEnv 沒清名額的話，那個 slot 會被永久佔住——DB 裡有人持有、實際上環境已經沒了，
// 而 nginx 段也跟著消失（RUNNING_SQL 要求 status='running'），症狀是「名額少了一個且找不到誰佔的」。
test('stopEnv 一併歸還對外名額', async () => {
  const pid = await mkEnv('a', 21000);
  await dbModule.query('UPDATE odoo_envs SET external_slot=2 WHERE project_id=$1', [pid]);
  await stopEnv(pid);
  const { rows: [env] } = await dbModule.query('SELECT external_slot, port FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(env.external_slot).toBeNull();
  expect(env.port).toBeNull();
});

// 意圖：這份 conf 是共用 nginx 的 include 檔。停機後那一段仍指著已被移除的容器，舊分頁重整會拿到
// 502；歸還名額後那個子網域也該從 conf 消失，否則下一個借到同號 slot 的人會被導到別人的環境。
// 兩條路徑都必須走防抖版（批次回收會連續呼叫，逐一 reload 等於連續打擾同一台 nginx 上的正式站）。
test('停機後會同步 nginx conf（走防抖版）', async () => {
  const pid = await mkEnv('a', 21000);
  await stopEnv(pid);
  expect(nginxMap.syncNginxMapDebounced).toHaveBeenCalled();
  expect(nginxMap.syncNginxMap).not.toHaveBeenCalled();
});

test('歸還對外名額後會同步 nginx conf（走防抖版）', async () => {
  const pid = await mkEnv('a', 21000);
  await dbModule.query("UPDATE odoo_envs SET external_slot=0, last_active_at=NOW() - interval '45 minutes' WHERE project_id=$1", [pid]);
  await sweepIdleEnvs({ idleMin: 999, maxHours: 999, externalIdleMin: 20 });
  expect(nginxMap.syncNginxMapDebounced).toHaveBeenCalled();
});

test('沒有任何名額到期 → 不去打擾共用 nginx', async () => {
  const pid = await mkEnv('a', 21000);
  await dbModule.query('UPDATE odoo_envs SET external_slot=0, last_active_at=NOW() WHERE project_id=$1', [pid]);
  await sweepIdleEnvs({ idleMin: 999, maxHours: 999, externalIdleMin: 20 });
  expect(nginxMap.syncNginxMapDebounced).not.toHaveBeenCalled();
});
