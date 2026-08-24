const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret';

const mockRunEnvSetup = jest.fn();
const mockStopEnv = jest.fn();
const mockEnvContainerAlive = jest.fn();
jest.mock('../pipeline/env-agent', () => ({
  runEnvSetup: mockRunEnvSetup,
  stopEnv: mockStopEnv,
  envContainerAlive: mockEnvContainerAlive,
  nightlyShutdown: jest.fn(),
  ENV_BASE: require('path').resolve(__dirname, '..', '..', '..', 'odoo-envs')
}));

// filestore／sessions 是容器內的 odoo user 寫的，平台直接 fs.rmSync 在正式機一律 EACCES，
// 刪除環境因此永遠失敗。mock 起來才擋得住「有人改回 rmSync」——沒有它的話，DELETE 這支不論
// 走哪個實作都會綠（真實 removeDirForce 對不存在的目錄直接 return，測試環境正好沒有那個目錄）。
// removeEnvDir（保留 filestore）與 removeDirForce（整棵刪）分開 mock：DELETE 走的必須是前者，
// 走後者會連 filestore 一起砍掉，而平台從不 drop Odoo DB → 重建後每筆 attachment 都指向不存在
// 的檔案（2026-08-24 萊峰19 丟掉 634 個檔）。兩個都留著才驗得出「有沒有改回整棵刪」。
const mockRemoveDirForce = jest.fn().mockResolvedValue({ removed: true, viaDocker: false });
const mockRemoveEnvDir = jest.fn().mockResolvedValue({ removed: true, kept: ['filestore'] });
jest.mock('../lib/docker-env', () => ({
  removeDirForce: (...a) => mockRemoveDirForce(...a),
  removeEnvDir: (...a) => mockRemoveEnvDir(...a),
  containerExists: jest.fn().mockResolvedValue(false),
  containerLogs: jest.fn().mockResolvedValue(''),
}));

// 手動建立測試區的兩條入口（/env/setup、/env/sso 自動起）必須與 pipeline 的 deploy/E2E
// 序列化——否則同時觸發 runEnvSetup 會爭埠、_failEnv 互蓋健康的 running（實測 project 2 埠 21000/21001 漂移）。
// 這個 mock 保留「執行 fn」語意（讓 runEnvSetup 仍被呼叫），只用來斷言持鎖與 key 型別。
const mockWithProjectLock = jest.fn((id, fn) => Promise.resolve().then(fn));
jest.mock('../pipeline/project-lock', () => ({
  withProjectLock: (id, fn) => mockWithProjectLock(id, fn),
  tryProjectLock: jest.fn(),
}));

let dbModule, app;
let userId, projectId, token;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: [user] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('envuser', $1, 'Env') RETURNING id",
    [hash]
  );
  userId = user.id;
  token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('EnvProj', '17.0') RETURNING id"
  );
  projectId = proj.id;

  const expressApp = express();
  expressApp.use(express.json());
  const { registerRoutes } = require('../env-routes');
  registerRoutes(expressApp);
  app = expressApp;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => {
  mockRunEnvSetup.mockReset(); mockStopEnv.mockReset(); mockWithProjectLock.mockClear();
  // 預設「容器活著」：docker 是唯一模式、pid 恆為 NULL，running 的活性一律問容器。
  // 不設預設的話，既有 running 測試會被自癒邏輯誤打回 idle。
  mockEnvContainerAlive.mockReset(); mockEnvContainerAlive.mockResolvedValue(true);
});

const auth = () => ({ Authorization: `Bearer ${token}` });

