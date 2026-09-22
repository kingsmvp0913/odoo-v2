// 意圖：更版頁是「平台更版機制」子專案唯一有人看得到的東西，而它承載兩項已拍板的裁決：
//   裁決二 紅燈只在畫面上通知（這台沒有 webhook／Teams）→ 端點必須把「上一次沒成功」與
//          「沒有任何東西會通知你」當成資料回出來，而不是靠前端自己編。
//   裁決三 在飛任務會被中止 → 人工更版不得在使用者沒有明確說要中止時把任務砍掉。
// 另外守的是三層防線的第三層：這四支端點全部只給平台管理員。
//
// ⚠ 這個檔**不能**讓 restartNow 真的跑起來：它會 spawn 全套 jest（現象是 hang 不是 fail，
// Task 3 已經交代過），也會對宿主下 docker restart。所以整支 pipeline/release 的 restartNow
// 被 mock 掉，其餘（pendingReleases／releaseWindowConfig／lastReleaseResult）維持真的，
// 因為端點與引擎讀的必須是同一份資料——那正是這裡要驗的。
process.env.JWT_SECRET = 'test-release-routes';

const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');

jest.mock('../pipeline/release', () => {
  const actual = jest.requireActual('../pipeline/release');
  return { ...actual, restartNow: jest.fn().mockResolvedValue({
    restarted: true, testsPassed: true, tests: { summary: 'Tests: 5947 passed' }, released: 1,
  }) };
});
jest.mock('../pipeline/runner', () => ({
  getInflightInfo: jest.fn().mockReturnValue([]),
  abortTask: jest.fn(),
}));

let dbModule, app, adminToken, userToken, release, runner;

// 全週 0 點起 24 小時＝永遠在時段內。時鐘無關，才不會在半夜跑測試時變色。
const ALWAYS = { weekdays: [0, 1, 2, 3, 4, 5, 6], startHour: 0, durationHours: 24 };

