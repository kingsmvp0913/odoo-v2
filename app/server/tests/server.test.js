const request = require('supertest');

// Must set env vars BEFORE requiring any module
process.env.JWT_SECRET = 'test-jwt-secret';

const { newDb } = require('pg-mem');
const { _setPoolForTesting } = require('../db');
const { createApp } = require('../index');

let app;

beforeAll(async () => {
  const pgMem = newDb();
  const { Pool } = pgMem.adapters.createPg();
  _setPoolForTesting(new Pool());
  app = createApp();
});

afterAll(async () => {
  _setPoolForTesting(null);
});

test('GET / returns 200', async () => {
  const res = await request(app).get('/');
  expect(res.status).toBe(200);
});

test('GET /api/unknown returns 404', async () => {
  const res = await request(app).get('/api/unknown');
  expect(res.status).toBe(404);
});
