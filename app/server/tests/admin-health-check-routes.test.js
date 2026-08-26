// 意圖：admin 一鍵健檢 API（建 run/背景觸發/查歷史與明細）＋admin-gate（子專案 2）。
const request = require('supertest');
const { newDb } = require('pg-mem');

const mockRun = jest.fn().mockResolvedValue(undefined);
const mockRunTask = jest.fn().mockResolvedValue(undefined);
const mockWindowStart = jest.fn().mockResolvedValue(new Date(Date.now() - 3 * 86400000));
jest.mock('../pipeline/health-check-runner', () => ({
  runAudit: mockRun, runTaskHealthCheck: mockRunTask, auditWindowStart: mockWindowStart
}));
// 「修這條」會真的開 git worktree 並 spawn claude，測試只驗路由與狀態機
const mockRunFix = jest.fn().mockResolvedValue(undefined);
const mockAdopt = jest.fn().mockResolvedValue({ branch: 'fix/finding-1-1', commit: 'abc123' });
const mockPush = jest.fn().mockResolvedValue({ branch: 'fix/finding-1-1' });
const mockDiscard = jest.fn().mockResolvedValue(undefined);
const mockApply = jest.fn().mockResolvedValue({ branch: 'fix/finding-1-1', merged: true, restarted: true });
jest.mock('../pipeline/finding-fix', () => ({
  runFix: mockRunFix, adoptFix: mockAdopt, pushFix: mockPush, discardFix: mockDiscard, applyFix: mockApply,
  classifyChanges: jest.requireActual('../pipeline/finding-fix').classifyChanges
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
beforeEach(() => { mockRun.mockClear(); mockRunTask.mockClear(); mockWindowStart.mockClear(); });

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

// 大健檢不只是「換一個天數」：monthly 還會多帶一份上一期資料給 agent 做趨勢比對，所以 cadence
// 必須原樣落地並傳進 runner——只存 window_days 的話，續跑時那半段會靜默消失。
test.each([['weekly', 7], ['monthly', 30]])('POST 帶 cadence=%s → 固定回看 %s 天，且節奏傳進 runner', async (cadence, days) => {
  const res = await request(app).post('/api/admin/health-check')
    .set('Authorization', `Bearer ${adminToken}`).send({ cadence });
  expect(res.status).toBe(200);
  const { rows: [r] } = await dbModule.query('SELECT window_days, cadence FROM health_check_runs WHERE id=$1', [res.body.runId]);
  expect(r.window_days).toBe(days);
  expect(r.cadence).toBe(cadence);
  expect(mockRun).toHaveBeenCalledWith(res.body.runId, expect.objectContaining({ cadence }));
  expect(mockWindowStart).not.toHaveBeenCalled();     // 固定視窗不該再去問增量起點
});

test('POST 不帶 cadence／亂填 → 退回 daily 增量，不會靜默跑成大健檢', async () => {
  const res = await request(app).post('/api/admin/health-check')
    .set('Authorization', `Bearer ${adminToken}`).send({ cadence: '大健檢' });
  const { rows: [r] } = await dbModule.query('SELECT cadence FROM health_check_runs WHERE id=$1', [res.body.runId]);
  expect(r.cadence).toBe('daily');
  expect(mockRun).toHaveBeenCalledWith(res.body.runId, expect.objectContaining({ cadence: 'daily' }));
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

// 歷史列表要一眼看得出「這一輪嚴不嚴重、還有沒有事沒處理」。沒有這兩個聚合，得逐輪點進去才知道，
// 而點進去之前每一列長得一模一樣。
describe('GET list 的嚴重度與處理狀態聚合', () => {
  async function runWith(findings) {
    const { rows: [run] } = await dbModule.query(
      "INSERT INTO health_check_runs (status, window_days) VALUES ('done',7) RETURNING id");
    for (const [severity, kind, status] of findings) {
      await dbModule.query(
        `INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity, kind, status)
         VALUES ($1,'__audit__','d',$2,$3,$4)`, [run.id, severity, kind, status]);
    }
    const list = await request(app).get('/api/admin/health-check').set('Authorization', `Bearer ${adminToken}`);
    return list.body.find(x => x.id === run.id);
  }

  test('嚴重度取本輪最嚴重的那一條，不是最後一條也不是字串序', async () => {
    // 刻意把 high 放在中間：取最大值才會過，取首／末筆或字串排序都會拿到別的值
    const row = await runWith([['low', 'proposal', 'pending'], ['high', 'proposal', 'pending'], ['ok', 'summary', 'pending']]);
    expect(row.severity_rank).toBe(3);
  });

  test('健檢自己失敗要蓋過一切：那一輪的「最嚴重只有 low」是假的，它根本沒檢查完', async () => {
    const row = await runWith([['low', 'proposal', 'pending'], ['error', 'note', 'pending']]);
    expect(row.error_count).toBe(1);
  });

  test('待辦只算 medium 以上：輕微的放著不管是允許的，不該讓整列長年掛紅字', async () => {
    const row = await runWith([['low', 'proposal', 'pending'], ['medium', 'proposal', 'done'], ['high', 'proposal', 'pending']]);
    expect(row.proposal_count).toBe(3);
    expect(row.open_count).toBe(1);          // low 不算、已處理的 medium 也不算，只剩那條 high
  });

  test('提案全部處理完 → 待辦歸零（而不是沿用提案總數）', async () => {
    const row = await runWith([['high', 'proposal', 'done'], ['medium', 'proposal', 'no_change']]);
    expect(row.proposal_count).toBe(2);
    expect(row.open_count).toBe(0);
  });

  test('一則 finding 都沒有 → 嚴重度為 NULL，前端才顯示得出「—」而不是誤報正常', async () => {
    const row = await runWith([]);
    expect(row.severity_rank).toBeNull();
    expect(row.proposal_count).toBe(0);
  });
});

// 意圖：admin 必須看得到固定晚間健檢的狀態；不能再用「上一輪 + 24 小時」，否則手動執行會把
// 排程帶到下午。這條端點與 cron 共用判斷，避免兩邊漂移。
describe('GET /api/admin/health-check-schedule', () => {
  beforeEach(() => dbModule.query('DELETE FROM health_check_runs'));

  test('401 未帶 token / 403 非 admin', async () => {
    expect((await request(app).get('/api/admin/health-check-schedule')).status).toBe(401);
    expect((await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
  });

  test('從沒跑過 → 回傳排程狀態', async () => {
    const res = await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, running: false, lastRunAt: null });
  });

  test('上一輪還在跑 → running，不給下次時刻（等這輪落地才算得準）', async () => {
    await dbModule.query("INSERT INTO health_check_runs (status, window_days, created_at) VALUES ('running',30,NOW())");
    const res = await request(app).get('/api/admin/health-check-schedule').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body).toMatchObject({ running: true, due: false, nextRunAt: null });
  });
});

test('GET 排程總覽：僅 admin 可讀，包含臺灣時間 23:00 的健檢', async () => {
  expect((await request(app).get('/api/admin/schedules')).status).toBe(401);
  expect((await request(app).get('/api/admin/schedules').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
  const res = await request(app).get('/api/admin/schedules').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'health-check', timing: expect.stringContaining('每日 23:00（臺灣時間）') }),
    expect.objectContaining({ id: 'cron-tick', timing: '每分鐘' })
  ]));
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

// --- 「修這條」：只有提案能修、同一條不並發、三段動作各自獨立 ---

async function newProposal(kind = 'proposal') {
  const { rows: [run] } = await dbModule.query("INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id");
  const { rows: [f] } = await dbModule.query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, kind)
     VALUES ($1,'__audit__','某條提案','細節','medium',$2) RETURNING id`, [run.id, kind]);
  return f.id;
}

test('POST 修這條：建 fix 紀錄（running）並背景觸發', async () => {
  const id = await newProposal();
  const res = await request(app).post(`/api/admin/health-check/findings/${id}/fix`)
    .set('Authorization', `Bearer ${adminToken}`).send({});
  expect(res.status).toBe(200);
  const { rows: [fix] } = await dbModule.query('SELECT status, finding_id FROM finding_fixes WHERE id=$1', [res.body.fixId]);
  expect(fix.status).toBe('running');
  expect(fix.finding_id).toBe(id);
  expect(mockRunFix).toHaveBeenCalledWith(res.body.fixId, expect.objectContaining({ findingId: id }));
});

test('候選訊號不能修：證據還不夠就動手，等於在沒有結論時改碼', async () => {
  const id = await newProposal('signal');
  const res = await request(app).post(`/api/admin/health-check/findings/${id}/fix`)
    .set('Authorization', `Bearer ${adminToken}`).send({});
  expect(res.status).toBe(400);
});

test('同一條提案不並發：兩個工作區同時改同一件事，兩份 diff 都會是半套', async () => {
  const id = await newProposal();
  const first = await request(app).post(`/api/admin/health-check/findings/${id}/fix`)
    .set('Authorization', `Bearer ${adminToken}`).send({});
  const second = await request(app).post(`/api/admin/health-check/findings/${id}/fix`)
    .set('Authorization', `Bearer ${adminToken}`).send({});
  expect(second.status).toBe(409);
  expect(second.body.fixId).toBe(first.body.fixId);       // 指回進行中的那一個，不是再開一個
});

test('GET 回最新一次修正；採用與推送是兩顆分開的按鈕', async () => {
  const id = await newProposal();
  const started = await request(app).post(`/api/admin/health-check/findings/${id}/fix`)
    .set('Authorization', `Bearer ${adminToken}`).send({});
  const got = await request(app).get(`/api/admin/health-check/findings/${id}/fix`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(got.body.id).toBe(started.body.fixId);

  const adopt = await request(app).post(`/api/admin/fixes/${started.body.fixId}/adopt`)
    .set('Authorization', `Bearer ${adminToken}`).send({});
  expect(adopt.status).toBe(200);
  expect(mockAdopt).toHaveBeenCalledWith(started.body.fixId, expect.any(Number));
  expect(mockPush).not.toHaveBeenCalled();                // 採用不會順手推上去

  await request(app).post(`/api/admin/fixes/${started.body.fixId}/push`)
    .set('Authorization', `Bearer ${adminToken}`).send({});
  expect(mockPush).toHaveBeenCalled();
});

test('修正相關路由一律 admin only', async () => {
  const id = await newProposal();
  expect((await request(app).post(`/api/admin/health-check/findings/${id}/fix`)
    .set('Authorization', `Bearer ${userToken}`).send({})).status).toBe(403);
  expect((await request(app).post('/api/admin/fixes/1/adopt')
    .set('Authorization', `Bearer ${userToken}`).send({})).status).toBe(403);
  expect((await request(app).post('/api/admin/fixes/1/push')).status).toBe(401);
  // 套用會重啟整個平台，是全站破壞力最大的一顆按鈕
  expect((await request(app).post('/api/admin/fixes/1/apply')
    .set('Authorization', `Bearer ${userToken}`).send({})).status).toBe(403);
  expect((await request(app).post('/api/admin/fixes/1/apply')).status).toBe(401);
});

test('套用要把在飛任務清單傳進去：重不重啟由 runner 的實際狀態決定，不是由前端說了算', async () => {
  const r = await request(app).post('/api/admin/fixes/7/apply')
    .set('Authorization', `Bearer ${adminToken}`).send({});
  expect(r.status).toBe(200);
  expect(mockApply).toHaveBeenCalledWith(7, expect.any(Number), []);
});
