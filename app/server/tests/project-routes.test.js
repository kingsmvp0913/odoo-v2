const request = require('supertest');
const { newDb } = require('pg-mem');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { encrypt } = require('../lib/crypto');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
// 本檔不碰實機 docker：PUT /api/projects/:id/vpn 會 stop+rm `vpn-proj-<id>`、刪專案會 stop+rm
// odoo 容器。pg-mem 給的專案 id 從 1 開始，跟開發機上真的容器名撞得剛剛好（實測 `vpn-proj-1`
// 真的被 docker rm -f 掉），而這些函式對「容器不存在」都是靜默的，砍錯完全沒有訊號。
jest.mock('../lib/vpn-gateway', () => {
  const actual = jest.requireActual('../lib/vpn-gateway');
  return {
    ...actual,
    ensureGatewayRunning: jest.fn().mockResolvedValue(undefined),
    stopGateway: jest.fn().mockResolvedValue(undefined),
    removeGateway: jest.fn().mockResolvedValue(undefined),
  };
});
jest.mock('../lib/docker-env', () => {
  const actual = jest.requireActual('../lib/docker-env');
  return {
    ...actual,
    stopContainer: jest.fn().mockResolvedValue({ code: 0 }),
    removeContainer: jest.fn().mockResolvedValue(undefined),
    containerExists: jest.fn().mockResolvedValue(false),
    containerRunning: jest.fn().mockResolvedValue(false),
  };
});
jest.mock('../lib/project-vpn', () => ({
  startProjectVpns: jest.fn().mockResolvedValue(''),
  stopProjectVpns: jest.fn().mockResolvedValue(undefined),
}));
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
  // rebuild-testing 刻意不 mock：更新 repo 的最後一步（testing 重長到 ai-dev）就在它裡面，
  // 連它一起 mock 掉會讓「有沒有真的重建」測不到。它實際會呼叫的 git 函式在這裡補上。
  revParse: jest.fn().mockResolvedValue('sha-backup'),
  resetTestingToAiBranch: jest.fn().mockResolvedValue(undefined),
  resetTestingTo: jest.fn().mockResolvedValue(undefined),
  mergeInto: jest.fn().mockResolvedValue({ hasConflicts: false, conflictFiles: [] }),
  commitAll: jest.fn().mockResolvedValue(undefined),
  getMainBranch: jest.fn().mockResolvedValue('main'),
  listRemoteBranches: jest.fn().mockResolvedValue(['main', 'develop', 'ai-dev']),
  setRemoteHead: jest.fn().mockResolvedValue(undefined),
  // ai-dev 基底扶正（reconcileAiBranch）用的一組。預設 refExists=false＝遠端還沒有 ai-dev，
  // 扶正因此直接跳過，既有案例維持原本流程不被干擾；扶正本身另有專屬案例覆蓋。
  AI_BRANCH: 'ai-dev',
  // 撞名守衛用；給真實行為而非 jest.fn()，否則那道守衛在測試裡形同不存在
  remoteAiBranchName: (b) => (b ? `ai-dev-${String(b).replace(/\//g, '-')}` : 'ai-dev'),
  remoteAiRef: jest.fn().mockResolvedValue('ai-dev'),
  refExists: jest.fn().mockResolvedValue(false),
  aiBranchBase: jest.fn().mockResolvedValue(null),
  aiOwnCommits: jest.fn().mockResolvedValue(0),
  rebuildAiBranch: jest.fn().mockResolvedValue({ oldSha: 'oldsha1', newSha: 'newsha1' }),
  listRemoteBranchesByUrl: jest.fn().mockResolvedValue({ branches: ['main', 'kangyue'], defaultBranch: 'kangyue' }),
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

