const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ processed: 0 }), resetLoopCounter: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
jest.mock('../pipeline/git', () => ({ createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn() }));

process.env.JWT_SECRET = 'test-proj';
let app, dbModule, token;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
  const res = await request(app).post('/api/auth/setup').send({ username: 'user1', password: 'pass1234', display_name: 'User' });
  token = res.body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

let projectId, repoId;

test('GET /api/projects → 401 without token', async () => {
  const res = await request(app).get('/api/projects');
  expect(res.status).toBe(401);
});

test('POST /api/projects → 400 missing fields', async () => {
  const res = await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Proj' });
  expect(res.status).toBe(400);
});

test('POST /api/projects → 201 creates', async () => {
  const res = await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'TestProj', odoo_version: '17.0', description: 'A test project' });
  expect(res.status).toBe(201);
  expect(res.body.name).toBe('TestProj');
  projectId = res.body.id;
});

test('GET /api/projects → 200 lists with repo_count', async () => {
  const res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBeGreaterThan(0);
  expect(res.body[0]).toHaveProperty('repo_count');
});

test('GET /api/projects/:id → 200 with repos array', async () => {
  const res = await request(app).get(`/api/projects/${projectId}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.name).toBe('TestProj');
  expect(Array.isArray(res.body.repos)).toBe(true);
});

test('POST /api/projects/:id/repos → 400 missing fields', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/repos`)
    .set('Authorization', `Bearer ${token}`)
    .send({ label: 'main' });
  expect(res.status).toBe(400);
});

test('POST /api/projects/:id/repos → 201 creates primary repo', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/repos`)
    .set('Authorization', `Bearer ${token}`)
    .send({ label: 'main', repo_url: 'https://github.com/test/odoo', local_path: '/opt/odoo', is_primary: true });
  expect(res.status).toBe(201);
  expect(res.body.is_primary).toBe(true);
  repoId = res.body.id;
});

test('POST /api/projects/:id/repos → new primary demotes previous primary', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/repos`)
    .set('Authorization', `Bearer ${token}`)
    .send({ label: 'plugin-hr', repo_url: 'https://github.com/test/hr', is_primary: true });
  expect(res.status).toBe(201);
  const { rows } = await dbModule.query('SELECT is_primary FROM project_repos WHERE id = $1', [repoId]);
  expect(rows[0].is_primary).toBe(false);
});

test('PUT /api/projects/:id → 200 updates description', async () => {
  const res = await request(app).put(`/api/projects/${projectId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ description: 'Updated desc' });
  expect(res.status).toBe(200);
  expect(res.body.description).toBe('Updated desc');
});

test('DELETE /api/projects/:id/repos/:repoId → 200', async () => {
  const res = await request(app).delete(`/api/projects/${projectId}/repos/${repoId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
});

test('DELETE /api/projects/:id → 200 and cascades repos', async () => {
  const res = await request(app).delete(`/api/projects/${projectId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT * FROM project_repos WHERE project_id = $1', [projectId]);
  expect(rows.length).toBe(0);
});

test('GET /api/projects/:id → 404 after delete', async () => {
  const res = await request(app).get(`/api/projects/${projectId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);
});
