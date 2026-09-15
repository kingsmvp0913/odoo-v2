const request = require('supertest');
const { newDb } = require('pg-mem');

// runClaude 全域 mock：用來證明提交這條路徑一個 agent 都不會叫
const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));

// 3-I2：手動觸發端點只負責轉發，不重跑 runNightlyFix 內部一整套保險絲——mock 掉，
// 只驗證有沒有被呼叫、帶了什麼參數。
const mockRunNightlyFix = jest.fn().mockResolvedValue({ attempted: 0, applied: 0, skipped: 0 });
jest.mock('../pipeline/nightly-fix', () => ({ runNightlyFix: (...args) => mockRunNightlyFix(...args) }));

process.env.JWT_SECRET = 'test-feedback';

let app, dbModule, userToken, adminToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  // admin：走 /api/auth/setup 拿 token（不要自己簽 token——會繞過真實授權路徑）
  const adminRes = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'admin1234', display_name: 'Admin'
  });
  adminToken = adminRes.body.token;

  // 一般使用者：INSERT 後走 /api/auth/login
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('regular', $1, 'Regular', 'user')",
    [hash]
  );
  const userRes = await request(app).post('/api/auth/login').send({
    username: 'regular', password: 'pass1234'
  });
  userToken = userRes.body.token;
});

beforeEach(() => { mockRunClaude.mockClear(); mockRunNightlyFix.mockClear(); });

afterAll(() => {
  dbModule._setPoolForTesting(null);
});

test('任何登入使用者都能提意見', async () => {
  const res = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`)
    .field('content', '任務頂欄的按鈕上下沒留白');
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT status, content FROM feedback WHERE id=$1', [res.body.id]);
  expect(rows[0]).toMatchObject({ status: 'new', content: '任務頂欄的按鈕上下沒留白' });
});

test('提交時一個 agent 都不會被呼叫', async () => {
  await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`)
    .field('content', '另一件事');
  // ⚠ 這條是成本洞的迴歸測試：triage 一旦被搬回提交時機，任何登入使用者
  //   都能單方面觸發無上限的 opus 成本。看到這裡紅了不要放寬它，去看是誰把 AI 搬回來了。
  expect(mockRunClaude).not.toHaveBeenCalled();
});

test('空內容退 400', async () => {
  const res = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '   ');
  expect(res.status).toBe(400);
});

test('一般使用者打管理端點回 403', async () => {
  const res = await request(app).get('/api/admin/feedback')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});

test('管理員核准會記下是誰、什麼時候', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '要核准的');
  const res = await request(app).patch(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'approved' });
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query(
    'SELECT status, decided_by, decided_at FROM feedback WHERE id=$1', [body.id]);
  expect(rows[0].status).toBe('approved');
  expect(rows[0].decided_by).not.toBeNull();
  expect(rows[0].decided_at).not.toBeNull();
});

test('不認得的 status 退 400', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', 'x');
  const res = await request(app).patch(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'merged' });
  expect(res.status).toBe(400);
});

// 2026-09-10：done 改為人工也能設。原本只有夜間批次寫得進去，於是「我自己動手修好了」在畫面上
// 無路可走——留著 approved 會讓批次每晚重撿一次（重付 triage、重跑兩次全套測試），改 rejected
// 又等於謊稱「決定不做」。實際踩到：那天只能繞過 API 直接下 SQL 改。
test('人工可以把意見標成已完成（自己動手修好的那條路）', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '我自己修好了');
  const res = await request(app).patch(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'done', verdict_note: '人工修正' });
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query(
    'SELECT status, verdict_note, decided_by FROM feedback WHERE id=$1', [body.id]);
  expect(rows[0].status).toBe('done');
  expect(rows[0].verdict_note).toBe('人工修正');
  expect(rows[0].decided_by).not.toBeNull();   // 誰標的要留得下來
});

