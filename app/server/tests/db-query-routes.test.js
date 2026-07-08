process.env.APP_SECRET = 'test-secret';
process.env.JWT_SECRET = 'test-dbq';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const mockRunSelect = jest.fn();
jest.mock('../lib/ssh-sql', () => ({ runSelect: (...a) => mockRunSelect(...a) }));

let dbModule, app, token, userToken, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name,role) VALUES ('u','h','U','admin') RETURNING id");
  token = jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const { rows: [nu] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name,role) VALUES ('nu','h','NU','user') RETURNING id");
  userToken = jwt.sign({ userId: nu.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
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

// 主題 E-3：DB 連線管理與對正式庫查詢限 admin；GET 清單（僅 metadata）一般 user 仍可讀
test('E-3 非 admin：POST 建立連線 → 403，GET 清單仍 200', async () => {
  const uauth = { Authorization: `Bearer ${userToken}` };
  const post = await request(app).post(`/api/projects/${projectId}/db-connections`).set(uauth).send({
    name: 'x', ssh_host: 'h', ssh_user: 'u', db_name: 'd'
  });
  expect(post.status).toBe(403);
  const list = await request(app).get(`/api/projects/${projectId}/db-connections`).set(uauth);
  expect(list.status).toBe(200);
});

// direct 模式（DBeaver 直連）：不需 SSH 欄位，必填 db_host/db_user/db_password/db_name
let dcid;
test('direct POST 建立（不需 ssh 欄位，回傳含 db_host 不含密碼）', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
    name: 'dconn', connect_mode: 'direct',
    db_host: 'db.example.com', db_port: 5432, db_user: 'reader', db_password: 'dbsecret', db_name: 'odoo_prd', db_ssl: true
  });
  expect(res.status).toBe(201);
  expect(res.body.db_host).toBe('db.example.com');
  expect(res.body.db_ssl).toBe(true);
  expect(res.body.db_password_enc).toBeUndefined();
  expect(res.body.ssh_password_enc).toBeUndefined();
  dcid = res.body.id;
});

test('direct POST 缺 db_host → 400', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
    name: 'bad', connect_mode: 'direct', db_user: 'reader', db_password: 'x', db_name: 'd'
  });
  expect(res.status).toBe(400);
});

test('direct query：runSelect 收到解密後的 db_password 明文', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, columns: ['x'], rows: [['1']], row_count: 1 });
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/${dcid}/query`).set(auth()).send({ sql: 'SELECT 1' });
  expect(res.status).toBe(200);
  expect(mockRunSelect.mock.calls.at(-1)[0].db_password).toBe('dbsecret');
});

test('/test 端點：以表單值呼叫 runSelect(SELECT 1) 並回 ok', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, columns: ['?column?'], rows: [['1']], row_count: 1 });
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/test`).set(auth()).send({
    connect_mode: 'direct', db_host: 'h', db_user: 'u', db_password: 'formpw', db_name: 'd'
  });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const call = mockRunSelect.mock.calls.at(-1);
  expect(call[0].db_password).toBe('formpw');
  expect(call[1]).toBe('SELECT 1');
});

test('/test 端點：編輯時密碼留空 → 回填已存密碼', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, columns: [], rows: [], row_count: 0 });
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/test`).set(auth()).send({
    id: dcid, connect_mode: 'direct', db_host: 'db.example.com', db_user: 'reader', db_name: 'odoo_prd'
    // db_password 留空
  });
  expect(res.status).toBe(200);
  expect(mockRunSelect.mock.calls.at(-1)[0].db_password).toBe('dbsecret');
});

test('/test 端點：非 admin → 403', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/test`)
    .set({ Authorization: `Bearer ${userToken}` }).send({ connect_mode: 'direct', db_host: 'h', db_user: 'u', db_password: 'p', db_name: 'd' });
  expect(res.status).toBe(403);
});