test('GET env → idle if no record', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/env`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('idle');
});

test('POST setup → triggers runEnvSetup and returns ok', async () => {
  mockRunEnvSetup.mockResolvedValueOnce(undefined);
  const res = await request(app)
    .post(`/api/projects/${projectId}/env/setup`)
    .set(auth()).send({});
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  // fire-and-forget so we need to wait a tick
  await new Promise(r => setTimeout(r, 10));
  // port 為租約，存於 odoo_envs.port（啟動測試區時借、停止時還），route 不再轉傳 body 參數
  expect(mockRunEnvSetup).toHaveBeenCalledWith(String(projectId));
});

// 意圖：手動建立必須持專案鎖與 pipeline deploy/E2E 序列化。且 key 必須是「數字」project_id——
// deploy-testing.js 用 DB 數字 project_id 當 withProjectLock 的 key，Map key 字串 '2' ≠ 數字 2 不互斥，
// 傳字串等於根本沒鎖（正是 project 2 埠漂移＋env 被打成 error 的成因）。
test('POST setup → 以數字 project_id 持鎖後才 runEnvSetup（字串 key 不會與 pipeline 互斥）', async () => {
  mockRunEnvSetup.mockResolvedValueOnce(undefined);
  const res = await request(app)
    .post(`/api/projects/${projectId}/env/setup`)
    .set(auth()).send({});
  expect(res.status).toBe(200);
  await new Promise(r => setTimeout(r, 10));
  expect(mockWithProjectLock).toHaveBeenCalledWith(projectId, expect.any(Function));
  expect(typeof mockWithProjectLock.mock.calls[0][0]).toBe('number');
  // 鎖住的 fn 執行後才真的呼叫 runEnvSetup
  expect(mockRunEnvSetup).toHaveBeenCalledWith(String(projectId));
});

// 意圖：/env/sso 的「環境被回收 → 自動起」入口同樣要持鎖（與上同一 race 面）。
test('GET env/sso 自動起 → 同樣以數字 project_id 持鎖', async () => {
  mockRunEnvSetup.mockResolvedValueOnce(undefined);
  const pid = await mkEnv('lock', { status: 'idle', sso_secret: 'sec' });
  const res = await request(app).get(`/api/projects/${pid}/env/sso`).set(auth());
  expect(res.status).toBe(202);
  await new Promise(r => setTimeout(r, 10));
  expect(mockWithProjectLock).toHaveBeenCalledWith(pid, expect.any(Function));
  expect(typeof mockWithProjectLock.mock.calls[0][0]).toBe('number');
  expect(mockRunEnvSetup).toHaveBeenCalledWith(String(pid));
});

test('GET env → returns record after upsert', async () => {
  await dbModule.query(
    "INSERT INTO odoo_envs (project_id, status, port) VALUES ($1, 'setting_up', 8070) ON CONFLICT (project_id) DO UPDATE SET status='setting_up', port=8070",
    [projectId]
  );
  const res = await request(app).get(`/api/projects/${projectId}/env`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('setting_up');
});

test('POST stop → calls stopEnv', async () => {
  mockStopEnv.mockResolvedValueOnce(undefined);
  const res = await request(app)
    .post(`/api/projects/${projectId}/env/stop`)
    .set(auth());
  expect(res.status).toBe(200);
  expect(mockStopEnv).toHaveBeenCalledWith(String(projectId));
});

test('DELETE env → resets to idle', async () => {
  mockRemoveDirForce.mockClear();
  mockRemoveEnvDir.mockClear();
  const res = await request(app)
    .delete(`/api/projects/${projectId}/env`)
    .set(auth());
  expect(res.status).toBe(200);
  const { rows: [env] } = await dbModule.query(
    'SELECT status FROM odoo_envs WHERE project_id=$1', [projectId]
  );
  expect(env.status).toBe('idle');
  // 環境目錄必須走 root 容器退路刪除，不可用 fs.rmSync——改回去這支就會紅
  expect(mockRemoveEnvDir).toHaveBeenCalledWith(expect.stringContaining('odoo-envs'));
  // 且必須是「保留 filestore」的那支。直接對整個 envDir 呼叫 removeDirForce 會把 filestore 一起砍掉，
  // 而平台從不 drop Odoo DB → 重建後 attachment 全指向不存在的檔案，asset bundle 與圖片一律 500。
  expect(mockRemoveDirForce).not.toHaveBeenCalledWith(expect.stringContaining('odoo-envs'));
});

test('401 without token', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/env`);
  expect(res.status).toBe(401);
});

