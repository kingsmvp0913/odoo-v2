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
  mergeToAiBranch: jest.fn().mockResolvedValue(undefined),
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
jest.mock('../pipeline/merge-agent', () => ({ clarifyConflict: jest.fn() }));

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
  const { mergeToAiBranch, deleteBranchLocal } = require('../pipeline/git');
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
  expect(mergeToAiBranch).toHaveBeenCalledWith('/repos/ap/main', 'task/task_review_ok',
    expect.objectContaining({ GIT_PAT: 'test-pat-token' }));
  expect(deleteBranchLocal).toHaveBeenCalled();

  const { rows: updated } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(updated[0].status).toBe('wiki_updating');

  await dbModule.query('DELETE FROM task_logs WHERE task_id = $1', [taskId]);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('POST /api/tasks/:id/approve → review_pending 但發起 user 無 PAT → 400，且不呼叫 mergeToAiBranch', async () => {
  const { mergeToAiBranch } = require('../pipeline/git');
  mergeToAiBranch.mockClear();

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
  expect(mergeToAiBranch).not.toHaveBeenCalled();

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

// --- sync 衝突（main → ai-dev 開工前同步，merge_conflict_data.sync=true）的裁決收尾 ---
// 意圖：碼還沒開始寫，sync 衝突解完不能像 task 分支併 testing 那樣進 deploy_testing，要回分析重跑。
describe('sync 衝突的裁決收尾', () => {
  test('resolve-conflicts：sync 衝突全解完 → 回 analysis_running 而非 deploy_testing', async () => {
    const { concludeMerge, applyConflictChoices } = require('../pipeline/git');
    concludeMerge.mockClear().mockResolvedValue(undefined);
    applyConflictChoices.mockClear().mockResolvedValue([]); // 套用後無殘留未解
    const taskId = await insertConflictProjectTask('syncrc');
    await dbModule.query(
      "UPDATE tasks SET merge_conflict_data=$2 WHERE id=$1",
      [taskId, JSON.stringify({ sync: true, prior_status: 'analysis_running', repos: [{ repo: 'main', files: ['a.py'] }] })]
    );

    const res = await request(app).post(`/api/tasks/${taskId}/resolve-conflicts`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolutions: [{ repo: 'main', file: 'a.py', action: 'take_theirs' }] });

    expect(res.status).toBe(200);
    const { rows: after } = await dbModule.query('SELECT status, merge_conflict_data FROM tasks WHERE id=$1', [taskId]);
    expect(after[0].status).toBe('analysis_running'); // 不是 deploy_testing——碼還沒寫呢
    expect(after[0].merge_conflict_data).toBeNull();
    await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
  });

  test('mark-conflict-resolved：sync 衝突 → 回 analysis_running', async () => {
    const { rows: [t] } = await dbModule.query(
      "INSERT INTO tasks (user_id, task_id, source, title, status, merge_conflict_data) VALUES ($1,'task_sync_mc','odoo','T','merge_conflict',$2) RETURNING id",
      [userId, JSON.stringify({ sync: true, prior_status: 'analysis_running', repos: [{ repo: 'r1', files: ['a.py'] }] })]
    );

    const res = await request(app).post(`/api/tasks/${t.id}/mark-conflict-resolved`)
      .set('Authorization', `Bearer ${adminToken}`).send({});

    expect(res.status).toBe(200);
    const { rows: after } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t.id]);
    expect(after[0].status).toBe('analysis_running');
    await dbModule.query('DELETE FROM tasks WHERE id = $1', [t.id]);
  });

  test('普通 merge 衝突（無 sync 旗標）→ 仍走 deploy_testing（回歸）', async () => {
    const { concludeMerge, applyConflictChoices } = require('../pipeline/git');
    concludeMerge.mockClear().mockResolvedValue(undefined);
    applyConflictChoices.mockClear().mockResolvedValue([]);
    const taskId = await insertConflictProjectTask('syncreg');
    await dbModule.query(
      "UPDATE tasks SET merge_conflict_data=$2 WHERE id=$1",
      [taskId, JSON.stringify({ repos: [{ repo: 'main', files: ['a.py'] }] })]
    );

    await request(app).post(`/api/tasks/${taskId}/resolve-conflicts`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolutions: [{ repo: 'main', file: 'a.py', action: 'take_theirs' }] });

    const { rows: after } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
    expect(after[0].status).toBe('deploy_testing');
    await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
  });
});

