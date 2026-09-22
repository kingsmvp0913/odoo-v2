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
