// 意圖：起手包（buildWindowSummary）是健檢每輪真正先讀的那一份。它少給的東西，健檢就會自己下
// SQL 去補，而自己拼的 SQL 沒有人審——上一輪就是拼成 `status LIKE '%_running' AND updated_at > 24h`，
// 漏了 is_hidden 與 is_paused，把兩張使用者手動封存的任務報成「靜默消失 30 天與 42 天」（假陽性）。
// 同理 respec 的 repeat_avg 含跨閘門呼叫，深診路徑標了警語、起手包沒標，於是 8.5 被讀成整關空轉。
// 這支從兩端釘住：(1) 起手包自己產出「卡住任務」區塊，篩選條件與 runner.js 的派工查詢同源；
// (2) 多閘門 stage 的警語兩條路徑一致。
const { newDb } = require('pg-mem');

let dbModule, userId;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
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
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('healthstuck', $1, '測試', 'user') RETURNING id",
    [hash]
  );
  userId = rows[0].id;
});
afterAll(() => dbModule._setPoolForTesting(null));

const { buildWindowSummary, buildAgentSummary } = require('../pipeline/health-data');

const mkTask = async (taskId, { status, updatedAt, hidden = false, paused = false }) => {
  const { rows: [r] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, created_at, updated_at, is_hidden, is_paused)
     VALUES ($1,$2,'odoo',$2,$3,$4,$4,$5,$6) RETURNING id`,
    [userId, taskId, status, updatedAt, hidden, paused]
  );
  return r.id;
};

test('起手包自己產出卡住任務區塊，篩選與派工查詢同源（排除 is_hidden／is_paused）', async () => {
  await dbModule.query('DELETE FROM tasks');
  // 真正卡住的：停在 AI 該推進的狀態、30 小時沒動、沒被封存也沒被暫停
  const stuck = await mkTask('S_stuck', { status: 'coding_running', updatedAt: ago(30 * HOUR) });
  // 使用者手動封存的（真實案例：cs_running 的 task 105、analysis_running 的 task 148）。
  // runner.js 的派工查詢帶 is_hidden = false，本來就不派——不得列進卡住清單。
  const hidden = await mkTask('S_hidden', { status: 'cs_running', updatedAt: ago(30 * DAY), hidden: true });
  await mkTask('S_hidden2', { status: 'analysis_running', updatedAt: ago(42 * DAY), hidden: true });
  // 手動暫停的：同理不派，也不算卡住
  const paused = await mkTask('S_paused', { status: 'qa_running', updatedAt: ago(5 * DAY), paused: true });
  // 等人動作的關：不在 RUNNABLE_STATUSES 內，停多久都不是「卡在執行中」
  await mkTask('S_human', { status: 'review_pending', updatedAt: ago(10 * DAY) });
  // 剛動過的：未達門檻
  await mkTask('S_fresh', { status: 'coding_running', updatedAt: ago(HOUR) });

  const w = await buildWindowSummary(ago(7 * DAY));

  expect(w.stuck_tasks).toBeDefined();
  expect(w.stuck_tasks.threshold_hours).toBe(24);
  // 只有一張真的卡住；封存／暫停／等人／剛動過的都不該混進來
  expect(w.stuck_tasks.rows.map(r => r.id)).toEqual([stuck]);
  expect(w.stuck_tasks.count).toBe(1);
  expect(w.stuck_tasks.rows[0].status).toBe('coding_running');
  expect(w.stuck_tasks.rows[0].stalled_hours).toBeCloseTo(30, 0);
  const listed = w.stuck_tasks.rows.map(r => r.id);
  expect(listed).not.toContain(hidden);
  expect(listed).not.toContain(paused);
  // 但被排除的張數要照報：它們確實停在執行中狀態很久，靜默吃掉等於逼健檢自己再去查一次
  expect(w.stuck_tasks.excluded).toEqual({ hidden: 2, paused: 1 });
  // 並且要明講「不派是正確行為」，否則同一個假陽性會換個地方重演
  expect(w.stuck_tasks.excluded_note).toMatch(/正確行為/);
  // 篩選口徑寫在輸出裡，健檢才不會覺得需要自己拼 SQL
  expect(w.stuck_tasks.filter).toMatch(/is_hidden/);
  expect(w.stuck_tasks.filter).toMatch(/is_paused/);
});

test('多閘門 stage 的警語：起手包的 per_stage 與深診的 repeat_calls 帶同一句', async () => {
  await dbModule.query('DELETE FROM token_usage');
  await dbModule.query('DELETE FROM tasks');
  await mkTask('MG1', { status: 'done', updatedAt: ago(HOUR) });
  // respec 這個 agent_type 由三個不同閘門共用（spec-review／clarify-chat／respec-patch），
  // 同一張任務各跑一次就記成 3——沒有警語會被讀成「這一關重跑三次＝空轉」
  for (let i = 0; i < 3; i++) {
    await dbModule.query(
      `INSERT INTO token_usage (task_id, agent_type, model, input_tokens, duration_ms, status, recorded_at)
       VALUES ('MG1','respec','claude-opus-5',1,1000,'completed',NOW())`);
  }
  await dbModule.query(
    `INSERT INTO token_usage (task_id, agent_type, model, input_tokens, duration_ms, status, recorded_at)
     VALUES ('MG1','coding','claude-opus-5',1,1000,'completed',NOW())`);

  const w = await buildWindowSummary(ago(DAY));

  expect(w.per_stage.respec.repeat_avg).toBe(3);
  expect(w.per_stage.respec.note).toMatch(/不等於本關重跑/);
  // 單一閘門的關不加這個噪音
  expect(w.per_stage.coding.note).toBeUndefined();

  // 兩條路徑的警語必須是同一句：各寫一份就會出現「深診說不等於重跑、起手包沒說」的落差
  const deep = await buildAgentSummary({ name: 'respec-patch', stage: 'respec' }, { windowDays: 1 });
  expect(deep.repeat_calls.note).toBe(w.per_stage.respec.note);
});
