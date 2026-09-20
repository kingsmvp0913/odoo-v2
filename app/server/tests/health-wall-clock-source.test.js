// 意圖：wall-clock 的「完成時刻」不得退回 tasks.updated_at。
// updated_at 的語意是「最後一次被改」——任何外部批次（eService 同步、封存 cron）碰一下就刷成現在，
// 於是一張窗前早就完成的舊任務會被拉進本輪視窗，並用「建立時刻 → 被 touch 的時刻」當成處理耗時，
// p90 誇大（實測 51.1 小時）。2026-09-11 的修正只覆蓋了「done 且 done_at 有值」的路徑，客服結案
// 的任務從不寫 done_at，整批仍從 ELSE 分支退回 updated_at。
// 這支從兩端釘住：
//   (1) buildWindowSummary 的選窗：done 卻沒有 done_at 的任務不得靠 updated_at 進窗，改以
//       「最後一次 agent 呼叫的時間」重判；查不到的剔除並計進 tasks_no_completion_ts（不是靜默消失）。
//   (2) wall_clock 的耗時：沒有 done_at 時同樣退回最後一次 agent 呼叫（token_usage，append-only、
//       外部批次碰不到），不是 updated_at。
const { newDb } = require('pg-mem');

let dbModule, userId;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('wcsrc','h','測試','user') RETURNING id"
  );
  userId = rows[0].id;
});
afterAll(() => dbModule._setPoolForTesting(null));

const { buildAgentSummary, buildWindowSummary } = require('../pipeline/health-data');

const mkTask = async (taskId, { status, createdAt, updatedAt, doneAt = null }) => {
  const { rows: [r] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, created_at, updated_at, done_at)
     VALUES ($1,$2,'odoo',$2,$3,$4,$5,$6) RETURNING id`,
    [userId, taskId, status, createdAt, updatedAt, doneAt]
  );
  return r.id;
};
const mkCall = (taskId, agentType, at) => dbModule.query(
  `INSERT INTO token_usage (task_id,user_id,agent_type,input_tokens,status,recorded_at)
   VALUES ($1,$2,$3,1,'completed',$4)`, [taskId, userId, agentType, at]
);

const clean = async () => {
  await dbModule.query('DELETE FROM token_usage');
  await dbModule.query('DELETE FROM tasks');
};

test('視窗：done 但沒有 done_at 的任務，不得靠被刷新的 updated_at 進窗', async () => {
  await clean();
  // A：80 天前建立、客服結案（從不寫 done_at），最後一次 agent 呼叫也在 79 天前，
  //    但 updated_at 被外部批次（eService 同步）刷成現在。
  //    舊行為：進窗，wall-clock 算成約 1920 小時，p90 整個被它決定。
  await mkTask('WC_old', { status: 'done', createdAt: ago(80 * DAY), updatedAt: ago(0) });
  await mkCall('WC_old', 'cs', ago(79 * DAY));
  // B：同樣沒有 done_at，但連一次 agent 呼叫都查不到＝說不出何時完成 → 剔除並計數
  await mkTask('WC_blind', { status: 'done', createdAt: ago(60 * DAY), updatedAt: ago(0) });
  // C：本輪真的完成的，耗時 2 小時 —— wall-clock 只該由它決定
  const idFresh = await mkTask('WC_new', {
    status: 'done', createdAt: ago(3 * HOUR), updatedAt: ago(HOUR), doneAt: ago(HOUR)
  });

  const w = await buildWindowSummary(ago(7 * DAY));

  expect(w.tasks.map(t => t.id)).toEqual([idFresh]);
  expect(w.volume.tasks_touched).toBe(1);
  expect(w.volume.wall_clock.done_tasks).toBe(1);
  expect(w.volume.wall_clock.p90_hours).toBeCloseTo(2, 1);   // 舊行為是 ~1920
  // 說不出完成時刻的那張要講出來，不能靜默消失——否則「樣本變少」跟「本來就少」分不出來。
  // 只算 WC_blind：WC_old 有完成時刻，只是落在窗外，那跟一般的窗外任務同一回事。
  expect(w.volume.tasks_no_completion_ts).toBe(1);
});

test('視窗：done 沒有 done_at、但最後一次呼叫落在窗內的，照樣算本輪', async () => {
  await clean();
  // 客服結案、沒有 done_at，最後一次 agent 呼叫在 2 小時前＝確實是本輪完成的，不該被誤殺
  const id = await mkTask('WC_cs_in', { status: 'done', createdAt: ago(5 * HOUR), updatedAt: ago(0) });
  await mkCall('WC_cs_in', 'cs', ago(2 * HOUR));

  const w = await buildWindowSummary(ago(7 * DAY));

  expect(w.tasks.map(t => t.id)).toEqual([id]);
  expect(w.volume.tasks_no_completion_ts).toBe(0);
  expect(w.volume.wall_clock.done_tasks).toBe(1);
  expect(w.volume.wall_clock.p90_hours).toBeCloseTo(3, 1);   // 5h 前建立 → 2h 前完成
});

test('buildAgentSummary：沒有 done_at 時用最後一次 agent 呼叫當完成時刻，不用 updated_at', async () => {
  await clean();
  // A：100 小時前建立、最後一次 agent 呼叫在 99 小時前（＝實際耗時 1 小時），
  //    但 updated_at 被刷成現在。退回 updated_at 會算成 100 小時。
  await mkTask('WC_cs', { status: 'done', createdAt: ago(100 * HOUR), updatedAt: ago(0) });
  await mkCall('WC_cs', 'library', ago(99 * HOUR));
  // B：有 done_at 的正常任務，耗時 2 小時
  await mkTask('WC_ok', {
    status: 'done', createdAt: ago(5 * HOUR), updatedAt: ago(0), doneAt: ago(3 * HOUR)
  });
  await mkCall('WC_ok', 'library', ago(3 * HOUR));

  const s = await buildAgentSummary({ name: 'library', stage: 'library', label: 'Wiki' }, { windowDays: 30 });

  expect(s.tasks.wall_clock.done_tasks).toBe(2);              // 兩張都算得出來，沒有被整批丟掉
  // 樣本是 [1, 2]：p90 取 2。退回 updated_at 的舊行為會讓 WC_cs 變成 100，p90＝100
  expect(s.tasks.wall_clock.p90_hours).toBeCloseTo(2, 1);
  expect(s.tasks.wall_clock.p50_hours).toBeCloseTo(1, 1);
});

test('buildAgentSummary：最後一次呼叫早於建立時刻這種壞資料不混入樣本', async () => {
  await clean();
  await mkTask('WC_bad', { status: 'done', createdAt: ago(HOUR), updatedAt: ago(0) });
  await mkCall('WC_bad', 'library', ago(5 * HOUR));           // 比 created_at 還早

  const s = await buildAgentSummary({ name: 'library', stage: 'library', label: 'Wiki' }, { windowDays: 30 });

  expect(s.tasks.wall_clock.done_tasks).toBe(0);
  expect(s.tasks.wall_clock.p90_hours).toBe(0);
});
