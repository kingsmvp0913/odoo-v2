const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('../lib/deploy-run', () => ({ runDeploy: jest.fn().mockResolvedValue({ ok: true, status: 'success', modules: ['idx_hj'] }) }));
const { runDeploy } = require('../lib/deploy-run');

process.env.JWT_SECRET = 'test-deploy-routes';
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

  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('甲', '17.0')");   // 1
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('乙', '17.0')");   // 2
  await dbModule.query('UPDATE projects SET auto_deploy_enabled = true WHERE id = 1');
  // 1 = 甲的測試區、2 = 甲的正式區、3 = 乙的測試區
  // 測試區與正式區刻意給不同的 db_name：同一個專案兩區共用一個資料庫是本檔另外擋掉的
  // 錯誤狀態，拿它當基礎資料的話每個案例都會踩到那道檢查。
  for (const [pid, env, db] of [[1, 'test', 'db1'], [1, 'prod', 'db1_prod'], [2, 'test', 'db1']]) {
    await dbModule.query(
      `INSERT INTO project_deploy_targets (project_id, env, runtime, addons_dir, db_name, branch)
       VALUES ($1, $2, 'docker', '/a/addons', $3, 'ai-dev')`, [pid, env, db]
    );
  }
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

const auth = (r) => r.set('Authorization', `Bearer ${token}`);
const on = () => dbModule.query('UPDATE projects SET auto_deploy_enabled = true WHERE id = 1');
const off = () => dbModule.query('UPDATE projects SET auto_deploy_enabled = false WHERE id = 1');

beforeEach(() => runDeploy.mockClear());

// 意圖（Rule 9）：前端把分頁藏起來不是授權，使用者照樣打得到 API。
// 五個端點漏任何一個，關掉總開關就形同虛設。
test('專案開關關閉時所有部署端點都 403', async () => {
  await off();
  const calls = [
    ['get', '/api/projects/1/deploy-targets'],
    ['post', '/api/projects/1/deploy-probe'],
    ['post', '/api/projects/1/deploy-targets'],
    ['patch', '/api/projects/1/deploy-targets/1'],
    ['post', '/api/projects/1/deploy-targets/1/deploy'],
    ['get', '/api/projects/1/deploy-runs'],
  ];
  for (const [m, url] of calls) {
    const res = await auth(request(app)[m](url)).send({ confirm: true, enabled: true });
    expect([m, url, res.status]).toEqual([m, url, 403]);
  }
  await on();
});

// 意圖：中途被關掉就該立刻擋下，這正是「不可快取」的意義。
test('開關在兩次請求之間被關掉，第二次立刻 403', async () => {
  await on();
  expect((await auth(request(app).get('/api/projects/1/deploy-targets'))).status).toBe(200);
  await off();
  expect((await auth(request(app).get('/api/projects/1/deploy-targets'))).status).toBe(403);
  await on();
});

// 意圖：正式區不可逆，失敗只還原檔案、資料庫改動留在原地。
test('正式區部署缺 confirm 時擋下且不執行', async () => {
  const res = await auth(request(app).post('/api/projects/1/deploy-targets/2/deploy')).send({});
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/確認/);
  expect(runDeploy).not.toHaveBeenCalled();
});

test('正式區帶 confirm 才執行', async () => {
  const res = await auth(request(app).post('/api/projects/1/deploy-targets/2/deploy')).send({ confirm: true });
  expect(res.status).toBe(200);
  expect(runDeploy).toHaveBeenCalledTimes(1);
  expect(runDeploy.mock.calls[0][1].trigger).toBe('manual_prod');
});

test('測試區部署不需要 confirm', async () => {
  const res = await auth(request(app).post('/api/projects/1/deploy-targets/1/deploy')).send({});
  expect(res.status).toBe(200);
  expect(runDeploy.mock.calls[0][1].trigger).toBe('manual_retry');
});

// 意圖：此 repo 沒有專案成員表，跨專案隔離要端點自己做。
test('不得部署別的專案的目標（target 3 屬於乙）', async () => {
  const res = await auth(request(app).post('/api/projects/1/deploy-targets/3/deploy')).send({ confirm: true });
  expect(res.status).toBe(404);
  expect(runDeploy).not.toHaveBeenCalled();
});