// 建一個獨立的 project + odoo_envs 列，供 /env/sso 借名額測試使用（每個 project 各自一列，
// 避免與檔案前段共用的 projectId 互相干擾）。
let _envSsoSeq = 0;
async function mkEnv(name, opts = {}) {
  _envSsoSeq += 1;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ($1,'17.0') RETURNING id",
    [`${name}-sso-${_envSsoSeq}`]
  );
  await dbModule.query(
    `INSERT INTO odoo_envs (project_id, status, port, url, sso_secret, external_slot, error_msg)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [p.id, opts.status || 'idle', opts.port ?? null, opts.url ?? null, opts.sso_secret ?? null, opts.external_slot ?? null, opts.error_msg ?? null]
  );
  return p.id;
}

// 意圖：對外名額必須是「人點開的當下才借」。若在建環境時就配，pipeline 跑起來的環境
// 也會各佔一個，10 個名額瞬間見底——那正是本次改版要消除的。
describe('/env/sso 借對外名額', () => {
  const saved = process.env.ENV_EXTERNAL_URL_TEMPLATE;
  afterEach(() => {
    if (saved === undefined) delete process.env.ENV_EXTERNAL_URL_TEMPLATE;
    else process.env.ENV_EXTERNAL_URL_TEMPLATE = saved;
  });

  test('子網域模式：回傳的網址是子網域，且 slot 已寫進 DB', async () => {
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-test-{slot}.example.com';
    const pid = await mkEnv('a', { status: 'running', port: 21000, sso_secret: 'sec' });
    const res = await request(app).get(`/api/projects/${pid}/env/sso`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/odoo-ai-test-0\.example\.com\/aidev\/sso\?token=/);
    const { rows: [env] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.external_slot).toBe(0);
  });

  // 意圖：本機／未反代機沒有子網域可用，必須逐字維持 port 模式——否則開發機永遠開不了測試區，
  // 而這個症狀在正式機重現不了。
  test('未設子網域樣板：沿用 odoo_envs.url（port 模式），不借名額', async () => {
    delete process.env.ENV_EXTERNAL_URL_TEMPLATE;
    const pid = await mkEnv('b', { status: 'running', port: 21001, sso_secret: 'sec', url: 'http://127.0.0.2:21001' });
    const res = await request(app).get(`/api/projects/${pid}/env/sso`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^http:\/\/127\.0\.0\.2:21001\/aidev\/sso\?token=/);
    const { rows: [env] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.external_slot).toBeNull();
  });

  // 缺 sso_secret 代表環境從沒建成功過，Task 9 之後這才是真正的 409（重起也沒用）；
  // 若已有 sso_secret 只是 status 不是 running，改走 202 自動起（見下方新測試）。
  test('環境未就緒（無 sso_secret）→ 409，且不借名額', async () => {
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-test-{slot}.example.com';
    const pid = await mkEnv('c', { status: 'idle' });
    const res = await request(app).get(`/api/projects/${pid}/env/sso`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    const { rows: [env] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.external_slot).toBeNull();
  });

  // 意圖：真人關掉分頁偵測不到，所以「還名額」只有明確按鈕與閒置逾時兩條路。
  // 少了明確這條，名額只能等 20 分鐘自然到期，10 個名額的池子體感會非常小。
  // 意圖：前端要能在「已借到名額」時才顯示歸還按鈕，就得從 GET /env 看得到名額。
  // 沒帶這欄的話按鈕只能無條件顯示，按下去對沒借名額的環境是個空操作。
  test('GET /env 帶出 external_slot（前端據此決定歸還按鈕顯不顯示）', async () => {
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-test-{slot}.example.com';
    const pid = await mkEnv('h', { status: 'running', port: 21003, sso_secret: 'sec' });
    await request(app).get(`/api/projects/${pid}/env/sso`).set('Authorization', `Bearer ${token}`);
    const res = await request(app).get(`/api/projects/${pid}/env`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.external_slot).toBe('number');
  });

  test('關閉對外端點歸還名額', async () => {
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-test-{slot}.example.com';
    const pid = await mkEnv('d', { status: 'running', port: 21002, sso_secret: 'sec' });
    await request(app).get(`/api/projects/${pid}/env/sso`).set('Authorization', `Bearer ${token}`);
    const res = await request(app).post(`/api/projects/${pid}/env/external/release`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const { rows: [env] } = await dbModule.query('SELECT external_slot, status FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.external_slot).toBeNull();
    expect(env.status).toBe('running');   // 只收名額，不停環境
  });

  // 意圖：名額載體是 DB 欄位，任何把環境打回 idle 的路徑都必須一併歸還，否則那個 slot 由一個
  // 已經不存在的環境持有——而它不會出現在 nginx conf（RUNNING_SQL 要求 running），
  // 症狀是「名額少一個且查不到誰佔的」，要等 20 分鐘閒置掃描才自己好。
  test('刪除環境一併歸還對外名額', async () => {
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-test-{slot}.example.com';
    const pid = await mkEnv('i', { status: 'running', port: 21004, sso_secret: 'sec' });
    await request(app).get(`/api/projects/${pid}/env/sso`).set('Authorization', `Bearer ${token}`);
    const res = await request(app).delete(`/api/projects/${pid}/env`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const { rows: [env] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.external_slot).toBeNull();
  });

  // 意圖：docker 是唯一模式、odoo_envs.pid 恆為 NULL，所以 running 的活性一律問「容器在不在跑」。
  // 容器被外部 kill／OOM／重建中斷後繞過 stopEnv 消失時，DB 殘留 running 會讓使用者點開啟時
  // 拿到一個指向死容器的網址（空白畫面）。GET /env 必須據容器活性把它自癒回 idle 並歸還 slot/port。
  // 用假 pid 的舊寫法測不到這條——真實環境 pid 是 NULL，`&& env.pid` 這關永遠進不去。
  test('docker 容器不在跑（pid 恆為 NULL）→ GET /env 自癒回 idle 並歸還 slot/port', async () => {
    mockEnvContainerAlive.mockResolvedValueOnce(false);
    const pid = await mkEnv('dead', { status: 'running', port: 21020, sso_secret: 'sec', external_slot: 7 });
    // pid 欄位維持 NULL（mkEnv 不寫 pid）＝真實 docker 狀態
    const res = await request(app).get(`/api/projects/${pid}/env`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('idle');
    const { rows: [env] } = await dbModule.query('SELECT status, external_slot, port FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.status).toBe('idle');
    expect(env.external_slot).toBeNull();
    expect(env.port).toBeNull();
  });

  // 意圖：同上，另一條把 running 打回 idle 的路徑——DB 標 running 但容器已不在的自癒，聚焦歸還對外名額。
  test('偵測容器已死自癒回 idle 時一併歸還對外名額', async () => {
    mockEnvContainerAlive.mockResolvedValueOnce(false);
    const pid = await mkEnv('j', { status: 'running', port: 21006, sso_secret: 'sec', external_slot: 5 });
    const res = await request(app).get(`/api/projects/${pid}/env`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('idle');
    const { rows: [env] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.external_slot).toBeNull();
  });

  // 意圖與上面兩支的「歸還名額」不同：這裡管的是**內部埠租約**。埠是租來的（leasePort／releasePort），
  // `releasePort` 的註解明寫「停機／夜間關機／閒置回收／刪除專案皆須呼叫，否則池子會單向耗盡」，
  // 而池子只有 21000-21019 共 20 個。停機路徑（env-agent 的 stopEnv／nightlyShutdown）都清了 port，
  // 只有 route 這兩條沒清 → 每刪一次環境就永久少一個埠，最後所有專案都起不了測試區。
  // 對外名額有 20 分鐘閒置掃描兜底，內部埠沒有等價的自動回收，所以這個洩漏是永久的。
  test('刪除環境一併歸還內部埠租約', async () => {
    const pid = await mkEnv('k', { status: 'running', port: 21008, sso_secret: 'sec' });
    const res = await request(app).delete(`/api/projects/${pid}/env`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const { rows: [env] } = await dbModule.query('SELECT port FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.port).toBeNull();
  });

  // 意圖：測試區只有 docker 一種模式，Odoo 跑在容器裡、odoo_envs.pid 恆為 NULL——原本的
  // process.kill(pid, SIGTERM) 打不到任何東西。於是刪除環境後：目錄沒了、DB 說埠已歸還，
  // 容器卻還在跑而且還綁著那個埠。leasePort 會實測綁定所以不會配爆，但池子（只有 20 個）
  // 會靜默縮水，且從 DB 完全查不出是誰佔的。stopEnv 是唯一真正 stop+rm 容器的路徑。
  test('刪除環境必須真的停掉容器（只清 DB 欄位會留下綁著該埠的孤兒容器）', async () => {
    const pid = await mkEnv('m', { status: 'running', port: 21012, sso_secret: 'sec' });
    const res = await request(app).delete(`/api/projects/${pid}/env`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(mockStopEnv).toHaveBeenCalledWith(String(pid));
  });

  test('偵測容器已死自癒回 idle 時一併歸還內部埠租約', async () => {
    mockEnvContainerAlive.mockResolvedValueOnce(false);
    const pid = await mkEnv('l', { status: 'running', port: 21010, sso_secret: 'sec' });
    const res = await request(app).get(`/api/projects/${pid}/env`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('idle');
    const { rows: [env] } = await dbModule.query('SELECT port FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.port).toBeNull();
  });

  // 意圖：使用者按「開啟測試區」時環境可能已被閒置回收停掉。回 409「尚未就緒」等於要他自己
  // 去找「建立環境」按鈕再等——那個按鈕在專案頁，任務頁根本沒有。改成直接幫他起。
  // runEnvSetup 已在檔案頂端被 mock 為 mockRunEnvSetup（POST /env/setup 沿用同一支 spy），
  // /env/sso 走的是同一個 require('./pipeline/env-agent')，故不需另建 spy。
  test('環境 idle → 觸發建立並回 202 starting，不回 url', async () => {
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-test-{slot}.example.com';
    mockRunEnvSetup.mockResolvedValueOnce(undefined);
    const pid = await mkEnv('e', { status: 'idle', sso_secret: 'sec' });
    const res = await request(app).get(`/api/projects/${pid}/env/sso`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(202);
    expect(res.body.starting).toBe(true);
    expect(res.body.url).toBeUndefined();
    expect(mockRunEnvSetup).toHaveBeenCalledWith(String(pid));
  });

  // 意圖：連按兩次不得起兩個環境。runEnvSetup 內建 in-flight 去重，但這裡要確認我們有走到它，
  // 而不是各自 spawn——setting_up 代表已經有一個在跑，不該再觸發一次。
  test('環境 setting_up → 回 202 但不再觸發建立', async () => {
    const pid = await mkEnv('f', { status: 'setting_up', sso_secret: 'sec' });
    const res = await request(app).get(`/api/projects/${pid}/env/sso`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(202);
    expect(mockRunEnvSetup).not.toHaveBeenCalled();
  });

  // 意圖：_failEnv 只把 status 改成 error，不清 sso_secret（曾經建成功、之後重啟失敗＝
  // sso_secret 仍在）。若把這當一般未就緒自動重試，_setupInflight 失敗 settle 後立刻刪 key，
  // 下一次輪詢就會重跑一整輪 docker build/pip install/DB init，且使用者只會看到「建立中」
  // 而看不到真正失敗的原因。這裡要斷言兩件事：不觸發 runEnvSetup、回應帶出 error_msg。
  test('環境 error → 409 且不觸發建立，訊息帶出 error_msg', async () => {
    const pid = await mkEnv('g', { status: 'error', sso_secret: 'sec', error_msg: 'docker image build 失敗' });
    const res = await request(app).get(`/api/projects/${pid}/env/sso`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('docker image build 失敗');
    expect(mockRunEnvSetup).not.toHaveBeenCalled();
  });

  // 意圖：DB 標 running 但容器其實已不在（孤兒 running）時，點「開啟」不能拿 status 當真給一個
  // 指向死容器的子網域網址——那正是使用者看到的空白畫面。必須偵測容器不活、改走自動起回 202，
  // 且絕不借出對外名額給一個死掉的環境。這是 GET /env 自癒的同一個盲區在開啟路徑上的另一半。
  test('status=running 但容器已死 → /env/sso 改走自動起回 202，不給死網址也不借名額', async () => {
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-test-{slot}.example.com';
    mockEnvContainerAlive.mockResolvedValueOnce(false);
    mockRunEnvSetup.mockResolvedValueOnce(undefined);
    const pid = await mkEnv('dead-sso', { status: 'running', port: 21022, sso_secret: 'sec' });
    const res = await request(app).get(`/api/projects/${pid}/env/sso`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(202);
    expect(res.body.starting).toBe(true);
    expect(res.body.url).toBeUndefined();
    await new Promise(r => setTimeout(r, 10));
    expect(mockRunEnvSetup).toHaveBeenCalledWith(String(pid));
    const { rows: [env] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.external_slot).toBeNull();
  });
});
