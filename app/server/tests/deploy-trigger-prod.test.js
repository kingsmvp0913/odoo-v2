// 意圖：「上正式」按鈕把 ai-dev 推上 main 之後，接著部署到客戶正式區。
// 守的是「部署失敗不可以讓 /release 回錯」——回錯使用者會重按，變成重複 merge。
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 }), resetLoopCounter: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/project-vpn', () => ({ startProjectVpns: jest.fn().mockResolvedValue(''), stopProjectVpns: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/git-identity', () => ({ buildGitEnv: jest.fn().mockResolvedValue({}) }));
jest.mock('../lib/deploy-run', () => ({ runDeploy: jest.fn(), runDeployGroup: jest.fn() }));

// releaseAiToMain 回「有合進去」，其餘 git 函式一律無害
jest.mock('../pipeline/git', () => {
  const real = jest.requireActual('../pipeline/git');
  return { ...real, releaseAiToMain: jest.fn().mockResolvedValue({ merged: true, hasConflicts: false, conflictFiles: [], restoreFailed: false }) };
});

process.env.JWT_SECRET = 'test-prod-trigger';
process.env.APP_SECRET = 'test-app-secret';

const { runDeployGroup } = require('../lib/deploy-run');
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
  runDeployGroup.mockReset().mockImplementation(async (ids) =>
    ids.map((id) => ({ targetId: id, ok: true, status: 'success', modules: ['idx_hj'] })));
  await dbModule.query('DELETE FROM project_deploy_targets');
  await dbModule.query('UPDATE projects SET auto_deploy_enabled = true');
  await dbModule.query('DELETE FROM task_logs');   // 先清：task_logs 的 FK 沒有 CASCADE
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
// 預設帶 confirmDeploy：這些既有案例驗的是「部署有沒有被觸發、失敗怎麼回報」，
// 不是那道確認閘門本身（閘門另有下面三支專屬測試）。
const release = (body = { confirmDeploy: true }, t = token) =>
  request(app).post(`/api/projects/${projectId}/release`)
    .set('Authorization', `Bearer ${t}`).send(body);

test('有啟用的正式區目標時，上正式之後接著部署', async () => {
  await addTarget('prod', true);
  const res = await release();
  expect(res.status).toBe(200);
  expect(runDeployGroup).toHaveBeenCalledTimes(1);
  expect(runDeployGroup.mock.calls[0][1].trigger).toBe('manual_prod');
  expect(res.body.deploy[0].ok).toBe(true);
});

// 意圖：關著開關的人會以為程式沒上去，或以為部署過了。兩種誤解都要避免。
test('專案開關關閉時回應帶 deploySkipped，且不部署', async () => {
  await dbModule.query('UPDATE projects SET auto_deploy_enabled = false');
  await addTarget('prod', true);
  const res = await release();
  expect(res.body.deploySkipped).toBe(true);
  expect(res.body.deploy).toEqual([]);
  expect(runDeployGroup).not.toHaveBeenCalled();
});

// deploySkipped 的語意已擴大：從「開關關著」變成「這次沒有部署，原因在 deploySkipReason」。
// 沒有啟用中的正式區目標同樣代表客戶正式區沒更新，那件事值得講——原本回 false
// 會讓彈窗顯示成「正式區已部署」，而其實一個目標都沒動。
test('沒有啟用的正式區目標時不部署，並說明原因', async () => {
  await addTarget('prod', false);
  const res = await release();
  expect(res.body.deploy).toEqual([]);
  expect(res.body.deploySkipped).toBe(true);
  expect(res.body.deploySkipReason).toMatch(/沒有啟用中的正式區部署目標/);
  expect(runDeployGroup).not.toHaveBeenCalled();
});

// 意圖：測試區目標由核准那關負責，「上正式」不該碰它。
test('不觸發測試區目標', async () => {
  await addTarget('test', true);
  await release();
  expect(runDeployGroup).not.toHaveBeenCalled();
});

// 意圖（Rule 9）：碼已經 push 上 main 了。這時候回錯會讓使用者重按，變成重複 merge。
test('部署失敗時 /release 仍回 ok:true，失敗放在 deploy 裡', async () => {
  runDeployGroup.mockImplementation(async (ids) =>
    ids.map((id) => ({ targetId: id, ok: false, status: 'rolled_back', error: '健康檢查未通過' })));
  await addTarget('prod', true);
  const res = await release();
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.deploy[0].ok).toBe(false);
  expect(res.body.deploy[0].error).toMatch(/健康檢查/);
});

test('部署丟例外也不讓 /release 回 500', async () => {
  runDeployGroup.mockRejectedValue(new Error('SSH 連不上'));
  await addTarget('prod', true);
  const res = await release();
  expect(res.status).toBe(200);
  expect(res.body.deploy[0].error).toMatch(/SSH/);
});

