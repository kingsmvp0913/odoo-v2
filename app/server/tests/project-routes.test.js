const request = require('supertest');
const { newDb } = require('pg-mem');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { encrypt } = require('../lib/crypto');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ processed: 0 }), resetLoopCounter: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(),
  runDeploy: jest.fn(),
  checkoutDefault: jest.fn(),
  ensureMainBranch: jest.fn(),
  pullBranch: jest.fn(),
  ensureTestingBranch: jest.fn(),
  ensureAiBranch: jest.fn(),
  syncMainIntoAi: jest.fn(),
  abortMerge: jest.fn(),
  releaseAiToMain: jest.fn(),
}));

process.env.JWT_SECRET = 'test-proj';
process.env.APP_SECRET = 'test-proj-appsecret'; // E-2：PATCH 加密 E2E 測試密碼需 APP_SECRET
let app, dbModule, token, gitMock;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
  gitMock = require('../pipeline/git');
  const res = await request(app).post('/api/auth/setup').send({ username: 'user1', password: 'pass1234', display_name: 'User' });
  token = res.body.token;
  const { rows: [u] } = await dbModule.query("SELECT id FROM users WHERE username = 'user1'");
  userId = u.id;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

let projectId, repoId, userId;

test('GET /api/projects → 401 without token', async () => {
  const res = await request(app).get('/api/projects');
  expect(res.status).toBe(401);
});

test('POST /api/projects → 400 missing fields', async () => {
  const res = await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Proj' });
  expect(res.status).toBe(400);
});

test('POST /api/projects → 201 creates', async () => {
  const res = await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'TestProj', odoo_version: '17.0', description: 'A test project' });
  expect(res.status).toBe(201);
  expect(res.body.name).toBe('TestProj');
  projectId = res.body.id;
});

test('GET /api/projects → 200 lists with repo_count', async () => {
  const res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBeGreaterThan(0);
  expect(res.body[0]).toHaveProperty('repo_count');
});

test('GET /api/projects/:id → 200 with repos array', async () => {
  const res = await request(app).get(`/api/projects/${projectId}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.name).toBe('TestProj');
  expect(Array.isArray(res.body.repos)).toBe(true);
});

test('POST /api/projects/:id/repos → 400 missing fields', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/repos`)
    .set('Authorization', `Bearer ${token}`)
    .send({ label: 'main' });
  expect(res.status).toBe(400);
});

test('POST /api/projects/:id/repos → 201 creates primary repo', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/repos`)
    .set('Authorization', `Bearer ${token}`)
    .send({ label: 'main', repo_url: 'https://github.com/test/odoo', local_path: '/opt/odoo', is_primary: true });
  expect(res.status).toBe(201);
  expect(res.body.is_primary).toBe(true);
  repoId = res.body.id;
});

test('POST /api/projects/:id/repos → new primary demotes previous primary', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/repos`)
    .set('Authorization', `Bearer ${token}`)
    .send({ label: 'plugin-hr', repo_url: 'https://github.com/test/hr', is_primary: true });
  expect(res.status).toBe(201);
  const { rows } = await dbModule.query('SELECT is_primary FROM project_repos WHERE id = $1', [repoId]);
  expect(rows[0].is_primary).toBe(false);
});

