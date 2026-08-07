// 初次 clone 私有 repo 需帶「發起人」的 PAT（有 PAT 就用、無 PAT 退機器憑證）。
// 攔截 execFile 檢查 fresh clone 拿到的 opts.env。
jest.mock('../lib/github-api', () => ({ fetchGitHubIdentity: jest.fn() }));

const execFileCalls = [];
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execFile: jest.fn((file, args, opts, cb) => {
      execFileCalls.push({ file, args, opts });
      if (typeof cb === 'function') process.nextTick(() => cb(null, '', ''));
      return { on: () => {} };
    }),
  };
});
// clone 成功後 triggerClone 會呼叫這些——隔離掉避免真副作用
jest.mock('../pipeline/git', () => ({
  ensureTestingBranch: jest.fn().mockResolvedValue(undefined),
  ensureMainBranch: jest.fn().mockResolvedValue('main'),
  pullBranch: jest.fn().mockResolvedValue(undefined),
  // 新增 repo 的撞名守衛與 clone 後的 ai-dev 基底扶正會用到。remoteAiBranchName 給真實行為
  // 而非 jest.fn()，否則守衛形同不存在；refExists=false 讓扶正直接跳過，不干擾本檔的 PAT 劇本。
  remoteAiBranchName: (b) => (b ? `ai-dev-${String(b).replace(/\//g, '-')}` : 'ai-dev'),
  AI_BRANCH: 'ai-dev',
  refExists: jest.fn().mockResolvedValue(false),
  remoteAiRef: jest.fn().mockResolvedValue('ai-dev'),
  getMainBranch: jest.fn().mockResolvedValue('main'),
}));

const request = require('supertest');
const { newDb } = require('pg-mem');
process.env.JWT_SECRET = 'test-clone-pat';
process.env.APP_SECRET = 'test-clone-pat-app';
const { fetchGitHubIdentity } = require('../lib/github-api');

let app, dbModule, token;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  app = require('../index').createApp();
  const res = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '管理員' });
  token = res.body.token;
}, 30000);
afterAll(() => dbModule._setPoolForTesting(null));

function lastClone() {
  return [...execFileCalls].reverse().find(c => c.file === 'git' && c.args.includes('clone'));
}

async function newProject(name) {
  const p = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name, odoo_version: '17.0' });
  return p.body.id;
}

test('發起人已設 PAT → 初次 clone 帶入其 gitEnv（GIT_PAT/GIT_ASKPASS）', async () => {
  fetchGitHubIdentity.mockResolvedValueOnce({ login: 'bob', name: 'Bob', email: 'bob@corp.com' });
  const set = await request(app).post('/api/settings/github-pat')
    .set('Authorization', `Bearer ${token}`).send({ pat: 'ghp_clone_me' });
  expect(set.status).toBe(200);

  const pid = await newProject('CloneWithPat');
  execFileCalls.length = 0;
  const r = await request(app).post(`/api/projects/${pid}/repos`).set('Authorization', `Bearer ${token}`)
    .send({ label: 'main', repo_url: 'https://github.com/test/private-repo' });
  expect(r.status).toBe(201);

  const clone = lastClone();
  expect(clone).toBeTruthy();
  expect(clone.opts.env).toBeDefined();
  expect(clone.opts.env.GIT_PAT).toBe('ghp_clone_me');
  expect(clone.opts.env.GIT_ASKPASS).toBeTruthy();
});

test('發起人未設 PAT → 初次 clone 退回機器憑證（不帶 env）', async () => {
  const del = await request(app).delete('/api/settings/github-pat').set('Authorization', `Bearer ${token}`);
  expect(del.status).toBe(200);

  const pid = await newProject('CloneNoPat');
  execFileCalls.length = 0;
  const r = await request(app).post(`/api/projects/${pid}/repos`).set('Authorization', `Bearer ${token}`)
    .send({ label: 'main', repo_url: 'https://github.com/test/public-repo' });
  expect(r.status).toBe(201);

  const clone = lastClone();
  expect(clone).toBeTruthy();
  // 無 PAT：沿用舊行為，不注入 gitEnv（env 未帶 → 繼承 process.env 的機器憑證）
  expect(clone.opts.env).toBeUndefined();
});