// --- 逐檔追問釐清 merge-clarify（給非工程師）---
// 意圖：追問問答落進 merge_conflict_data.details[file].qa；AI 回 keep 時不動既有建議、狀態維持 merge_conflict。
test('merge-clarify：AI 回 keep → 問答入 qa、不改建議、不推進 pipeline', async () => {
  const { clarifyConflict } = require('../pipeline/merge-agent');
  const { runPipeline } = require('../pipeline/runner');
  clarifyConflict.mockClear().mockResolvedValue({ answer: '就是兩邊都新增了同一個檔', recommendation: 'keep', rationale: '' });
  runPipeline.mockClear();
  const taskId = await insertConflictProjectTask('mckeep');
  await dbModule.query("UPDATE tasks SET merge_conflict_data=$2 WHERE id=$1", [taskId,
    JSON.stringify({ repos: [{ repo: 'main', files: ['a.py'], details: { 'a.py': { recommendation: 'manual', rationale: 'x', qa: [] } } }] })]);

  const res = await request(app).post(`/api/tasks/${taskId}/merge-clarify`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ repo: 'main', file: 'a.py', question: '這是什麼意思？' });

  expect(res.status).toBe(200);
  expect(res.body.changed).toBe(false);
  expect(res.body.recommendation).toBe('manual');
  // clarifyConflict 收到 repo 路徑＋本檔問答歷史
  expect(clarifyConflict).toHaveBeenCalledWith('/repos/mckeep/main', 'a.py',
    expect.objectContaining({ question: '這是什麼意思？' }), null, expect.objectContaining({ taskId }));
  expect(runPipeline).not.toHaveBeenCalled(); // 追問不推進 pipeline
  const { rows: after } = await dbModule.query('SELECT status, merge_conflict_data FROM tasks WHERE id=$1', [taskId]);
  expect(after[0].status).toBe('merge_conflict');
  const cd = typeof after[0].merge_conflict_data === 'string' ? JSON.parse(after[0].merge_conflict_data) : after[0].merge_conflict_data;
  expect(cd.repos[0].details['a.py'].qa).toEqual([{ q: '這是什麼意思？', a: '就是兩邊都新增了同一個檔' }]);
  expect(cd.repos[0].details['a.py'].recommendation).toBe('manual'); // keep：建議不動
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

// 意圖：AI 判斷有更適合選項時回非 keep → 同步更新 details[file].recommendation/rationale，回 changed=true。
test('merge-clarify：AI 回非 keep → 更新建議、changed=true', async () => {
  const { clarifyConflict } = require('../pipeline/merge-agent');
  clarifyConflict.mockClear().mockResolvedValue({ answer: '新版是舊版超集，選取新版不會失去東西', recommendation: 'take_theirs', rationale: '新版超集' });
  const taskId = await insertConflictProjectTask('mcchg');
  await dbModule.query("UPDATE tasks SET merge_conflict_data=$2 WHERE id=$1", [taskId,
    JSON.stringify({ repos: [{ repo: 'main', files: ['a.py'], details: { 'a.py': { recommendation: 'manual', rationale: 'x', qa: [] } } }] })]);

  const res = await request(app).post(`/api/tasks/${taskId}/merge-clarify`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ repo: 'main', file: 'a.py', question: '我選取新版會失去什麼？' });

  expect(res.status).toBe(200);
  expect(res.body.changed).toBe(true);
  expect(res.body.recommendation).toBe('take_theirs');
  const { rows: after } = await dbModule.query('SELECT merge_conflict_data FROM tasks WHERE id=$1', [taskId]);
  const cd = typeof after[0].merge_conflict_data === 'string' ? JSON.parse(after[0].merge_conflict_data) : after[0].merge_conflict_data;
  expect(cd.repos[0].details['a.py'].recommendation).toBe('take_theirs');
  expect(cd.repos[0].details['a.py'].rationale).toBe('新版超集');
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('merge-clarify：非 merge_conflict 狀態 → 400', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_mc_wrong','odoo','T','deploy_testing') RETURNING id", [userId]);
  const res = await request(app).post(`/api/tasks/${rows[0].id}/merge-clarify`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ repo: 'main', file: 'a.py', question: '?' });
  expect(res.status).toBe(400);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [rows[0].id]);
});

test('merge-clarify：空 question → 400', async () => {
  const taskId = await insertConflictProjectTask('mcempty');
  await dbModule.query("UPDATE tasks SET merge_conflict_data=$2 WHERE id=$1", [taskId,
    JSON.stringify({ repos: [{ repo: 'main', files: ['a.py'], details: { 'a.py': { qa: [] } } }] })]);
  const res = await request(app).post(`/api/tasks/${taskId}/merge-clarify`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ repo: 'main', file: 'a.py', question: '   ' });
  expect(res.status).toBe(400);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

// --- code-zip：過渡期管理員下載改動模組的 zip，自行解壓到正式區 ---

test('code-zip → 403 非管理員', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('plainuser','x','U','user') RETURNING id"
  );
  const token = jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const res = await request(app).get('/api/tasks/1/code-zip')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(403);
});

test('code-zip → 400 任務尚無分支', async () => {
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_cto_bad','odoo','T','coding_running') RETURNING id",
    [userId]
  );
  const res = await request(app).get(`/api/tasks/${rows[0].id}/code-zip`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(400);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [rows[0].id]);
});