test('PUT /api/projects/:id → 200 updates description', async () => {
  const res = await request(app).put(`/api/projects/${projectId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ description: 'Updated desc' });
  expect(res.status).toBe(200);
  expect(res.body.description).toBe('Updated desc');
});

test('DELETE repo → 409 正在 clone/更新中', async () => {
  await dbModule.query("UPDATE project_repos SET clone_status='cloning' WHERE id=$1", [repoId]);
  const res = await request(app).delete(`/api/projects/${projectId}/repos/${repoId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(409);
});

test('DELETE repo → 409 測試環境使用中', async () => {
  await dbModule.query("UPDATE project_repos SET clone_status='done' WHERE id=$1", [repoId]);
  await dbModule.query(
    "INSERT INTO odoo_envs (project_id, status) VALUES ($1,'running') ON CONFLICT (project_id) DO UPDATE SET status='running'",
    [projectId]
  );
  const res = await request(app).delete(`/api/projects/${projectId}/repos/${repoId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(409);
});

test('DELETE /api/projects/:id/repos/:repoId → 200 (環境閒置、clone 完成)', async () => {
  await dbModule.query("UPDATE odoo_envs SET status='idle' WHERE project_id=$1", [projectId]);
  await dbModule.query("UPDATE project_repos SET clone_status='done' WHERE id=$1", [repoId]);
  const res = await request(app).delete(`/api/projects/${projectId}/repos/${repoId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
});

test('DELETE /api/projects/:id → 200 and cascades repos & env', async () => {
  await dbModule.query(
    "INSERT INTO odoo_envs (project_id, status) VALUES ($1,'running') ON CONFLICT (project_id) DO UPDATE SET status='running'",
    [projectId]
  );
  const res = await request(app).delete(`/api/projects/${projectId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT * FROM project_repos WHERE project_id = $1', [projectId]);
  expect(rows.length).toBe(0);
  const { rows: envs } = await dbModule.query('SELECT * FROM odoo_envs WHERE project_id = $1', [projectId]);
  expect(envs.length).toBe(0);
});

test('GET /api/projects/:id → 404 after delete', async () => {
  const res = await request(app).get(`/api/projects/${projectId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);
});

test('PATCH mapping → 409 when a source name is already used by another project', async () => {
  const a = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name: 'MapA', odoo_version: '17.0' });
  const b = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name: 'MapB', odoo_version: '17.0' });

  // A 綁定「共用名」（多行）
  const r1 = await request(app).patch(`/api/projects/${a.body.id}`).set('Authorization', `Bearer ${token}`)
    .send({ odoo_project_name: '專案甲\n共用名' });
  expect(r1.status).toBe(200);

  // B 想綁同一個「共用名」→ 應被擋下
  const r2 = await request(app).patch(`/api/projects/${b.body.id}`).set('Authorization', `Bearer ${token}`)
    .send({ odoo_project_name: '共用名' });
  expect(r2.status).toBe(409);
  expect(r2.body.error).toContain('共用名');

  // B 改綁不重複的名稱 → 成功
  const r3 = await request(app).patch(`/api/projects/${b.body.id}`).set('Authorization', `Bearer ${token}`)
    .send({ odoo_project_name: '專案乙' });
  expect(r3.status).toBe(200);
});

test('PATCH e2e_disabled → round-trip 存取，且不影響其他欄位', async () => {
  const p = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name: 'E2eProj', odoo_version: '17.0', description: '保留描述' });
  const pid = p.body.id;
  expect(p.body.e2e_disabled).toBe(true);   // 預設 true（新建專案預設關閉 E2E）

  const on = await request(app).patch(`/api/projects/${pid}`).set('Authorization', `Bearer ${token}`)
    .send({ e2e_disabled: true });
  expect(on.status).toBe(200);
  expect(on.body.e2e_disabled).toBe(true);
  expect(on.body.description).toBe('保留描述');   // 未帶的欄位不動

  const off = await request(app).patch(`/api/projects/${pid}`).set('Authorization', `Bearer ${token}`)
    .send({ e2e_disabled: false });
  expect(off.body.e2e_disabled).toBe(false);

  // 不帶 e2e_disabled 的請求不得覆蓋現值
  await request(app).patch(`/api/projects/${pid}`).set('Authorization', `Bearer ${token}`)
    .send({ e2e_disabled: true });
  const keep = await request(app).patch(`/api/projects/${pid}`).set('Authorization', `Bearer ${token}`)
    .send({ description: '只改描述' });
  expect(keep.body.e2e_disabled).toBe(true);
});

test('GET /api/projects → 含 unread_count', async () => {
  const pRes = await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'UnreadProj', odoo_version: '17.0' });
  const pid = pRes.body.id;

  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'C',$2) RETURNING id",
    [pid, userId]
  );
  await dbModule.query(
    "INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1,'ai','r')",
    [chat.id]
  );
  const res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
  const p = res.body.find(x => x.id === pid);
  expect(p.unread_count).toBe(1);
});

