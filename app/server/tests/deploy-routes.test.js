const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('../lib/deploy-run', () => ({ runDeploy: jest.fn().mockResolvedValue({ ok: true, status: 'success', modules: ['idx_hj'] }) }));
const { runDeploy } = require('../lib/deploy-run');

process.env.JWT_SECRET = 'test-deploy-routes';
process.env.APP_SECRET = 'test-app-secret';

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
    username: 'admin', password: 'password123', display_name: '管理員'
  });
  token = res.body.token;

  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('甲', '17.0')");   // 1
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('乙', '17.0')");   // 2
  await dbModule.query('UPDATE projects SET auto_deploy_enabled = true WHERE id = 1');
  // 1 = 甲的測試區、2 = 甲的正式區、3 = 乙的測試區
  for (const [pid, env] of [[1, 'test'], [1, 'prod'], [2, 'test']]) {
    await dbModule.query(
      `INSERT INTO project_deploy_targets (project_id, env, runtime, addons_dir, db_name, branch)
       VALUES ($1, $2, 'docker', '/a/addons', 'db1', 'ai-dev')`, [pid, env]
    );
  }
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

const auth = (r) => r.set('Authorization', `Bearer ${token}`);
const on = () => dbModule.query('UPDATE projects SET auto_deploy_enabled = true WHERE id = 1');
const off = () => dbModule.query('UPDATE projects SET auto_deploy_enabled = false WHERE id = 1');

beforeEach(() => runDeploy.mockClear());

// 意圖（Rule 9）：前端把分頁藏起來不是授權，使用者照樣打得到 API。
// 五個端點漏任何一個，關掉總開關就形同虛設。
test('專案開關關閉時所有部署端點都 403', async () => {
  await off();
  const calls = [
    ['get', '/api/projects/1/deploy-targets'],
    ['post', '/api/projects/1/deploy-probe'],
    ['post', '/api/projects/1/deploy-targets'],
    ['patch', '/api/projects/1/deploy-targets/1'],
    ['post', '/api/projects/1/deploy-targets/1/deploy'],
    ['get', '/api/projects/1/deploy-runs'],
  ];
  for (const [m, url] of calls) {
    const res = await auth(request(app)[m](url)).send({ confirm: true, enabled: true });
    expect([m, url, res.status]).toEqual([m, url, 403]);
  }
  await on();
});

// 意圖：中途被關掉就該立刻擋下，這正是「不可快取」的意義。
test('開關在兩次請求之間被關掉，第二次立刻 403', async () => {
  await on();
  expect((await auth(request(app).get('/api/projects/1/deploy-targets'))).status).toBe(200);
  await off();
  expect((await auth(request(app).get('/api/projects/1/deploy-targets'))).status).toBe(403);
  await on();
});

// 意圖：正式區不可逆，失敗只還原檔案、資料庫改動留在原地。
test('正式區部署缺 confirm 時擋下且不執行', async () => {
  const res = await auth(request(app).post('/api/projects/1/deploy-targets/2/deploy')).send({});
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/確認/);
  expect(runDeploy).not.toHaveBeenCalled();
});

test('正式區帶 confirm 才執行', async () => {
  const res = await auth(request(app).post('/api/projects/1/deploy-targets/2/deploy')).send({ confirm: true });
  expect(res.status).toBe(200);
  expect(runDeploy).toHaveBeenCalledTimes(1);
  expect(runDeploy.mock.calls[0][1].trigger).toBe('manual_prod');
});

test('測試區部署不需要 confirm', async () => {
  const res = await auth(request(app).post('/api/projects/1/deploy-targets/1/deploy')).send({});
  expect(res.status).toBe(200);
  expect(runDeploy.mock.calls[0][1].trigger).toBe('manual_retry');
});

// 意圖：此 repo 沒有專案成員表，跨專案隔離要端點自己做。
test('不得部署別的專案的目標（target 3 屬於乙）', async () => {
  const res = await auth(request(app).post('/api/projects/1/deploy-targets/3/deploy')).send({ confirm: true });
  expect(res.status).toBe(404);
  expect(runDeploy).not.toHaveBeenCalled();
});

test('不得改別的專案的目標啟用狀態', async () => {
  const res = await auth(request(app).patch('/api/projects/1/deploy-targets/3')).send({ enabled: true });
  expect(res.status).toBe(404);
  const { rows } = await dbModule.query('SELECT enabled FROM project_deploy_targets WHERE id = 3');
  expect(rows[0].enabled).toBe(false);
});

test('enabled 必須是布林，字串不接受', async () => {
  const res = await auth(request(app).patch('/api/projects/1/deploy-targets/1')).send({ enabled: 'true' });
  expect(res.status).toBe(400);
});

test('啟用與停用都存得進去', async () => {
  await auth(request(app).patch('/api/projects/1/deploy-targets/1')).send({ enabled: true });
  let r = await dbModule.query('SELECT enabled FROM project_deploy_targets WHERE id = 1');
  expect(r.rows[0].enabled).toBe(true);
  await auth(request(app).patch('/api/projects/1/deploy-targets/1')).send({ enabled: false });
  r = await dbModule.query('SELECT enabled FROM project_deploy_targets WHERE id = 1');
  expect(r.rows[0].enabled).toBe(false);
});

test('deploy-runs 只回本專案的紀錄', async () => {
  await dbModule.query("INSERT INTO deploy_runs (target_id, trigger, status) VALUES (1, 'manual_retry', 'success')");
  await dbModule.query("INSERT INTO deploy_runs (target_id, trigger, status) VALUES (3, 'manual_retry', 'success')");
  const res = await auth(request(app).get('/api/projects/1/deploy-runs'));
  expect(res.status).toBe(200);
  expect(res.body.runs.map(r => r.target_id)).toEqual([1]);
});
