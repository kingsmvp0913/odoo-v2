const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret';

const mockRunEnvSetup = jest.fn();
const mockStopEnv = jest.fn();
jest.mock('../pipeline/env-agent', () => ({
  runEnvSetup: mockRunEnvSetup,
  stopEnv: mockStopEnv,
  nightlyShutdown: jest.fn(),
  ENV_BASE: require('path').resolve(__dirname, '..', '..', '..', 'odoo-envs')
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
beforeEach(() => { mockRunEnvSetup.mockReset(); mockStopEnv.mockReset(); });

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
  const res = await request(app)
    .delete(`/api/projects/${projectId}/env`)
    .set(auth());
  expect(res.status).toBe(200);
  const { rows: [env] } = await dbModule.query(
    'SELECT status FROM odoo_envs WHERE project_id=$1', [projectId]
  );
  expect(env.status).toBe('idle');
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
    `INSERT INTO odoo_envs (project_id, status, port, url, sso_secret, external_slot)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [p.id, opts.status || 'idle', opts.port ?? null, opts.url ?? null, opts.sso_secret ?? null, opts.external_slot ?? null]
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

  test('環境未 running → 409，且不借名額', async () => {
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-test-{slot}.example.com';
    const pid = await mkEnv('c', { status: 'idle', sso_secret: 'sec' });
    const res = await request(app).get(`/api/projects/${pid}/env/sso`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    const { rows: [env] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.external_slot).toBeNull();
  });

  // 意圖：真人關掉分頁偵測不到，所以「還名額」只有明確按鈕與閒置逾時兩條路。
  // 少了明確這條，名額只能等 20 分鐘自然到期，10 個名額的池子體感會非常小。
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
});
