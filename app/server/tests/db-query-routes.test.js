process.env.APP_SECRET = 'test-secret';
process.env.JWT_SECRET = 'test-dbq';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const mockRunSelect = jest.fn();
jest.mock('../lib/ssh-sql', () => ({ runSelect: (...a) => mockRunSelect(...a) }));

let dbModule, app, token, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name) VALUES ('u','h','U') RETURNING id");
  token = jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,odoo_version) VALUES ('P','17.0') RETURNING id");
  projectId = p.id;
  const a = express(); a.use(express.json());
  require('../db-query-routes').registerRoutes(a);
  app = a;
});
afterAll(() => dbModule._setPoolForTesting(null));
const auth = () => ({ Authorization: `Bearer ${token}` });

let cid;
test('POST 建立連線（回傳不含密碼）', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
    name: 'c1', ssh_host: '1.2.3.4', ssh_user: 'root', auth_type: 'password', ssh_password: 'secret',
    connect_mode: 'docker', docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_prd'
  });
  expect(res.status).toBe(201);
  expect(res.body.ssh_password_enc).toBeUndefined();
  cid = res.body.id;
});

test('GET 列出（不含密碼）', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/db-connections`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body[0].ssh_password_enc).toBeUndefined();
  expect(res.body[0].name).toBe('c1');
});

test('POST query 呼叫 runSelect 並回結果', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, columns: ['id'], rows: [['1']], row_count: 1 });
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/${cid}/query`).set(auth()).send({ sql: 'SELECT 1' });
  expect(res.status).toBe(200);
  expect(res.body.row_count).toBe(1);
  // runSelect 收到的 conn 應含解密後的明文密碼
  expect(mockRunSelect.mock.calls[0][0].ssh_password).toBe('secret');
});

test('DELETE 移除連線', async () => {
  const res = await request(app).delete(`/api/projects/${projectId}/db-connections/${cid}`).set(auth());
  expect(res.status).toBe(200);
});

test('401 無 token', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/db-connections`);
  expect(res.status).toBe(401);
});