// 健檢開的單是兩列（health_check_findings 的提案 ＋ feedback）。夜間批次合併完是兩列一起標 done，
// 人工這條路只改一半的話，提案那列會永遠停在 approved——健檢頁還當它沒處理完。
test('人工標完成時，健檢開單的那筆提案也要一起標完成', async () => {
  const { rows: [run] } = await dbModule.query(
    "INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id");
  const { rows: [f] } = await dbModule.query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, kind, status)
     VALUES ($1,'__audit__','標題','診斷','medium','proposal','approved') RETURNING id`, [run.id]);
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '健檢開的單');
  await dbModule.query('UPDATE feedback SET finding_id=$2 WHERE id=$1', [body.id, f.id]);

  await request(app).patch(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'done' });

  const { rows } = await dbModule.query(
    'SELECT status, applied_at FROM health_check_findings WHERE id=$1', [f.id]);
  expect(rows[0].status).toBe('done');
  expect(rows[0].applied_at).not.toBeNull();
});

test('沒有連著提案的一般意見標完成不受影響（不得因為 finding_id 是 NULL 就整條炸掉）', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '使用者自己提的');
  const res = await request(app).patch(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'done' });
  expect(res.status).toBe(200);
});

// Minor：done 是夜間批次合併完才會寫的終態。再核准一次會把它塞回 approved，
// 讓下一輪夜間批次重跑整條已經做完的鏈（同一份 finding_fixes 再修一次）。
test('已完成（done）的意見不能再被核准', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '已合併的意見');
  // 直接下 SQL 模擬夜間批次寫入的終態（走 PATCH 也可以，這裡只是不想牽扯另一條路徑）
  await dbModule.query("UPDATE feedback SET status='done' WHERE id=$1", [body.id]);
  const res = await request(app).patch(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'approved' });
  expect(res.status).toBe(400);
  const { rows } = await dbModule.query('SELECT status FROM feedback WHERE id=$1', [body.id]);
  expect(rows[0].status).toBe('done');   // 沒有被改回 approved
});

// 3-I1：requireAdmin 內的 SELECT role 若拋錯，沒有 try/catch 就不會呼叫 next()、也不會
// 回應——請求會被吞掉、掛在原地（管理員開頁面轉圈）。這裡逼 DB 層在 requireAdmin 那一次
// 查詢拋錯，斷言回應就是 500 + 該錯誤訊息本身，而不是流到下一層才報出無關的錯誤。
// ⚠ 同一個 request 在打到 requireAdmin 之前，auth.js 的 verifyToken 也查了一次一模一樣
// 字面的「SELECT role FROM users WHERE id = $1」（它自己的 try/catch 會把失敗吞成 401，
// 測不到 requireAdmin 本身）。用 mockRejectedValueOnce 攔第一次會誤中 verifyToken；
// 這裡改成攔「第二次遇到這句字面完全相同的 SQL」，精準命中 requireAdmin 那一次。
test('requireAdmin 查詢失敗要在攔截點本身回 500（不能被吞掉、流到下一層才報錯）', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '測 requireAdmin 出錯');
  const pool = dbModule.getPool();
  const orig = pool.query.bind(pool);
  const TARGET_SQL = 'SELECT role FROM users WHERE id = $1';
  let seen = 0;
  const spy = jest.spyOn(pool, 'query').mockImplementation((text, params) => {
    if (text === TARGET_SQL) {
      seen += 1;
      if (seen === 2) return Promise.reject(new Error('boom')); // 第 1 次是 verifyToken，第 2 次才是 requireAdmin
    }
    return orig(text, params);
  });
  try {
    const res = await request(app).patch(`/api/admin/feedback/${body.id}`)
      .set('Authorization', `Bearer ${adminToken}`).send({ status: 'approved' })
      .timeout({ response: 5000, deadline: 5000 });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  } finally {
    spy.mockRestore();
  }
});

// 3-I2：手動補跑一次夜間批次的端點。startedBy 要帶觸發者的 userId（不是 null）——
// getHealthCheckSchedule 等排程判斷靠 started_by IS NULL 分辨自動排程與人工觸發。
test('管理員手動觸發夜間批次會帶自己的 userId 當 startedBy', async () => {
  const res = await request(app).post('/api/admin/nightly-fix')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(mockRunNightlyFix).toHaveBeenCalledTimes(1);
  const arg = mockRunNightlyFix.mock.calls[0][0];
  expect(arg.startedBy).not.toBeNull();
  expect(typeof arg.startedBy).toBe('number');
});

test('一般使用者不能手動觸發夜間批次', async () => {
  const res = await request(app).post('/api/admin/nightly-fix')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
  expect(mockRunNightlyFix).not.toHaveBeenCalled();
});

// Minor：GET /api/feedback/mine 原本沒選 verdict_note——使用者送出意見被駁回後，除了
// triage_note 之外看不到任何後續（駁回原因只在管理頁看得到）。
test('GET /api/feedback/mine 帶回 verdict_note（駁回原因），使用者看得到自己被駁回的理由', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '想反映一個問題');
  await request(app).patch(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'rejected', verdict_note: '重複回報' });
  const res = await request(app).get('/api/feedback/mine')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(200);
  const mine = res.body.find((r) => r.id === body.id);
  expect(mine).toMatchObject({ status: 'rejected', verdict_note: '重複回報' });
});

// Minor：意見與附件原本只增不減，沒有刪除端點。DELETE /api/admin/feedback/:id 把已寫好的
// deleteFeedbackDir 接上——這裡驗證 DB 列真的被刪、且非管理員不能呼叫。
test('管理員可以刪除一筆意見（DB 列消失）', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '要被刪除的意見');
  const res = await request(app).delete(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT id FROM feedback WHERE id=$1', [body.id]);
  expect(rows).toHaveLength(0);
});

test('刪除不存在的意見回 404', async () => {
  const res = await request(app).delete('/api/admin/feedback/999999')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
});

test('一般使用者不能刪除意見', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '不該被一般使用者刪掉');
  const res = await request(app).delete(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
  const { rows } = await dbModule.query('SELECT id FROM feedback WHERE id=$1', [body.id]);
  expect(rows).toHaveLength(1);   // 沒被刪掉
});

// 意圖：已完成＝碼已經合併進 master（或人工修好了）。刪掉它會把「這件事做過了」的唯一紀錄
// 連同附件實體檔一起清掉，之後沒有任何地方查得到那份改動是為了什麼而做。
test('已完成的意見不能刪除', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '已合併的意見');
  await dbModule.query("UPDATE feedback SET status='done' WHERE id=$1", [body.id]);

  const res = await request(app).delete(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(400);
  const { rows } = await dbModule.query('SELECT id FROM feedback WHERE id=$1', [body.id]);
  expect(rows).toHaveLength(1);          // 真的還在，不是只回了錯誤碼
});

test('未完成的意見照樣刪得掉（對照組，證明上一支是狀態擋的）', async () => {
  const { body } = await request(app).post('/api/feedback')
    .set('Authorization', `Bearer ${userToken}`).field('content', '還沒處理的');
  const res = await request(app).delete(`/api/admin/feedback/${body.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT id FROM feedback WHERE id=$1', [body.id]);
  expect(rows).toHaveLength(0);
});

