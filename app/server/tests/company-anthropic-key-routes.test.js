/**
 * company-anthropic-key-routes.test.js — 客戶 API key 的兩個入口各自的權限
 * （2026-09-24 裁決「兩邊都要能填」）
 *
 * 規則本體另有 company-anthropic-key.test.js。這支只管**誰動得了誰的 key**——
 * 那是這兩組端點唯一不一樣的地方，也是唯一會出人命的地方：公司 id 若從參數收，
 * 公司管理員就能填別家公司的 key。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

// 驗 key 的探針不真的去叫 claude
jest.mock('../pipeline/claude-runner', () => ({ runClaude: jest.fn(async () => ({})) }));

process.env.JWT_SECRET = 'test-company-key-jwt';
process.env.APP_SECRET = 'test-company-key-secret';

let app, dbModule, tok = {}, coA, coB, coInternal;
const one = async (sql, p) => (await dbModule.query(sql, p)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });
const keyOf = async (id) => (await one('SELECT anthropic_key_enc FROM companies WHERE id=$1', [id])).anthropic_key_enc;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  tok.platformAdmin = (await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '平台管理員' })).body.token;

  const mkCo = async (name, internal) => (await one(
    'INSERT INTO companies (name, is_active, is_internal) VALUES ($1,true,$2) RETURNING id', [name, internal])).id;
  coA = await mkCo('客戶甲', false);
  coB = await mkCo('客戶乙', false);
  coInternal = await mkCo('內部', true);

  const mkUser = async (u, role, company) => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      [u, hash, role, company]);
    return (await request(app).post('/api/auth/login').send({ username: u, password: 'password123' })).body.token;
  };
  tok.adminA = await mkUser('a-admin', 'company_admin', coA);
  tok.adminB = await mkUser('b-admin', 'company_admin', coB);
  tok.userA = await mkUser('a-user', 'user', coA);
  tok.adminInternal = await mkUser('int-admin', 'company_admin', coInternal);
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('公司管理員自己換（/api/company/anthropic-key）', () => {
  test('設定 → 查得到「已設定」，而且回應裡沒有 key 也沒有密文', async () => {
    const put = await request(app).put('/api/company/anthropic-key').set(as(tok.adminA)).send({ api_key: 'sk-aaa' });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain('sk-aaa');

    const get = await request(app).get('/api/company/anthropic-key').set(as(tok.adminA));
    expect(get.body.configured).toBe(true);
    expect(JSON.stringify(get.body)).not.toContain('sk-aaa');
    // 落庫的是密文
    expect(await keyOf(coA)).not.toBe('sk-aaa');
  });

  // ⚠ 這是整支最重要的一條。端點沒有公司參數可帶，所以「動到別家」只可能發生在
  // 實作改成從 body/網址收 id 的那一天——那時這條會紅。
  test('甲的管理員設定 key，乙公司完全沒被動到', async () => {
    const before = await keyOf(coB);
    await request(app).put('/api/company/anthropic-key').set(as(tok.adminA)).send({ api_key: 'sk-aaa2' });
    expect(await keyOf(coB)).toBe(before);
    const getB = await request(app).get('/api/company/anthropic-key').set(as(tok.adminB));
    expect(getB.body.configured).toBe(false);
  });

  test('清除 → 回到「未設定」', async () => {
    await request(app).put('/api/company/anthropic-key').set(as(tok.adminA)).send({ api_key: 'sk-tmp' });
    expect((await request(app).delete('/api/company/anthropic-key').set(as(tok.adminA))).status).toBe(204);
    expect((await request(app).get('/api/company/anthropic-key').set(as(tok.adminA))).body.configured).toBe(false);
  });

  // 這是花錢的開關，不是一般設定
  test('一般使用者一律 403（讀、寫、刪都是）', async () => {
    expect((await request(app).get('/api/company/anthropic-key').set(as(tok.userA))).status).toBe(403);
    expect((await request(app).put('/api/company/anthropic-key').set(as(tok.userA)).send({ api_key: 'x' })).status).toBe(403);
    expect((await request(app).delete('/api/company/anthropic-key').set(as(tok.userA))).status).toBe(403);
  });

  test('內部公司的管理員 → 400，說清楚內部用平台訂閱', async () => {
    const r = await request(app).put('/api/company/anthropic-key').set(as(tok.adminInternal)).send({ api_key: 'sk' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('平台的訂閱');
  });

  // 平台管理員沒有公司。訊息要講清楚要去哪裡，不然只會看到沒頭沒尾的錯誤。
  test('平台管理員打這組 → 400 並指路到公司管理', async () => {
    const r = await request(app).get('/api/company/anthropic-key').set(as(tok.platformAdmin));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/不屬於任何公司/);
  });
});

describe('平台管理員代填（/api/admin/companies/:id/anthropic-key）', () => {
  test('代填成功，落庫是密文', async () => {
    const r = await request(app).put(`/api/admin/companies/${coB}/anthropic-key`)
      .set(as(tok.platformAdmin)).send({ api_key: 'sk-bbb' });
    expect(r.status).toBe(200);
    expect(await keyOf(coB)).not.toBe('sk-bbb');
    expect((await request(app).get('/api/company/anthropic-key').set(as(tok.adminB))).body.configured).toBe(true);
  });

  test('公司管理員打不到這組（那是平台管理員限定）', async () => {
    expect((await request(app).put(`/api/admin/companies/${coA}/anthropic-key`)
      .set(as(tok.adminA)).send({ api_key: 'sk' })).status).toBe(403);
  });

  test('兩個入口對內部公司的訊息逐字相同（規則是同一份）', async () => {
    const viaAdmin = await request(app).put(`/api/admin/companies/${coInternal}/anthropic-key`)
      .set(as(tok.platformAdmin)).send({ api_key: 'sk' });
    const viaCompany = await request(app).put('/api/company/anthropic-key')
      .set(as(tok.adminInternal)).send({ api_key: 'sk' });
    expect(viaAdmin.status).toBe(viaCompany.status);
    expect(viaAdmin.body.error).toBe(viaCompany.body.error);
  });

  test('代填後客戶自己清得掉（兩邊操作同一份資料）', async () => {
    await request(app).put(`/api/admin/companies/${coB}/anthropic-key`)
      .set(as(tok.platformAdmin)).send({ api_key: 'sk-bbb2' });
    expect((await request(app).delete('/api/company/anthropic-key').set(as(tok.adminB))).status).toBe(204);
    expect(await keyOf(coB)).toBeNull();
  });
});