test('POST reclone：發起 user 未設 PAT、repo 已 clone（.git 存在）→ 400', async () => {
  const p = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name: 'RecloneProj', odoo_version: '17.0' });
  const pid = p.body.id;

  const r = await request(app).post(`/api/projects/${pid}/repos`).set('Authorization', `Bearer ${token}`)
    .send({ label: 'main', repo_url: 'https://github.com/test/reclone-target' });
  const rid = r.body.id;

  // 已 clone：local_path 指向一個真的存在、內含 .git 的暫存目錄
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclone-test-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  await dbModule.query(
    "UPDATE project_repos SET local_path=$2, clone_status='done' WHERE id=$1",
    [rid, dir]
  );

  // user1（token 對應的使用者）未設 github_pat_enc
  const res = await request(app).post(`/api/projects/${pid}/repos/${rid}/reclone`)
    .set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/PAT/);
});

// updateMainClone 是背景（fire-and-forget）流程，reclone 端點回應後才在背景跑完；
// 用輪詢 clone_status 取代直接呼叫（該函式未 export，且不宜為測試新增 export）。
async function waitReclone(rid) {
  for (let i = 0; i < 100; i++) {
    const { rows: [r] } = await dbModule.query(
      'SELECT clone_status, clone_error FROM project_repos WHERE id=$1', [rid]
    );
    if (r.clone_status !== 'cloning') return r;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('reclone 逾時未完成（clone_status 卡在 cloning）');
}

// 建一個「已 clone、已設 PAT」可觸發 updateMainClone 更新流程的 repo
async function setupReclonableRepo(name) {
  const p = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name, odoo_version: '17.0' });
  const pid = p.body.id;
  const r = await request(app).post(`/api/projects/${pid}/repos`).set('Authorization', `Bearer ${token}`)
    .send({ label: 'main', repo_url: `https://github.com/test/${name}` });
  const rid = r.body.id;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  await dbModule.query(
    "UPDATE project_repos SET local_path=$2, clone_status='done' WHERE id=$1", [rid, dir]
  );
  await dbModule.query('UPDATE users SET github_pat_enc=$2 WHERE id=$1', [userId, encrypt('test-pat-token')]);
  return { pid, rid, dir };
}

// 意圖：testing 已改以 ai-dev 為基準重建；「更新 repo」若只 pull main 不同步進 ai-dev，
// 使用者 push 進 main 的修正（如補上缺的 module）就傳不到測試環境。
test('POST reclone：pull 完 main 後把新 commit 帶進 ai-dev，testing 才跟得上', async () => {
  gitMock.ensureMainBranch.mockResolvedValue('main');
  gitMock.pullBranch.mockResolvedValue(undefined);
  gitMock.ensureAiBranch.mockResolvedValue(undefined);
  gitMock.syncMainIntoAi.mockResolvedValue({ hasConflicts: false, conflictFiles: [] });

  const { pid, rid } = await setupReclonableRepo('reclone-sync-ok');
  const res = await request(app).post(`/api/projects/${pid}/repos/${rid}/reclone`)
    .set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(200);

  const row = await waitReclone(rid);
  expect(row.clone_status).toBe('done');
  expect(gitMock.ensureAiBranch).toHaveBeenCalled();
  expect(gitMock.syncMainIntoAi).toHaveBeenCalled();
  expect(gitMock.pullBranch.mock.invocationCallOrder[0])
    .toBeLessThan(gitMock.syncMainIntoAi.mock.invocationCallOrder[0]);
});

