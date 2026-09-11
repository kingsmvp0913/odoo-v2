// 意圖：產品化規格頁是內部規劃文件，只能給平台管理員看。
// 規格檔放在不進版控的 docs/，由平台讀出來回給已登入的管理員；任何人都能打到這支就等於公開。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');
const request = require('supertest');

process.env.JWT_SECRET = 'test-docs-routes';

let dbModule, app, adminToken, userToken, docsDir;

beforeAll(async () => {
  docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-routes-'));
  process.env.DOCS_DIR = docsDir;

  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  const { hashPassword } = require('../password');
  const pw = await hashPassword('pw');
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('adm',$1,'A','admin'), ('usr',$1,'U','user')",
    [pw]
  );
  adminToken = (await request(app).post('/api/auth/login').send({ username: 'adm', password: 'pw' })).body.token;
  userToken = (await request(app).post('/api/auth/login').send({ username: 'usr', password: 'pw' })).body.token;
}, 30000);

afterAll(() => {
  dbModule._setPoolForTesting(null);
  delete process.env.DOCS_DIR;
  fs.rmSync(docsDir, { recursive: true, force: true });
});

const SPEC_FILE = 'odoo-v2-saas-specs.html';
const writeSpec = (html) => fs.writeFileSync(path.join(docsDir, SPEC_FILE), html);

beforeEach(() => {
  fs.rmSync(path.join(docsDir, SPEC_FILE), { force: true });
});

test('沒登入拿不到規格頁', async () => {
  writeSpec('<title>規格</title>');
  const res = await request(app).get('/api/docs/saas-specs');
  expect(res.status).toBe(401);
  expect(res.text).not.toContain('<title>規格</title>');
});

test('一般使用者拿不到規格頁', async () => {
  writeSpec('<title>規格</title>');
  const res = await request(app).get('/api/docs/saas-specs').set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
  expect(res.text).not.toContain('<title>規格</title>');
});

test('管理員拿到的是 docs 目錄裡那份檔案的內容，型別是 HTML', async () => {
  writeSpec('<title>規格</title><p>marker-7f3a</p>');
  const res = await request(app).get('/api/docs/saas-specs').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/^text\/html/);
  expect(res.text).toBe('<title>規格</title><p>marker-7f3a</p>');
});

test('檔案還沒產生時回 404 並說明原因，不是 500', async () => {
  const res = await request(app).get('/api/docs/saas-specs').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
  expect(res.body.error).toBe('規格頁尚未產生');
});