// 分頁（?limit / ?offset）沒有自動化測試，這是能力限制不是遺漏：
// `GET /api/admin/feedback` 的查詢（f.* + LEFT JOIN + json_agg ... GROUP BY）**pg-mem 執行不了**
// ——實測三種寫法都拋 `Unknown alias "f"`，明列欄位那版則卡在 `json_build_object` 未實作。
// 這支測試檔裡唯一碰那個端點的既有測試是「一般使用者回 403」，在跑到 SQL 之前就被擋掉了，
// 所以這個端點的查詢從來沒有在測試裡真的執行過。
// ⚠ 不要為了讓它可測而改寫那段 SQL：正式環境（真 PG）是好的，改它等於拿正式行為去遷就
// 測試框架的限制。分頁行為改用真伺服器 curl 驗（2026-09-10 驗過 limit/offset/上限三項）。

// 09-15 R6：健檢提案一律待人工核准，而同一條提案在兩個畫面各有一列（健檢頁的提案＋意見回饋管理的單）。
// 單核准了、提案還掛 pending，健檢頁的待處理數就在說謊；已經結案的提案不能被這裡翻回 approved。
test('在意見回饋管理核准健檢開的單，提案那列也跟著核准；已結案的提案不被翻回來', async () => {
  const { rows: [run] } = await dbModule.query("INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id");
  const mk = async (findingStatus) => {
    const { rows: [f] } = await dbModule.query(
      `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, kind, status)
       VALUES ($1,'__audit__','標題','診斷','medium','proposal',$2) RETURNING id`, [run.id, findingStatus]);
    const { rows: [fb] } = await dbModule.query(
      "INSERT INTO feedback (user_id, content, status, finding_id) VALUES (NULL, '健檢開的單', 'new', $1) RETURNING id", [f.id]);
    return { findingId: f.id, feedbackId: fb.id };
  };
  const pending = await mk('pending');
  const closed = await mk('no_change');
  for (const x of [pending, closed]) {
    const res = await request(app).patch(`/api/admin/feedback/${x.feedbackId}`)
      .set('Authorization', `Bearer ${adminToken}`).send({ status: 'approved' });
    expect(res.status).toBe(200);
  }
  const statusOf = async (id) => (await dbModule.query('SELECT status, decided_by FROM health_check_findings WHERE id=$1', [id])).rows[0];
  expect(await statusOf(pending.findingId)).toMatchObject({ status: 'approved' });
  expect((await statusOf(pending.findingId)).decided_by).not.toBeNull();
  expect((await statusOf(closed.findingId)).status).toBe('no_change');
});
