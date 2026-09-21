/**
 * company-admin-routes.test.js — 平台管理員的公司管理（規格 §5.3「新增 公司管理（admin）」）
 *
 * 為什麼要這支：公司表從第 1 部就存在，但至今沒有任何端點能建立或修改公司——
 * 唯一寫過它的是一次性遷移腳本。沒有這一關，就沒有辦法建立第一家客戶公司。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-coadmin-jwt';
process.env.APP_SECRET = 'test-coadmin-secret';

let app, dbModule, adminToken, userToken;

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

  const co = (await one('INSERT INTO companies (name, is_active) VALUES ($1, true) RETURNING id', ['既有公司'])).id;
  const hash = await bcrypt.hash('password123', 10);
  await dbModule.query(
    'INSERT INTO users (username, password_hash, display_name, role, company_id, approved) VALUES ($1,$2,$1,$3,$4,true)',
    ['plain', hash, 'user', co]
  );
  userToken = (await request(app).post('/api/auth/login').send({ username: 'plain', password: 'password123' })).body.token;
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('授權', () => {
  test('一般使用者列公司 → 403（這是平台管理員限定的工具，不是「看不到」）', async () => {
    expect((await request(app).get('/api/admin/companies').set(as(userToken))).status).toBe(403);
  });
  test('一般使用者建公司 → 403', async () => {
    expect((await request(app).post('/api/admin/companies').set(as(userToken)).send({ name: 'x' })).status).toBe(403);
  });
  test('未登入 → 401', async () => {
    expect((await request(app).get('/api/admin/companies')).status).toBe(401);
  });
});

describe('建立公司', () => {
  test('預設不啟用（規格 §4.1：預設安全值，要啟用得明確帶）', async () => {
    const res = await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '甲客戶' });
    expect(res.status).toBe(201);
    expect(res.body.is_active).toBe(false);
    expect(res.body.is_internal).toBe(false);
  });

  test('帶 is_internal: true 會被忽略——誤標成內部就是拿平台的訂閱跑客戶的 AI', async () => {
    const res = await request(app).post('/api/admin/companies').set(as(adminToken))
      .send({ name: '乙客戶', is_internal: true });
    expect(res.status).toBe(201);
    expect(res.body.is_internal).toBe(false);
    const row = await one('SELECT is_internal FROM companies WHERE id = $1', [res.body.id]);
    expect(row.is_internal).toBe(false);
  });

  test('名稱重複 → 409', async () => {
    await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '丙客戶' });
    const res = await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '丙客戶' });
    expect(res.status).toBe(409);
  });

  test('沒給名稱 → 400', async () => {
    expect((await request(app).post('/api/admin/companies').set(as(adminToken)).send({})).status).toBe(400);
  });

  test('功能開關：認得的存下來，不認得的丟掉', async () => {
    const res = await request(app).post('/api/admin/companies').set(as(adminToken))
      .send({ name: '丁客戶', features: { exam: true, bogus: true } });
    expect(res.status).toBe(201);
    expect(res.body.features).toEqual({ exam: true });
  });
});

describe('修改公司', () => {
  test('改啟用與使用期間', async () => {
    const id = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '戊客戶' })).body.id;
    const res = await request(app).put(`/api/admin/companies/${id}`).set(as(adminToken))
      .send({ is_active: true, active_until: '2030-01-01T00:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(true);
    expect(new Date(res.body.active_until).getUTCFullYear()).toBe(2030);
  });

  test('改 is_internal 一樣被忽略', async () => {
    const id = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '己客戶' })).body.id;
    await request(app).put(`/api/admin/companies/${id}`).set(as(adminToken)).send({ is_internal: true });
    const row = await one('SELECT is_internal FROM companies WHERE id = $1', [id]);
    expect(row.is_internal).toBe(false);
  });

  test('改不存在的公司 → 404', async () => {
    expect((await request(app).put('/api/admin/companies/999999').set(as(adminToken)).send({ is_active: true })).status).toBe(404);
  });

  test('沒帶的欄位不動（部分更新不可以把別的欄位洗成 null）', async () => {
    const id = (await request(app).post('/api/admin/companies').set(as(adminToken))
      .send({ name: '庚客戶', features: { exam: true } })).body.id;
    await request(app).put(`/api/admin/companies/${id}`).set(as(adminToken)).send({ is_active: true });
    const res = await request(app).get('/api/admin/companies').set(as(adminToken));
    const row = res.body.find(c => c.id === id);
    expect(row.features).toEqual({ exam: true });
    expect(row.name).toBe('庚客戶');
  });
});

describe('列出公司', () => {
  test('不回傳 PAT 密文，只回「有沒有設」', async () => {
    const id = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '辛客戶' })).body.id;
    await dbModule.query('UPDATE companies SET git_pat_enc = $1 WHERE id = $2', ['fake-cipher', id]);
    const res = await request(app).get('/api/admin/companies').set(as(adminToken));
    const row = res.body.find(c => c.id === id);
    expect(row.has_git_pat).toBe(true);
    expect(row.git_pat_enc).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('fake-cipher');
  });

  test('人數與專案數各自算各自的——寫錯會變成兩者相乘，而且只檢查「有回數字」的測試抓不到', async () => {
    const id = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '壬客戶' })).body.id;
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      ['cnt-u1', 'x', 'user', id]);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      ['cnt-u2', 'x', 'user', id]);
    const p1 = (await one("INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", ['計數專案一'])).id;
    const p2 = (await one("INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", ['計數專案二'])).id;
    await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2)', [p1, id]);
    await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2)', [p2, id]);

    const row = (await request(app).get('/api/admin/companies').set(as(adminToken))).body.find(c => c.id === id);
    expect(row.user_count).toBe(2);
    expect(row.project_count).toBe(2);
  });
});

describe('功能清單', () => {
  test('回得出可勾選的功能（前端要拿它畫勾選框）', async () => {
    const res = await request(app).get('/api/admin/companies/features').set(as(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.some(f => f.key === 'exam')).toBe(true);
  });
});
