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
