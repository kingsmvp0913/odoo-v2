const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret';

const mockRunEnvSetup = jest.fn();
const mockStopEnv = jest.fn();
const mockSyncUsers = jest.fn();
jest.mock('../pipeline/env-agent', () => ({
  runEnvSetup: mockRunEnvSetup,
  stopEnv: mockStopEnv,
  syncUsers: mockSyncUsers,
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
beforeEach(() => { mockRunEnvSetup.mockReset(); mockStopEnv.mockReset(); mockSyncUsers.mockReset(); });

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
  // port 由 projects.port 決定（建專案時已固定分配），route 不再轉傳 body 參數
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

test('POST sync-users → 409 建立中（setting_up）', async () => {
  await dbModule.query(
    "INSERT INTO odoo_envs (project_id, status) VALUES ($1,'setting_up') ON CONFLICT (project_id) DO UPDATE SET status='setting_up'",
    [projectId]
  );
  const res = await request(app)
    .post(`/api/projects/${projectId}/env/sync-users`)
    .set(auth());
  expect(res.status).toBe(409);
  expect(mockSyncUsers).not.toHaveBeenCalled();
});

test('POST sync-users → calls syncUsers and returns log', async () => {
  await dbModule.query("UPDATE odoo_envs SET status='running' WHERE project_id=$1", [projectId]);
  mockSyncUsers.mockResolvedValueOnce('[seed] 1 users → SEED_DONE 1\n');
  const res = await request(app)
    .post(`/api/projects/${projectId}/env/sync-users`)
    .set(auth());
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.log).toContain('SEED_DONE');
  expect(mockSyncUsers).toHaveBeenCalledWith(String(projectId));
});

test('POST sync-users → 500 when env not built', async () => {
  await dbModule.query("UPDATE odoo_envs SET status='running' WHERE project_id=$1", [projectId]);
  mockSyncUsers.mockRejectedValueOnce(new Error('環境尚未建立，請先建立測試環境'));
  const res = await request(app)
    .post(`/api/projects/${projectId}/env/sync-users`)
    .set(auth());
  expect(res.status).toBe(500);
  expect(res.body.error).toContain('尚未建立');
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
