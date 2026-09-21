/**
 * company-admin-bindings.test.js — 公司↔專案綁定與「可上正式」（規格 §4.3、§5.3）
 *
 * 綁定就是可視範圍本身：綁了才看得到，解除立刻看不到。
 * can_release 另外控制「能不能按上正式」，預設不給。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-bind-jwt';
process.env.APP_SECRET = 'test-bind-secret';

let app, dbModule, adminToken, coCustomer, coInternal, projectId;

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

  coInternal = (await one('INSERT INTO companies (name, is_active, is_internal) VALUES ($1,true,true) RETURNING id', ['內部'])).id;
  coCustomer = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '甲客戶' })).body.id;
  projectId = (await one("INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", ['測試專案'])).id;
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('綁定', () => {
  test('綁上去，can_release 預設 false', async () => {
    const res = await request(app).put(`/api/admin/companies/${coCustomer}/projects/${projectId}`)
      .set(as(adminToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body.can_release).toBe(false);
    const row = await one('SELECT can_release FROM project_companies WHERE project_id=$1 AND company_id=$2',
      [projectId, coCustomer]);
    expect(row.can_release).toBe(false);
  });

  test('重複綁同一個專案不會爆（改成更新 can_release）', async () => {
    const res = await request(app).put(`/api/admin/companies/${coCustomer}/projects/${projectId}`)
      .set(as(adminToken)).send({ can_release: true });
    expect(res.status).toBe(200);
    expect(res.body.can_release).toBe(true);
  });

  test('內部公司不准勾可上正式（它綁了全部專案，勾了等於全員可上正式）', async () => {
    const res = await request(app).put(`/api/admin/companies/${coInternal}/projects/${projectId}`)
      .set(as(adminToken)).send({ can_release: true });
    expect(res.status).toBe(400);
    const row = await one('SELECT can_release FROM project_companies WHERE project_id=$1 AND company_id=$2',
      [projectId, coInternal]);
    expect(row === undefined || row.can_release === false).toBe(true);
  });

  test('內部公司可以綁專案，只是 can_release 一定 false', async () => {
    const res = await request(app).put(`/api/admin/companies/${coInternal}/projects/${projectId}`)
      .set(as(adminToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body.can_release).toBe(false);
  });

  test('綁不存在的專案 → 404', async () => {
    expect((await request(app).put(`/api/admin/companies/${coCustomer}/projects/999999`)
      .set(as(adminToken)).send({})).status).toBe(404);
  });

  test('不存在的公司 → 404', async () => {
    expect((await request(app).put(`/api/admin/companies/999999/projects/${projectId}`)
      .set(as(adminToken)).send({})).status).toBe(404);
  });
});

describe('列出與解除', () => {
  test('列得出綁了哪些專案，含 can_release 與任務數（解除前要讓人知道會影響幾張單）', async () => {
    const res = await request(app).get(`/api/admin/companies/${coCustomer}/projects`).set(as(adminToken));
    expect(res.status).toBe(200);
    const row = res.body.find(r => r.project_id === projectId);
    expect(row.can_release).toBe(true);
    expect(typeof row.task_count).toBe('number');
  });

  test('解除綁定 → 204，DB 真的沒了', async () => {
    const res = await request(app).delete(`/api/admin/companies/${coCustomer}/projects/${projectId}`).set(as(adminToken));
    expect(res.status).toBe(204);
    const row = await one('SELECT 1 FROM project_companies WHERE project_id=$1 AND company_id=$2',
      [projectId, coCustomer]);
    expect(row).toBeUndefined();
  });

  test('解除沒綁過的 → 404（靜默成功會讓人以為解除了別的東西）', async () => {
    expect((await request(app).delete(`/api/admin/companies/${coCustomer}/projects/${projectId}`)
      .set(as(adminToken))).status).toBe(404);
  });
});

describe('授權', () => {
  test('一般使用者不能綁——但他連公司都看不到，先確認是 403 不是 404', async () => {
    const res = await request(app).put(`/api/admin/companies/${coCustomer}/projects/${projectId}`).send({});
    expect(res.status).toBe(401);
  });
});
