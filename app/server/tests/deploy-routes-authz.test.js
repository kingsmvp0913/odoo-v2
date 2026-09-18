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

// db_name 跟著 env 走：route 會擋「測試區與正式區指向同一個資料庫」，而 pg-mem 的表在
// 案例之間不清空（rules/testing #17），固定送同一個名字會讓後面每個建立案例都撞到前面留下的目標。
const body = (extra) => {
  const env = (extra && extra.env) || 'prod';
  return {
    env, runtime: 'docker', addons_dir: '/odoo/custom/addons',
    db_name: env === 'prod' ? 'ciyun' : 'ciyun_test', branch: 'main', ...extra
  };
};

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

// ── 編輯與刪除

// 意圖（Rule 9）：這些欄位是探測出來的事實。手改了就跟客戶機對不上，而且要到真的
// 部署那一刻才炸——改的當下畫面全綠。要換 instance 只能重新評估。
test('探測出來的定址欄位不給改', async () => {
  const { rows: [t] } = await dbModule.query('SELECT id FROM project_deploy_targets ORDER BY id LIMIT 1');
  for (const key of ['runtime', 'container_name', 'compose_service', 'compose_dir', 'service_name']) {
    const res = await request(app).patch(`/api/projects/1/deploy-targets/${t.id}`)
      .set('Authorization', `Bearer ${token}`).send({ [key]: 'x', db_name: 'y' });
    expect([key, res.status]).toEqual([key, 400]);
    expect(res.body.error).toMatch(/探測結果/);
  }
});

// 意圖（Rule 9）：last_deployed_sha 是「上次送到這個目標的版本」。換了資料庫或目錄之後
// 它描述的是別的地方，留著會讓下次部署只送 diff，新目標永遠拿不到完整的碼——
// 而且部署會回報成功。
test('改到資料庫或目錄時清掉 last_deployed_sha，只改模組則保留', async () => {
  const { rows: [c] } = await dbModule.query('SELECT id FROM db_connections WHERE project_id = 1');
  const { rows: [r] } = await dbModule.query('SELECT id FROM project_repos WHERE project_id = 1');
  const created = await request(app).post('/api/projects/1/deploy-targets')
    .set('Authorization', `Bearer ${token}`).send(body({ conn_id: c.id, repo_id: r.id }));
  const id = created.body.id;
  await dbModule.query("UPDATE project_deploy_targets SET last_deployed_sha = 'abc123' WHERE id = $1", [id]);

  const keep = await request(app).patch(`/api/projects/1/deploy-targets/${id}`)
    .set('Authorization', `Bearer ${token}`).send({ modules: ['idx_hj'] });
  expect(keep.status).toBe(200);
  expect(keep.body.resetSha).toBe(false);
  let { rows } = await dbModule.query('SELECT last_deployed_sha FROM project_deploy_targets WHERE id = $1', [id]);
  expect(rows[0].last_deployed_sha).toBe('abc123');

  const moved = await request(app).patch(`/api/projects/1/deploy-targets/${id}`)
    .set('Authorization', `Bearer ${token}`).send({ db_name: '別的資料庫' });
  expect(moved.body.resetSha).toBe(true);
  ({ rows } = await dbModule.query('SELECT last_deployed_sha FROM project_deploy_targets WHERE id = $1', [id]));
  expect(rows[0].last_deployed_sha).toBeNull();
});

// 意圖：env 決定來源分支。改了 env 卻沿用舊分支＝正式區繼續吃測試分支的碼。
test('改 env 時來源分支跟著重推', async () => {
  const { rows: [c] } = await dbModule.query('SELECT id FROM db_connections WHERE project_id = 1');
  const { rows: [r] } = await dbModule.query('SELECT id FROM project_repos WHERE project_id = 1');
  // 用一個沒有別的目標在用的資料庫：這裡驗的是「改 env 會重推分支」，
  // 不該順便撞上「兩區不得共用資料庫」那道檢查。
  const created = await request(app).post('/api/projects/1/deploy-targets')
    .set('Authorization', `Bearer ${token}`)
    .send(body({ env: 'prod', conn_id: c.id, repo_id: r.id, db_name: 'ciyun_branch' }));
  expect(created.body.branch).toBe('main');
  const res = await request(app).patch(`/api/projects/1/deploy-targets/${created.body.id}`)
    .set('Authorization', `Bearer ${token}`).send({ env: 'test' });
  expect(res.body.branch).toBe('ai-dev');
  expect(res.body.target.branch).toBe('ai-dev');
});