test('code-zip → 不限審核狀態，回傳含 <repo>/<模組> 結構的 zip，非模組檔列在 skipped header', async () => {
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

  const res = await request(app).get(`/api/tasks/${t.id}/code-zip`)
    .set('Authorization', `Bearer ${adminToken}`)
    .buffer(true).parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });

  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('application/zip');
  expect(res.headers['content-disposition']).toContain(`${taskKey}.zip`);
  // 依 repo（git URL 末段 odoo17_hungjou）分層：<repo>/<module>
  expect(JSON.parse(decodeURIComponent(res.headers['x-zip-entries']))).toEqual(['odoo17_hungjou/idx_demo']);
  expect(JSON.parse(decodeURIComponent(res.headers['x-zip-skipped']))).toContain('README.md');

  // 內容真的解得開才算數：只驗 header 的話，回傳半截 zip 也會綠燈。
  // 不引入解壓相依——ZIP 的 local file header 前綴為 PK\x03\x04，檔名以明文存放，直接掃即可。
  const buf = res.body;
  expect(buf.slice(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const asText = buf.toString('latin1');
  expect(asText).toContain('odoo17_hungjou/idx_demo/__manifest__.py');
  expect(asText).toContain('odoo17_hungjou/idx_demo/models/sale_order.py');
  expect(asText).not.toContain('README.md');

  fs.rmSync(tmp, { recursive: true, force: true });
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [t.id]);
});

// 意圖：沒有任何模組改動時必須在「開始輸出前」擋下並回 JSON。header 一旦送出就改不回錯誤，
// 使用者只會拿到一個 0 模組的空 zip，還以為佈署包好了。
test('code-zip → 沒有模組改動時回 400，不得送出空 zip', async () => {
  const { diffNameOnly, refExists } = require('../pipeline/git');
  refExists.mockResolvedValue(true);
  diffNameOnly.mockResolvedValue(['README.md']); // 有改動，但不屬任何模組

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cto2-'));
  const localPath = path.join(tmp, 'repos', 'main');
  fs.mkdirSync(localPath, { recursive: true });

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('CTO2','17.0') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main',$2,$3,true,'done')",
    [proj.id, 'https://github.com/Ideaxpress-odoo/odoo17_hungjou.git', localPath]
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id, git_branch) VALUES ($1,'task_cto_empty','odoo','T','coding_running',$2,'task/task_cto_empty') RETURNING id",
    [userId, proj.id]
  );

  const res = await request(app).get(`/api/tasks/${t.id}/code-zip`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('沒有可打包的模組');
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

test('POST /api/tasks/:id/spec-revise → 寫 task_logs(user) 並轉 respec_running（不寫 task_messages）', async () => {
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_spec_revise','odoo','T','spec_review') RETURNING id",
    [userId]
  );
  const taskId = t.id;
  const res = await request(app).post(`/api/tasks/${taskId}/spec-revise`)
    .set('Authorization', `Bearer ${adminToken}`).send({ feedback: '為什麼備註欄設計成唯讀？' });
  expect(res.status).toBe(200);
  const { rows: [after] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(after.status).toBe('respec_running');
  const { rows: logs } = await dbModule.query(
    "SELECT role, content FROM task_logs WHERE task_id=$1", [taskId]
  );
  expect(logs.some(l => l.role === 'user' && l.content.includes('為什麼備註欄設計成唯讀'))).toBe(true);
  const { rows: msgs } = await dbModule.query('SELECT id FROM task_messages WHERE task_id=$1', [taskId]);
  expect(msgs.length).toBe(0);   // 提問走 task_logs，不再落 task_messages
  await dbModule.query('DELETE FROM task_logs WHERE task_id = $1', [taskId]);
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

test('POST /api/tasks/:id/cs-followup → 寫 task_logs(user) 並轉 cs_running', async () => {
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_cs_followup','service','T','cs_reply_pending') RETURNING id",
    [userId]
  );
  const taskId = t.id;
  const res = await request(app).post(`/api/tasks/${taskId}/cs-followup`)
    .set('Authorization', `Bearer ${adminToken}`).send({ note: '客戶用的是 17.0，回覆請提到' });
  expect(res.status).toBe(200);
  const { rows: [after] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(after.status).toBe('cs_running');
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [taskId]);
  expect(logs.some(l => l.role === 'user' && l.content.includes('17.0'))).toBe(true);
  await dbModule.query('DELETE FROM task_logs WHERE task_id=$1', [taskId]);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('POST /api/tasks/:id/cs-followup → 非 cs_reply_pending → 400、狀態不變', async () => {
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_cs_followup_bad','service','T','done') RETURNING id",
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/cs-followup`)
    .set('Authorization', `Bearer ${adminToken}`).send({ note: 'x' });
  expect(res.status).toBe(400);
  const { rows: [after] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('done');
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [t.id]);
});

test('POST /api/tasks/:id/cs-followup → 空 note → 400', async () => {
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'task_cs_followup_empty','service','T','cs_reply_pending') RETURNING id",
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/cs-followup`)
    .set('Authorization', `Bearer ${adminToken}`).send({ note: '   ' });
  expect(res.status).toBe(400);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [t.id]);
});
