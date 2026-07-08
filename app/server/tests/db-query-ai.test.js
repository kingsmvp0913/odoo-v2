process.env.APP_SECRET = 'test-secret';
process.env.JWT_SECRET = 'test-dbq-ai';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');

const mockRunSelect = jest.fn();
jest.mock('../lib/ssh-sql', () => ({ runSelect: (...a) => mockRunSelect(...a) }));

let dbModule, app, projectId;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,folder_name,odoo_version) VALUES ('鴻久','hungjou','17.0') RETURNING id");
  projectId = p.id;
  await dbModule.query("INSERT INTO db_connections (project_id,name,ssh_host,ssh_user,db_name) VALUES ($1,'hj','1.2.3.4','root','odoo_prd')", [projectId]);
  const a = express(); a.use(express.json());
  require('../db-query-routes').registerRoutes(a);
  app = a;
});
afterAll(() => dbModule._setPoolForTesting(null));

test('GET /ai/db/connections 依專案名過濾（loopback）', async () => {
  const res = await request(app).get('/ai/db/connections?project=hungjou');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.connections[0].name).toBe('hj');
  expect(res.body.connections[0].db_engine).toBe('postgres');
  expect(res.body.connections[0].ssh_password_enc).toBeUndefined();
});

test('POST /ai/db/query 執行 SELECT（loopback）', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, columns: ['id'], rows: [['1']], row_count: 1 });
  const { rows: [c] } = await dbModule.query('SELECT id FROM db_connections LIMIT 1');
  const res = await request(app).post('/ai/db/query').send({ connection_id: c.id, sql: 'SELECT 1' });
  expect(res.status).toBe(200);
  expect(res.body.row_count).toBe(1);
});

test('loopbackOnly 擋非本機來源', () => {
  const { loopbackOnly } = require('../db-query-routes');
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  loopbackOnly({ socket: { remoteAddress: '8.8.8.8' } }, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});

test('loopbackOnly 放行本機來源', () => {
  const { loopbackOnly } = require('../db-query-routes');
  const next = jest.fn();
  loopbackOnly({ socket: { remoteAddress: '127.0.0.1' } }, {}, next);
  expect(next).toHaveBeenCalled();
});
