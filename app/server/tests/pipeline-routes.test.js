const request = require('supertest');
const { newDb } = require('pg-mem');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.APP_SECRET = 'test-pipeline-appsecret';
const { encrypt } = require('../lib/crypto');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 2 })
}));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(),
  runDeploy: jest.fn(),
  mergeToMain: jest.fn().mockResolvedValue(undefined),
  deleteBranchLocal: jest.fn().mockResolvedValue(undefined),
  removeWorktree: jest.fn().mockResolvedValue(undefined),
  concludeMerge: jest.fn().mockResolvedValue(undefined),
  applyConflictChoices: jest.fn().mockResolvedValue([]),
  getMainBranch: jest.fn().mockResolvedValue('main'),
  diffNameOnly: jest.fn().mockResolvedValue([]),
  refExists: jest.fn().mockResolvedValue(true)
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

  // approve 併主線會解發起 user 的 gitEnv（Task 9）；種一組 PAT 讓既有 approve 測試維持過關
  await dbModule.query('UPDATE users SET github_pat_enc = $2 WHERE id = $1', [userId, encrypt('test-pat-token')]);
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
  expect(mergeToMain).toHaveBeenCalledWith('/repos/ap/main', 'task/task_review_ok',
    expect.objectContaining({ GIT_PAT: 'test-pat-token' }));
  expect(deleteBranchLocal).toHaveBeenCalled();

  const { rows: updated } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(updated[0].status).toBe('wiki_updating');

  await dbModule.query('DELETE FROM task_logs WHERE task_id = $1', [taskId]);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('POST /api/tasks/:id/approve → review_pending 但發起 user 無 PAT → 400，且不呼叫 mergeToMain', async () => {
  const { mergeToMain } = require('../pipeline/git');
  mergeToMain.mockClear();

  const { rows: [nopatUser] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('nopat', 'x', 'NoPAT') RETURNING id"
  );
  const nopatToken = jwt.sign({ userId: nopatUser.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('NoPatProj','17.0') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/nopat/main',true,'done')",
    [proj.id]
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id, git_branch) VALUES ($1,'task_nopat','odoo','Test','review_pending',$2,'task/task_nopat') RETURNING id",
    [nopatUser.id, proj.id]
  );

  const res = await request(app).post(`/api/tasks/${t.id}/approve`)
    .set('Authorization', `Bearer ${nopatToken}`);

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/PAT/);
  expect(mergeToMain).not.toHaveBeenCalled();

  await dbModule.query('DELETE FROM tasks WHERE id = $1', [t.id]);
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

// --- 塊 C：逐檔裁決衝突 resolve-conflicts ---
// 意圖：使用者對每個衝突檔選「取新版/取舊版/手解」，全部收斂 → commit 了結 → deploy_testing。
test('resolve-conflicts：全部取一側、無殘留 → concludeMerge → deploy_testing（done）', async () => {
  const { concludeMerge, applyConflictChoices } = require('../pipeline/git');
  concludeMerge.mockClear().mockResolvedValue(undefined);
  applyConflictChoices.mockClear().mockResolvedValue([]); // 套用後無殘留未解
  const taskId = await insertConflictProjectTask('rcclean');
  await dbModule.query(
    "UPDATE tasks SET merge_conflict_data=$2 WHERE id=$1",
    [taskId, JSON.stringify({ repos: [{ repo: 'main', files: ['a.py'], details: { 'a.py': { recommendation: 'take_theirs' } } }] })]
  );

  const res = await request(app).post(`/api/tasks/${taskId}/resolve-conflicts`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ resolutions: [{ repo: 'main', file: 'a.py', action: 'take_theirs' }] });

  expect(res.status).toBe(200);
  expect(res.body.done).toBe(true);
  expect(applyConflictChoices).toHaveBeenCalledWith('/repos/rcclean/main', expect.any(Map));
  expect(concludeMerge).toHaveBeenCalledWith('/repos/rcclean/main');
  const { rows: after } = await dbModule.query('SELECT status, merge_conflict_data FROM tasks WHERE id=$1', [taskId]);
  expect(after[0].status).toBe('deploy_testing');
  expect(after[0].merge_conflict_data).toBeNull();
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

// 意圖：有檔選「手解」→ 套用後仍未解 → 留 merge_conflict，且 merge_conflict_data 只留未解檔（已解卡片消失）。
test('resolve-conflicts：含 manual → 仍 merge_conflict、資料只留未解檔（not done）', async () => {
  const { concludeMerge, applyConflictChoices } = require('../pipeline/git');
  concludeMerge.mockClear();
  applyConflictChoices.mockClear().mockResolvedValue(['b.py']); // b.py 選 manual，仍未解
  const taskId = await insertConflictProjectTask('rcmanual');
  await dbModule.query(
    "UPDATE tasks SET merge_conflict_data=$2 WHERE id=$1",
    [taskId, JSON.stringify({ repos: [{ repo: 'main', files: ['a.py', 'b.py'] }] })]
  );

  const res = await request(app).post(`/api/tasks/${taskId}/resolve-conflicts`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ resolutions: [
      { repo: 'main', file: 'a.py', action: 'take_theirs' },
      { repo: 'main', file: 'b.py', action: 'manual' }
    ] });

  expect(res.status).toBe(200);
  expect(res.body.done).toBe(false);
  expect(concludeMerge).not.toHaveBeenCalled(); // 有未解不得了結
  const { rows: after } = await dbModule.query('SELECT status, merge_conflict_data FROM tasks WHERE id=$1', [taskId]);
  expect(after[0].status).toBe('merge_conflict');
  const cd = typeof after[0].merge_conflict_data === 'string' ? JSON.parse(after[0].merge_conflict_data) : after[0].merge_conflict_data;
  expect(cd.repos[0].files).toEqual(['b.py']);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('resolve-conflicts：非 merge_conflict 狀態 → 400', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_rc_wrong','odoo','T','deploy_testing') RETURNING id",
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${rows[0].id}/resolve-conflicts`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ resolutions: [{ repo: 'main', file: 'a.py', action: 'take_theirs' }] });
  expect(res.status).toBe(400);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [rows[0].id]);
});

test('resolve-conflicts：不合法 action → 400', async () => {
  const taskId = await insertConflictProjectTask('rcbad');
  const res = await request(app).post(`/api/tasks/${taskId}/resolve-conflicts`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ resolutions: [{ repo: 'main', file: 'a.py', action: 'nonsense' }] });
  expect(res.status).toBe(400);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

// --- copy-to-online：過渡期管理員手動把模組整包搬到正式區 ---

test('copy-to-online → 403 非管理員', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('plainuser','x','U','user') RETURNING id"
  );
  const token = jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const res = await request(app).post('/api/tasks/1/copy-to-online')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(403);
});

test('copy-to-online → 400 任務尚無分支', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_cto_bad','odoo','T','coding_running') RETURNING id",
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${rows[0].id}/copy-to-online`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(400);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [rows[0].id]);
});

test('copy-to-online → 不限審核狀態，整包複製改動模組到 ONLINE_ADDONS_DIR，非模組檔列 skipped', async () => {
  const { getMainBranch, diffNameOnly, refExists } = require('../pipeline/git');
  refExists.mockResolvedValue(true);
  getMainBranch.mockResolvedValue('main');
  diffNameOnly.mockResolvedValue(['idx_demo/models/sale_order.py', 'README.md']);

  // 真實臨時 worktree：<tmpRepoParent>/.worktrees/<task_id>/main/idx_demo/{__manifest__.py,models/..}
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cto-'));
  const localPath = path.join(tmp, 'repos', 'main');
  fs.mkdirSync(localPath, { recursive: true });
  const taskKey = 'task_cto_ok';
  const wtRepo = path.join(tmp, 'repos', '.worktrees', taskKey, 'main');
  const modelsDir = path.join(wtRepo, 'idx_demo', 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.writeFileSync(path.join(wtRepo, 'idx_demo', '__manifest__.py'), "{'name':'demo'}");
  fs.writeFileSync(path.join(modelsDir, 'sale_order.py'), '# hi');

  const dest = path.join(tmp, 'online_addons');
  process.env.ONLINE_ADDONS_DIR = dest;

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('CTO','17.0') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main',$2,$3,true,'done')",
    [proj.id, 'https://github.com/Ideaxpress-odoo/odoo17_hungjou.git', localPath]
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id, git_branch) VALUES ($1,$2,'odoo','T','coding_running',$3,$4) RETURNING id",
    [userId, taskKey, proj.id, `task/${taskKey}`]
  );

  const res = await request(app).post(`/api/tasks/${t.id}/copy-to-online`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(200);
  // 依 repo（git URL 末段 odoo17_hungjou）放：<base>/odoo17_hungjou/<module>
  expect(res.body.copied).toEqual(['odoo17_hungjou/idx_demo']);
  expect(res.body.skipped).toContain('README.md');
  expect(fs.existsSync(path.join(dest, 'odoo17_hungjou', 'idx_demo', '__manifest__.py'))).toBe(true);
  expect(fs.existsSync(path.join(dest, 'odoo17_hungjou', 'idx_demo', 'models', 'sale_order.py'))).toBe(true);

  delete process.env.ONLINE_ADDONS_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [t.id]);
});

