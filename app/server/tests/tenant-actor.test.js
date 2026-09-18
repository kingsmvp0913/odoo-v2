/**
 * tenant-actor.test.js — 每個請求一進來就知道「你是誰、屬於哪家公司、那家能不能用」（規格 §5.1）
 *
 * 兩個最容易做錯、做錯就出事的點：
 *  1. req.isAdmin 語意不能變。全平台至少 6 處自己查 role === 'admin'，
 *     verifyToken 改寫時若順手把公司管理員也算進 isAdmin，客戶就拿到平台權限。
 *  2. 沒有公司的人一律算可用。合併之後、遷移腳本跑之前，現有 6 個一般使用者
 *     company_id 還是 NULL；把「沒有公司」當成不可用，這 6 個人會全部被鎖在門外。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, adminToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  const res = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '管理員' });
  adminToken = res.body.token;
});

afterAll(() => dbModule._setPoolForTesting(null));

// 直接建帳號 + 登入拿 token（rules/testing 22：走真實授權路徑，不用私有 signer）
const makeUser = async (username, role, companyId) => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password123', 10);
  await dbModule.query(
    'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1, $2, $3, $4, $5)',
    [username, hash, username, role, companyId]
  );
  const res = await request(app).post('/api/auth/login').send({ username, password: 'password123' });
  return res.body.token;
};

const makeCompany = async (name, opts = {}) => {
  const { rows } = await dbModule.query(
    `INSERT INTO companies (name, is_active, is_internal, active_from, active_until)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, opts.isActive !== false, !!opts.isInternal, opts.activeFrom || null, opts.activeUntil || null]
  );
  return rows[0].id;
};

test('平台管理員：isAdmin 為 true、沒有公司、可用', async () => {
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.role).toBe('admin');
  expect(res.body.company_id).toBeNull();
  expect(res.body.company_usable).toBe(true);
});

test('公司管理員不是平台管理員（isAdmin 語意不能被改寫）', async () => {
  const cid = await makeCompany('甲公司');
  const token = await makeUser('ca1', 'company_admin', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.role).toBe('company_admin');
  expect(res.body.company_id).toBe(cid);
  expect(res.body.company_name).toBe('甲公司');
  expect(res.body.company_usable).toBe(true);
});

test('還沒掛公司的一般使用者仍然可用（遷移跑之前不能把人鎖在門外）', async () => {
  const token = await makeUser('legacy1', 'user', null);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.company_id).toBeNull();
  expect(res.body.company_usable).toBe(true);
});

test('公司被停用 → company_usable 是 false', async () => {
  const cid = await makeCompany('停用公司', { isActive: false });
  const token = await makeUser('off1', 'user', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.company_usable).toBe(false);
});

test('使用期間已過 → company_usable 是 false', async () => {
  const cid = await makeCompany('過期公司', { activeUntil: '2020-01-01T00:00:00Z' });
  const token = await makeUser('expired1', 'user', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.body.company_usable).toBe(false);
});

test('使用期間還沒開始 → company_usable 是 false', async () => {
  const cid = await makeCompany('未開始公司', { activeFrom: '2999-01-01T00:00:00Z' });
  const token = await makeUser('future1', 'user', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.body.company_usable).toBe(false);
});

test('使用期間兩端都是 NULL＝不限，算可用', async () => {
  const cid = await makeCompany('不限期間公司');
  const token = await makeUser('unlimited1', 'user', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.body.company_usable).toBe(true);
});

describe('公司不可用時的全域閘門（規格 §7）', () => {
  let offToken;

  beforeAll(async () => {
    const cid = await makeCompany('已停用客戶', { isActive: false });
    offToken = await makeUser('blocked1', 'user', cid);
  });

  test('工作台 API 一律 403，並說明原因', async () => {
    const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${offToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('停用');
    expect(res.body.companyUnusable).toBe(true);
  });

  test('GET /api/auth/me 仍然通（前端要顯示原因，不能變成白畫面）', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${offToken}`);
    expect(res.status).toBe(200);
    expect(res.body.company_usable).toBe(false);
  });

  test('公司正常的人不受影響', async () => {
    const cid = await makeCompany('正常客戶');
    const okToken = await makeUser('normal1', 'user', cid);
    const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${okToken}`);
    expect(res.status).toBe(200);
  });

  test('還沒掛公司的舊帳號不受影響（遷移跑之前）', async () => {
    const token = await makeUser('legacy2', 'user', null);
    const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  test('平台管理員不受影響', async () => {
    const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  // 白名單只留 GET /auth/me；PUT /auth/me 會改 display_name／密碼，是狀態變更端點，
  // 曾經因為沿用舊閘門的 /auth/ 整段前綴白名單而被漏放，複審後收窄。
  // body 選了「純改 display_name」——若白名單又被放寬，這支會拿到 200/{ok:true} 而不是 403。
  test('PUT /api/auth/me（狀態變更）一樣 403，GET /api/auth/me 仍然放行', async () => {
    const putRes = await request(app).put('/api/auth/me')
      .set('Authorization', `Bearer ${offToken}`)
      .send({ display_name: '應該被擋下來的改名' });
    expect(putRes.status).toBe(403);
    expect(putRes.body.companyUnusable).toBe(true);

    const getRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${offToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.company_usable).toBe(false);
  });

  // 規格風險最高點：閘門查詢 DB 失敗時必須放行，不能讓資料庫抖一下就把全平台擋在外面。
  // 只 mock 這一支查詢——用 SELECT 欄位清單辨認（`c.is_active, c.active_from, c.active_until`
  // 只有本閘門的 SQL 這樣選），不能只認「JOIN companies」：verifyToken 自己的
  // LEFT JOIN companies 查詢也含這個子字串，會被一起打斷，誤判成本閘門擋人。
  // 其他查詢一律照走真實 pg-mem，避免整個 db module 被 mock 掉、拖垮這支檔案其他測試
  //（rules/testing 26 的教訓）。
  test('閘門查詢 DB 失敗時放行，不阻斷整個平台', async () => {
    const pool = dbModule.getPool();
    const originalQuery = pool.query.bind(pool);
    const spy = jest.spyOn(pool, 'query').mockImplementation((text, params) => {
      if (typeof text === 'string' && text.includes('c.is_active, c.active_from, c.active_until')) {
        return Promise.reject(new Error('模擬 DB 查詢失敗'));
      }
      return originalQuery(text, params);
    });
    try {
      const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${offToken}`);
      // 閘門本身查不動，交給下游決定；offToken 對應的帳號其餘條件都合法，最終仍會 200
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});
