const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ processed: 0 }), resetLoopCounter: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
jest.mock('../pipeline/git', () => ({ createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn() }));

process.env.JWT_SECRET = 'test-wiki';
let app, dbModule, token, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
  const userRes = await request(app).post('/api/auth/setup').send({ username: 'wikiuser', password: 'pass1234', display_name: 'Wiki' });
  token = userRes.body.token;
  const projRes = await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'WikiProj', odoo_version: '17.0' });
  projectId = projRes.body.id;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('GET /api/projects/:id/wiki → 200 empty list', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/wiki`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

test('POST /api/projects/:id/wiki → 400 missing slug', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/wiki`)
    .set('Authorization', `Bearer ${token}`).send({ title: 'Home' });
  expect(res.status).toBe(400);
});

test('POST /api/projects/:id/wiki → 201 creates page', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/wiki`)
    .set('Authorization', `Bearer ${token}`)
    .send({ slug: 'home', title: '首頁', content: '# 首頁\n\n這是首頁。' });
  expect(res.status).toBe(201);
  expect(res.body.slug).toBe('home');
});

test('POST /api/projects/:id/wiki → 409 duplicate slug', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/wiki`)
    .set('Authorization', `Bearer ${token}`)
    .send({ slug: 'home', title: '首頁2', content: '' });
  expect(res.status).toBe(409);
});

test('GET /api/projects/:id/wiki/:slug → 200 with content', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/wiki/home`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.content).toContain('首頁');
});

test('GET /api/projects/:id/wiki/:slug/raw → 200 text', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/wiki/home/raw`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.text).toContain('首頁');
});

test('PUT /api/projects/:id/wiki/:slug → 200 updates content', async () => {
  const res = await request(app).put(`/api/projects/${projectId}/wiki/home`)
    .set('Authorization', `Bearer ${token}`)
    .send({ content: '# 首頁\n\n更新後內容。' });
  expect(res.status).toBe(200);
  expect(res.body.content).toContain('更新後內容');
});

test('GET /api/projects/:id/wiki → lists page without content field', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/wiki`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBe(1);
  expect(res.body[0]).not.toHaveProperty('content');
});

test('DELETE /api/projects/:id/wiki/:slug → 200', async () => {
  const res = await request(app).delete(`/api/projects/${projectId}/wiki/home`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
});

test('GET /api/projects/:id/wiki/:slug → 404 after delete', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/wiki/home`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);
});

test('GET /wiki returns node_type and parent_id fields', async () => {
  const pr = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name: 'WikiFieldsProj', odoo_version: '17.0' });
  const pid = pr.body.id;
  await request(app).post(`/api/projects/${pid}/wiki`).set('Authorization', `Bearer ${token}`)
    .send({ slug: 'overview', title: '專案概論', content: '# x' });
  const res = await request(app).get(`/api/projects/${pid}/wiki`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body[0]).toHaveProperty('node_type');
  expect(res.body[0]).toHaveProperty('parent_id');
});

test('POST /wiki/:slug/refresh → 404 for missing slug', async () => {
  const pr = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name: 'RefreshProj', odoo_version: '17.0' });
  const res = await request(app).post(`/api/projects/${pr.body.id}/wiki/nope/refresh`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);
});
