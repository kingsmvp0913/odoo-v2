// 意圖：admin 一鍵健檢 API（建 run/背景觸發/查歷史與明細）＋admin-gate（子專案 2）。
const request = require('supertest');
const { newDb } = require('pg-mem');

const mockRun = jest.fn().mockResolvedValue(undefined);
const mockRunTask = jest.fn().mockResolvedValue(undefined);
const mockWindowStart = jest.fn().mockResolvedValue(new Date(Date.now() - 3 * 86400000));
jest.mock('../pipeline/health-check-runner', () => ({
  runAudit: mockRun, runTaskHealthCheck: mockRunTask, auditWindowStart: mockWindowStart
}));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn(), getInflightTaskIds: () => [], getInflightInfo: () => [], abortTask: jest.fn(), whenIdle: jest.fn()
}));
process.env.JWT_SECRET = 'test-hc-routes';

let app, dbModule, adminToken, userToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
  const setup = await request(app).post('/api/auth/setup').send({ username: 'admin1', password: 'pass1234', display_name: 'A' });
  adminToken = setup.body.token;
  await request(app).post('/api/admin/users').set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'bob', password: 'pass1234', display_name: 'B', role: 'user' });
  const login = await request(app).post('/api/auth/login').send({ username: 'bob', password: 'pass1234' });
  userToken = login.body.token;
}, 30000);
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(() => { mockRun.mockClear(); mockRunTask.mockClear(); });

test('401 未帶 token / 403 非 admin', async () => {
  expect((await request(app).post('/api/admin/health-check')).status).toBe(401);
  expect((await request(app).post('/api/admin/health-check').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
});

test('GET 健檢路由 401 未帶 token / 403 非 admin', async () => {
  expect((await request(app).get('/api/admin/health-check')).status).toBe(401);
  expect((await request(app).get('/api/admin/health-check').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
  expect((await request(app).get('/api/admin/health-check/1')).status).toBe(401);
  expect((await request(app).get('/api/admin/health-check/1').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
});

test('POST → 建 run(running)、回 runId、背景觸發主導型健檢（視窗＝上一輪之後的增量）', async () => {
  const res = await request(app).post('/api/admin/health-check').set('Authorization', `Bearer ${adminToken}`).send({});
  expect(res.status).toBe(200);
  expect(typeof res.body.runId).toBe('number');
  const { rows: [r] } = await dbModule.query('SELECT status, since_at FROM health_check_runs WHERE id=$1', [res.body.runId]);
  expect(r.status).toBe('running');
  expect(r.since_at).not.toBeNull();                    // 增量視窗的起點一定要落地，否則續跑會走錯 scope
  expect(mockRun).toHaveBeenCalledWith(res.body.runId, expect.objectContaining({ sinceAt: expect.anything() }));
});

// sinceDays 是例外出口：想回頭重掃更久以前（剛接手、或補一段）時才用。
test('POST 帶 sinceDays → 視窗改成回溯那麼多天，而不是增量', async () => {
  const res = await request(app).post('/api/admin/health-check')
    .set('Authorization', `Bearer ${adminToken}`).send({ sinceDays: 30 });
  expect(res.status).toBe(200);
  const { rows: [r] } = await dbModule.query('SELECT window_days, since_at FROM health_check_runs WHERE id=$1', [res.body.runId]);
  expect(r.window_days).toBe(30);
  expect(Date.now() - new Date(r.since_at).getTime()).toBeGreaterThan(29 * 86400000);
});

// 處置狀態就是「跨輪記憶」：沒有它，健檢每輪把同一件事重講一次，而上輪的裁決無處可存。
test('PATCH finding 狀態：落狀態＋裁決理由；判「處理完成」才補成效回看的起算點', async () => {
  const { rows: [run] } = await dbModule.query("INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id");
  const { rows: [f] } = await dbModule.query(
    `INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity, kind)
     VALUES ($1,'__audit__','某條提案','medium','proposal') RETURNING id, status, applied_at`, [run.id]);
  expect(f.status).toBe('pending');                     // 預設待處理
  expect(f.applied_at).toBeNull();

  const noChange = await request(app).patch('/api/admin/health-check/findings/' + f.id)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'no_change', verdict_note: '證據只有一張任務' });
  expect(noChange.status).toBe(200);
  expect(noChange.body.status).toBe('no_change');
  expect(noChange.body.verdict_note).toBe('證據只有一張任務');
  expect(noChange.body.applied_at).toBeNull();          // 不須調整不是「套用」，不該起算成效

  const done = await request(app).patch('/api/admin/health-check/findings/' + f.id)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'done' });
  expect(done.body.applied_at).not.toBeNull();
  const applied = done.body.applied_at;
  // 再改一次狀態不得把起算點往後推，否則成效永遠「還沒累積到樣本」
  const again = await request(app).patch('/api/admin/health-check/findings/' + f.id)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'done', verdict_note: '補一句' });
  expect(again.body.applied_at).toBe(applied);
});