test('不得改別的專案的目標啟用狀態', async () => {
  const res = await auth(request(app).patch('/api/projects/1/deploy-targets/3')).send({ enabled: true });
  expect(res.status).toBe(404);
  const { rows } = await dbModule.query('SELECT enabled FROM project_deploy_targets WHERE id = 3');
  expect(rows[0].enabled).toBe(false);
});

test('enabled 必須是布林，字串不接受', async () => {
  const res = await auth(request(app).patch('/api/projects/1/deploy-targets/1')).send({ enabled: 'true' });
  expect(res.status).toBe(400);
});

test('啟用與停用都存得進去', async () => {
  await auth(request(app).patch('/api/projects/1/deploy-targets/1')).send({ enabled: true });
  let r = await dbModule.query('SELECT enabled FROM project_deploy_targets WHERE id = 1');
  expect(r.rows[0].enabled).toBe(true);
  await auth(request(app).patch('/api/projects/1/deploy-targets/1')).send({ enabled: false });
  r = await dbModule.query('SELECT enabled FROM project_deploy_targets WHERE id = 1');
  expect(r.rows[0].enabled).toBe(false);
});

test('deploy-runs 只回本專案的紀錄', async () => {
  await dbModule.query("INSERT INTO deploy_runs (target_id, trigger, status) VALUES (1, 'manual_retry', 'success')");
  await dbModule.query("INSERT INTO deploy_runs (target_id, trigger, status) VALUES (3, 'manual_retry', 'success')");
  const res = await auth(request(app).get('/api/projects/1/deploy-runs'));
  expect(res.status).toBe(200);
  expect(res.body.runs.map(r => r.target_id)).toEqual([1]);
});

// ── odoo 執行檔路徑（systemd 目標）
//
// 意圖（Rule 9）：這一欄會原封不動進客戶正式機的 shell。存進來之前就要擋掉不合法的值——
// 等到部署當下才由 buildUpgradeCmd 拋，使用者看到的會是一次失敗的部署（客戶服務已經停過一次）
// 而不是一則存檔錯誤。
test('odoo_bin 存得進去也讀得回來，不合法的路徑存不進去', async () => {
  await on();
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url) VALUES (1, 'main', 'https://example.com/r.git')"
  );
  const { rows: [repo] } = await dbModule.query('SELECT id FROM project_repos WHERE project_id = 1');

  const bad = await auth(request(app).patch('/api/projects/1/deploy-targets/1'))
    .send({ repo_id: repo.id, addons_dir: '/a/addons', db_name: 'db1', odoo_bin: 'odoo-bin; rm -rf /' });
  expect(bad.status).toBe(400);

  const ok = await auth(request(app).patch('/api/projects/1/deploy-targets/1'))
    .send({ repo_id: repo.id, addons_dir: '/a/addons', db_name: 'db1', odoo_bin: '/odoo/odoo-server/odoo-bin' });
  expect(ok.status).toBe(200);
  expect(ok.body.target.odoo_bin).toBe('/odoo/odoo-server/odoo-bin');

  // 清空＝回到裸名 odoo-bin（PATH 上有的機器仍然可用）
  const cleared = await auth(request(app).patch('/api/projects/1/deploy-targets/1'))
    .send({ repo_id: repo.id, addons_dir: '/a/addons', db_name: 'db1', odoo_bin: '' });
  expect(cleared.body.target.odoo_bin).toBeNull();
});

// 沒帶 odoo_bin 的 PATCH 不可以把既有的值洗掉——前端只送有改到的欄位，
// 洗掉的話使用者按一次「儲存」就會讓部署回到 command not found。
test('PATCH 沒帶 odoo_bin 時保留既有值', async () => {
  await on();
  const { rows: [repo] } = await dbModule.query('SELECT id FROM project_repos WHERE project_id = 1');
  await dbModule.query("UPDATE project_deploy_targets SET odoo_bin = '/odoo/odoo-server/odoo-bin' WHERE id = 1");
  const res = await auth(request(app).patch('/api/projects/1/deploy-targets/1'))
    .send({ repo_id: repo.id, addons_dir: '/a/addons', db_name: 'db1' });
  expect(res.status).toBe(200);
  expect(res.body.target.odoo_bin).toBe('/odoo/odoo-server/odoo-bin');
});

