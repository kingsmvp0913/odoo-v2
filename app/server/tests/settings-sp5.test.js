const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 0 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn()
}));
jest.mock('../pipeline/coding-agent', () => ({ runCodingAgent: jest.fn() }));
jest.mock('../pipeline/qa-agent', () => ({ runQaAgent: jest.fn() }));

process.env.JWT_SECRET = 'test-sp5';

let app, dbModule, token;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  const res = await request(app).post('/api/auth/setup').send({
    username: 'sp5user', password: 'pass1234', display_name: 'SP5'
  });
  token = res.body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('GET /api/settings returns coding_cmd and qa_cmd fields', async () => {
  const res = await request(app).get('/api/settings')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('coding_cmd');
  expect(res.body).toHaveProperty('qa_cmd');
});

test('PUT /api/settings saves coding_cmd and qa_cmd', async () => {
  const res = await request(app).put('/api/settings')
    .set('Authorization', `Bearer ${token}`)
    .send({ coding_cmd: 'echo hello', qa_cmd: 'echo test' });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

test('GET /api/settings returns updated coding_cmd and qa_cmd', async () => {
  const res = await request(app).get('/api/settings')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.coding_cmd).toBe('echo hello');
  expect(res.body.qa_cmd).toBe('echo test');
});
