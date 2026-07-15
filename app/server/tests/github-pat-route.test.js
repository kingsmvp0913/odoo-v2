jest.mock('../lib/github-api', () => ({
  fetchGitHubIdentity: jest.fn()
}));
const request = require('supertest');
const { newDb } = require('pg-mem');
process.env.JWT_SECRET = 'test-pat-secret';
process.env.APP_SECRET = 'test-app-secret';
const { fetchGitHubIdentity } = require('../lib/github-api');
const { decrypt } = require('../lib/crypto');

let app, dbModule, token;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  app = require('../index').createApp();
  const res = await request(app).post('/api/auth/setup').send({ username: 'admin', password: 'password123', display_name: '管理員' });
  token = res.body.token;
});
afterAll(() => dbModule._setPoolForTesting(null));

test('POST github-pat：驗證通過 → 加密存 + 回 login', async () => {
  fetchGitHubIdentity.mockResolvedValueOnce({ login: 'bob', name: 'Bob', email: 'bob@corp.com' });
  const res = await request(app).post('/api/settings/github-pat')
    .set('Authorization', `Bearer ${token}`).send({ pat: 'ghp_real' });
  expect(res.status).toBe(200);
  expect(res.body.login).toBe('bob');
  const { rows } = await dbModule.query('SELECT github_pat_enc, github_login FROM users WHERE username=$1', ['admin']);
  expect(rows[0].github_login).toBe('bob');
  expect(decrypt(rows[0].github_pat_enc)).toBe('ghp_real'); // 存的是密文、可解回原值
});

test('GET github-pat：回狀態但不含 token', async () => {
  const res = await request(app).get('/api/settings/github-pat').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.configured).toBe(true);
  expect(res.body.login).toBe('bob');
  expect(JSON.stringify(res.body)).not.toMatch(/ghp_real/);
  expect(Object.keys(res.body)).not.toContain('github_pat_enc');
});

test('POST github-pat：PAT 無效 → 401 且不儲存變更', async () => {
  fetchGitHubIdentity.mockRejectedValueOnce(new Error('GitHub 認證失敗：PAT 無效'));
  const res = await request(app).post('/api/settings/github-pat')
    .set('Authorization', `Bearer ${token}`).send({ pat: 'ghp_bad' });
  expect(res.status).toBe(401);
});

test('DELETE github-pat：清空欄位', async () => {
  const res = await request(app).delete('/api/settings/github-pat').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const get = await request(app).get('/api/settings/github-pat').set('Authorization', `Bearer ${token}`);
  expect(get.body.configured).toBe(false);
});