// ── 測試區與正式區不得共用同一個資料庫
//
// 意圖（Rule 9）：評估是「用哪條連線掃，掃到的每個 instance 就套那條連線的 db_name」。
// 一條連線掃到兩個 instance（慈雲那台 odoo-server／odoo-test）時兩個候選會拿到同一個
// 名字，測試區於是被填成正式的資料庫——按下去就是拿 ai 分支的碼升級客戶正在用的資料。
// 這三個案例分別守住存檔、啟用、與改欄位三個入口，缺一都留著同一條路。
const seedRepo = async () => {
  const { rows } = await dbModule.query('SELECT id FROM project_repos WHERE project_id = 1');
  if (rows.length) return rows[0].id;
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url) VALUES (1, 'main', 'https://example.com/r.git')"
  );
  const { rows: [r] } = await dbModule.query('SELECT id FROM project_repos WHERE project_id = 1');
  return r.id;
};

test('存不進「測試區指向正式區的資料庫」', async () => {
  await on();
  const repoId = await seedRepo();
  const res = await auth(request(app).post('/api/projects/1/deploy-targets')).send({
    env: 'test', runtime: 'docker', repo_id: repoId, addons_dir: '/a/addons', db_name: 'db1_prod',
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/正式區/);
});

test('撞到別區資料庫的舊目標不給啟用', async () => {
  await on();
  await dbModule.query("UPDATE project_deploy_targets SET db_name = 'db1_prod' WHERE id = 1");
  const res = await auth(request(app).patch('/api/projects/1/deploy-targets/1')).send({ enabled: true });
  expect(res.status).toBe(400);
  const { rows } = await dbModule.query('SELECT enabled FROM project_deploy_targets WHERE id = 1');
  expect(rows[0].enabled).toBe(false);
  await dbModule.query("UPDATE project_deploy_targets SET db_name = 'db1' WHERE id = 1");
});

test('改欄位時把資料庫改成別區在用的也擋下', async () => {
  await on();
  const repoId = await seedRepo();
  const res = await auth(request(app).patch('/api/projects/1/deploy-targets/1'))
    .send({ repo_id: repoId, addons_dir: '/a/addons', db_name: 'db1_prod' });
  expect(res.status).toBe(400);
  const { rows } = await dbModule.query('SELECT db_name FROM project_deploy_targets WHERE id = 1');
  expect(rows[0].db_name).toBe('db1');
});

// 意圖：使用者的分頁可能是平台更新前開的，載到的舊畫面程式根本沒有 odoo_bin 這個欄位，
// 存出來的 systemd 目標就是空的，而部署當下只會吐一行 command not found（慈雲實際踩過）。
// 探測結果跟著同一份 payload 送上來，補得起來就補。
test('前端沒帶 odoo_bin 時從 probe_json 補上', async () => {
  await on();
  const repoId = await seedRepo();
  const res = await auth(request(app).post('/api/projects/1/deploy-targets')).send({
    env: 'test', runtime: 'systemd', repo_id: repoId, addons_dir: '/odoo/custom/addons_test',
    db_name: 'db_from_probe', service_name: 'odoo-test',
    probe_json: { candidate: { odooBin: '/odoo/odoo-server/odoo-bin' } },
  });
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT odoo_bin FROM project_deploy_targets WHERE id = $1', [res.body.id]);
  expect(rows[0].odoo_bin).toBe('/odoo/odoo-server/odoo-bin');
});

test('probe_json 帶的 odoo_bin 不合法就不存進去', async () => {
  await on();
  const repoId = await seedRepo();
  const res = await auth(request(app).post('/api/projects/1/deploy-targets')).send({
    env: 'test', runtime: 'systemd', repo_id: repoId, addons_dir: '/odoo/custom/addons_test',
    db_name: 'db_bad_probe', service_name: 'odoo-test',
    probe_json: { candidate: { odooBin: 'odoo-bin; rm -rf /' } },
  });
  expect(res.status).toBe(400);
});
