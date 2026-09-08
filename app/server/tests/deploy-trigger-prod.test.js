// 意圖：「上正式」按鈕把 ai-dev 推上 main 之後，接著部署到客戶正式區。
// 守的是「部署失敗不可以讓 /release 回錯」——回錯使用者會重按，變成重複 merge。
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 }), resetLoopCounter: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/project-vpn', () => ({ startProjectVpns: jest.fn().mockResolvedValue(''), stopProjectVpns: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/git-identity', () => ({ buildGitEnv: jest.fn().mockResolvedValue({}) }));
jest.mock('../lib/deploy-run', () => ({ runDeploy: jest.fn() }));

// releaseAiToMain 回「有合進去」，其餘 git 函式一律無害
jest.mock('../pipeline/git', () => {
  const real = jest.requireActual('../pipeline/git');
  return { ...real, releaseAiToMain: jest.fn().mockResolvedValue({ merged: true, hasConflicts: false, conflictFiles: [], restoreFailed: false }) };
});

process.env.JWT_SECRET = 'test-prod-trigger';
process.env.APP_SECRET = 'test-app-secret';

const { runDeploy } = require('../lib/deploy-run');
let app, dbModule, token, projectId;

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

  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('PA','17.0','pa') RETURNING id"
  );
  projectId = p.id;
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/pa/main',true,'done')",
    [projectId]
  );
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  runDeploy.mockReset().mockResolvedValue({ ok: true, status: 'success', modules: ['idx_hj'] });
  await dbModule.query('DELETE FROM project_deploy_targets');
  await dbModule.query('DELETE FROM teams_settings');
  await dbModule.query('INSERT INTO teams_settings (id, auto_deploy_enabled) VALUES (1, true)');
  await dbModule.query('DELETE FROM tasks');
  // 一張待上正式的任務：已核准、尚未推 main
  await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, project_id, approved_at)
     VALUES (1,'task_pa_1','odoo','T','c','done',$1,NOW())`, [projectId]
  );
});

const addTarget = (env, enabled) => dbModule.query(
  `INSERT INTO project_deploy_targets (project_id, env, runtime, addons_dir, db_name, branch, enabled)
   VALUES ($1,$2,'docker','/a/addons','db','main',$3)`, [projectId, env, enabled]
);
const release = () => request(app).post(`/api/projects/${projectId}/release`)
  .set('Authorization', `Bearer ${token}`).send({});

test('有啟用的正式區目標時，上正式之後接著部署', async () => {
  await addTarget('prod', true);
  const res = await release();
  expect(res.status).toBe(200);
  expect(runDeploy).toHaveBeenCalledTimes(1);
  expect(runDeploy.mock.calls[0][1].trigger).toBe('manual_prod');
  expect(res.body.deploy[0].ok).toBe(true);
});

// 意圖：關著開關的人會以為程式沒上去，或以為部署過了。兩種誤解都要避免。
test('總開關關閉時回應帶 deploySkipped，且不部署', async () => {
  await dbModule.query('UPDATE teams_settings SET auto_deploy_enabled = false WHERE id = 1');
  await addTarget('prod', true);
  const res = await release();
  expect(res.body.deploySkipped).toBe(true);
  expect(res.body.deploy).toEqual([]);
  expect(runDeploy).not.toHaveBeenCalled();
});

test('沒有啟用的正式區目標時 deploy 是空陣列', async () => {
  await addTarget('prod', false);
  const res = await release();
  expect(res.body.deploy).toEqual([]);
  expect(res.body.deploySkipped).toBe(false);
});

// 意圖：測試區目標由核准那關負責，「上正式」不該碰它。
test('不觸發測試區目標', async () => {
  await addTarget('test', true);
  await release();
  expect(runDeploy).not.toHaveBeenCalled();
});

// 意圖（Rule 9）：碼已經 push 上 main 了。這時候回錯會讓使用者重按，變成重複 merge。
test('部署失敗時 /release 仍回 ok:true，失敗放在 deploy 裡', async () => {
  runDeploy.mockResolvedValue({ ok: false, status: 'rolled_back', error: '健康檢查未通過' });
  await addTarget('prod', true);
  const res = await release();
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.deploy[0].ok).toBe(false);
  expect(res.body.deploy[0].error).toMatch(/健康檢查/);
});

test('部署丟例外也不讓 /release 回 500', async () => {
  runDeploy.mockRejectedValue(new Error('SSH 連不上'));
  await addTarget('prod', true);
  const res = await release();
  expect(res.status).toBe(200);
  expect(res.body.deploy[0].error).toMatch(/SSH/);
});

// 意圖：任務標記與部署是兩件事，部署失敗不該讓「已上正式」的標記消失。
test('部署失敗仍標記 merged_to_main_at', async () => {
  runDeploy.mockResolvedValue({ ok: false, error: 'x' });
  await addTarget('prod', true);
  await release();
  const { rows } = await dbModule.query('SELECT merged_to_main_at FROM tasks WHERE task_id = $1', ['task_pa_1']);
  expect(rows[0].merged_to_main_at).not.toBeNull();
});
