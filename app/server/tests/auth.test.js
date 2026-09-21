/**
 * auth.test.js — Auth routes tests using pg-mem (no real PostgreSQL needed)
 *
 * TDD: tests written before implementation.
 * All 9 original test cases preserved; SQLite replaced with pg-mem.
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

// Must set env vars BEFORE requiring any module
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let app;
let dbModule;

beforeAll(async () => {
  // Build pg-mem pool
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  // Inject pool before requiring modules
  dbModule = require('../db');
  dbModule._setPoolForTesting(pool);

  // Run migration so tables exist
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();
});

afterAll(async () => {
  dbModule._setPoolForTesting(null);
});

let adminToken;

test('GET /api/setup/status → needsSetup: true initially', async () => {
  const res = await request(app).get('/api/setup/status');
  expect(res.status).toBe(200);
  expect(res.body.needsSetup).toBe(true);
});

test('POST /api/auth/setup → creates admin, returns token', async () => {
  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'password123', display_name: '管理員'
  });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeDefined();
  adminToken = res.body.token;
});

test('POST /api/auth/setup → 403 after first admin', async () => {
  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin2', password: 'password123', display_name: '管理員2'
  });
  expect(res.status).toBe(403);
});

test('GET /api/setup/status → needsSetup: false after setup', async () => {
  const res = await request(app).get('/api/setup/status');
  expect(res.body.needsSetup).toBe(false);
});

test('POST /api/auth/login → valid credentials return token + user', async () => {
  const res = await request(app).post('/api/auth/login').send({
    username: 'admin', password: 'password123'
  });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeDefined();
  expect(res.body.user.role).toBe('admin');
  expect(res.body.user.password_hash).toBeUndefined();
});

test('POST /api/auth/login → 401 on wrong password', async () => {
  const res = await request(app).post('/api/auth/login').send({
    username: 'admin', password: 'wrong'
  });
  expect(res.status).toBe(401);
});

test('GET /api/auth/me → returns user with valid token', async () => {
  const res = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.username).toBe('admin');
  expect(res.body.password_hash).toBeUndefined();
});

test('GET /api/auth/me → 401 without token', async () => {
  const res = await request(app).get('/api/auth/me');
  expect(res.status).toBe(401);
});

test('GET /api/auth/me → 401 with invalid token', async () => {
  const res = await request(app).get('/api/auth/me')
    .set('Authorization', 'Bearer invalid.token.here');
  expect(res.status).toBe(401);
});

// --- 主題 E-2：系統不再持有使用者可還原密碼（password_enc 一律不寫，E2E 改用每專案測試帳號）---

test('setup 建管理員不寫 password_enc（不再持有可還原密碼）', async () => {
  const { rows: [u] } = await dbModule.query("SELECT password_enc FROM users WHERE username='admin'");
  expect(u.password_enc).toBeNull();
});

test('改密碼成功但不寫 password_enc', async () => {
  const res = await request(app).put('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ current_password: 'password123', new_password: 'newpassword456' });
  expect(res.status).toBe(200);
  const { rows: [u] } = await dbModule.query("SELECT password_enc FROM users WHERE username='admin'");
  expect(u.password_enc).toBeNull();
  // 還原，避免影響其他測試
  await request(app).put('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ current_password: 'newpassword456', new_password: 'password123' });
});

test('登入成功不補寫 password_enc', async () => {
  const { hashPassword } = require('../password');
  const h = await hashPassword('backfillpass');
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('bf', $1, 'BF')", [h]
  );
  const res = await request(app).post('/api/auth/login').send({ username: 'bf', password: 'backfillpass' });
  expect(res.status).toBe(200);
  const after = await dbModule.query("SELECT password_enc FROM users WHERE username='bf'");
  expect(after.rows[0].password_enc).toBeNull();
});

// --- 自助註冊 ＋ 待審核閘門 ---

// 意圖：自助註冊建 pending 帳號（role=user、approved=false），回 token 供本次精靈設定憑證用。
// approved 唯一在此設 false——其餘建立路徑（setup/admin/直接 INSERT）預設 true，安全模型只擋自助註冊。
test('POST /api/auth/register → 建 pending user、回 token', async () => {
  const res = await request(app).post('/api/auth/register').send({
    username: 'newbie', password: 'password123', display_name: '新人'
  });
  expect(res.status).toBe(201);
  expect(res.body.token).toBeDefined();
  const { rows: [u] } = await dbModule.query("SELECT role, approved FROM users WHERE username='newbie'");
  expect(u.role).toBe('user');
  expect(u.approved).toBe(false);
});

test('POST /api/auth/register → 帳號重複 409', async () => {
  const res = await request(app).post('/api/auth/register').send({
    username: 'newbie', password: 'password123', display_name: '新人2'
  });
  expect(res.status).toBe(409);
});

test('POST /api/auth/register → 密碼<8 → 400', async () => {
  const res = await request(app).post('/api/auth/register').send({
    username: 'shorty', password: 'abc', display_name: 'S'
  });
  expect(res.status).toBe(400);
});

// 意圖：pending 帳號密碼對也不得登入（管理員核准前）。
test('POST /api/auth/login → 未核准帳號 403 pendingApproval', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: 'newbie', password: 'password123' });
  expect(res.status).toBe(403);
  expect(res.body.pendingApproval).toBe(true);
});

// 意圖：這支原本斷言「pending token 能放行走 settings」——那是舊行為，前提是「待審核」與
// 「已停用」是兩個要分開處理的狀態。P3-13 裁決：這個前提不再成立（正式環境零筆待審／NULL，
// 而且全庫唯一寫入 approved=false 的路徑 auth.js:155 在同一份計畫的 Task 8 會被關掉），
// 之後 approved=false 只剩一種意思：被公司管理員收回存取權。所以本關在 verifyToken 補上
// 「approved===false 一律 403」之後，這支測試斷言的行為就是刻意被推翻的舊行為，不是新缺陷
// ——翻面保留（不刪），紀錄「這裡曾經是反過來的、後來被刻意改掉」。
test('收回存取權（approved=false）：所有路徑一律 403，包含舊閘門原本放行的 settings', async () => {
  // 拿 pending 帳號的 register token
  const reg = await request(app).post('/api/auth/register').send({
    username: 'pend2', password: 'password123', display_name: 'P2'
  });
  const pendToken = reg.body.token;

  const blocked = await request(app).get('/api/tasks').set('Authorization', `Bearer ${pendToken}`);
  expect(blocked.status).toBe(403);
  expect(blocked.body.pendingApproval).toBe(true);

  // index.js 舊閘門的 settings 白名單現在攔不到這裡——verifyToken 自己的 approved 檢查
  // 跑得更早，同一個 token 打 settings 一樣要被擋下來。
  const passed = await request(app).post('/api/settings/verify-odoo').set('Authorization', `Bearer ${pendToken}`).send({});
  expect(passed.status).toBe(403);
});

// 意圖：已核准（admin）token 不被閘門擋。
test('未核准閘門：admin token 打工作台 API 不被擋（非 403 pendingApproval）', async () => {
  const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${adminToken}`);
  expect(res.body.pendingApproval).toBeUndefined();
  expect(res.status).not.toBe(403);
});

// 意圖：/me 要回 approved 供前端導向（pending→精靈/等待頁）。
test('GET /api/auth/me → 含 approved', async () => {
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  expect(res.body.approved).toBe(true);
});

// --- JWT 撤銷：帳號被刪除後，已簽發的 token 必須立即失效 ---
// 意圖：token 有效期 7 天且無狀態，`verifyToken` 只驗簽章不看資料庫。離職者帳號被管理員刪掉後，
// 他手上的舊 token 仍能打所有 API 最長 7 天——「刪除帳號」這個動作對安全性等於沒有發生。
// 這裡刻意用「使用者自己資料範圍」的端點（/api/auth/me）驗證：它不經 admin guard，
// 是撤銷失效時最赤裸的破口。
test('刪除帳號後，該帳號既有 JWT 立即失效（401，不得放行 7 天）', async () => {
  const reg = await request(app).post('/api/auth/register').send({
    username: 'leaver', password: 'password123', display_name: '離職者'
  });
  const leaverToken = reg.body.token;
  const { rows: [u] } = await dbModule.query("SELECT id FROM users WHERE username='leaver'");
  await dbModule.query('UPDATE users SET approved = true WHERE id = $1', [u.id]);

  // 刪除前：token 可用（確保後面的 401 是「被撤銷」而不是「本來就不能用」）
  const before = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${leaverToken}`);
  expect(before.status).toBe(200);

  await dbModule.query('DELETE FROM users WHERE id = $1', [u.id]);

  const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${leaverToken}`);
  expect(after.status).toBe(401);
});

// 意圖：撤銷檢查不得改成「任何 DB 例外都放行」——那等於沒有檢查。
test('有效 token 仍正常放行（撤銷檢查不得誤殺在職帳號）', async () => {
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.username).toBe('admin');
});

// 意圖（最終審查 IMPORTANT-2）：登入失敗計數要記在真實使用者的位址上，不是 nginx 的位址上——
// 否則網路上任何人都能把管理員對所有人封鎖。只有對方是信任的 proxy 時才採用 X-Real-IP。
test('POST /api/auth/login 失敗：信任的 proxy 轉來的記在 X-Real-IP；不信任時 header 不理', async () => {
  const old = process.env.TRUSTED_PROXY_IPS;
  try {
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    await request(app).post('/api/auth/login').set('X-Real-IP', '203.0.113.50').send({ username: 'proxied', password: 'x' });
    delete process.env.TRUSTED_PROXY_IPS;
    await request(app).post('/api/auth/login').set('X-Real-IP', '203.0.113.51').send({ username: 'proxied', password: 'x' });
    const { rows } = await dbModule.query("SELECT source FROM login_attempts WHERE username = 'proxied' ORDER BY source");
    const sources = rows.map(r => r.source);
    expect(sources).toContain('203.0.113.50');
    expect(sources).not.toContain('203.0.113.51');
    expect(sources).toHaveLength(2); // 第二筆記在直連的對方位址（supertest 的本機位址）
  } finally { if (old === undefined) delete process.env.TRUSTED_PROXY_IPS; else process.env.TRUSTED_PROXY_IPS = old; }
});

// 意圖（裁決 R17）：登入成功要把該 (帳號, 來源) 的打錯次數歸零——否則同一個人長期零星打錯，
// 累積到 10 次就被永久封鎖。但已封鎖的那一對即使密碼對也照樣擋（先查封鎖、再驗密碼、成功才歸零）。
test('POST /api/auth/login：錯 4 次、對 1 次、再錯 4 次 → 沒被鎖；已封鎖的一對密碼對也照樣擋', async () => {
  const login = password => request(app).post('/api/auth/login').send({ username: 'bf', password });
  for (let i = 0; i < 4; i++) expect((await login('wrong')).status).toBe(401);
  expect((await login('backfillpass')).status).toBe(200);
  for (let i = 0; i < 4; i++) expect((await login('wrong')).status).toBe(401);
  expect((await login('backfillpass')).status).toBe(200); // 沒有累積到 5 次鎖定
  await dbModule.query("DELETE FROM login_attempts WHERE username = 'bf'");
  for (let i = 0; i < 10; i++) await login('wrong'); // 第 6 次起被鎖（429）；直接把這一對設成封鎖
  await dbModule.query("UPDATE login_attempts SET blocked = true WHERE username = 'bf'");
  const r = await login('backfillpass');
  expect(r.status).toBe(429);
  expect(r.body.reason).toBe('blocked');
  const { rows } = await dbModule.query("SELECT blocked FROM login_attempts WHERE username = 'bf'");
  expect(rows).toEqual([{ blocked: true }]);
});

// 租戶隔離：自助註冊一律 role='user'，不能沒有公司（否則遷移跑完後 company_id 永遠 NULL，
// 核准之後 canSeeProject 仍恆為 false）。放在檔案最後，插入內部公司不汙染前面的既有測試。
test('POST /api/auth/register → 有內部公司時，新帳號預設掛內部公司', async () => {
  const { rows: [co] } = await dbModule.query(
    "INSERT INTO companies (name, is_active, is_internal) VALUES ('內部', true, true) RETURNING id"
  );
  const res = await request(app).post('/api/auth/register')
    .send({ username: 'tenant-reg1', password: 'password123', display_name: 'Reg1' });
  expect(res.status).toBe(201);
  const { rows: [u] } = await dbModule.query('SELECT company_id FROM users WHERE username = $1', ['tenant-reg1']);
  expect(u.company_id).toBe(co.id);
});
