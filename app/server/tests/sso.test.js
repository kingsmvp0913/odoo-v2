const crypto = require('crypto');
const { mintSsoToken } = require('../sso');

test('mintSsoToken 產生可被同密鑰 HMAC 驗證的 token', () => {
  const t = mintSsoToken({ secret: 'k', login: 'alice', name: 'Alice', ttlSec: 60 });
  const [p, s] = t.split('.');
  const expect_ = crypto.createHmac('sha256', 'k').update(p).digest('base64url');
  expect(s).toBe(expect_);
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  expect(payload.login).toBe('alice');
  expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
});

// --- GET /api/projects/:id/env/sso ---
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret';

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
  // 租戶隔離改動後，/env/sso 前面加了視覺化檢查——使用者要看得到專案才能過。給他一家公司、
  // 把專案綁上去，讓這裡測的是「看得到之後、狀態機邏輯本身」，不是被視覺化檢查擋在門外。
  const { rows: [company] } = await dbModule.query(
    "INSERT INTO companies (name, is_active) VALUES ('SsoCo', true) RETURNING id"
  );
  const { rows: [user] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, company_id) VALUES ('ssouser', $1, 'SSO User', $2) RETURNING id",
    [hash, company.id]
  );
  userId = user.id;
  token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('SsoProj', '17.0') RETURNING id"
  );
  projectId = proj.id;
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2)', [projectId, company.id]);

  const expressApp = express();
  expressApp.use(express.json());
  const { registerRoutes } = require('../env-routes');
  registerRoutes(expressApp);
  app = expressApp;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });
afterEach(() => { jest.restoreAllMocks(); });

const auth = () => ({ Authorization: `Bearer ${token}` });

// 意圖：從沒建過的專案（無 odoo_envs 列／無 sso_secret）按「測試區」不得是死路。
// 舊版回 409「尚未就緒」，而唯一能補救的「建立環境」按鈕只在專案詳情頁——側欄與專案卡的
// 「測試區」按下去等於什麼都不會發生。改成與「被閒置回收」同樣處理：幫他起、回 202。
test('GET env/sso → 從沒建過時觸發建立並回 202，不再回 409 死路', async () => {
  const envAgent = require('../pipeline/env-agent');
  const spy = jest.spyOn(envAgent, 'runEnvSetup').mockResolvedValue(undefined);
  const res = await request(app).get(`/api/projects/${projectId}/env/sso`).set(auth());
  expect(res.status).toBe(202);
  expect(res.body.starting).toBe(true);
  expect(spy).toHaveBeenCalledWith(String(projectId));
});

test('GET env/sso → 200 回免密登入 URL 並帶 token', async () => {
  // 明確走 port 模式：本測試驗 port 模式的 url 組裝，必須隔離進程可能洩漏的 ENV_EXTERNAL_URL_TEMPLATE
  // （正式機 .env 有設，會讓 url 變子網域而誤紅）。子網域模式的 url 由 env-routes.test.js 覆蓋。
  const savedTpl = process.env.ENV_EXTERNAL_URL_TEMPLATE;
  delete process.env.ENV_EXTERNAL_URL_TEMPLATE;
  try {
    // status 必須是 running：/env/sso 現在明確檢查狀態（子網域模式下要在這裡借對外名額，
    // 只有 url/sso_secret 存在但環境其實已停機的話不該再簽發免密登入連結）。
    // status='running' 還不夠——docker 是唯一模式、pid 恆為 NULL，端點會再問容器在不在跑（孤兒
    // running 會被擋掉改走自動起）。此測試模擬「環境正常在跑」，故讓容器活性檢查回 true。
    const envAgent = require('../pipeline/env-agent');
    jest.spyOn(envAgent, 'envContainerAlive').mockResolvedValue(true);
    await dbModule.query(
      "INSERT INTO odoo_envs (project_id, status, url, sso_secret) VALUES ($1, 'running', 'http://localhost:8071/', 'ssosecret') ON CONFLICT (project_id) DO UPDATE SET status='running', url='http://localhost:8071/', sso_secret='ssosecret'",
      [projectId]
    );
    const res = await request(app).get(`/api/projects/${projectId}/env/sso`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('http://localhost:8071/aidev/sso?token=');
    // TTL 收緊：token 有效期不得超過 30 秒（URL query 會進 access log，縮小可重放窗）。
    const tok = decodeURIComponent(res.body.url.split('token=')[1]);
    const payload = JSON.parse(Buffer.from(tok.split('.')[0], 'base64url').toString());
    expect(payload.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(30);
  } finally {
    if (savedTpl === undefined) delete process.env.ENV_EXTERNAL_URL_TEMPLATE;
    else process.env.ENV_EXTERNAL_URL_TEMPLATE = savedTpl;
  }
});

test('401 without token', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/env/sso`);
  expect(res.status).toBe(401);
});

// 規格 §2／§5.3：測試環境管理對客戶關閉——這個使用者看得到 projectId（前面的 200/409 測試已
// 證明看得到），管理端點仍不能碰。403 而非 404，因為擋他的理由是「不是平台管理員」，
// 不是「看不到這個專案」。
test('一般使用者看得到專案，仍不能呼叫管理端點（DELETE env）→ 403', async () => {
  const res = await request(app).delete(`/api/projects/${projectId}/env`).set(auth());
  expect(res.status).toBe(403);
});
