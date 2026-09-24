/**
 * company-readiness.test.js — 開通檢查表的判定（子專案 4 §4.1）
 *
 * 這張表唯一的價值是「它講的是真的」。說已完成但其實沒有，比沒有這張表更糟——
 * 人會照著它把客戶交出去。所以每一項的兩個方向都要釘。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');
const { companyReadiness } = require('../lib/company-readiness');

process.env.JWT_SECRET = 'test-readiness-jwt';
process.env.APP_SECRET = 'test-readiness-secret';

let app, dbModule, adminToken, coId, internalId, projectId;
const one = async (sql, p) => (await dbModule.query(sql, p)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });
const step = (r, key) => r.steps.find((s) => s.key === key);

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

  coId = (await one("INSERT INTO companies (name, is_active, is_internal) VALUES ('客戶甲', false, false) RETURNING id")).id;
  internalId = (await one("INSERT INTO companies (name, is_active, is_internal) VALUES ('內部', true, true) RETURNING id")).id;
  projectId = (await one("INSERT INTO projects (name, odoo_version) VALUES ('甲的專案','17') RETURNING id")).id;
});

afterAll(() => dbModule._setPoolForTesting(null));

test('什麼都還沒做 → 八項全未完成，done=0', async () => {
  const r = await companyReadiness(coId);
  expect(r.applicable).toBe(true);
  expect(r.total).toBe(8);
  expect(r.done).toBe(0);
  expect(r.steps.every((s) => s.done === false)).toBe(true);
  // 每一項都要講得出下一步去哪裡做，否則這張表只是在說「你還沒好」
  expect(r.steps.every((s) => (s.hint || '').length > 5)).toBe(true);
});

// 內部公司不走開通流程。讓「不適用」由資料本身講，而不是靠每個呼叫端記得隱藏。
test('內部公司 → applicable=false，不回任何步驟', async () => {
  const r = await companyReadiness(internalId);
  expect(r).toEqual({ applicable: false, done: 0, total: 0, steps: [] });
});

test('找不到公司 → null（呼叫端回 404）', async () => {
  expect(await companyReadiness(999999)).toBeNull();
});

test('啟用公司 → 第 1 項完成', async () => {
  await dbModule.query('UPDATE companies SET is_active = true WHERE id = $1', [coId]);
  expect(step(await companyReadiness(coId), 'company').done).toBe(true);
});

test('建了公司管理員 → 第 2 項完成；一般使用者不算', async () => {
  const hash = await bcrypt.hash('password123', 10);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('plain',$1,'plain','user',$2)",
    [hash, coId]);
  expect(step(await companyReadiness(coId), 'admin').done).toBe(false);

  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('coadmin',$1,'coadmin','company_admin',$2)",
    [hash, coId]);
  expect(step(await companyReadiness(coId), 'admin').done).toBe(true);
});

test('綁了專案 → 第 3 項完成', async () => {
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2)', [projectId, coId]);
  expect(step(await companyReadiness(coId), 'project').done).toBe(true);
});

// 只填登入帳號、沒有 PAT 是不能用的憑證，標成已設定等於把問題留到客戶第一次 commit
test('GIT 看的是 PAT，不是只填了登入帳號', async () => {
  await dbModule.query("UPDATE companies SET git_login='someone' WHERE id=$1", [coId]);
  expect(step(await companyReadiness(coId), 'git').done).toBe(false);
  await dbModule.query("UPDATE companies SET git_pat_enc='enc' WHERE id=$1", [coId]);
  expect(step(await companyReadiness(coId), 'git').done).toBe(true);
});

// infra 是三件事併一項（使用者同意不拆），所以提示必須講出缺哪一個
test('repo／DB／部署目標三件缺一不可，提示要講出缺哪個', async () => {
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url) VALUES ($1,'main','https://example.invalid/a.git')", [projectId]);
  let s = step(await companyReadiness(coId), 'infra');
  expect(s.done).toBe(false);
  expect(s.hint).toContain('資料庫連線');
  expect(s.hint).toContain('正式機部署目標');
  expect(s.hint).not.toContain('缺：repo');

  await dbModule.query(
    `INSERT INTO db_connections (project_id, name, ssh_host, ssh_user, db_name)
     VALUES ($1,'prod','h','u','d')`, [projectId]);
  await dbModule.query(
    `INSERT INTO project_deploy_targets (project_id, env, runtime, addons_dir, db_name, branch)
     VALUES ($1,'prod','docker','/a','d','main')`, [projectId]);
  s = step(await companyReadiness(coId), 'infra');
  expect(s.done).toBe(true);
});

// 部署目標要是正式機的；只有測試區的不算開通完成
test('只有 test 環境的部署目標不算「正式機部署目標」', async () => {
  const p2 = (await one("INSERT INTO projects (name, odoo_version) VALUES ('只有測試','17') RETURNING id")).id;
  const co2 = (await one("INSERT INTO companies (name, is_active, is_internal) VALUES ('客戶乙', true, false) RETURNING id")).id;
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2)', [p2, co2]);
  await dbModule.query(
    `INSERT INTO project_deploy_targets (project_id, env, runtime, addons_dir, db_name, branch)
     VALUES ($1,'test','docker','/a','d','main')`, [p2]);
  expect(step(await companyReadiness(co2), 'infra').done).toBe(false);
});

test('建了測試區 → 第 6 項完成', async () => {
  await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1,'running')", [projectId]);
  expect(step(await companyReadiness(coId), 'testenv').done).toBe(true);
});

test('填了 API key → 第 7 項完成', async () => {
  await dbModule.query("UPDATE companies SET anthropic_key_enc='enc' WHERE id=$1", [coId]);
  expect(step(await companyReadiness(coId), 'apikey').done).toBe(true);
});

// 專案可能同時綁多家公司，別家在同一個共用專案下跑完的任務不算這家開通完成
test('跑通的任務看「誰建的」，不是看專案', async () => {
  const hash = await bcrypt.hash('password123', 10);
  const other = (await one(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('outsider',$1,'outsider','admin') RETURNING id",
    [hash])).id;
  await dbModule.query(
    "INSERT INTO tasks (task_id, title, status, source, user_id, project_id) VALUES ('T-other','別家的','done','web',$1,$2)",
    [other, projectId]);
  expect(step(await companyReadiness(coId), 'firsttask').done).toBe(false);

  const mine = (await one("SELECT id FROM users WHERE username='coadmin'")).id;
  await dbModule.query(
    "INSERT INTO tasks (task_id, title, status, source, user_id, project_id) VALUES ('T-mine','我們的','done','web',$1,$2)",
    [mine, projectId]);
  expect(step(await companyReadiness(coId), 'firsttask').done).toBe(true);
});

test('八項都完成 → done=8', async () => {
  const r = await companyReadiness(coId);
  expect(`未完成的: ${r.steps.filter((s) => !s.done).map((s) => s.key).join(',') || '(無)'}`).toBe('未完成的: (無)');
  expect(r.done).toBe(8);
});

describe('端點', () => {
  test('平台管理員拿得到', async () => {
    const res = await request(app).get(`/api/admin/companies/${coId}/readiness`).set(as(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(8);
  });

  test('不存在的公司 → 404', async () => {
    expect((await request(app).get('/api/admin/companies/999999/readiness').set(as(adminToken))).status).toBe(404);
  });

  // 這張表會透露客戶的基礎設定狀態，跟公司管理頁其他端點同一個門檻
  test('沒有 token → 401', async () => {
    expect((await request(app).get(`/api/admin/companies/${coId}/readiness`)).status).toBe(401);
  });
});

// 失控保險絲的預設值（2026-09-24 使用者拍板 50）。它不是帳單上限——客戶用訂閱憑證、
// 不會被按量扣款——而是「這張任務燒得不合理，停下來讓人看一眼」。
// 依據：185 張真實任務的 p99 是 $27.69、史上最貴 $31.97，所以 50 不會誤擋正常工作。
describe('新客戶公司的任務花費上限預設值', () => {
  test('沒帶就給 50，不是留空（留空＝沒有任何保險絲）', async () => {
    const res = await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '預設值測試' });
    expect(res.status).toBe(201);
    const row = await one('SELECT task_budget_usd FROM companies WHERE id=$1', [res.body.id]);
    expect(Number(row.task_budget_usd)).toBe(50);
  });

  test('明確帶 null → 尊重呼叫端，停用上限', async () => {
    const res = await request(app).post('/api/admin/companies')
      .set(as(adminToken)).send({ name: '不設上限測試', task_budget_usd: null });
    expect(res.status).toBe(201);
    const row = await one('SELECT task_budget_usd FROM companies WHERE id=$1', [res.body.id]);
    expect(row.task_budget_usd).toBeNull();
  });

  test('帶了不合法的金額 → 400，不會默默用預設值蓋過去', async () => {
    const res = await request(app).post('/api/admin/companies')
      .set(as(adminToken)).send({ name: '壞金額測試', task_budget_usd: -5 });
    expect(res.status).toBe(400);
  });
});
