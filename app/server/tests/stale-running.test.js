// 意圖：使用者回報有兩張任務停在執行中的狀態 30 天與 42 天——不重試、不報錯、不通知，畫面一直
// 顯示「執行中」。平台過去沒有任何一處在看「一張任務在某一關待了多久」，所以這種靜默消失只能靠
// 人剛好翻到才會發現。這一支釘住那道兜底網，以及它**不可以**誤傷的東西：
//   - 只認 *_running，不認整份 RUNNABLE_STATUSES（new／branch_pending／deploy_testing 是等著被派，
//     不是殘留）——這正是本修正第一版被駁回的理由。
//   - 門檻要遠大於正常排隊（併發上限／merge 尾巴獨佔）能造成的等待；設成小時級就會把健康任務標失敗。
//   - 維護中、用量閘門 blocked、真的在飛的任務一律不動。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/usage-gate', () => ({ getGateState: jest.fn().mockResolvedValue({ blocked: false }) }));
// runner 會拖進 git／clarify-chat／embedding 等一整串依賴，這裡只需要「誰在飛」這一個事實
jest.mock('../pipeline/runner', () => ({ getInflightTaskIds: jest.fn(() => []) }));

let dbModule, notify, usageGate, runner, maintenance, reclaimStaleRunningTasks, STALE_STATUSES;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  notify = require('../notify');
  usageGate = require('../pipeline/usage-gate');
  runner = require('../pipeline/runner');
  maintenance = require('../pipeline/maintenance');
  ({ reclaimStaleRunningTasks, STALE_STATUSES } = require('../pipeline/stale-running'));

  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('stale','h','S','user')"
  );
});
afterAll(() => dbModule._setPoolForTesting(null));

beforeEach(async () => {
  await dbModule.query('DELETE FROM task_events');
  await dbModule.query('DELETE FROM tasks');
  notify.emitToUser.mockClear();
  usageGate.getGateState.mockResolvedValue({ blocked: false });
  runner.getInflightTaskIds.mockReturnValue([]);
  await maintenance.leaveMaintenance();
});

// updated_at 是唯一的「上次有進展是什麼時候」，故由測試直接指定
async function mkTask(taskId, status, daysAgo, extra = {}) {
  const at = new Date(Date.now() - daysAgo * 86400000).toISOString();
  const { rows } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, status, is_paused, is_hidden, updated_at)
     VALUES (1, $1, 'test', $2, $3, $4, $5) RETURNING id`,
    [taskId, status, extra.paused ?? false, extra.hidden ?? false, at]
  );
  return rows[0].id;
}

const statusOf = async (id) => (await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [id])).rows[0];

test('停在 analysis_running 超過門檻 → 標 stopped、原因寫進執行歷程並通知使用者', async () => {
  const id = await mkTask('T1', 'analysis_running', 30);
  const r = await reclaimStaleRunningTasks({ hours: 72 });
  expect(r.reclaimed).toBe(1);
  const task = await statusOf(id);
  expect(task.status).toBe('stopped');
  // 訊息要讓使用者看得懂發生什麼事、以及自己能做什麼（stopped 可按「解決阻塞」回同一關）
  expect(task.blocker_content).toMatch(/分析中/);
  expect(task.blocker_content).toMatch(/30 天/);
  // stopped 是 actor:'human'，這個事件才會進收件匣／webhook——少了它就還是「沒有通知」
  expect(notify.emitToUser).toHaveBeenCalledWith(1, 'task:updated', { taskId: id, status: 'stopped' });
  const { rows } = await dbModule.query('SELECT content FROM task_events WHERE task_id=$1', [id]);
  expect(rows).toHaveLength(1);
  expect(rows[0].content).toContain('❌ 失敗');
});

// 駁回理由（修正 #49）：門檻太小會把因 MAX_PER_USER／deploy-E2E 併發上限／merge 尾巴獨佔而
// 正常排隊的健康任務誤判成殘留，標成失敗還通知使用者。
test('門檻內的執行中任務一張都不能動 — 正常排隊不是殘留', async () => {
  const ids = [
    await mkTask('T2', 'merge_running', 2),
    await mkTask('T3', 'playwright_running', 2),
    await mkTask('T4', 'coding_running', 1),
  ];
  const r = await reclaimStaleRunningTasks({ hours: 72 });
  expect(r.reclaimed).toBe(0);
  for (const id of ids) expect((await statusOf(id)).status).not.toBe('stopped');
  expect(notify.emitToUser).not.toHaveBeenCalled();
});

// 同上駁回理由的另一半：掃描範圍用整份 RUNNABLE_STATUSES 就會掃到這些「等著被派」的狀態。
test('非 *_running 的可派工狀態不在掃描範圍', async () => {
  expect(STALE_STATUSES).toContain('analysis_running');
  expect(STALE_STATUSES).not.toContain('new');
  expect(STALE_STATUSES).not.toContain('branch_pending');
  expect(STALE_STATUSES).not.toContain('deploy_testing');
  const ids = [
    await mkTask('T5', 'new', 40),
    await mkTask('T6', 'branch_pending', 40),
    await mkTask('T7', 'deploy_testing', 40),
  ];
  expect((await reclaimStaleRunningTasks({ hours: 72 })).reclaimed).toBe(0);
  for (const id of ids) expect((await statusOf(id)).status).not.toBe('stopped');
});

test('暫停與封存的任務不動 — 那是人自己按的，不是平台把它弄丟', async () => {
  const paused = await mkTask('T8', 'analysis_running', 40, { paused: true });
  const hidden = await mkTask('T9', 'qa_running', 40, { hidden: true });
  expect((await reclaimStaleRunningTasks({ hours: 72 })).reclaimed).toBe(0);
  expect((await statusOf(paused)).status).toBe('analysis_running');
  expect((await statusOf(hidden)).status).toBe('qa_running');
});

test('真的在飛的任務不動 — 那是活著的 agent，改它的狀態是跟它搶寫', async () => {
  const id = await mkTask('T10', 'coding_running', 40);
  runner.getInflightTaskIds.mockReturnValue([id]);
  expect((await reclaimStaleRunningTasks({ hours: 72 })).reclaimed).toBe(0);
  expect((await statusOf(id)).status).toBe('coding_running');
});

// 維護中與用量閘門 blocked 時全平台都不派工，任務停著是正常的——這時掃描等於把所有在途任務
// 一次標成失敗，是這道網唯一會造成大規模誤傷的情境。
test('維護中整支跳過', async () => {
  const id = await mkTask('T11', 'analysis_running', 40);
  await maintenance.enterMaintenance(60000);
  try {
    expect(await reclaimStaleRunningTasks({ hours: 72 })).toEqual({ reclaimed: 0, skipped: 'maintenance' });
  } finally { await maintenance.leaveMaintenance(); }
  expect((await statusOf(id)).status).toBe('analysis_running');
});

test('用量閘門 blocked 時整支跳過', async () => {
  const id = await mkTask('T12', 'analysis_running', 40);
  usageGate.getGateState.mockResolvedValue({ blocked: true });
  expect(await reclaimStaleRunningTasks({ hours: 72 })).toEqual({ reclaimed: 0, skipped: 'usage-gate' });
  expect((await statusOf(id)).status).toBe('analysis_running');
});

test('門檻設 0 ＝停用', async () => {
  const id = await mkTask('T13', 'analysis_running', 40);
  expect(await reclaimStaleRunningTasks({ hours: 0 })).toEqual({ reclaimed: 0, skipped: 'disabled' });
  expect((await statusOf(id)).status).toBe('analysis_running');
});
