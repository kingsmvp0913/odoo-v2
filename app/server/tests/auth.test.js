/**
 * auth.test.js — Auth routes tests using pg-mem (no real PostgreSQL needed)
 *
 * TDD: tests written before implementation.
 * All 9 original test cases preserved; SQLite replaced with pg-mem.
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

// Must set env vars BEFORE requiring any module
process.env.JWT_SECRET = 'test-jwt-secret';

let app;
let dbModule;

beforeAll(async () => {
  // Build pg-mem pool
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  // Inject pool before requiring modules
  dbModule = require('../db');
  dbModule._setPoolForTesting(pool);

  // Run migration so tables exist
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();
});

afterAll(async () => {
  dbModule._setPoolForTesting(null);
});

let adminToken;

test('GET /api/setup/status → needsSetup: true initially', async () => {
  const res = await request(app).get('/api/setup/status');
  expect(res.status).toBe(200);
  expect(res.body.needsSetup).toBe(true);
});

test('POST /api/auth/setup → creates admin, returns token', async () => {
  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'password123', display_name: '管理員'
  });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeDefined();
  adminToken = res.body.token;
});

test('POST /api/auth/setup → 403 after first admin', async () => {
  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin2', password: 'password123', display_name: '管理員2'
  });
  expect(res.status).toBe(403);
});

test('GET /api/setup/status → needsSetup: false after setup', async () => {
  const res = await request(app).get('/api/setup/status');
  expect(res.body.needsSetup).toBe(false);
});

test('POST /api/auth/login → valid credentials return token + user', async () => {
  const res = await request(app).post('/api/auth/login').send({
    username: 'admin', password: 'password123'
  });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeDefined();
  expect(res.body.user.role).toBe('admin');
  expect(res.body.user.password_hash).toBeUndefined();
});

test('POST /api/auth/login → 401 on wrong password', async () => {
  const res = await request(app).post('/api/auth/login').send({
    username: 'admin', password: 'wrong'
  });
  expect(res.status).toBe(401);
});

test('GET /api/auth/me → returns user with valid token', async () => {
  const res = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.username).toBe('admin');
  expect(res.body.password_hash).toBeUndefined();
});

test('GET /api/auth/me → 401 without token', async () => {
  const res = await request(app).get('/api/auth/me');
  expect(res.status).toBe(401);
});

test('GET /api/auth/me → 401 with invalid token', async () => {
  const res = await request(app).get('/api/auth/me')
    .set('Authorization', 'Bearer invalid.token.here');
  expect(res.status).toBe(401);
});
