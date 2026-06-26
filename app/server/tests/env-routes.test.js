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
  nightlyShutdown: jest.fn()
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
    .set(auth()).send({ port: 8070 });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  // fire-and-forget so we need to wait a tick
  await new Promise(r => setTimeout(r, 10));
  expect(mockRunEnvSetup).toHaveBeenCalledWith(String(projectId), 8070);
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