// --- MODE_B 規格審核閘門：spec-approve（確認開工）／spec-revise（寫意見改規格）---

test('POST /api/tasks/:id/spec-approve → spec_review 轉 branch_pending 並跑 pipeline', async () => {
  const { runPipeline } = require('../pipeline/runner');
  runPipeline.mockClear();
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_spec_ok','odoo','T','spec_review') RETURNING id",
    [userId]
  );
  const taskId = rows[0].id;

  const res = await request(app).post(`/api/tasks/${taskId}/spec-approve`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(200);
  const { rows: after } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(after[0].status).toBe('branch_pending');
  expect(runPipeline).toHaveBeenCalledWith(userId);

  await dbModule.query('DELETE FROM task_logs WHERE task_id = $1', [taskId]);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('POST /api/tasks/:id/spec-approve → 非 spec_review 狀態 → 400、狀態不變', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_spec_badstate','odoo','T','coding_running') RETURNING id",
    [userId]
  );
  const taskId = rows[0].id;

  const res = await request(app).post(`/api/tasks/${taskId}/spec-approve`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(400);
  const { rows: after } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(after[0].status).toBe('coding_running');

  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('POST /api/tasks/:id/spec-revise → 寫 manual 留言(applied_at NULL) 並轉 respec_running', async () => {
  const { runPipeline } = require('../pipeline/runner');
  runPipeline.mockClear();
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_spec_revise','odoo','T','spec_review') RETURNING id",
    [userId]
  );
  const taskId = rows[0].id;

  const res = await request(app).post(`/api/tasks/${taskId}/spec-revise`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ feedback: '請把備註欄位改成多行文字' });

  expect(res.status).toBe(200);
  const { rows: after } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(after[0].status).toBe('respec_running');
  const { rows: msgs } = await dbModule.query(
    "SELECT content, source, applied_at FROM task_messages WHERE task_id = $1", [taskId]
  );
  expect(msgs.length).toBe(1);
  expect(msgs[0].content).toContain('多行文字');
  expect(msgs[0].source).toBe('manual');
  expect(msgs[0].applied_at).toBeNull(); // 待 respec 吸收
  expect(runPipeline).toHaveBeenCalledWith(userId);

  await dbModule.query('DELETE FROM task_messages WHERE task_id = $1', [taskId]);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('POST /api/tasks/:id/spec-revise → 空 feedback → 400', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_spec_revise_empty','odoo','T','spec_review') RETURNING id",
    [userId]
  );
  const taskId = rows[0].id;

  const res = await request(app).post(`/api/tasks/${taskId}/spec-revise`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ feedback: '   ' });

  expect(res.status).toBe(400);
  const { rows: after } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(after[0].status).toBe('spec_review'); // 狀態不變

  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('POST /api/tasks/:id/spec-revise → 非 spec_review 狀態 → 400', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_spec_revise_badstate','odoo','T','coding_running') RETURNING id",
    [userId]
  );
  const taskId = rows[0].id;

  const res = await request(app).post(`/api/tasks/${taskId}/spec-revise`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ feedback: '改一下' });

  expect(res.status).toBe(400);

  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});