// 意圖：這裡不綁任何任務，沒有裁決 UI 可用——撞衝突時必須 abort 讓 ai-dev 還原、不留半殘 merge，
// 並 fail loud 落 clone_error；下一張任務的 analysis 會撞到同一衝突，屆時循正常管道掛上去裁決。
test('POST reclone：同步衝突 → abort 還原並落 clone_error，不留半殘 merge', async () => {
  gitMock.ensureMainBranch.mockResolvedValue('main');
  gitMock.pullBranch.mockResolvedValue(undefined);
  gitMock.ensureAiBranch.mockResolvedValue(undefined);
  gitMock.syncMainIntoAi.mockResolvedValue({ hasConflicts: true, conflictFiles: ['a.py'] });
  gitMock.abortMerge.mockResolvedValue(undefined);

  const { pid, rid, dir } = await setupReclonableRepo('reclone-sync-conflict');
  const res = await request(app).post(`/api/projects/${pid}/repos/${rid}/reclone`)
    .set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(200);

  const row = await waitReclone(rid);
  expect(gitMock.abortMerge).toHaveBeenCalledWith(dir);
  expect(row.clone_status).toBe('error');
  expect(row.clone_error).toContain('a.py');
  // I-2：clone_status='error' 之後這個 repo 就從 pipeline 消失（全平台撈 repo 一律 WHERE
  // clone_status='done'），「開一張任務處理」會撈到 0 個 repo＝死路，不得出現在指示裡。
  expect(row.clone_error).not.toContain('開一張任務');
  expect(row.clone_error).toContain('GitHub');
});

// 意圖：埠改為租約制後，建立專案不該再佔用埠——否則專案數一多就把整池吃光，
// 而那些專案的測試區可能根本沒開過。
test('建立專案不配發 port（port 欄位維持 NULL）', async () => {
  const res = await request(app)
    .post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'no-port-proj', odoo_version: '17.0' });
  expect(res.status).toBe(201);
  expect(res.body.port).toBeNull();
});

// ---- 上正式（ai-dev → main）----
// 意圖：合併是不可逆的正式區操作，「標記已上正式」必須只在真的推上去之後發生。
// 任何一個 repo 沒成功就不標記——寧可下次清單多列幾張，也不要標了卻沒上去。

// 直接 INSERT 建 repo，避開 POST /repos 會觸發的背景 clone（會與測試的狀態改寫競態）
async function makeReleaseProject(name, labels = ['main']) {
  const p = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name, odoo_version: '17.0' });
  const pid = p.body.id;
  const dirs = [];
  for (const label of labels) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-${label}-`));
    await dbModule.query(
      `INSERT INTO project_repos (project_id, label, repo_url, local_path, clone_status, is_primary)
       VALUES ($1, $2, $3, $4, 'done', $5)`,
      [pid, label, `https://github.com/test/${name}`, dir, label === labels[0]]
    );
    dirs.push(dir);
  }
  await dbModule.query('UPDATE users SET github_pat_enc=$2 WHERE id=$1', [userId, encrypt('test-pat-token')]);
  return { pid, dirs };
}

