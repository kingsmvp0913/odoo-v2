/**
 * company-routes.test.js — 公司管理員管自家帳號（規格 §5.3「新增 company-routes.js」、§8 P6）
 *
 * 範圍限自己公司，而且公司 id 不是參數——是從 req.actor 來的，
 * 讓它變成路徑參數就等於開了一條「改個數字試試看」的路。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-cort-jwt';
process.env.APP_SECRET = 'test-cort-secret';

let app, dbModule, adminToken, caToken, plainToken, coA, coB, userInB;

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
    'INSERT INTO companies (name, is_active) VALUES ($1, true) RETURNING id', [name])).id;
  coA = await mkCo('甲公司');
  coB = await mkCo('乙公司');

  const mkUser = async (username, companyId, role) => {
    const hash = await bcrypt.hash('password123', 10);
    const id = (await one(
      'INSERT INTO users (username, password_hash, display_name, role, company_id, approved) VALUES ($1,$2,$1,$3,$4,true) RETURNING id',
      [username, hash, role, companyId])).id;
    const token = (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
    return { id, token };
  };
  caToken = (await mkUser('ca-a', coA, 'company_admin')).token;
  plainToken = (await mkUser('plain-a', coA, 'user')).token;
  userInB = (await mkUser('someone-b', coB, 'user')).id;
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('誰能用', () => {
  test('一般使用者 → 403（他看得到自己公司，只是不能管帳號）', async () => {
    expect((await request(app).get('/api/company/users').set(as(plainToken))).status).toBe(403);
  });
  test('公司管理員 → 200', async () => {
    expect((await request(app).get('/api/company/users').set(as(caToken))).status).toBe(200);
  });
  test('平台管理員沒有公司 → 400，訊息要講清楚要去哪管', async () => {
    const res = await request(app).get('/api/company/users').set(as(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('公司');
  });
});

describe('範圍', () => {
  test('只列得到自己公司的人', async () => {
    const res = await request(app).get('/api/company/users').set(as(caToken));
    expect(res.body.every(u => u.company_id === coA)).toBe(true);
    expect(res.body.some(u => u.id === userInB)).toBe(false);
  });

  test('改別家公司的人 → 404（不是 403：403 等於承認這個 id 存在）', async () => {
    const res = await request(app).put(`/api/company/users/${userInB}`).set(as(caToken))
      .send({ display_name: '被改到了' });
    expect(res.status).toBe(404);
    const row = await one('SELECT display_name FROM users WHERE id=$1', [userInB]);
    expect(row.display_name).not.toBe('被改到了');
  });

  test('停用別家公司的人 → 404，而且真的沒被停用', async () => {
    const res = await request(app).put(`/api/company/users/${userInB}/active`).set(as(caToken))
      .send({ active: false });
    expect(res.status).toBe(404);
    const row = await one('SELECT approved FROM users WHERE id=$1', [userInB]);
    expect(row.approved).toBe(true);
  });
});

describe('新增帳號', () => {
  test('自動掛在自己公司，不看 body 給什麼 company_id', async () => {
    const res = await request(app).post('/api/company/users').set(as(caToken))
      .send({ username: 'new-a', password: 'password123', display_name: '新人', company_id: coB });
    expect(res.status).toBe(201);
    const row = await one('SELECT company_id, role FROM users WHERE username=$1', ['new-a']);
    expect(row.company_id).toBe(coA);
    expect(row.role).toBe('user');
  });

  test('不准建平台管理員（建得出來就等於拿到全平台）', async () => {
    const res = await request(app).post('/api/company/users').set(as(caToken))
      .send({ username: 'evil', password: 'password123', role: 'admin' });
    expect(res.status).toBe(400);
    expect(await one('SELECT 1 FROM users WHERE username=$1', ['evil'])).toBeUndefined();
  });

  test('可以建公司管理員', async () => {
    const res = await request(app).post('/api/company/users').set(as(caToken))
      .send({ username: 'ca2', password: 'password123', role: 'company_admin' });
    expect(res.status).toBe(201);
    expect((await one('SELECT role FROM users WHERE username=$1', ['ca2'])).role).toBe('company_admin');
  });

  test('密碼太短 → 400（比照平台既有規則）', async () => {
    expect((await request(app).post('/api/company/users').set(as(caToken))
      .send({ username: 'short', password: 'abc' })).status).toBe(400);
  });

  test('帳號重複 → 409', async () => {
    const res = await request(app).post('/api/company/users').set(as(caToken))
      .send({ username: 'new-a', password: 'password123' });
    expect(res.status).toBe(409);
  });
});

describe('改角色與停用', () => {
  test('user → company_admin 可以', async () => {
    const id = (await one('SELECT id FROM users WHERE username=$1', ['new-a'])).id;
    const res = await request(app).put(`/api/company/users/${id}`).set(as(caToken)).send({ role: 'company_admin' });
    expect(res.status).toBe(200);
    expect((await one('SELECT role FROM users WHERE id=$1', [id])).role).toBe('company_admin');
  });

  test('改成 admin → 400，而且 DB 沒變', async () => {
    const id = (await one('SELECT id FROM users WHERE username=$1', ['new-a'])).id;
    const res = await request(app).put(`/api/company/users/${id}`).set(as(caToken)).send({ role: 'admin' });
    expect(res.status).toBe(400);
    expect((await one('SELECT role FROM users WHERE id=$1', [id])).role).toBe('company_admin');
  });

  test('停用＝approved 設 false（規格 §8 P6：只能停用不能刪）', async () => {
    const id = (await one('SELECT id FROM users WHERE username=$1', ['new-a'])).id;
    const res = await request(app).put(`/api/company/users/${id}/active`).set(as(caToken)).send({ active: false });
    expect(res.status).toBe(200);
    expect((await one('SELECT approved FROM users WHERE id=$1', [id])).approved).toBe(false);
  });

  test('停用之後，對方手上那張還沒過期的 token 立刻失效（不然停用等於做半套）', async () => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id, approved) VALUES ($1,$2,$1,$3,$4,true)',
      ['tobedisabled', hash, 'user', coA]);
    const victimToken = (await request(app).post('/api/auth/login')
      .send({ username: 'tobedisabled', password: 'password123' })).body.token;
    // 停用之前：用得動
    expect((await request(app).get('/api/auth/me').set(as(victimToken))).status).toBe(200);

    const id = (await one('SELECT id FROM users WHERE username=$1', ['tobedisabled'])).id;
    await request(app).put(`/api/company/users/${id}/active`).set(as(caToken)).send({ active: false });

    // 停用之後：同一張 token 立刻不能用
    expect((await request(app).get('/api/auth/me').set(as(victimToken))).status).toBe(403);
  });

  test('從來沒設過 approved 的既有帳號照樣能用（判斷式寫成 !approved 會把 9 個管理員全鎖死）', async () => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      ['legacy-null', hash, 'user', coA]);
    const t = (await request(app).post('/api/auth/login')
      .send({ username: 'legacy-null', password: 'password123' })).body.token;
    expect((await request(app).get('/api/auth/me').set(as(t))).status).toBe(200);
  });

  test('沒有刪除端點（規格 §8 P6）', async () => {
    const id = (await one('SELECT id FROM users WHERE username=$1', ['new-a'])).id;
    expect((await request(app).delete(`/api/company/users/${id}`).set(as(caToken))).status).toBe(404);
  });
});
