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
  const { rows: [user] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('ssouser', $1, 'SSO User') RETURNING id",
    [hash]
  );
  userId = user.id;
  token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('SsoProj', '17.0') RETURNING id"
  );
  projectId = proj.id;

  const expressApp = express();
  expressApp.use(express.json());
  const { registerRoutes } = require('../env-routes');
  registerRoutes(expressApp);
  app = expressApp;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

const auth = () => ({ Authorization: `Bearer ${token}` });

test('GET env/sso → 409 當測試區尚未就緒（無 url/sso_secret）', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/env/sso`).set(auth());
  expect(res.status).toBe(409);
});

test('GET env/sso → 200 回免密登入 URL 並帶 token', async () => {
  // status 必須是 running：/env/sso 現在明確檢查狀態（子網域模式下要在這裡借對外名額，
  // 只有 url/sso_secret 存在但環境其實已停機的話不該再簽發免密登入連結）。
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
});

test('401 without token', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/env/sso`);
  expect(res.status).toBe(401);
});