// #5 我的最愛：per-user 收藏，供專案列表置頂。驗 intent——收藏狀態要能反映在 is_favorite，
// 且只反映「自己的」收藏（別人收藏同一專案不得讓我的 is_favorite 變 true）。
describe('我的最愛（per-user）', () => {
  const findP = (body) => body.find(p => p.id === projectId);

  test('預設 is_favorite=false；POST 收藏 → true；DELETE 取消 → false', async () => {
    let res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(findP(res.body).is_favorite).toBe(false);

    const post = await request(app).post(`/api/projects/${projectId}/favorite`).set('Authorization', `Bearer ${token}`).send({});
    expect(post.status).toBe(200);
    res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(findP(res.body).is_favorite).toBe(true);

    const del = await request(app).delete(`/api/projects/${projectId}/favorite`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
    res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(findP(res.body).is_favorite).toBe(false);
  });

  test('別人收藏同一專案，不會讓我的 is_favorite 變 true（per-user 隔離）', async () => {
    await dbModule.query(
      "INSERT INTO users (username, password_hash, display_name) VALUES ('other-fav', 'x', 'Other')"
    );
    const { rows: [o] } = await dbModule.query("SELECT id FROM users WHERE username='other-fav'");
    await dbModule.query('INSERT INTO project_favorites (user_id, project_id) VALUES ($1, $2)', [o.id, projectId]);
    const res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(findP(res.body).is_favorite).toBe(false);
  });

  test('重複 POST 收藏 idempotent（ON CONFLICT DO NOTHING，不 500）', async () => {
    await request(app).post(`/api/projects/${projectId}/favorite`).set('Authorization', `Bearer ${token}`).send({});
    const again = await request(app).post(`/api/projects/${projectId}/favorite`).set('Authorization', `Bearer ${token}`).send({});
    expect(again.status).toBe(200);
    await request(app).delete(`/api/projects/${projectId}/favorite`).set('Authorization', `Bearer ${token}`); // 還原
  });
});

test('GET /api/projects/:id → 200 with repos array', async () => {
  const res = await request(app).get(`/api/projects/${projectId}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.name).toBe('TestProj');
  expect(Array.isArray(res.body.repos)).toBe(true);
});

// Finding 1（Task 8 opus review）：projects 存了 vpn_config_enc／vpn_password_enc（VPN 憑證密文）之後，
// 這兩條泛用列表／單筆路由若沿用 SELECT *，會把密文一起吐給任何已登入使用者——VPN 狀態應只走
// 專屬的 GET /api/projects/:id/vpn（見 db-query-routes.js），這裡完全不該出現這兩個欄位。
describe('projects 路由不外洩 VPN 憑證密文', () => {
  test('先在專案設定 VPN，再驗證 GET /api/projects 與 GET /api/projects/:id 都不含密文欄位', async () => {
    const put = await request(app).put(`/api/projects/${projectId}/vpn`).set('Authorization', `Bearer ${token}`)
      .send({ vpn_config: 'client\ndev tun', vpn_username: 'aicd5', vpn_password: 'Aicd5' });
    expect(put.status).toBe(200);

    const list = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const proj = list.body.find(p => p.id === projectId);
    expect(proj).toBeDefined();
    expect(proj.vpn_config_enc).toBeUndefined();
    expect(proj.vpn_password_enc).toBeUndefined();

    const single = await request(app).get(`/api/projects/${projectId}`).set('Authorization', `Bearer ${token}`);
    expect(single.status).toBe(200);
    expect(single.body.vpn_config_enc).toBeUndefined();
    expect(single.body.vpn_password_enc).toBeUndefined();
  });
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

// 意圖：任務工作樹住在主 clone 的 sibling（`.worktrees/<task_id>/<repo 目錄名>`），只刪 local_path
// 會把它們留在磁碟上。同一個 repo 之後再加回來時，殘骸的 `.git` 指向已消失的 admin 目錄，pipeline
// 會誤判成可用工作樹而讓任務永遠停住（正式站 task_service_3900 的來源）。別的 repo 的工作樹是
// 同一層的鄰居，必須原封不動——所以測試放兩個目錄，只有一個該消失。
test('DELETE repo → 連自己的任務工作樹一起清掉，但不動別的 repo 的', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-del-'));
  const localPath = path.join(root, 'kangyue');
  const mine = path.join(root, '.worktrees', 'task_1', 'kangyue');
  const neighbour = path.join(root, '.worktrees', 'task_1', 'other');
  for (const d of [localPath, mine, neighbour]) fs.mkdirSync(d, { recursive: true });

  await dbModule.query("UPDATE odoo_envs SET status='idle' WHERE project_id=$1", [projectId]);
  // 自建 repo 列：上面那支 DELETE 測試已經把共用的 repoId 刪掉了
  const { rows: [own] } = await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, clone_status) VALUES ($1,'kangyue','https://example.com/r.git',$2,'done') RETURNING id",
    [projectId, localPath]
  );
  const res = await request(app).delete(`/api/projects/${projectId}/repos/${own.id}`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(fs.existsSync(mine)).toBe(false);
  expect(fs.existsSync(neighbour)).toBe(true);
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

// 意圖：更新 repo 的最後一步是把 testing 重長到最新 ai-dev——那是測試環境 addons 的實際來源分支。
// 上一支測試叫「testing 才跟得上」，但只驗到 syncMainIntoAi，重建那半邊完全沒被覆蓋；
// 實測鴻久 testing 停在四天前、落後 ai-dev 16 個檔，而全程零錯誤訊息（doRebuild 撈不到 repo 時
// 回 null＝乾淨完成，updateMainClone 那道刻意設計的 fail-loud console.warn 因此不會觸發）。
test('POST reclone：更新完成後 testing 真的被重長到 ai-dev（不是只 pull 完就算）', async () => {
  gitMock.ensureMainBranch.mockResolvedValue('main');
  gitMock.pullBranch.mockResolvedValue(undefined);
  gitMock.ensureAiBranch.mockResolvedValue(undefined);
  gitMock.syncMainIntoAi.mockResolvedValue({ hasConflicts: false, conflictFiles: [] });
  gitMock.resetTestingToAiBranch.mockClear();

  const { pid, rid, dir } = await setupReclonableRepo('reclone-rebuild-testing');
  const res = await request(app).post(`/api/projects/${pid}/repos/${rid}/reclone`)
    .set('Authorization', `Bearer ${token}`).send({});
  expect(res.status).toBe(200);

  const row = await waitReclone(rid);
  expect(row.clone_status).toBe('done');
  expect(gitMock.resetTestingToAiBranch).toHaveBeenCalledWith(dir);
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

// ---- ai-dev 基底扶正 ----
// 意圖：ai-dev 是建立當下從主分支長出來的，主分支之後才改對也不會跟著搬家。實測某專案 ai-dev
// 長自 main、真主分支是 kangyue，同步炸出 28 個「內容衝突」，真因卻只是基底選錯。以下鎖住
// 「什麼時候該自動扶正、什麼時候絕不能動手」——後者更重要：ai-dev 上的 AI 產出只存在於該分支，
// 重建即永久遺失。
function stubAiBase({ actual, own }) {
  gitMock.ensureMainBranch.mockResolvedValue('kangyue');
  gitMock.pullBranch.mockResolvedValue(undefined);
  gitMock.ensureAiBranch.mockResolvedValue(undefined);
  gitMock.syncMainIntoAi.mockResolvedValue({ hasConflicts: false, conflictFiles: [] });
  gitMock.syncMainIntoAi.mockClear(); // 跨案例共用的 mock，不清會讀到別的案例留下的呼叫紀錄
  gitMock.refExists.mockResolvedValue(true);
  gitMock.aiBranchBase.mockResolvedValue(actual);
  gitMock.aiOwnCommits.mockResolvedValue(own);
  gitMock.rebuildAiBranch.mockClear();
  gitMock.rebuildAiBranch.mockResolvedValue({ oldSha: 'aaaaaaa1', newSha: 'bbbbbbb2' });
}
afterEach(() => { gitMock.refExists.mockResolvedValue(false); }); // 別污染其他案例

test('reclone：基底歪掉且零 AI 產出 → 自動重建，並照常完成同步', async () => {
  stubAiBase({ actual: 'main', own: 0 });
  const { pid, rid, dir } = await setupReclonableRepo('reclone-ai-rebuild');
  await request(app).post(`/api/projects/${pid}/repos/${rid}/reclone`)
    .set('Authorization', `Bearer ${token}`).send({});

  const row = await waitReclone(rid);
  // 第三參數是發起人的 git 身分／PAT env，內容不是本案例的重點，只確認有帶（無 PAT 會 push 失敗）
  expect(gitMock.rebuildAiBranch).toHaveBeenCalledWith(dir, 'kangyue', expect.any(Object));
  expect(gitMock.syncMainIntoAi).toHaveBeenCalled(); // 扶正後同步仍要跑，不是扶完就結束
  expect(row.clone_status).toBe('done');
  expect(row.clone_error).toBeNull();                // 已修好＝使用者無事可做，不該留紅字
});

test('reclone：基底歪掉但 ai-dev 上有 AI 產出 → 絕不重建，停下來讓人處理', async () => {
  stubAiBase({ actual: 'main', own: 3 });
  const { pid, rid } = await setupReclonableRepo('reclone-ai-has-work');
  await request(app).post(`/api/projects/${pid}/repos/${rid}/reclone`)
    .set('Authorization', `Bearer ${token}`).send({});

  const row = await waitReclone(rid);
  expect(gitMock.rebuildAiBranch).not.toHaveBeenCalled(); // 那 3 個 commit 只存在於 ai-dev
  expect(gitMock.syncMainIntoAi).not.toHaveBeenCalled();  // 硬同步注定衝突，不要製造待解狀態
  expect(row.clone_status).toBe('error');
  expect(row.clone_error).toContain('main');              // 說清楚它現在長在哪
  expect(row.clone_error).toContain('kangyue');           // 以及應該長在哪
});

test('reclone：基底偵測本身出錯 → 只記錄不阻斷（不確定不足以中止使用者的更新）', async () => {
  stubAiBase({ actual: 'main', own: 0 });
  gitMock.refExists.mockRejectedValue(new Error('git 探測失敗'));
  const { pid, rid } = await setupReclonableRepo('reclone-ai-probe-fail');
  await request(app).post(`/api/projects/${pid}/repos/${rid}/reclone`)
    .set('Authorization', `Bearer ${token}`).send({});

  const row = await waitReclone(rid);
  expect(row.clone_status).toBe('done');           // 探測失敗不得讓 repo 掉出 pipeline（規則 81）
  expect(gitMock.syncMainIntoAi).toHaveBeenCalled();
  expect(gitMock.rebuildAiBranch).not.toHaveBeenCalled();
});

test('reclone：基底正確 → 完全不碰 ai-dev', async () => {
  stubAiBase({ actual: 'kangyue', own: 0 });
  const { pid, rid } = await setupReclonableRepo('reclone-ai-base-ok');
  await request(app).post(`/api/projects/${pid}/repos/${rid}/reclone`)
    .set('Authorization', `Bearer ${token}`).send({});

  const row = await waitReclone(rid);
  expect(gitMock.rebuildAiBranch).not.toHaveBeenCalled();
  expect(row.clone_status).toBe('done');
});

// ---- 新增 repo 時選主分支 ----
// 意圖：主分支只有「新增」這一次機會可選（PUT 已鎖死），所以列分支不能依賴本地 clone。
test('GET remote-branches：clone 前就能列出遠端分支與預設分支', async () => {
  const res = await request(app).get('/api/git/remote-branches?url=https://example.com/x.git')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.branches).toContain('kangyue');
  expect(res.body.defaultBranch).toBe('kangyue');
});

test('GET remote-branches：讀不到（私有 repo 無 PAT／網址錯）回 200 空清單，不得擋住新增流程', async () => {
  gitMock.listRemoteBranchesByUrl.mockRejectedValueOnce(new Error('Authentication failed'));
  const res = await request(app).get('/api/git/remote-branches?url=https://example.com/private.git')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);        // 不是 4xx/5xx——前端要能降級成自動偵測
  expect(res.body.ok).toBe(false);
  expect(res.body.branches).toEqual([]);
  expect(res.body.reason).toContain('Authentication');
});

// 意圖：同一客戶 repo 可以被多個專案使用（跟不同主分支平行開發），但兩個專案落在同一條遠端
// ai 分支上就會互相 force push 覆蓋，而且完全靜默。這道守衛把它變成新增當下就看得到的錯誤。
test('POST repos：同 repo 同主分支的第二個專案 → 409，並指名是誰佔用', async () => {
  const mk = async (name) => (await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${token}`).send({ name, odoo_version: '17.0' })).body.id;
  const url = 'https://example.com/shared.git';
  const p1 = await mk('clash-first');
  await request(app).post(`/api/projects/${p1}/repos`).set('Authorization', `Bearer ${token}`)
    .send({ label: 'main', repo_url: url, base_branch: 'kangyue' });

  const p2 = await mk('clash-second');
  const res = await request(app).post(`/api/projects/${p2}/repos`).set('Authorization', `Bearer ${token}`)
    .send({ label: 'main', repo_url: url, base_branch: 'kangyue' });
  expect(res.status).toBe(409);
  expect(res.body.error).toContain(`#${p1}`);       // 指名佔用者，否則使用者無從查起
  expect(res.body.error).toContain('ai-dev-kangyue');
});