let taskSeq = 0;
async function addTask(pid, { approved = true, merged = false } = {}) {
  const taskId = `REL-${++taskSeq}`;
  await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, approved_at, merged_to_main_at)
     VALUES ($1, $2, 'manual', $3, 'done', $4, $5, $6)`,
    [userId, taskId, `任務 ${taskId}`, pid, approved ? new Date() : null, merged ? new Date() : null]
  );
  return taskId;
}

const okRelease = { merged: true, hasConflicts: false, conflictFiles: [], restoreFailed: false };

async function mergedFlags(pid) {
  const { rows } = await dbModule.query(
    'SELECT task_id, merged_to_main_at FROM tasks WHERE project_id = $1 ORDER BY task_id', [pid]
  );
  return rows;
}

test('GET pending-release：只回已核准且尚未上正式的任務', async () => {
  const { pid } = await makeReleaseProject('rel-list');
  const pending = await addTask(pid, { approved: true });
  await addTask(pid, { approved: true, merged: true }); // 已上正式
  await addTask(pid, { approved: false });              // 還沒核准

  const res = await request(app).get(`/api/projects/${pid}/pending-release`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.tasks.map(t => t.task_id)).toEqual([pending]);
});

test('POST release：全部 repo 成功 → 待上正式的任務被標記，已上正式的不動', async () => {
  gitMock.releaseAiToMain.mockReset().mockResolvedValue(okRelease);
  const { pid, dirs } = await makeReleaseProject('rel-ok');
  const pending = await addTask(pid, { approved: true });
  const already = await addTask(pid, { approved: true, merged: true });
  const { rows: [before] } = await dbModule.query(
    'SELECT merged_to_main_at FROM tasks WHERE task_id = $1', [already]
  );

  const res = await request(app).post(`/api/projects/${pid}/release`)
    .set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.tasks.map(t => t.task_id)).toEqual([pending]);
  expect(gitMock.releaseAiToMain).toHaveBeenCalledTimes(1);
  expect(gitMock.releaseAiToMain.mock.calls[0][0]).toBe(dirs[0]);

  const rows = await mergedFlags(pid);
  expect(rows.find(r => r.task_id === pending).merged_to_main_at).not.toBeNull();
  // 已上正式的任務不該被重新蓋掉時間
  expect(new Date(rows.find(r => r.task_id === already).merged_to_main_at).getTime())
    .toBe(new Date(before.merged_to_main_at).getTime());
});

test('POST release：合併衝突 → 不標記，回傳衝突檔案', async () => {
  gitMock.releaseAiToMain.mockReset().mockResolvedValue(
    { merged: false, hasConflicts: true, conflictFiles: ['models/sale_order.py'], restoreFailed: false }
  );
  const { pid } = await makeReleaseProject('rel-conflict');
  await addTask(pid, { approved: true });

  const res = await request(app).post(`/api/projects/${pid}/release`)
    .set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(false);
  expect(res.body.repos[0].conflictFiles).toEqual(['models/sale_order.py']);
  expect(res.body.tasks).toEqual([]);
  expect((await mergedFlags(pid)).every(r => r.merged_to_main_at === null)).toBe(true);
});

test('POST release：多 repo 其中一個失敗 → 一張都不標記', async () => {
  gitMock.releaseAiToMain.mockReset()
    .mockResolvedValueOnce(okRelease)
    .mockRejectedValueOnce(Object.assign(new Error('push rejected'), { stderr: 'protected branch' }));
  const { pid } = await makeReleaseProject('rel-partial', ['main', 'plugin']);
  await addTask(pid, { approved: true });

  const res = await request(app).post(`/api/projects/${pid}/release`)
    .set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(false);
  expect(res.body.repos).toHaveLength(2);
  expect(res.body.repos[1].error).toContain('protected branch');
  expect((await mergedFlags(pid)).every(r => r.merged_to_main_at === null)).toBe(true);
});

test('POST release：未設 PAT → 400 且完全不碰 git', async () => {
  gitMock.releaseAiToMain.mockReset().mockResolvedValue(okRelease);
  const { pid } = await makeReleaseProject('rel-nopat');
  await addTask(pid, { approved: true });
  await dbModule.query('UPDATE users SET github_pat_enc=NULL WHERE id=$1', [userId]);

  const res = await request(app).post(`/api/projects/${pid}/release`)
    .set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('PAT');
  expect(gitMock.releaseAiToMain).not.toHaveBeenCalled();
  expect((await mergedFlags(pid)).every(r => r.merged_to_main_at === null)).toBe(true);

  await dbModule.query('UPDATE users SET github_pat_enc=$2 WHERE id=$1', [userId, encrypt('test-pat-token')]);
});

// 意圖：使用者開著彈窗期間別人 approve 了新任務，那張也會被這次 merge 一起推上 main。
// 若沿用開窗當下的清單標記就會漏掉它，之後永遠顯示「待上正式」。
test('POST release：git 執行期間新核准的任務也一併標記', async () => {
  const { pid } = await makeReleaseProject('rel-race');
  await addTask(pid, { approved: true });
  gitMock.releaseAiToMain.mockReset().mockImplementation(async () => {
    await addTask(pid, { approved: true }); // 合併進行中冒出來的新核准任務
    return okRelease;
  });

  const res = await request(app).post(`/api/projects/${pid}/release`)
    .set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(200);
  expect(res.body.tasks).toHaveLength(2);
  expect((await mergedFlags(pid)).every(r => r.merged_to_main_at !== null)).toBe(true);
});

test('POST release：專案沒有 clone 完成的 repo → 400', async () => {
  gitMock.releaseAiToMain.mockReset().mockResolvedValue(okRelease);
  const p = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name: 'rel-norepo', odoo_version: '17.0' });

  const res = await request(app).post(`/api/projects/${p.body.id}/release`)
    .set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(400);
  expect(gitMock.releaseAiToMain).not.toHaveBeenCalled();
});
