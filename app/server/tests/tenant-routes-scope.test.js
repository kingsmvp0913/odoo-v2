/**
 * tenant-routes-scope.test.js — 跨公司矩陣（規格 §9）
 *
 * 這支守的是整個產品化最核心的一句承諾：一家客戶看不到另一家客戶的任何東西。
 * 刻意用「硬帶對方的 id 打 API」的方式測，而不是只測列表——列表漏一筆只是少看到，
 * 帶 id 打得進去才是真的外洩。
 * 看不到一律期待 404 而不是 403：403 等於承認「這個 id 存在」，那本身就是外洩。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-scope-jwt';
process.env.APP_SECRET = 'test-scope-secret';

let app, dbModule;
let adminToken, aToken, bToken;
let coA, coB, coInternal, pA, pB;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

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

  const mkCo = async (name, isInternal = false) => (await one(
    'INSERT INTO companies (name, is_active, is_internal) VALUES ($1, true, $2) RETURNING id', [name, isInternal]
  )).id;
  coInternal = await mkCo('內部', true);
  coA = await mkCo('甲公司');
  coB = await mkCo('乙公司');

  const mkUser = async (username, companyId) => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      [username, hash, 'user', companyId]
    );
    return (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
  };
  aToken = await mkUser('userA', coA);
  bToken = await mkUser('userB', coB);

  const mkProject = async (name, companyId) => {
    const id = (await one("INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", [name])).id;
    await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2)', [id, companyId]);
    return id;
  };
  pA = await mkProject('甲的專案', coA);
  pB = await mkProject('乙的專案', coB);
});

afterAll(() => dbModule._setPoolForTesting(null));

const as = (t) => ({ Authorization: `Bearer ${t}` });

describe('專案', () => {
  test('列表只看得到自己公司綁的', async () => {
    const res = await request(app).get('/api/projects').set(as(aToken));
    expect(res.status).toBe(200);
    expect(res.body.map(p => p.id)).toEqual([pA]);
  });

  test('平台管理員看得到全部', async () => {
    const res = await request(app).get('/api/projects').set(as(adminToken));
    expect(res.body.map(p => p.id).sort()).toEqual([pA, pB].sort());
  });

  test('硬帶別家的專案 id → 404（不是 403，403 等於承認它存在）', async () => {
    expect((await request(app).get(`/api/projects/${pB}`).set(as(aToken))).status).toBe(404);
    expect((await request(app).get(`/api/projects/${pB}/repos`).set(as(aToken))).status).toBe(404);
    expect((await request(app).get(`/api/projects/${pB}/pending-release`).set(as(aToken))).status).toBe(404);
  });

  test('自己公司的專案照常打得開', async () => {
    expect((await request(app).get(`/api/projects/${pA}`).set(as(aToken))).status).toBe(200);
  });

  test('建立專案改成平台管理員限定', async () => {
    const res = await request(app).post('/api/projects')
      .set(as(aToken)).send({ name: '偷建的', odoo_version: '17' });
    expect(res.status).toBe(403);
  });

  test('改專案、刪專案、加 repo 都是平台管理員限定', async () => {
    expect((await request(app).patch(`/api/projects/${pA}`).set(as(aToken)).send({ description: 'x' })).status).toBe(403);
    expect((await request(app).delete(`/api/projects/${pA}`).set(as(aToken))).status).toBe(403);
    expect((await request(app).post(`/api/projects/${pA}/repos`).set(as(aToken)).send({ label: 'x', repo_url: 'y' })).status).toBe(403);
  });
});

describe('上正式（規格 §4.3 can_release）', () => {
  test('一般使用者不能按，即使綁定勾了', async () => {
    await dbModule.query('UPDATE project_companies SET can_release = true WHERE project_id=$1 AND company_id=$2', [pA, coA]);
    const res = await request(app).post(`/api/projects/${pA}/release`).set(as(aToken)).send({});
    expect(res.status).toBe(403);
  });

  test('別家公司的人連專案都看不到，更不可能按', async () => {
    const res = await request(app).post(`/api/projects/${pB}/release`).set(as(aToken)).send({});
    expect([403, 404]).toContain(res.status);
  });
});
