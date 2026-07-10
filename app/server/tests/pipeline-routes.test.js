const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 2 })
}));
jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(),
  runDeploy: jest.fn(),
  mergeToMain: jest.fn().mockResolvedValue(undefined),
  deleteBranchLocal: jest.fn().mockResolvedValue(undefined),
  removeWorktree: jest.fn().mockResolvedValue(undefined),
  concludeMerge: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/rebuild-testing', () => ({
  rebuildTesting: jest.fn().mockResolvedValue(null),
  INFLIGHT_DEPLOYED: ['deploy_testing', 'playwright_running', 'review_pending'],
}));

process.env.JWT_SECRET = 'test-pipeline-secret';

let app, dbModule, adminToken, userId;

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
  adminToken = res.body.token;

  const me = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  userId = me.body.id;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('POST /api/pipeline/run → 401 without token', async () => {
  const res = await request(app).post('/api/pipeline/run');
  expect(res.status).toBe(401);
});

test('POST /api/pipeline/run → calls runPipeline and returns dispatched count', async () => {
  const res = await request(app).post('/api/pipeline/run')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.dispatched).toBe(2);
  const { runPipeline } = require('../pipeline/runner');
  expect(runPipeline).toHaveBeenCalledWith(userId);
});

test('POST /api/tasks/:id/approve → 400 for non-review_pending task', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1, 'task_odoo_approve_test', 'odoo', 'Test', 'analysis_running') RETURNING id",
    [userId]
  );
  const taskId = rows[0].id;

  const res = await request(app).post(`/api/tasks/${taskId}/approve`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(400);

  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('POST /api/tasks/:id/approve → 404 for non-existent task', async () => {
  const res = await request(app).post('/api/tasks/999999/approve')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
});

test('POST /api/tasks/:id/approve → review_pending 併主線、刪分支、轉 wiki_updating', async () => {
  const { mergeToMain, deleteBranchLocal } = require('../pipeline/git');
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('AP','17.0') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/ap/main',true,'done')",
    [proj.id]
  );
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id, git_branch) VALUES ($1,'task_review_ok','odoo','Test','review_pending',$2,'task/task_review_ok') RETURNING id",
    [userId, proj.id]
  );
  const taskId = rows[0].id;

  const res = await request(app).post(`/api/tasks/${taskId}/approve`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(mergeToMain).toHaveBeenCalledWith('/repos/ap/main', 'task/task_review_ok');
  expect(deleteBranchLocal).toHaveBeenCalled();

  const { rows: updated } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(updated[0].status).toBe('wiki_updating');

  await dbModule.query('DELETE FROM task_logs WHERE task_id = $1', [taskId]);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('POST /api/tasks/:id/mark-conflict-resolved → deploy_testing', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_conflict_ok','odoo','T','merge_conflict') RETURNING id",
    [userId]
  );
  const taskId = rows[0].id;
  const res = await request(app).post(`/api/tasks/${taskId}/mark-conflict-resolved`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const { rows: updated } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(updated[0].status).toBe('deploy_testing');
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

// --- 健檢 U6：merge_conflict 人工解完 → 轉 deploy 前必須驗證並了結 merge ---
// 意圖：半套 merge（衝突標記）進部署會變 Python SyntaxError，被誤歸因為程式問題退 coding。

async function insertConflictProjectTask(folder) {
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ($1,'17.0',$1) RETURNING id", [folder]
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u',$2,true,'done')",
    [proj.id, `/repos/${folder}/main`]
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,$2,'odoo','T','merge_conflict',$3) RETURNING id",
    [userId, `task_cf_${folder}`, proj.id]
  );
  return t.id;
}

test('mark-conflict-resolved 專案任務：repo 仍有未解衝突 → 400 且狀態不變', async () => {
  const { concludeMerge } = require('../pipeline/git');
  concludeMerge.mockRejectedValueOnce(new Error('仍有未解的衝突檔：a.py'));
  const taskId = await insertConflictProjectTask('cfdirty');

  const res = await request(app).post(`/api/tasks/${taskId}/mark-conflict-resolved`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(400);
  const { rows: after } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(after[0].status).toBe('merge_conflict'); // 不得放行半套 merge 進部署
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('mark-conflict-resolved 專案任務：驗證通過（concludeMerge 了結）→ deploy_testing', async () => {
  const { concludeMerge } = require('../pipeline/git');
  concludeMerge.mockResolvedValue(undefined);
  const taskId = await insertConflictProjectTask('cfclean');

  const res = await request(app).post(`/api/tasks/${taskId}/mark-conflict-resolved`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(200);
  expect(concludeMerge).toHaveBeenCalledWith('/repos/cfclean/main');
  const { rows: after } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(after[0].status).toBe('deploy_testing');
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

// 意圖：重建來源的衝突（merge_conflict_data.rebuild=true）解完，要還原原狀態、觸發續跑重建，
// 而非走正常 merge_running 的 deploy_testing 出口——兩種衝突來源後續處理不同。
test('mark-conflict-resolved：rebuild 來源 → 還原 prior_status、觸發重建、不進 deploy_testing', async () => {
  const { concludeMerge } = require('../pipeline/git');
  concludeMerge.mockResolvedValue(undefined);
  const rebuildMod = require('../pipeline/rebuild-testing');
  rebuildMod.rebuildTesting.mockClear().mockResolvedValue(null);

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('cfrb','17.0','cfrb') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u',$2,true,'done')",
    [proj.id, '/repos/cfrb/main']
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id, merge_conflict_data) VALUES ($1,'task_cf_rb','odoo','T','merge_conflict',$2,$3) RETURNING id",
    [userId, proj.id, JSON.stringify({ rebuild: true, prior_status: 'review_pending', repos: [{ repo: 'main', files: ['x.py'] }] })]
  );

  const res = await request(app).post(`/api/tasks/${t.id}/mark-conflict-resolved`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(200);
  expect(rebuildMod.rebuildTesting).toHaveBeenCalledWith(proj.id, userId);
  const { rows: after } = await dbModule.query('SELECT status, merge_conflict_data FROM tasks WHERE id=$1', [t.id]);
  expect(after[0].status).toBe('review_pending');  // 還原原關卡，非 deploy_testing
  expect(after[0].merge_conflict_data).toBeNull();
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [t.id]);
});