// 意圖（Rule 9）：手滑刪掉一個啟用中的目標之後完全沒有徵狀——客戶那台就是靜靜停在舊版。
test('啟用中的目標不給刪，要先停用', async () => {
  const { rows: [c] } = await dbModule.query('SELECT id FROM db_connections WHERE project_id = 1');
  const { rows: [r] } = await dbModule.query('SELECT id FROM project_repos WHERE project_id = 1');
  const created = await request(app).post('/api/projects/1/deploy-targets')
    .set('Authorization', `Bearer ${token}`).send(body({ conn_id: c.id, repo_id: r.id }));
  const id = created.body.id;
  await request(app).patch(`/api/projects/1/deploy-targets/${id}`)
    .set('Authorization', `Bearer ${token}`).send({ enabled: true });

  const blocked = await request(app).delete(`/api/projects/1/deploy-targets/${id}`)
    .set('Authorization', `Bearer ${token}`);
  expect(blocked.status).toBe(400);
  expect(blocked.body.error).toMatch(/停用/);

  await request(app).patch(`/api/projects/1/deploy-targets/${id}`)
    .set('Authorization', `Bearer ${token}`).send({ enabled: false });
  const ok = await request(app).delete(`/api/projects/1/deploy-targets/${id}`)
    .set('Authorization', `Bearer ${token}`);
  expect(ok.status).toBe(200);
  const { rows } = await dbModule.query('SELECT id FROM project_deploy_targets WHERE id = $1', [id]);
  expect(rows).toHaveLength(0);
});

// 意圖：deploy_runs 帶 ON DELETE CASCADE，刪目標會把部署歷史一起帶走。
// 前端要在二次確認裡講清楚「連 N 筆一起刪」，所以列表必須給得出這個 N。
test('列表帶出每個目標的部署紀錄筆數', async () => {
  const { rows: [c] } = await dbModule.query('SELECT id FROM db_connections WHERE project_id = 1');
  const { rows: [r] } = await dbModule.query('SELECT id FROM project_repos WHERE project_id = 1');
  const created = await request(app).post('/api/projects/1/deploy-targets')
    .set('Authorization', `Bearer ${token}`).send(body({ conn_id: c.id, repo_id: r.id }));
  const id = created.body.id;
  for (const st of ['success', 'failed']) {
    await dbModule.query(
      "INSERT INTO deploy_runs (target_id, trigger, status) VALUES ($1, 'manual', $2)", [id, st]);
  }
  const res = await request(app).get('/api/projects/1/deploy-targets').set('Authorization', `Bearer ${token}`);
  const mine = res.body.targets.find(x => x.id === id);
  expect(mine.run_count).toBe(2);
  const other = res.body.targets.find(x => x.id !== id && x.run_count === 0);
  expect(other).toBeTruthy();   // 沒跑過的要是 0 不是 undefined
});

// 刪除會連 deploy_runs 一起消失（CASCADE），回傳筆數讓前端能誠實回報刪了什麼
test('刪除回報一起消失的部署紀錄筆數', async () => {
  const { rows: [t] } = await dbModule.query(
    'SELECT target_id FROM deploy_runs ORDER BY id DESC LIMIT 1');
  const res = await request(app).delete(`/api/projects/1/deploy-targets/${t.target_id}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.deletedRuns).toBe(2);
  const { rows } = await dbModule.query('SELECT id FROM deploy_runs WHERE target_id = $1', [t.target_id]);
  expect(rows).toHaveLength(0);
});
