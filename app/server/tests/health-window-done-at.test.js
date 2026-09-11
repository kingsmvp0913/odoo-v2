// 意圖：健檢視窗量的是「這段期間發生了什麼」。若視窗篩選看 tasks.updated_at，任何「不代表任務有
// 進度」的系統維護動作（cron 的自動封存曾寫 updated_at = NOW()）都會把陳年舊任務刷進窗內，被算成
// 本輪發生的事，wall_clock 的 p50/p90 因此誇大（實測約 6 倍）——而畫面上完全看不出異常。
// 這支從兩端釘住：(1) 自動封存不得動 updated_at；(2) 已完成的任務一律以 done_at 進出視窗（含上界），
// 進行中的任務維持 updated_at 不變。
const { newDb } = require('pg-mem');

jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../pipeline/sync', () => ({ syncUser: jest.fn().mockResolvedValue({ odoo: { added: 0 }, service: { added: 0 } }) }));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ processed: 0 }) }));

let dbModule, cronModule, userId;
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('healthwin', $1, '測試', 'user') RETURNING id",
    [hash]
  );
  userId = rows[0].id;
  cronModule = require('../cron');
});
afterAll(() => dbModule._setPoolForTesting(null));

const { buildWindowSummary } = require('../pipeline/health-data');

const mkTask = async (taskId, { status, createdAt, updatedAt, doneAt = null }) => {
  const { rows: [r] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, created_at, updated_at, done_at)
     VALUES ($1,$2,'odoo',$2,$3,$4,$5,$6) RETURNING id`,
    [userId, taskId, status, createdAt, updatedAt, doneAt]
  );
  return r.id;
};

test('autoArchiveDone 只寫 is_hidden，不刷 updated_at（封存不是進度）', async () => {
  await dbModule.query('DELETE FROM tasks');
  const stamp = ago(31 * DAY);
  const id = await mkTask('arch1', { status: 'done', createdAt: stamp, updatedAt: stamp, doneAt: stamp });

  await cronModule.autoArchiveDone();

  const { rows: [t] } = await dbModule.query('SELECT is_hidden, updated_at FROM tasks WHERE id=$1', [id]);
  expect(t.is_hidden).toBe(true);
  // 封存後 updated_at 必須還停在原地：一被刷成 NOW()，這張三十天前結案的任務就會混進健檢視窗
  expect(new Date(t.updated_at).getTime()).toBeCloseTo(new Date(stamp).getTime(), -3);
});

test('健檢視窗：已完成的任務以 done_at 進出視窗，updated_at 被刷過也不會混進來', async () => {
  await dbModule.query('DELETE FROM tasks');
  // A：40 天前就結案、但 updated_at 被系統維護動作刷成現在（DB 裡的既有汙染列）→ 不該算本輪
  const idOld = await mkTask('W_old', { status: 'done', createdAt: ago(41 * DAY), updatedAt: ago(0), doneAt: ago(40 * DAY) });
  // B：進行中，done_at 為 NULL → 行為完全不變，照 updated_at 進窗
  const idRunning = await mkTask('W_run', { status: 'coding', createdAt: ago(3 * DAY), updatedAt: ago(DAY) });
  // C：本輪真的完成的（耗時 1 小時）→ wall_clock 只該由它決定
  const idFresh = await mkTask('W_new', { status: 'done', createdAt: ago(2 * 3600 * 1000), updatedAt: ago(3600 * 1000), doneAt: ago(3600 * 1000) });

  const w = await buildWindowSummary(ago(7 * DAY));

  const ids = w.tasks.map(t => t.id).sort((a, b) => a - b);
  expect(ids).toEqual([idRunning, idFresh].sort((a, b) => a - b));
  expect(ids).not.toContain(idOld);
  expect(w.volume.tasks_touched).toBe(2);
  // 混進 40 天前那張時 p90 會是 984 小時；正解只看窗內真的完成的那張
  expect(w.volume.wall_clock.done_tasks).toBe(1);
  expect(w.volume.wall_clock.p90_hours).toBeCloseTo(1, 1);
});

test('健檢視窗的上界同樣看 done_at（趨勢比對的「上一期」才切得對）', async () => {
  await dbModule.query('DELETE FROM tasks');
  // 上一期完成的：done_at 落在 [7 天前, 1 天前) 內，但 updated_at 被刷成現在
  const idPrev = await mkTask('W_prev', { status: 'done', createdAt: ago(3 * DAY), updatedAt: ago(0), doneAt: ago(2 * DAY) });
  // 本期才完成的：done_at 在上界之後，不該算進上一期
  const idNow = await mkTask('W_now', { status: 'done', createdAt: ago(2 * 3600 * 1000), updatedAt: ago(3600 * 1000), doneAt: ago(3600 * 1000) });

  const w = await buildWindowSummary(ago(7 * DAY), ago(DAY));

  expect(w.tasks.map(t => t.id)).toEqual([idPrev]);
  expect(w.tasks.map(t => t.id)).not.toContain(idNow);
});
