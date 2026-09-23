const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-setup-race';
process.env.APP_SECRET = 'test-setup-race-app';

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn(), resetLoopCounter: jest.fn() }));
jest.mock('../pipeline/git', () => ({ createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn() }));
jest.mock('../lib/project-vpn', () => ({ startProjectVpns: jest.fn(), stopProjectVpns: jest.fn() }));

let dbModule;

afterAll(() => dbModule._setPoolForTesting(null));

test('兩個首次 setup 同時抵達時只建立一個管理員', async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const app = require('../index').createApp();

  const payload = password => ({ username: `admin-${password}`, password, display_name: password });
  const [a, b] = await Promise.all([
    request(app).post('/api/auth/setup').send(payload('password-a')),
    request(app).post('/api/auth/setup').send(payload('password-b')),
  ]);

  expect([a.status, b.status].sort()).toEqual([200, 403]);
  const { rows: [count] } = await dbModule.query('SELECT COUNT(*)::int AS n FROM users');
  expect(count.n).toBe(1);
});
