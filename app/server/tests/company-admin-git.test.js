/**
 * company-admin-git.test.js — 公司 GIT 憑證，存之前先用 git ls-remote 驗證（規格 §6）
 *
 * 為什麼要當場驗：公司 PAT 是全公司在沒有個人 PAT 時的退路。存一把沒權限的 PAT，
 * 症狀會在很久以後的某次自動推送才出現，而且錯誤是 git 的英文認證訊息，追不回這裡。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

// 不真的連 GitHub：驗證這一關要能被測，就得能換掉它。
jest.mock('../pipeline/git', () => ({
  ...jest.requireActual('../pipeline/git'),
  listRemoteBranchesByUrl: jest.fn(),
}));

process.env.JWT_SECRET = 'test-cogit-jwt';
process.env.APP_SECRET = 'test-cogit-secret';

let app, dbModule, adminToken, coId, projectId;
const { listRemoteBranchesByUrl } = require('../pipeline/git');

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  adminToken = (await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '平台管理員' })).body.token;

  coId = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '甲客戶' })).body.id;
  projectId = (await one("INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", ['甲專案'])).id;
  await dbModule.query('INSERT INTO project_repos (project_id, label, repo_url) VALUES ($1,$2,$3)',
    [projectId, 'main', 'https://github.com/example/repo.git']);
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2)', [projectId, coId]);
});

afterEach(() => listRemoteBranchesByUrl.mockReset());
afterAll(() => dbModule._setPoolForTesting(null));

describe('存公司 GIT', () => {
  test('每個綁定專案的 repo 都連得上 → 存起來', async () => {
    listRemoteBranchesByUrl.mockResolvedValue({ branches: ['main'], defaultBranch: 'main' });
    const res = await request(app).put(`/api/admin/companies/${coId}/git`).set(as(adminToken))
      .send({ pat: 'ghp_good', login: 'co-bot', name: '甲公司機器人', email: 'bot@example.com' });
    expect(res.status).toBe(200);
    expect(listRemoteBranchesByUrl).toHaveBeenCalledTimes(1);
    const row = await one('SELECT git_pat_enc, git_login FROM companies WHERE id=$1', [coId]);
    expect(row.git_pat_enc).toBeTruthy();
    expect(row.git_login).toBe('co-bot');
  });

  test('存起來的是密文，不是明碼', async () => {
    const row = await one('SELECT git_pat_enc FROM companies WHERE id=$1', [coId]);
    expect(row.git_pat_enc).not.toContain('ghp_good');
  });

  test('回應不含 PAT（回去就等於外洩給任何看得到回應的人）', async () => {
    listRemoteBranchesByUrl.mockResolvedValue({ branches: ['main'], defaultBranch: 'main' });
    const res = await request(app).put(`/api/admin/companies/${coId}/git`).set(as(adminToken))
      .send({ pat: 'ghp_secret_value', login: 'co-bot' });
    expect(JSON.stringify(res.body)).not.toContain('ghp_secret_value');
  });

  test('連不上 → 400 且不存（舊的值也不可以被洗掉）', async () => {
    const before = await one('SELECT git_pat_enc FROM companies WHERE id=$1', [coId]);
    listRemoteBranchesByUrl.mockRejectedValue(new Error('Authentication failed'));
    const res = await request(app).put(`/api/admin/companies/${coId}/git`).set(as(adminToken))
      .send({ pat: 'ghp_bad', login: 'co-bot' });
    expect(res.status).toBe(400);
    const after = await one('SELECT git_pat_enc FROM companies WHERE id=$1', [coId]);
    expect(after.git_pat_enc).toBe(before.git_pat_enc);
  });

  test('沒綁任何專案的公司 → 沒東西可驗，直接存', async () => {
    const id = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '乙客戶' })).body.id;
    const res = await request(app).put(`/api/admin/companies/${id}/git`).set(as(adminToken))
      .send({ pat: 'ghp_x', login: 'b' });
    expect(res.status).toBe(200);
    expect(listRemoteBranchesByUrl).not.toHaveBeenCalled();
  });

  test('沒給 pat → 400', async () => {
    expect((await request(app).put(`/api/admin/companies/${coId}/git`).set(as(adminToken)).send({})).status).toBe(400);
  });
});

describe('清除公司 GIT', () => {
  test('清掉四個欄位', async () => {
    const res = await request(app).delete(`/api/admin/companies/${coId}/git`).set(as(adminToken));
    expect(res.status).toBe(204);
    const row = await one('SELECT git_pat_enc, git_login, git_name, git_email FROM companies WHERE id=$1', [coId]);
    expect(row.git_pat_enc).toBeNull();
    expect(row.git_login).toBeNull();
  });
});
