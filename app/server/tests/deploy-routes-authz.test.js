const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-deploy-authz';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, token;

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

  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('甲客戶', '17.0')");   // id 1
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('乙客戶', '17.0')");   // id 2
  // 乙客戶的 SSH 連線與 repo
  await dbModule.query(
    "INSERT INTO db_connections (project_id, name, ssh_host, ssh_user, db_name) VALUES (2, '乙-正式', '10.0.0.9', 'root', 'yi_prod')"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url) VALUES (2, '乙repo', 'https://x/y.git')"
  );
  await dbModule.query('INSERT INTO teams_settings (id, auto_deploy_enabled) VALUES (1, true)');
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

test('同專案的外鍵可以正常建立', async () => {
  await dbModule.query(
    "INSERT INTO db_connections (project_id, name, ssh_host, ssh_user, db_name) VALUES (1, '甲-正式', '10.0.0.1', 'root', 'jia_prod')"
  );
  const { rows: [c] } = await dbModule.query('SELECT id FROM db_connections WHERE project_id = 1');
  const res = await request(app).post('/api/projects/1/deploy-targets')
    .set('Authorization', `Bearer ${token}`).send(body({ conn_id: c.id }));
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
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
