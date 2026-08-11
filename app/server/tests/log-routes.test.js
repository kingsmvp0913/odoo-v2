process.env.APP_SECRET = 'test-secret';
process.env.JWT_SECRET = 'test-log-routes';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { aiToken, AI_TOKEN_HEADER } = require('../lib/ai-token');

const mockRunLogTail = jest.fn();
const mockProbe = jest.fn();
jest.mock('../lib/ssh-log', () => ({
  runLogTail: (...a) => mockRunLogTail(...a),
  probeLogSource: (...a) => mockProbe(...a),
  sshExecLog: jest.fn(),
}));
jest.mock('../lib/ssh-sql', () => ({ runSelect: jest.fn() }));

let dbModule, app, connId, projectId, token;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name,folder_name,odoo_version) VALUES ('鴻久','hungjou','17.0') RETURNING id");
  projectId = p.id;
  const { rows: [c] } = await dbModule.query(
    "INSERT INTO db_connections (project_id,name,ssh_host,ssh_user,db_name) VALUES ($1,'hj','1.2.3.4','root','odoo_prd') RETURNING id",
    [projectId]);
  connId = c.id;
  // 比照 db-query-routes.test.js:30 的既有做法：用真的 JWT_SECRET 簽真的 payload，
  // 走完整的 verifyToken 路徑（非繞過授權）。users 表欄位以該檔為準（display_name 為 NOT NULL）。
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name,role) VALUES ('t','x','T','admin') RETURNING id");
  token = jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const a = express(); a.use(express.json());
  require('../db-query-routes').registerRoutes(a);
  app = a;
});
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(() => { mockRunLogTail.mockReset(); mockProbe.mockReset(); });

test('POST /ai/db/log 轉呼 runLogTail 並回傳結果', async () => {
  mockRunLogTail.mockResolvedValueOnce({ ok: true, entries: [], total_matched: 0, returned: 0, truncated: false });
  const res = await request(app).post('/ai/db/log').set(AI_TOKEN_HEADER, aiToken())
    .send({ connection_id: connId, at: '2026-08-10T14:23:00+08:00', level: 'ERROR' });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(mockRunLogTail).toHaveBeenCalled();
  expect(mockRunLogTail.mock.calls[0][1]).toMatchObject({ at: '2026-08-10T14:23:00+08:00', level: 'ERROR' });
});

test('POST /ai/db/log 找不到連線時明確回報', async () => {
  const res = await request(app).post('/ai/db/log').set(AI_TOKEN_HEADER, aiToken())
    .send({ connection_id: 999999, at: '2026-08-10T14:23:00+08:00' });
  expect(res.body.ok).toBe(false);
  expect(res.body.error).toContain('連線');
  expect(mockRunLogTail).not.toHaveBeenCalled();
});

test('POST /ai/db/log 沒帶通行碼一律擋下', async () => {
  const res = await request(app).post('/ai/db/log')
    .send({ connection_id: connId, at: '2026-08-10T14:23:00+08:00' });
  expect(res.status).toBe(403);
  expect(mockRunLogTail).not.toHaveBeenCalled();
});

test('探測成功會把結果寫回連線設定', async () => {
  mockProbe.mockResolvedValueOnce({
    ok: true, log_mode: 'docker', log_container: 'odoo-app', log_tz_offset: 480,
  });
  const res = await request(app)
    .post(`/api/projects/${projectId}/db-connections/${connId}/probe-log`)
    .set({ Authorization: `Bearer ${token}` });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const { rows: [c] } = await dbModule.query(
    'SELECT log_mode, log_container, log_tz_offset FROM db_connections WHERE id=$1', [connId]);
  expect(c.log_mode).toBe('docker');
  expect(c.log_container).toBe('odoo-app');
  expect(c.log_tz_offset).toBe(480);
});

// 留下半套設定會讓之後的查詢用錯來源卻不自知，故失敗一律不寫。
// 前一個測試已寫入 docker，此處驗證失敗的探測「不會覆蓋」既有值——
// 若改用全新連線，log_mode 本來就是 null，測試恆綠而測不到任何行為。
test('探測失敗不得覆寫既有的 log 欄位', async () => {
  mockProbe.mockResolvedValueOnce({ ok: false, error: '偵測不到' });
  const res = await request(app)
    .post(`/api/projects/${projectId}/db-connections/${connId}/probe-log`)
    .set({ Authorization: `Bearer ${token}` });
  expect(res.body.ok).toBe(false);
  const { rows: [c] } = await dbModule.query('SELECT log_mode FROM db_connections WHERE id=$1', [connId]);
  expect(c.log_mode).toBe('docker');   // 仍是前一測試寫入的值，未被清掉
});

test('探測端點未帶 token 一律擋下', async () => {
  const res = await request(app)
    .post(`/api/projects/${projectId}/db-connections/${connId}/probe-log`);
  expect([401, 403]).toContain(res.status);
  expect(mockProbe).not.toHaveBeenCalled();
});