test('PATCH finding：狀態不合法回 400 / 非 admin 403 / 不存在回 404', async () => {
  const { rows: [run] } = await dbModule.query("INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id");
  const { rows: [f] } = await dbModule.query(
    `INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity, kind)
     VALUES ($1,'__audit__','x','ok','proposal') RETURNING id`, [run.id]);
  expect((await request(app).patch('/api/admin/health-check/findings/' + f.id)
    .set('Authorization', `Bearer ${adminToken}`).send({ status: '亂填' })).status).toBe(400);
  expect((await request(app).patch('/api/admin/health-check/findings/' + f.id)
    .set('Authorization', `Bearer ${userToken}`).send({ status: 'done' })).status).toBe(403);
  expect((await request(app).patch('/api/admin/health-check/findings/999999')
    .set('Authorization', `Bearer ${adminToken}`).send({ status: 'done' })).status).toBe(404);
});

test('GET list 回近筆含 findings_count；GET :id 回 run+findings', async () => {
  const { rows: [run] } = await dbModule.query("INSERT INTO health_check_runs (status, window_days) VALUES ('done',30) RETURNING id");
  await dbModule.query("INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity) VALUES ($1,'qa','d','ok')", [run.id]);

  const list = await request(app).get('/api/admin/health-check').set('Authorization', `Bearer ${adminToken}`);
  expect(list.status).toBe(200);
  const item = list.body.find(x => x.id === run.id);
  expect(item.findings_count).toBe(1);

  const detail = await request(app).get(`/api/admin/health-check/${run.id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(detail.body.run.id).toBe(run.id);
  expect(detail.body.findings[0].agent_name).toBe('qa');
});

// 意圖：健檢改成每週自動跑之後，admin 無從得知下一次是什麼時候（畫面只有歷史）。
// 這條端點就是那個答案，且必須與 cron 的排程判斷同源——各算一份的話，改了間隔只會改到一邊。
describe('GET /api/admin/health-check-schedule', () => {
  beforeEach(() => dbModule.query('DELETE FROM health_check_runs'));

  test('401 未帶 token / 403 非 admin', async () => {
    expect((await request(app).get('/api/admin/health-check-schedule')).status).toBe(401);
    expect((await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
  });

  test('從沒跑過 → due，沒有可推算的下次時刻', async () => {
    const res = await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, running: false, due: true, lastRunAt: null, nextRunAt: null });
  });

  test('上次已完成 → 下次＝上次起算滿一個週期', async () => {
    // 週期已由每週改為每天，所以「還沒到」的 fixture 要用小時，不能再用 2 天
    await dbModule.query("INSERT INTO health_check_runs (status, window_days, created_at) VALUES ('done',30,NOW() - INTERVAL '2 hours')");
    const res = await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.due).toBe(false);
    const gap = new Date(res.body.nextRunAt) - new Date(res.body.lastRunAt);
    expect(gap).toBe(res.body.intervalMs);
    expect(new Date(res.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  test('上次超過一個週期 → due（畫面顯示即將執行，而非過去的時刻）', async () => {
    await dbModule.query("INSERT INTO health_check_runs (status, window_days, created_at) VALUES ('done',30,NOW() - INTERVAL '2 days')");
    const res = await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.due).toBe(true);
  });

  test('上一輪還在跑 → running，不給下次時刻（等這輪落地才算得準）', async () => {
    await dbModule.query("INSERT INTO health_check_runs (status, window_days, created_at) VALUES ('running',30,NOW())");
    const res = await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body).toMatchObject({ running: true, due: false, nextRunAt: null });
  });
});

// --- scope=task：單張任務健檢（入口在任務詳情頁的 admin 按鈕）---

let taskSeq = 0;
async function newTask() {
  const { rows: [u] } = await dbModule.query("SELECT id FROM users WHERE username='admin1'");
  const bizId = `T-HC-${++taskSeq}`;
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, title, original_text, status, source) VALUES ($1,$2,'健檢用','x','new','web') RETURNING id",
    [u.id, bizId]);
  return { id: t.id, bizId };
}

test('POST task 健檢：401 未帶 token / 403 非 admin', async () => {
  expect((await request(app).post('/api/admin/health-check/task').send({ taskDbId: 1 })).status).toBe(401);
  expect((await request(app).post('/api/admin/health-check/task')
    .set('Authorization', `Bearer ${userToken}`).send({ taskDbId: 1 })).status).toBe(403);
});

test('POST task 健檢：建帶 task_db_id 的 run、背景觸發 runTaskHealthCheck', async () => {
  const { id: taskDbId } = await newTask();
  const res = await request(app).post('/api/admin/health-check/task')
    .set('Authorization', `Bearer ${adminToken}`).send({ taskDbId });
  expect(res.status).toBe(200);
  const { rows: [r] } = await dbModule.query('SELECT status, task_db_id FROM health_check_runs WHERE id=$1', [res.body.runId]);
  expect(r.status).toBe('running');
  expect(r.task_db_id).toBe(taskDbId);
  expect(mockRunTask).toHaveBeenCalledWith(res.body.runId, expect.objectContaining({ taskDbId }));
  expect(mockRun).not.toHaveBeenCalled();            // 不可誤觸全平台健檢
});

test('POST task 健檢：任務不存在回 404，且不建 run', async () => {
  const { rows: [before] } = await dbModule.query('SELECT COUNT(*)::int AS n FROM health_check_runs');
  const res = await request(app).post('/api/admin/health-check/task')
    .set('Authorization', `Bearer ${adminToken}`).send({ taskDbId: 999999 });
  expect(res.status).toBe(404);
  const { rows: [after] } = await dbModule.query('SELECT COUNT(*)::int AS n FROM health_check_runs');
  expect(after.n).toBe(before.n);                    // 不留下註定 error 的殭屍 run
  expect(mockRunTask).not.toHaveBeenCalled();
});

test('GET list／detail 帶出這是哪一張任務（沒有就分不出診斷的對象）', async () => {
  const { id: taskDbId, bizId } = await newTask();
  const { rows: [run] } = await dbModule.query(
    "INSERT INTO health_check_runs (status, task_db_id) VALUES ('done',$1) RETURNING id", [taskDbId]);
  const list = await request(app).get('/api/admin/health-check').set('Authorization', `Bearer ${adminToken}`);
  const row = list.body.find(r => r.id === run.id);
  expect(row.task_db_id).toBe(taskDbId);
  expect(row.task_id).toBe(bizId);
  const detail = await request(app).get('/api/admin/health-check/' + run.id).set('Authorization', `Bearer ${adminToken}`);
  expect(detail.body.run.task.task_id).toBe(bizId);
});
