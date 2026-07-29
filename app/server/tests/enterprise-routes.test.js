// 意圖：企業版來源是「平台唯一能自動處理的部分」，但憑證與 repo 位置只有管理員知道。
// 這組 API 要保證：非管理員完全碰不到；登記可覆蓋不長重複列；同步是背景工作不阻塞請求；
// 且刪除來源不會影響已在跑的容器（只是下次建置會 fail loud）。
const { newDb } = require('pg-mem');
const request = require('supertest');

jest.mock('../lib/enterprise-sources', () => {
  const actual = jest.requireActual('../lib/enterprise-sources');
  return { ...actual, syncSource: jest.fn().mockResolvedValue({ ok: true, path: '/tmp/e/17' }) };
});
jest.mock('../lib/git-identity', () => ({ buildGitEnv: jest.fn().mockResolvedValue({ GIT_PAT: 'x' }) }));

process.env.JWT_SECRET = 'test-enterprise';

let dbModule, app, token, ent, gitIdentity;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ent = require('../lib/enterprise-sources');
  gitIdentity = require('../lib/git-identity');
  const { createApp } = require('../index');
  app = createApp();
  const { hashPassword } = require('../password');
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('adm',$1,'A','admin')",
    [await hashPassword('pw')]
  );
  const res = await request(app).post('/api/auth/login').send({ username: 'adm', password: 'pw' });
  token = res.body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  await dbModule.query('DELETE FROM enterprise_sources');
  ent.syncSource.mockClear().mockResolvedValue({ ok: true, path: '/tmp/e/17' });
  gitIdentity.buildGitEnv.mockClear().mockResolvedValue({ GIT_PAT: 'x' });
});

const auth = () => ({ Authorization: `Bearer ${token}` });

test('GET 回傳所有已登記版本與狀態', async () => {
  await dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url, branch, clone_status) VALUES ('17','https://x/e.git','17.0','done')"
  );
  const res = await request(app).get('/api/admin/enterprise-sources').set(auth());
  expect(res.status).toBe(200);
  expect(res.body.sources).toHaveLength(1);
  expect(res.body.sources[0].odoo_version).toBe('17');
  expect(res.body.sources[0].clone_status).toBe('done');
});

// 意圖：同版本重登記是常態（改 repo 或改 branch），必須覆蓋而不是長出第二列——
// 兩列同版本會讓「掛哪一份」變成不確定行為。
test('PUT 同一版本兩次 → 覆蓋既有列，不新增', async () => {
  await request(app).put('/api/admin/enterprise-sources/17').set(auth())
    .send({ repo_url: 'https://x/a.git', branch: '17.0' });
  await request(app).put('/api/admin/enterprise-sources/17').set(auth())
    .send({ repo_url: 'https://x/b.git', branch: 'main' });
  const { rows } = await dbModule.query("SELECT repo_url, branch FROM enterprise_sources WHERE odoo_version='17'");
  expect(rows).toHaveLength(1);
  expect(rows[0].repo_url).toBe('https://x/b.git');
  expect(rows[0].branch).toBe('main');
});

test('PUT 版本正規化：帶 17.0 也存成大版本 17（與掛載時的查法一致）', async () => {
  await request(app).put('/api/admin/enterprise-sources/17.0').set(auth()).send({ repo_url: 'https://x/e.git' });
  const { rows } = await dbModule.query('SELECT odoo_version FROM enterprise_sources');
  expect(rows[0].odoo_version).toBe('17');
});

test('PUT 缺 repo_url → 400 且不寫入', async () => {
  const res = await request(app).put('/api/admin/enterprise-sources/17').set(auth()).send({ branch: '17.0' });
  expect(res.status).toBe(400);
  const { rows } = await dbModule.query('SELECT 1 FROM enterprise_sources');
  expect(rows).toHaveLength(0);
});

test('PUT 不支援的 Git URL → 400（擋掉會讓 execFile 拿到怪東西的輸入）', async () => {
  const res = await request(app).put('/api/admin/enterprise-sources/17').set(auth())
    .send({ repo_url: 'file:///etc/passwd' });
  expect(res.status).toBe(400);
});

// 意圖：enterprise repo 幾百 MB 起跳，clone 可能好幾分鐘。同步必須是背景工作，
// 否則管理員按下去就是一個看似當掉的畫面，然後 HTTP 逾時。
test('POST sync → 立刻回應，同步在背景跑', async () => {
  await dbModule.query("INSERT INTO enterprise_sources (odoo_version, repo_url) VALUES ('17','https://x/e.git')");
  let resolveSync;
  ent.syncSource.mockImplementation(() => new Promise(r => { resolveSync = r; }));
  const res = await request(app).post('/api/admin/enterprise-sources/17/sync').set(auth());
  expect(res.status).toBe(202);
  expect(ent.syncSource).toHaveBeenCalledWith('17', { GIT_PAT: 'x' });
  resolveSync({ ok: true, path: '/tmp/e/17' });
});

test('POST sync 未登記版本 → 404，不觸發同步', async () => {
  const res = await request(app).post('/api/admin/enterprise-sources/19/sync').set(auth());
  expect(res.status).toBe(404);
  expect(ent.syncSource).not.toHaveBeenCalled();
});

// 意圖：私有 repo 沒 PAT 一定失敗，與其讓 git 在背景報一串看不懂的認證錯誤，不如當場說清楚。
test('POST sync 但管理員沒設 PAT → 400 指向設定頁', async () => {
  await dbModule.query("INSERT INTO enterprise_sources (odoo_version, repo_url) VALUES ('17','https://x/e.git')");
  const err = new Error('no cred'); err.code = 'NO_GIT_CRED';
  gitIdentity.buildGitEnv.mockRejectedValueOnce(err);
  const res = await request(app).post('/api/admin/enterprise-sources/17/sync').set(auth());
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('PAT');
  expect(ent.syncSource).not.toHaveBeenCalled();
});

test('DELETE 移除來源登記', async () => {
  await dbModule.query("INSERT INTO enterprise_sources (odoo_version, repo_url) VALUES ('17','https://x/e.git')");
  const res = await request(app).delete('/api/admin/enterprise-sources/17').set(auth());
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT 1 FROM enterprise_sources');
  expect(rows).toHaveLength(0);
});

test('非管理員 → 403', async () => {
  const { hashPassword } = require('../password');
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('usr',$1,'U','user')",
    [await hashPassword('pw')]
  );
  const login = await request(app).post('/api/auth/login').send({ username: 'usr', password: 'pw' });
  const h = { Authorization: `Bearer ${login.body.token}` };
  expect((await request(app).get('/api/admin/enterprise-sources').set(h)).status).toBe(403);
  expect((await request(app).put('/api/admin/enterprise-sources/17').set(h).send({ repo_url: 'https://x/e.git' })).status).toBe(403);
});