async function seedPending({ members = null } = {}) {
  const { rows: [run] } = await dbModule.query(
    "INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id");
  const { rows: [f] } = await dbModule.query(
    `INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity)
     VALUES ($1,'qa','QA 關把規格沒寫的東西當缺陷退回','medium') RETURNING id`, [run.id]);
  const { rows: [fix] } = await dbModule.query(
    `INSERT INTO finding_fixes (finding_id, status, branch, commit_sha, diff, review_notes, verify_notes, members)
     VALUES ($1,'merged','fix/qa-123','abcdef1234567890','--- a\n+++ b','審過了','複檢動了一行',$2) RETURNING id`,
    [f.id, members ? JSON.stringify(members) : null]);
  return { findingId: f.id, fixId: fix.id };
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  release = require('../pipeline/release');
  runner = require('../pipeline/runner');

  const { hashPassword } = require('../password');
  const pw = await hashPassword('pw');
  await dbModule.query(
    "INSERT INTO companies (name, is_active, is_internal) VALUES ('客戶甲', true, false)");
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('adm',$1,'A','admin')", [pw]);
  await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, role, company_id)
     VALUES ('joe',$1,'J','user',(SELECT id FROM companies LIMIT 1))`, [pw]);

  // 登入走 auth 路由，所以這裡要一個裝得下它的 app；四支更版端點掛在同一個 app 上。
  app = express();
  app.use(express.json());
  require('../auth').registerRoutes(app);
  require('../release-routes').registerRoutes(app);

  adminToken = (await request(app).post('/api/auth/login').send({ username: 'adm', password: 'pw' })).body.token;
  userToken = (await request(app).post('/api/auth/login').send({ username: 'joe', password: 'pw' })).body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  await dbModule.query('DELETE FROM finding_fixes');
  await dbModule.query('DELETE FROM health_check_findings');
  await dbModule.query('DELETE FROM health_check_runs');
  await dbModule.query('DELETE FROM teams_settings');
  release.restartNow.mockClear();
  runner.getInflightInfo.mockReset().mockReturnValue([]);
  runner.abortTask.mockReset();
});

// 立刻更版是 fire-and-forget（全跑十幾分鐘，掛在請求上必定逾時），所以斷言背景那段之前
// 要讓事件迴圈把它跑完。單一個 setImmediate 不夠——那段裡有好幾個 await 打 DB。
const flushBackground = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const adm = () => ({ Authorization: `Bearer ${adminToken}` });
const usr = () => ({ Authorization: `Bearer ${userToken}` });

async function setWindow(cfg) {
  await dbModule.query(
    `INSERT INTO teams_settings (id, release_window) VALUES (1,$1)
       ON CONFLICT (id) DO UPDATE SET release_window = $1`, [JSON.stringify(cfg)]);
}

// ── 第三層防線：後端 403 ───────────────────────────────────────────────────
describe('管理員限定', () => {
  // 逐支列出來比「隨便挑一支驗」強，但清單自己也會腐爛：漏列一支就永遠沒人驗。
  // 所以先釘母體——本檔註冊的 admin 端點就是這四支，多一支而沒進清單時這裡先紅。
  const ADMIN_ENDPOINTS = [
    ['get', '/api/admin/release'],
    ['put', '/api/admin/release/window'],
    ['delete', '/api/admin/release/window'],
    ['post', '/api/admin/release/now'],
  ];

  test('母體：release-routes.js 註冊的 /api/admin/ 端點數與清單一致', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../release-routes.js'), 'utf8');
    const registered = [...src.matchAll(/app\.(get|put|post|delete)\('(\/api\/admin\/[^']+)'/g)]
      .map((m) => `${m[1]} ${m[2]}`);
    expect(registered.length).toBeGreaterThan(0);          // 抓不到就不是綠燈，是守衛失效
    expect(registered.sort()).toEqual(ADMIN_ENDPOINTS.map(([m, p]) => `${m} ${p}`).sort());
  });

  test.each(ADMIN_ENDPOINTS)('%s %s 對一般使用者回 403', async (method, path) => {
    const res = await request(app)[method](path).set(usr()).send({});
    expect(`${method} ${path}: ${res.status}`).toBe(`${method} ${path}: 403`);
  });

  test.each(ADMIN_ENDPOINTS)('%s %s 未登入回 401', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(`${method} ${path}: ${res.status}`).toBe(`${method} ${path}: 401`);
  });
});

// ── 問題一二三：什麼在等、什麼時候會上去、上一次成功了嗎 ─────────────────
describe('GET /api/admin/release 回得出那三個問題的答案', () => {
  test('待更版清單與引擎讀的是同一份（pendingReleases）', async () => {
    await setWindow(ALWAYS);
    const { fixId, findingId } = await seedPending();
    const engine = await release.pendingReleases();
    expect(engine).toHaveLength(1);                         // 母體：沒有待更版的話下面什麼都沒驗到
    const res = await request(app).get('/api/admin/release').set(adm());
    expect(res.status).toBe(200);
    expect(res.body.pending.map((r) => r.id)).toEqual([fixId]);
    expect(res.body.pending[0].finding_id).toBe(findingId);
    expect(res.body.pending[0].commit_sha).toBe('abcdef1234567890');
  });

  test('意見回饋來源跟著出來（稽核要答的是「依據哪段文字改的」）', async () => {
    await setWindow(ALWAYS);
    await seedPending({ members: [{ source: 'feedback', id: 42 }, { source: 'finding', id: 7 }] });
    const res = await request(app).get('/api/admin/release').set(adm());
    expect(res.body.pending).toHaveLength(1);
    expect(res.body.pending[0].feedback_ids).toEqual([42]);
  });

  test('時段：設定過就回得出下一次是什麼時候、現在在不在時段內', async () => {
    await setWindow(ALWAYS);
    const res = await request(app).get('/api/admin/release').set(adm());
    expect(res.body.window.configured).toBe(true);
    expect(res.body.window.inWindow).toBe(true);
    expect(res.body.window.nextWindowAt).not.toBeNull();
    // 裁決三的門檻要看得到，不是只寫在碼裡。2026-09-22 從 30 分鐘改成 5 分鐘：舊值是從
    // 「全跑約 15 分鐘」這個沒量過的數字推出來的，實測是 115 秒（見 pipeline/release.js）。
    // 這裡對回 release.js 的常數而不是寫死 5，免得兩邊哪天各說各話。
    expect(res.body.abortMinutes)
      .toBe(Math.round(require('../pipeline/release').RELEASE_ABORT_BEFORE_END_MS / 60000));
  });

  test('沒設定時段：configured=false，而且預填值不等於「已經在跑」', async () => {
    const res = await request(app).get('/api/admin/release').set(adm());
    expect(res.body.window.configured).toBe(false);
    expect(res.body.window.nextWindowAt).toBeNull();
    // 預設值只是表單預填（週六日 02:00 起兩小時）。若哪天被當成「沒設定時的行為」，
    // 平台會在沒有人同意的情況下自己在週末重啟客戶。
    expect(res.body.window.defaults).toEqual({ weekdays: [6, 0], startHour: 2, durationHours: 2 });
  });

  test('上一次失敗的結果原封回出來——這是唯一會留下來的通知', async () => {
    await dbModule.query(
      `INSERT INTO teams_settings (id, release_last_result) VALUES (1,$1)`,
      [JSON.stringify({ at: '2026-09-20T18:05:00.000Z', restarted: false, testsPassed: false,
        reason: '重啟前全跑未通過：3 支測試紅', released: 0, aborted: [] })]);
    const res = await request(app).get('/api/admin/release').set(adm());
    expect(res.body.last.restarted).toBe(false);
    expect(res.body.last.reason).toContain('3 支測試紅');
  });

  test('「沒有任何東西會通知你」是資料不是文案：notify.channels 是空的', async () => {
    const res = await request(app).get('/api/admin/release').set(adm());
    expect(res.body.notify.channels).toEqual([]);
    expect(res.body.notify.note).toContain('webhook');
  });
});

// ── 時段設定 ──────────────────────────────────────────────────────────────
describe('PUT/DELETE /api/admin/release/window', () => {
  test('存得進去，而且引擎（releaseWindowConfig）讀得到同一份', async () => {
    const res = await request(app).put('/api/admin/release/window').set(adm())
      .send({ weekdays: [6, 0], startHour: 2, durationHours: 2 });
    expect(res.status).toBe(200);
    // 星期照收到的順序原樣存（前端送出前自己排過）——這裡驗的是「存什麼讀回什麼」，不是排序。
    expect(res.body.window).toEqual({ weekdays: [6, 0], startHour: 2, durationHours: 2 });
    // 驗證通過卻被引擎判為無效的話，畫面會顯示存好了而機制其實是關的。
    expect(await release.releaseWindowConfig()).toEqual({ weekdays: [6, 0], startHour: 2, durationHours: 2 });
  });

  test.each([
    ['一天都沒選', { weekdays: [], startHour: 2, durationHours: 2 }],
    ['星期超出範圍', { weekdays: [9], startHour: 2, durationHours: 2 }],
    ['開始時間超出 0-23', { weekdays: [6], startHour: 26, durationHours: 2 }],
    ['長度不是正數', { weekdays: [6], startHour: 2, durationHours: 0 }],
    // 跨午夜的時段 isInWindow 會靜默漏掉（Task 1 審查記錄），在入口擋才有人看得到理由。
    ['跨過午夜', { weekdays: [6], startHour: 23, durationHours: 4 }],
  ])('%s → 400 且說得出理由', async (_name, body) => {
    const res = await request(app).put('/api/admin/release/window').set(adm()).send(body);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
    expect(await release.releaseWindowConfig()).toBeNull();   // 壞設定不得落地
  });

  test('取消＝引擎讀到 null＝自動更版整條關掉', async () => {
    await setWindow(ALWAYS);
    expect(await release.releaseWindowConfig()).not.toBeNull();
    const res = await request(app).delete('/api/admin/release/window').set(adm());
    expect(res.status).toBe(200);
    expect(await release.releaseWindowConfig()).toBeNull();
  });
});

// ── 立刻更版 ──────────────────────────────────────────────────────────────
describe('POST /api/admin/release/now', () => {
  test('沒有待更版的碼就不重啟——重啟不是零成本的操作', async () => {
    const res = await request(app).post('/api/admin/release/now').set(adm()).send({});
    expect(res.status).toBe(400);
    expect(release.restartNow).not.toHaveBeenCalled();
  });

  test('有任務在飛而沒說要中止 → 409 並附上清單（裁決三要看得到）', async () => {
    await seedPending();
    runner.getInflightInfo.mockReturnValue([{ taskId: 186, userId: 1, startedAt: '2026-09-22T01:00:00Z' }]);
    const res = await request(app).post('/api/admin/release/now').set(adm()).send({});
    expect(res.status).toBe(409);
    expect(res.body.inflight.map((t) => t.taskId)).toEqual([186]);
    expect(release.restartNow).not.toHaveBeenCalled();
  });

  test('明確說要中止 → 中止那幾條、留下說明、照常更版', async () => {
    await seedPending();
    runner.getInflightInfo.mockReturnValue([{ taskId: 186, userId: 1, startedAt: '2026-09-22T01:00:00Z' }]);
    await dbModule.query(
      `INSERT INTO tasks (id, task_id, title, user_id, status, source)
       VALUES (186,'T186','x',1,'coding_running','web')`);
    const res = await request(app).post('/api/admin/release/now').set(adm()).send({ abortInflight: true });
    expect(res.status).toBe(200);
    expect(res.body.started).toBe(true);
    await flushBackground();
    expect(runner.abortTask).toHaveBeenCalledWith(186);
    const { rows } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=186');
    expect(rows).toHaveLength(1);                // 母體：沒寫進去的話下一句什麼都沒驗
    expect(rows[0].content).toContain('重啟後會自動從同一關重跑');
  });

  test('夜間批次還在維護中就不插隊（它正在 git push，中途被砍要進 shell 才解得開）', async () => {
    await seedPending();
    await dbModule.query(
      `INSERT INTO teams_settings (id, maintenance_until) VALUES (1, NOW() + interval '1 hour')
         ON CONFLICT (id) DO UPDATE SET maintenance_until = NOW() + interval '1 hour'`);
    const res = await request(app).post('/api/admin/release/now').set(adm()).send({});
    expect(res.status).toBe(409);
    expect(release.restartNow).not.toHaveBeenCalled();
  });

  test('人工更版的結果一樣落 DB——否則「全跑紅了」只剩一行會被輪替掉的 stdout', async () => {
    await seedPending();
    release.restartNow.mockResolvedValueOnce({
      restarted: false, testsPassed: false, tests: { summary: 'Tests: 3 failed' },
      reason: '重啟前全跑未通過：3 支測試紅', released: 0,
    });
    await request(app).post('/api/admin/release/now').set(adm()).send({});
    await flushBackground();
    const res = await request(app).get('/api/admin/release').set(adm());
    expect(res.body.last).not.toBeNull();
    expect(res.body.last.source).toBe('manual');
    expect(res.body.last.restarted).toBe(false);
    expect(res.body.last.reason).toContain('3 支測試紅');
  });
});

// ── 公告橫幅的旗標 ────────────────────────────────────────────────────────
describe('GET /api/release/notice', () => {
  test('一般登入者也讀得到（會被重啟踢下線的是所有人，不是只有管理員）', async () => {
    await setWindow(ALWAYS);
    await seedPending();
    const res = await request(app).get('/api/release/notice').set(usr());
    expect(res.status).toBe(200);
    expect(res.body.show).toBe(true);
    expect(res.body.inWindow).toBe(true);
  });

  test('但不外洩管理員的東西：只回時間，不回筆數或診斷文字', async () => {
    await setWindow(ALWAYS);
    await seedPending();
    const res = await request(app).get('/api/release/notice').set(usr());
    expect(Object.keys(res.body).sort()).toEqual(['inWindow', 'label', 'show', 'startsAt']);
    expect(JSON.stringify(res.body)).not.toContain('QA 關');
  });

  test('沒有待更版的碼就不掛橫幅——時段到了也不會重啟，說要重啟就是騙人', async () => {
    await setWindow(ALWAYS);
    const res = await request(app).get('/api/release/notice').set(usr());
    expect(res.body.show).toBe(false);
  });

  test('沒設定時段就不掛橫幅', async () => {
    await seedPending();
    const res = await request(app).get('/api/release/notice').set(usr());
    expect(res.body.show).toBe(false);
  });

  test('未登入讀不到', async () => {
    const res = await request(app).get('/api/release/notice');
    expect(res.status).toBe(401);
  });
});