// 意圖：任務標記與部署是兩件事，部署失敗不該讓「已上正式」的標記消失。
test('部署失敗仍標記 merged_to_main_at', async () => {
  runDeployGroup.mockImplementation(async (ids) => ids.map((id) => ({ targetId: id, ok: false, error: 'x' })));
  await addTarget('prod', true);
  await release();
  const { rows } = await dbModule.query('SELECT merged_to_main_at FROM tasks WHERE task_id = $1', ['task_pa_1']);
  expect(rows[0].merged_to_main_at).not.toBeNull();
});

// ── 正式區部署的授權閘門 ─────────────────────────────────────────────
// 意圖（Rule 9）：這條路徑會 SSH 進客戶的正式機下指令。專用的部署端點（deploy-routes.js）
// 要求 admin ＋ 明確 confirm，但 /release 原本只驗登入、也不要求確認——等於整套授權
// 設計可以從這裡繞過去，平台上任何一個非 admin 帳號都按得到客戶的正式機。
// 合併到 main 那一半維持開放（本來就是），關起來的只有「動客戶正式機」這一半。

test('非 admin 按上正式：照樣合併到 main，但不部署，且要講出原因', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('regular', $1, '一般使用者', 'user') ON CONFLICT (username) DO NOTHING",
    [hash]
  );
  const login = await request(app).post('/api/auth/login').send({ username: 'regular', password: 'pass1234' });
  await addTarget('prod', true);

  const res = await release({ confirmDeploy: true }, login.body.token);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);          // 合併照做
  expect(res.body.deploySkipped).toBe(true);
  expect(res.body.deploySkipReason).toMatch(/管理員/);
  expect(runDeployGroup).not.toHaveBeenCalled();   // 客戶正式機一根手指都沒碰到
});

// 意圖：勾選是「我知道失敗時資料庫救不回來」的那一下。沒勾就不准動客戶正式區，
// 而且不可以靜默略過——使用者會以為已經上線。
test('admin 但沒帶 confirmDeploy：不部署，且回得出原因', async () => {
  await addTarget('prod', true);
  const res = await release({});
  expect(res.body.ok).toBe(true);
  expect(res.body.deploySkipped).toBe(true);
  expect(res.body.deploySkipReason).toMatch(/未確認/);
  expect(runDeployGroup).not.toHaveBeenCalled();
});

test('admin 且明確確認：才真的部署', async () => {
  await addTarget('prod', true);
  const res = await release({ confirmDeploy: true });
  expect(res.body.deploySkipped).toBe(false);
  expect(runDeployGroup).toHaveBeenCalled();
});

// 意圖：彈窗要先知道「按下去會不會動到客戶正式機」，警告才寫得對。
// 沒有這段的話警告只能寫成一句通用的話，於是每次都出現，於是沒有人會看。
test('pending-release 帶出「這一按會不會動到正式區」', async () => {
  await addTarget('prod', true);
  await addTarget('prod', false);      // 停用的不算
  await addTarget('test', true);       // 測試區不算
  const res = await request(app).get(`/api/projects/${projectId}/pending-release`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.body.prodDeploy).toEqual({ autoDeploy: true, targets: 1, isAdmin: true });
});

// ── 上正式的結果要進任務對話 ────────────────────────────────────────
// 意圖（Rule 9 / Rule 77）：/release 的回應只活在按下按鈕的那一瞬間，彈窗一關就查不到。
// 「這張任務到底上正式了沒、客戶正式區更新了沒」事後只有 task_logs 找得回來。
const chat = async () => (await dbModule.query(
  "SELECT content FROM task_logs WHERE task_id = (SELECT id FROM tasks WHERE task_id='task_pa_1') AND role='ai' ORDER BY id"
)).rows.map(r => r.content).join('\n');

test('部署成功時，這次上正式的任務對話留下結果與資料庫名', async () => {
  await addTarget('prod', true);
  await release();
  const c = await chat();
  expect(c).toMatch(/上正式/);
  expect(c).toMatch(/併入 main/);
  expect(c).toMatch(/客戶正式區部署完成/);
  expect(c).toMatch(/idx_hj/);
});

test('部署失敗時，任務對話留下失敗原因', async () => {
  runDeployGroup.mockImplementation(async (ids) =>
    ids.map((id) => ({ targetId: id, ok: false, status: 'rolled_back', error: '健康檢查未通過' })));
  await addTarget('prod', true);
  await release();
  expect(await chat()).toMatch(/健康檢查未通過/);
});

// 與測試區那條刻意不同：這裡開關關著也要寫。使用者是主動按下去、等著看客戶機更新了沒，
// 「什麼都沒寫」會被讀成「上正式了，客戶那邊也好了」。
test('沒部署時，任務對話要講出為什麼沒部署', async () => {
  await dbModule.query('UPDATE projects SET auto_deploy_enabled = false');
  await addTarget('prod', true);
  await release();
  const c = await chat();
  expect(c).toMatch(/客戶正式區未更新/);
  expect(c).toMatch(/未啟用自動部署/);
});

test('沒有任何任務被推上 main 時不寫對話', async () => {
  await dbModule.query('UPDATE tasks SET merged_to_main_at = NOW()');   // 這次沒有待上正式的任務
  await addTarget('prod', true);
  await release();
  expect(await chat()).toBe('');
});