test('POST repos：同 repo 但不同主分支 → 放行（這正是要支援的平行開發）', async () => {
  const mk = async (name) => (await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${token}`).send({ name, odoo_version: '17.0' })).body.id;
  const url = 'https://example.com/parallel.git';
  const p1 = await mk('parallel-a');
  await request(app).post(`/api/projects/${p1}/repos`).set('Authorization', `Bearer ${token}`)
    .send({ label: 'main', repo_url: url, base_branch: 'kangyue' });

  const p2 = await mk('parallel-b');
  const res = await request(app).post(`/api/projects/${p2}/repos`).set('Authorization', `Bearer ${token}`)
    .send({ label: 'main', repo_url: url, base_branch: 'main' });
  expect(res.status).toBe(201);
});

test('POST repos：選定的主分支要寫進 DB（之後不能改，寫錯就永久錯）', async () => {
  const p = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name: 'base-branch-on-create', odoo_version: '17.0' });
  const res = await request(app).post(`/api/projects/${p.body.id}/repos`)
    .set('Authorization', `Bearer ${token}`)
    .send({ label: 'main', repo_url: 'https://example.com/y.git', base_branch: 'kangyue' });
  expect(res.status).toBe(201);
  expect(res.body.base_branch).toBe('kangyue');
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

// ── 刪除專案的資料完整性 ───────────────────────────────────────────────────────
// 這個端點原本零測試覆蓋，所以以下三個缺陷同時存活：
//   1. 第 303 行註解宣稱「DB row 由 FK cascade 處理」，但 4 個子表全是裸的
//      REFERENCES tasks(id)、沒有一個 ON DELETE CASCADE。
//   2. db.js 的 query 是 pool.query 薄包裝，每次呼叫可能拿到不同 pooled connection，
//      所以 BEGIN/COMMIT/ROLLBACK 根本不構成交易——每個 DELETE 各自 autocommit。
//   3. cleanupProjectEnv（實體刪除測試環境與 repo clone、不可逆）排在所有 DB 操作之前。
// 三者相加：任何帶附件的專案，每按一次刪除就永久失去 log／事件／對話與環境，而專案本身還在。
//
// ⚠️ pg-mem 的 ROLLBACK 是假的（實測：INSERT 後 ROLLBACK，列數仍為 1），所以
// 「失敗時已刪的列會被回滾」這件事**無法在本地測試證明**，只能靠真 PostgreSQL。
// 以下三支測的是不依賴回滾語意、仍具鑑別力的部分。
describe('DELETE /api/projects/:id 的資料完整性', () => {
  const envAgent = require('../pipeline/env-agent');
  let cleanupSpy;

  let stopEnvSpy;
  beforeEach(() => {
    cleanupSpy = jest.spyOn(envAgent, 'cleanupProjectEnv').mockResolvedValue(undefined);
    stopEnvSpy = jest.spyOn(envAgent, 'stopEnv').mockResolvedValue(undefined);
  });
  afterEach(() => { cleanupSpy.mockRestore(); stopEnvSpy.mockRestore(); });

  async function mkProjectWithTask(name, opts = {}) {
    const { rows: [p] } = await dbModule.query(
      "INSERT INTO projects (name, odoo_version) VALUES ($1, '17') RETURNING id", [name]
    );
    const { rows: [t] } = await dbModule.query(
      "INSERT INTO tasks (user_id, task_id, source, project_id) VALUES ($1, $2, 'manual', $3) RETURNING id",
      [userId, `t_${name}`, p.id]
    );
    if (opts.attachment) {
      await dbModule.query(
        "INSERT INTO task_attachments (task_id, filename, file_path, origin) VALUES ($1, 'a.png', 'x/a.png', 'manual')",
        [t.id]
      );
    }
    if (opts.tokenUsage) {
      await dbModule.query(
        "INSERT INTO token_usage (task_id, project_id, agent_type) VALUES ($1, $2, 'coding')",
        [`t_${name}`, p.id]
      );
    }
    return { projectId: p.id, taskId: t.id, taskTextId: `t_${name}` };
  }

  // 意圖：附件是任務的正常產物（使用者上傳、eService 同步都會建），所以「有附件的專案」
  // 是常態而非邊界。漏刪 task_attachments 讓 DELETE FROM tasks 撞 FK，整個端點對這類
  // 專案永久失效——而且因為交易是假的，前面幾個 DELETE 已經 autocommit 出去了。
  test('帶附件的專案要能真的刪掉（漏刪 task_attachments 會撞 FK）', async () => {
    const { projectId: pid } = await mkProjectWithTask('fk-proj', { attachment: true });
    const res = await request(app).delete(`/api/projects/${pid}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const { rows: proj } = await dbModule.query('SELECT id FROM projects WHERE id = $1', [pid]);
    expect(proj).toHaveLength(0);
    const { rows: tasks } = await dbModule.query('SELECT id FROM tasks WHERE project_id = $1', [pid]);
    expect(tasks).toHaveLength(0);
  });

  // 意圖：不可逆的動作（實體刪除測試環境與 repo clone）必須排在可逆的 DB 操作**之後**。
  // 用「刪一個不存在的 id」當鑑別案例：正確實作會先查不到、回 404 就結束，永遠不碰檔案系統；
  // 原實作把 cleanupProjectEnv 放在最前面，所以連不存在的專案都會先跑一次實體清理。
  // 這支測試同時鎖住「順序」這個不變量，之後有人把 cleanup 搬回前面就會轉紅。
  test('刪不存在的專案不得觸發任何實體清理（不可逆動作必須排在 DB 之後）', async () => {
    const res = await request(app).delete('/api/projects/999999').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  // 意圖：token_usage 是計費／成本歷史，單張任務刪除刻意保留它（tasks-routes.js 刪除端點那段
  // 明寫理由：token-report ?all=true 專門把已刪任務列為孤兒，刪了成本統計會縮水）。刪整個專案
  // 沒有理由比刪單張任務更慢殺，本守衛鎖住兩邊一致。
  //
  // ⚠️ 為什麼是靜態守衛而不是行為測試：我先寫過行為版（建 token_usage 列 → 刪專案 → 斷言列還在），
  // 它在修法前就是綠的＝零鑑別力。原因是 pg-mem 的 `= ANY($1::…[])` 只要目標欄位有索引就靜默
  // 匹配 0 列（實測：裸表刪得掉、加了索引 rowCount=0），所以那條 DELETE 在 pg-mem 裡本來就是
  // no-op，行為測試不管碼對不對都會過。改測原始碼即可獲得真正的鑑別力。
  test('project-routes 不得出現 DELETE FROM token_usage（守衛：計費歷史不隨專案刪）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'project-routes.js'), 'utf8');
    expect(src).not.toMatch(/DELETE\s+FROM\s+token_usage/i);
  });

  // 意圖：`query` 是 pool.query 薄包裝，BEGIN/COMMIT 會落在不同 pooled connection 上＝根本沒有
  // 交易，而且那個 BEGIN 會讓連線帶著開啟中的交易被還回池子、污染之後的無關查詢。正確做法是
  // db.withTransaction（取專屬 client）。這支守衛擋住有人把裸 BEGIN 寫回來。
  // 意圖：這條鎖的是我自己上一版修法製造出來的 regression——把不可逆清理移到 COMMIT 之後是對的，
  // 但 project_repos／odoo_envs 對 projects 都是 ON DELETE CASCADE，交易一提交那些列就被帶走，
  // cleanupProjectEnv 自己再去查只會查到空的 → 目錄與容器全留在磁碟上，而且沒有任何路徑會再回收它們。
  //
  // 上面那支「順序守衛」抓不到這件事，因為它把 cleanupProjectEnv 整個 mock 掉，只驗「有沒有被呼叫」、
  // 沒驗「被呼叫時拿不拿得到完成工作所需的資料」。教訓：mock 掉一個協作者之後，至少要對「傳給它的
  // 參數是否足以讓它真的做事」下斷言，否則測到的只是呼叫本身。
  test('清理必須拿到交易前取好的路徑快照，且容器要真的被停掉', async () => {
    const { projectId: pid } = await mkProjectWithTask('snap-proj');
    await dbModule.query(
      "INSERT INTO project_repos (project_id, label, repo_url, local_path, clone_status) VALUES ($1,'main','u','/repos/snap-proj/main','done')",
      [pid]
    );
    const res = await request(app).delete(`/api/projects/${pid}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(stopEnvSpy).toHaveBeenCalled();            // 沒停＝容器繼續跑並佔著埠
    const snapshot = cleanupSpy.mock.calls[0][1];
    expect(snapshot).toBeDefined();                   // 沒傳快照＝清理註定查到空的，整段變 no-op
    expect(snapshot.repoPaths).toContain('/repos/snap-proj/main');
  });

  test('不得用 query() 直接下 BEGIN／COMMIT／ROLLBACK（守衛：交易必須走 withTransaction）', () => {
    for (const f of ['project-routes.js', 'admin-routes.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect(src).not.toMatch(/\bquery\(\s*['"`](BEGIN|COMMIT|ROLLBACK)/i);
    }
  });
});

