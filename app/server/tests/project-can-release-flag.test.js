/**
 * project-can-release-flag.test.js — 第 3 部 b Task 5b（規格 §4.3 can_release）
 *
 * 前端「上正式」按鈕（側欄專案右鍵選單，UiNextApp.js:1272）算不出自己能不能按——
 * 這個答案只有後端知道：canReleaseProject（lib/tenant-access.js）＝
 * 「平台管理員，或這家公司對這個專案的綁定勾了 can_release 的公司管理員」。
 * 這支釘住 GET /api/projects（側欄實際吃的那份）與 GET /api/projects/:id
 * 兩個端點都要把這個答案算進回應裡，且不能因為加欄位而動到既有的可見性規則。
 *
 * fixture 形狀照 tenant-routes-scope.test.js。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-can-release-jwt';
process.env.APP_SECRET = 'test-can-release-secret';

let app, dbModule;
let adminToken, companyAdminToken, normalUserToken, outsiderToken;
let coA, coB, pTrue, pFalse;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  adminToken = (await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '平台管理員' })).body.token;

  const mkCo = async (name) => (await one(
    'INSERT INTO companies (name, is_active, is_internal) VALUES ($1, true, false) RETURNING id', [name]
  )).id;
  coA = await mkCo('甲公司');
  coB = await mkCo('乙公司');

  const mkUser = async (username, role, companyId) => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      [username, hash, role, companyId]
    );
    return (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
  };
  companyAdminToken = await mkUser('coAAdmin', 'company_admin', coA);
  normalUserToken = await mkUser('coAUser', 'user', coA);
  outsiderToken = await mkUser('coBUser', 'user', coB);

  const mkProject = async (name, companyId, canRelease) => {
    const id = (await one("INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", [name])).id;
    await dbModule.query(
      'INSERT INTO project_companies (project_id, company_id, can_release) VALUES ($1,$2,$3)',
      [id, companyId, canRelease]
    );
    return id;
  };
  // 同一家公司底下兩個專案，綁定的 can_release 不同，才能拿同一個公司管理員／一般使用者
  // 分別測出 true 與 false 兩種結果（規則 19：測「覆蓋權」類邏輯要用兩筆以上有鑑別力的輸入）。
  pTrue = await mkProject('甲的專案（可上正式）', coA, true);
  pFalse = await mkProject('甲的專案（不可上正式）', coA, false);
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('GET /api/projects（側欄實際吃的那份，見 UiNextApp.js:566）的 can_release', () => {
  test('平台管理員 → 兩個專案都是 true，不受綁定影響', async () => {
    const res = await request(app).get('/api/projects').set(as(adminToken));
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((p) => [p.id, p]));
    expect(byId[pTrue].can_release).toBe(true);
    expect(byId[pFalse].can_release).toBe(true);
  });

  test('公司管理員、綁定 can_release=true → true', async () => {
    const res = await request(app).get('/api/projects').set(as(companyAdminToken));
    const byId = Object.fromEntries(res.body.map((p) => [p.id, p]));
    expect(byId[pTrue].can_release).toBe(true);
  });

  test('公司管理員、綁定 can_release=false → false', async () => {
    const res = await request(app).get('/api/projects').set(as(companyAdminToken));
    const byId = Object.fromEntries(res.body.map((p) => [p.id, p]));
    expect(byId[pFalse].can_release).toBe(false);
  });

  test('一般使用者，即使綁定有勾 → false（勾的是公司管理員的權限，不是全公司的）', async () => {
    const res = await request(app).get('/api/projects').set(as(normalUserToken));
    const byId = Object.fromEntries(res.body.map((p) => [p.id, p]));
    expect(byId[pTrue].can_release).toBe(false);
  });

  test('看不到這個專案的人 → 列表裡根本沒有這一筆，不因加欄位而變得看得到', async () => {
    const res = await request(app).get('/api/projects').set(as(outsiderToken));
    expect(res.body.map((p) => p.id)).not.toContain(pTrue);
    expect(res.body.map((p) => p.id)).not.toContain(pFalse);
  });
});

describe('GET /api/projects/:id 的 can_release（單一專案，供 ProjectDetail 之類讀取）', () => {
  test('平台管理員 → true', async () => {
    const res = await request(app).get(`/api/projects/${pFalse}`).set(as(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.can_release).toBe(true);
  });

  test('公司管理員、綁定 can_release=true → true', async () => {
    const res = await request(app).get(`/api/projects/${pTrue}`).set(as(companyAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.can_release).toBe(true);
  });

  test('公司管理員、綁定 can_release=false → false', async () => {
    const res = await request(app).get(`/api/projects/${pFalse}`).set(as(companyAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.can_release).toBe(false);
  });

  test('一般使用者，即使綁定有勾 → false', async () => {
    const res = await request(app).get(`/api/projects/${pTrue}`).set(as(normalUserToken));
    expect(res.status).toBe(200);
    expect(res.body.can_release).toBe(false);
  });

  test('看不到這個專案的人 → 404，不回任何資料（維持既有可見性規則，不可因加欄位而洩漏）', async () => {
    const res = await request(app).get(`/api/projects/${pTrue}`).set(as(outsiderToken));
    expect(res.status).toBe(404);
    expect(res.body.can_release).toBeUndefined();
  });
});

describe('待上正式清單與執行權分開', () => {
  let taskId;
  beforeAll(async () => {
    const submitter = await one("SELECT id FROM users WHERE username = 'coAUser'");
    taskId = 'RELEASE-VISIBLE-1';
    await dbModule.query(
      `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, approved_at)
       VALUES ($1,$2,'manual','待上正式的改動','done',$3,NOW())`,
      [submitter.id, taskId, pTrue]
    );
  });

  test('一般成員能唯讀同專案清單與提出者資訊，但不能執行上正式', async () => {
    const list = await request(app).get(`/api/projects/${pTrue}/pending-release`).set(as(normalUserToken));
    expect(list.status).toBe(200);
    expect(list.body.tasks).toEqual([expect.objectContaining({
      task_id: taskId, submitter_name: 'coAUser', submitter_company: '甲公司',
    })]);
    expect(list.body.prodDeploy.canRelease).toBe(false);
    const release = await request(app).post(`/api/projects/${pTrue}/release`).set(as(normalUserToken)).send({});
    expect(release.status).toBe(403);
  });

  test('公司管理員只在綁定可上正式的專案取得權限', async () => {
    const allowed = await request(app).get(`/api/projects/${pTrue}/pending-release`).set(as(companyAdminToken));
    const denied = await request(app).get(`/api/projects/${pFalse}/pending-release`).set(as(companyAdminToken));
    expect(allowed.body.prodDeploy.canRelease).toBe(true);
    expect(denied.body.prodDeploy.canRelease).toBe(false);
    expect((await request(app).post(`/api/projects/${pFalse}/release`).set(as(companyAdminToken)).send({})).status).toBe(403);
  });

  test('別家公司連清單也看不到', async () => {
    const res = await request(app).get(`/api/projects/${pTrue}/pending-release`).set(as(outsiderToken));
    expect(res.status).toBe(404);
    expect(res.body.tasks).toBeUndefined();
  });
});

test('客戶看規格摘要與驗收條件，但 API 不傳原始 YAML；平台管理員可看原文', async () => {
  const submitter = await one("SELECT id FROM users WHERE username = 'coAUser'");
  const raw = 'summary: 客戶可看懂的摘要\nacceptance:\n  - 驗收可使用\nrequirements:\n  - 內部實作細節\n';
  const task = await one(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, analysis_yaml)
     VALUES ($1,'SPEC-VISIBLE-1','manual','規格可見性','spec_review',$2,$3) RETURNING id`,
    [submitter.id, pTrue, raw]
  );
  await dbModule.query(
    "INSERT INTO task_specs (task_id, version, kind, analysis_yaml) VALUES ($1,1,'main',$2)",
    [task.id, raw]
  );
  const customer = await request(app).get(`/api/tasks/${task.id}`).set(as(normalUserToken));
  expect(customer.status).toBe(200);
  expect(customer.body.spec).toEqual(expect.objectContaining({ summary: '客戶可看懂的摘要', acceptance: ['驗收可使用'] }));
  expect(customer.body.task.analysis_yaml).toBeUndefined();
  expect(customer.body.spec.raw_yaml).toBeUndefined();
  expect(customer.body.specs[0].raw_yaml).toBeUndefined();
  const platform = await request(app).get(`/api/tasks/${task.id}`).set(as(adminToken));
  expect(platform.status).toBe(200);
  expect(platform.body.spec.raw_yaml).toBe(raw);
  expect(platform.body.specs[0].raw_yaml).toBe(raw);
});

test('合併衝突只能由平台管理員裁決，客戶不能直接呼叫 API 繞過畫面', async () => {
  const submitter = await one("SELECT id FROM users WHERE username = 'coAUser'");
  const task = await one(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id)
     VALUES ($1,'CONFLICT-PLATFORM-1','manual','合併衝突','merge_conflict',$2) RETURNING id`,
    [submitter.id, pTrue]
  );
  for (const endpoint of ['mark-conflict-resolved', 'resolve-conflicts', 'merge-clarify']) {
    for (const token of [normalUserToken, companyAdminToken]) {
      const res = await request(app).post(`/api/tasks/${task.id}/${endpoint}`).set(as(token)).send({});
      expect(res.status).toBe(403);
    }
  }
});

test('客戶停下時只看白話原因，請平台協助會留紀錄並通知管理員', async () => {
  const submitter = await one("SELECT id FROM users WHERE username = 'coAUser'");
  const task = await one(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, blocker_type, blocker_content)
     VALUES ($1,'BLOCKER-HELP-1','manual','待協助','stopped',$2,'env','Traceback: secret diagnostic') RETURNING id`,
    [submitter.id, pTrue]
  );
  const customer = await request(app).get(`/api/tasks/${task.id}`).set(as(normalUserToken));
  expect(customer.status).toBe(200);
  expect(customer.body.task.blocker_reason).toContain('測試環境');
  expect(customer.body.task.blocker_content).toBeUndefined();
  const platform = await request(app).get(`/api/tasks/${task.id}`).set(as(adminToken));
  expect(platform.body.task.blocker_content).toContain('Traceback');
  const help = await request(app).post(`/api/tasks/${task.id}/request-platform-help`).set(as(normalUserToken)).send({});
  expect(help.status).toBe(200);
  const log = await one("SELECT content FROM task_logs WHERE task_id = $1 AND content LIKE '[請平台協助]%'", [task.id]);
  expect(log.content).toContain('已通知平台管理員');
  const denied = await request(app).post(`/api/tasks/${task.id}/request-platform-help`).set(as(outsiderToken)).send({});
  expect(denied.status).toBe(404);
});
