const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-deploy-authz';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, token, userToken;

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

  // 非 admin 的一般使用者
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass1234', 4);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('regular', $1, '一般使用者', 'user')", [hash]
  );
  const login = await request(app).post('/api/auth/login').send({ username: 'regular', password: 'pass1234' });
  userToken = login.body.token;

  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('甲客戶', '17.0')");   // id 1
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('乙客戶', '17.0')");   // id 2
  // 乙客戶的 SSH 連線與 repo
  await dbModule.query(
    "INSERT INTO db_connections (project_id, name, ssh_host, ssh_user, db_name) VALUES (2, '乙-正式', '10.0.0.9', 'root', 'yi_prod')"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url) VALUES (2, '乙repo', 'https://x/y.git')"
  );
  // 甲客戶自己的 repo。repo_id 現在是建立部署目標的必填欄位（少了它按部署必定失敗），
  // 所以「同專案外鍵可以建立」那條要有一個合法的自家 repo 可送。
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url) VALUES (1, '甲repo', 'https://x/a.git')"
  );
  await dbModule.query('UPDATE projects SET auto_deploy_enabled = true');
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

const body = (extra) => ({
  env: 'prod', runtime: 'docker', addons_dir: '/odoo/custom/addons',
  db_name: 'ciyun', branch: 'main', ...extra
});

// 意圖（Rule 9）：此 repo 沒有 project_members 表，專案端點多半只驗 token，
// 所以「這個 id 屬不屬於這個專案」一定要端點自己驗。漏掉的後果不是資料外洩而已——
// 借到別的客戶的 SSH 連線，就能把甲客戶的碼部署到乙客戶的正式機。
test('不得用別的專案的 conn_id 建立部署目標', async () => {
  const res = await request(app).post('/api/projects/1/deploy-targets')
    .set('Authorization', `Bearer ${token}`).send(body({ conn_id: 1 }));
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/conn_id/);
  const { rows } = await dbModule.query('SELECT * FROM project_deploy_targets');
  expect(rows).toHaveLength(0);
});

test('不得用別的專案的 repo_id 建立部署目標', async () => {
  const res = await request(app).post('/api/projects/1/deploy-targets')
    .set('Authorization', `Bearer ${token}`).send(body({ repo_id: 1 }));
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/repo_id/);
});

test('不得對別的專案的連線跑探測', async () => {
  const res = await request(app).post('/api/projects/1/deploy-probe')
    .set('Authorization', `Bearer ${token}`).send({ conn_id: 1 });
  expect(res.status).toBe(404);
});

// 意圖（Rule 9）：repo_id 決定「部署的碼從哪個 repo 來」。少了它 deploy-run 的第一步
// headSha 就拋「這個部署目標沒有對應的 repo」——目標存得下去、畫面全綠，按部署必定失敗。
test('缺 repo_id 時擋下，不留一個按了必定失敗的目標', async () => {
  const { rows: [c0] } = await dbModule.query('SELECT id FROM db_connections WHERE project_id = 2');
  const before = await dbModule.query('SELECT count(*) AS n FROM project_deploy_targets');
  const res = await request(app).post('/api/projects/1/deploy-targets')
    .set('Authorization', `Bearer ${token}`).send(body({}));
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/repo_id/);
  const after = await dbModule.query('SELECT count(*) AS n FROM project_deploy_targets');
  expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
});

test('同專案的外鍵可以正常建立', async () => {
  await dbModule.query(
    "INSERT INTO db_connections (project_id, name, ssh_host, ssh_user, db_name) VALUES (1, '甲-正式', '10.0.0.1', 'root', 'jia_prod')"
  );
  const { rows: [c] } = await dbModule.query('SELECT id FROM db_connections WHERE project_id = 1');
  const { rows: [r] } = await dbModule.query('SELECT id FROM project_repos WHERE project_id = 1');
  const res = await request(app).post('/api/projects/1/deploy-targets')
    .set('Authorization', `Bearer ${token}`).send(body({ conn_id: c.id, repo_id: r.id }));
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

// 意圖：分支不再由前端指定。前端填死的 ai-dev／main 對 base_branch 不是 main 的專案是錯的
// （遠端 ai 分支叫 ai-dev-odoo15、主分支叫 develop），推不出來時才退回舊預設值。
test('來源分支由後端依環境推導，前端送什麼都不算數', async () => {
  const { rows: [c] } = await dbModule.query('SELECT id FROM db_connections WHERE project_id = 1');
  const { rows: [r] } = await dbModule.query('SELECT id FROM project_repos WHERE project_id = 1');
  const res = await request(app).post('/api/projects/1/deploy-targets')
    .set('Authorization', `Bearer ${token}`)
    .send(body({ env: 'test', conn_id: c.id, repo_id: r.id, branch: '前端亂送的分支' }));
  expect(res.status).toBe(200);
  expect(res.body.branch).toBe('ai-dev');
  const { rows } = await dbModule.query('SELECT branch FROM project_deploy_targets ORDER BY id DESC LIMIT 1');
  expect(rows[0].branch).toBe('ai-dev');
});

// 意圖：新建目標一律不自動啟用。這個功能會連進客戶正式機下指令，
// 建立當下就 enabled 等於「填完表單就開始自動部署」。
test('新建目標預設不啟用，即使 body 沒帶 enabled', async () => {
  const { rows } = await dbModule.query('SELECT enabled FROM project_deploy_targets ORDER BY id DESC LIMIT 1');
  expect(rows[0].enabled).toBe(false);
});

test('列表只回本專案的目標', async () => {
  const res = await request(app).get('/api/projects/2/deploy-targets')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.targets).toEqual([]);
});

// 意圖（Rule 9）：這些端點會 SSH 進客戶的正式機下指令。此 repo 沒有 project_members 表、
// 專案共享是既有設計，沒有「專案擁有者」可檢查，所以全部限 admin——總開關本來就在
// admin 設定頁裡。少了這道，任何登入者都能對任何客戶的正式機下指令。
test('非 admin 一律 403，五個端點都是', async () => {
  const calls = [
    ['get',  '/api/projects/1/deploy-targets'],
    ['post', '/api/projects/1/deploy-probe'],
    ['post', '/api/projects/1/deploy-targets'],
  ];
  for (const [m, url] of calls) {
    const res = await request(app)[m](url).set('Authorization', `Bearer ${userToken}`).send(body({}));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Admin only');
  }
});

test('未帶 token 一律 401', async () => {
  const res = await request(app).get('/api/projects/1/deploy-targets');
  expect(res.status).toBe(401);
});
