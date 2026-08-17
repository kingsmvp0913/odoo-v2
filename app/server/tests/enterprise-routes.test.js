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

test('POST sync 版本格式不正確 → 400，不觸發同步', async () => {
  const res = await request(app).post('/api/admin/enterprise-sources/abc/sync').set(auth());
  expect(res.status).toBe(400);
  expect(ent.syncSource).not.toHaveBeenCalled();
});

// 意圖：前端按鈕在 202 回應後立刻恢復可按，畫面要等 3 秒後那次輪詢才顯示「同步中」，
// 空窗期很容易被連按第二次。同一目錄兩個 git 同時操作可能撞 index.lock，最終由後完成者
// 決定 clone_status，可能出現「狀態 done、目錄其實半套」——故需擋下重複觸發。
test('POST sync 但仍在同步中（未逾時）→ 409，不重複觸發', async () => {
  await dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url, clone_status, updated_at) VALUES ('17','https://x/e.git','syncing',NOW())"
  );
  const res = await request(app).post('/api/admin/enterprise-sources/17/sync').set(auth());
  expect(res.status).toBe(409);
  expect(ent.syncSource).not.toHaveBeenCalled();
});

// 意圖：逾時條件是必要的另一面——server 若在同步中途重啟，狀態會永遠停在 syncing，
// 無條件擋會變成永久鎖死、再也無法重試，故超過 30 分鐘的 syncing 仍要放行。
test('POST sync 但 syncing 狀態已逾時（server 疑似曾在同步中重啟）→ 仍可重新觸發', async () => {
  await dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url, clone_status, updated_at) VALUES ('17','https://x/e.git','syncing', NOW() - interval '31 minutes')"
  );
  const res = await request(app).post('/api/admin/enterprise-sources/17/sync').set(auth());
  expect(res.status).toBe(202);
  expect(ent.syncSource).toHaveBeenCalled();
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

// 意圖：version 正規化失敗（majorDigits 回空字串）時若不擋，DELETE 會用 odoo_version='' 去刪、
// 命中 0 列卻仍回 {ok:true}——對管理員是假成功。
test('DELETE 版本格式不正確 → 400，不誤回假成功', async () => {
  const res = await request(app).delete('/api/admin/enterprise-sources/abc').set(auth());
  expect(res.status).toBe(400);
});

// ── 本地目錄來源 ──────────────────────────────────────────────────────────
// 意圖：企業版整包上百 MB，git 型態要求先把有授權的專有碼推上遠端。本地型態讓管理員直接把
// addons 放進共用目錄，故這條路徑不該要求 repo URL、不該要求 PAT，也不該走背景＋輪詢
// ——驗證是毫秒級的檔案檢查，按下去就該當場看到結果。

test('PUT 本地型態不帶 repo_url → 200（URL 是 git 型態才要的）', async () => {
  const res = await request(app).put('/api/admin/enterprise-sources/17').set(auth())
    .send({ source_type: 'local' });
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query("SELECT source_type, repo_url FROM enterprise_sources WHERE odoo_version='17'");
  expect(rows[0].source_type).toBe('local');
  expect(rows[0].repo_url).toBe('');
});

// 意圖（鑑別力）：本地型態放行不帶 URL，不代表 git 型態也可以——那條防線要維持。
test('PUT 未指定型態（＝git）仍要求 repo_url → 400', async () => {
  const res = await request(app).put('/api/admin/enterprise-sources/17').set(auth()).send({ branch: '17.0' });
  expect(res.status).toBe(400);
});

// 意圖：git 型態改本地型態後，舊的 repo_url 若留著，前端會顯示一個早已不適用的 URL，
// 而 syncSource 的分流只看 source_type——畫面與實際行為不一致是最難查的那種錯。
test('PUT 由 git 型態改為本地型態 → 清掉舊 repo_url 與 branch', async () => {
  await request(app).put('/api/admin/enterprise-sources/17').set(auth())
    .send({ repo_url: 'https://x/e.git', branch: '17.0' });
  await request(app).put('/api/admin/enterprise-sources/17').set(auth()).send({ source_type: 'local' });
  const { rows } = await dbModule.query("SELECT source_type, repo_url, branch FROM enterprise_sources WHERE odoo_version='17'");
  expect(rows[0].source_type).toBe('local');
  expect(rows[0].repo_url).toBe('');
  expect(rows[0].branch).toBeNull();
});

test('POST sync 本地型態 → 同步回結果（200 帶模組數），不要 PAT 也不背景跑', async () => {
  await dbModule.query("INSERT INTO enterprise_sources (odoo_version, repo_url, source_type) VALUES ('17','','local')");
  ent.syncSource.mockResolvedValue({ ok: true, path: '/e/17', moduleCount: 1284 });
  const res = await request(app).post('/api/admin/enterprise-sources/17/sync').set(auth());
  expect(res.status).toBe(200);
  expect(res.body.moduleCount).toBe(1284);
  expect(gitIdentity.buildGitEnv).not.toHaveBeenCalled();
  expect(ent.syncSource).toHaveBeenCalledWith('17');   // 不帶 gitEnv
});

// 意圖：驗證失敗要當場回錯誤原文。若比照 git 型態回 202，管理員只會看到「已開始」，
// 得再手動重整一次才知道自己放錯了——而那正是他最需要立刻知道的時刻。
test('POST sync 本地型態驗證失敗 → 400 並帶回原因，不回假成功', async () => {
  await dbModule.query("INSERT INTO enterprise_sources (odoo_version, repo_url, source_type) VALUES ('17','','local')");
  ent.syncSource.mockResolvedValue({ ok: false, error: '找不到 web_enterprise' });
  const res = await request(app).post('/api/admin/enterprise-sources/17/sync').set(auth());
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('web_enterprise');
});

// 意圖：那個 30 分鐘併發鎖是為了「兩個 git clone 撞同一個目錄」而存在的。本地驗證不寫檔案、
// 毫秒級結束，不需要鎖；而殘留的 syncing 狀態（例如型態切換前留下的）若也擋著，
// 會變成再也按不動「檢查」的死結。
test('POST sync 本地型態不受 syncing 併發鎖影響（驗證不寫檔，無競態可言）', async () => {
  await dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url, source_type, clone_status, updated_at) VALUES ('17','','local','syncing',NOW())"
  );
  ent.syncSource.mockResolvedValue({ ok: true, path: '/e/17', moduleCount: 3 });
  const res = await request(app).post('/api/admin/enterprise-sources/17/sync').set(auth());
  expect(res.status).toBe(200);
  expect(ent.syncSource).toHaveBeenCalled();
});

test('GET 回傳 source_type（前端據此顯示「檢查」而非「同步」）', async () => {
  await dbModule.query("INSERT INTO enterprise_sources (odoo_version, repo_url, source_type) VALUES ('17','','local')");
  const res = await request(app).get('/api/admin/enterprise-sources').set(auth());
  expect(res.body.sources[0].source_type).toBe('local');
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