// 意圖：主分支不一定叫 main／master（develop、trunk 都常見）。此設定的成敗關鍵在「有沒有落到該
// clone 的 origin/HEAD」——getMainBranch 讀的是 origin/HEAD，只寫 DB 的話畫面顯示已設定、pipeline
// 卻仍用舊分支，屬於最難察覺的那種脫鉤。故每個案例都同時斷言 DB 與 setRemoteHead。
describe('repo 主分支覆寫', () => {
  let pid, rid;

  beforeAll(async () => {
    const { rows: [p] } = await dbModule.query(
      "INSERT INTO projects (name, odoo_version) VALUES ('bb-proj','17.0') RETURNING id"
    );
    pid = p.id;
    const { rows: [r] } = await dbModule.query(
      `INSERT INTO project_repos (project_id, label, repo_url, local_path, clone_status)
       VALUES ($1,'main','https://x/y','/repos/bb/main','done') RETURNING id`,
      [pid]
    );
    rid = r.id;
  });

  const put = (body) => request(app).put(`/api/projects/${pid}/repos/${rid}`)
    .set('Authorization', `Bearer ${token}`).send(body);

  test('GET branches：給得出可選分支與目前生效的分支', async () => {
    const res = await request(app).get(`/api/projects/${pid}/repos/${rid}/branches`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.branches).toContain('develop');
    expect(res.body.effective).toBe('main');
    expect(res.body.ready).toBe(true);
  });

  test('clone 未完成 → 回空清單且 ready=false（不報錯，前端才好顯示提示）', async () => {
    await dbModule.query("UPDATE project_repos SET clone_status='cloning' WHERE id=$1", [rid]);
    const res = await request(app).get(`/api/projects/${pid}/repos/${rid}/branches`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.branches).toEqual([]);
    await dbModule.query("UPDATE project_repos SET clone_status='done' WHERE id=$1", [rid]);
  });

  // 主分支改為「只在新增 repo 時決定、之後鎖死」。原因：ai-dev 是建立當下從主分支長出來的，
  // 事後改設定不會讓它跟著搬家，同步從此是兩條平行線硬合（實測某專案 28 檔衝突，真因只是基底
  // 選錯）。以下案例的共同 intent 是「這個會造成不一致的入口確實被關掉了」。
  test('指定別的分支 → 400，且 DB 不得被改動', async () => {
    // 刻意用 develop（遠端確實存在的分支）：若改用不存在的分支，測試就分不出擋下的理由
    // 是「不准改」還是「分支不存在」，等於沒測到鎖死本身。
    await dbModule.query("UPDATE project_repos SET base_branch=NULL WHERE id=$1", [rid]);
    const res = await put({ base_branch: 'develop' });
    expect(res.status).toBe(400);
    const { rows } = await dbModule.query('SELECT base_branch FROM project_repos WHERE id=$1', [rid]);
    expect(rows[0].base_branch).toBeNull();
  });

  test('400 訊息要給得出出路，否則使用者只能卡住', async () => {
    const res = await put({ base_branch: 'develop' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/刪除.*重新新增/); // 指出唯一可行的替代路徑
  });

  test('清空（改回自動偵測）同樣擋下——它一樣會讓 ai-dev 與主分支脫鉤', async () => {
    await dbModule.query("UPDATE project_repos SET base_branch='develop' WHERE id=$1", [rid]);
    const res = await put({ base_branch: '' });
    expect(res.status).toBe(400);
    const { rows } = await dbModule.query('SELECT base_branch FROM project_repos WHERE id=$1', [rid]);
    expect(rows[0].base_branch).toBe('develop');
  });

  test('送回相同的值不算改動 → 放行（前端整包 PUT 會原樣帶回來，擋掉會讓改名都失敗）', async () => {
    await dbModule.query("UPDATE project_repos SET base_branch='develop' WHERE id=$1", [rid]);
    const res = await put({ label: 'main', base_branch: 'develop' });
    expect(res.status).toBe(200);
    expect(res.body.base_branch).toBe('develop');
  });

  test('一般編輯（沒帶 base_branch）照常成功且不動既有設定', async () => {
    // 直接以 SQL 設初始值，不經 PUT：PUT 這條路已經鎖死，靠它鋪路會讓本案例跟著壞掉。
    await dbModule.query("UPDATE project_repos SET base_branch='develop' WHERE id=$1", [rid]);
    const res = await put({ label: 'main-renamed' });
    expect(res.status).toBe(200);
    expect(res.body.base_branch).toBe('develop');
  });
});
