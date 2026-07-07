// 意圖：reentry_count 記錄任務「退回 coding」的總循環次數（前端可見真實次數；任務 52 實際 6 次卻顯示 0），
// 並在達上限時作為 per-stage 重試上限（各 3）之外的總循環兜底，強制 stopped。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));

let dbModule, bumpReentryOrStop, MAX_REENTRY, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('re','h','R') RETURNING id"
  );
  userId = u.id;
  ({ bumpReentryOrStop, MAX_REENTRY } = require('../pipeline/reentry'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

async function mkTask(reentry = 0) {
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, reentry_count) VALUES ($1,$2,'odoo','T','coding_running',$3) RETURNING id",
    [userId, `re_${Math.random().toString(36).slice(2)}`, reentry]
  );
  return t.id;
}

test('未達上限：+1 並回傳 false（呼叫端續設 coding_running）', async () => {
  const id = await mkTask(0);
  const stopped = await bumpReentryOrStop(id, userId);
  expect(stopped).toBe(false);
  const { rows: [t] } = await dbModule.query('SELECT reentry_count, status FROM tasks WHERE id=$1', [id]);
  expect(t.reentry_count).toBe(1);
  expect(t.status).toBe('coding_running'); // 尚未改（由呼叫端設）
});

test('達上限：回傳 true 並直接標 stopped（總循環兜底）', async () => {
  const id = await mkTask(MAX_REENTRY - 1); // 再 +1 即達上限
  const stopped = await bumpReentryOrStop(id, userId);
  expect(stopped).toBe(true);
  const { rows: [t] } = await dbModule.query('SELECT reentry_count, status, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.reentry_count).toBe(MAX_REENTRY);
  expect(t.status).toBe('stopped');
  expect(t.blocker_content).toContain('循環');
});
