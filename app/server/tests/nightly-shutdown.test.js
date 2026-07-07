// 意圖：夜間 shutdown 不得砍掉「正在被任務使用中」的 env，否則 deploy/E2E 中途死掉會被誤歸因為程式問題。
const { newDb } = require('pg-mem');

jest.mock('child_process', () => ({ execFile: jest.fn(), spawn: jest.fn() }));
jest.mock('../pipeline/git', () => ({ ensureTestingBranch: jest.fn() }));

let dbModule, nightlyShutdown, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('ns','h','N') RETURNING id"
  );
  userId = u.id;
  ({ nightlyShutdown } = require('../pipeline/env-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  await dbModule.query('DELETE FROM tasks');
  await dbModule.query('DELETE FROM odoo_envs');
  await dbModule.query('DELETE FROM projects');
});

async function mkProject(name) {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ($1,'17.0') RETURNING id", [name]
  );
  return p.id;
}

test('閒置專案的 env → 夜間 shutdown 關閉', async () => {
  const pid = await mkProject('idle-proj');
  await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1,'running')", [pid]);
  await nightlyShutdown();
  const { rows: [e] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('idle');
});

test('有任務在 deploy_testing 的專案 env → 跳過不砍', async () => {
  const pid = await mkProject('busy-deploy');
  await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1,'running')", [pid]);
  await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'ns_dep','odoo','T','deploy_testing',$2)",
    [userId, pid]
  );
  await nightlyShutdown();
  const { rows: [e] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('running'); // 使用中不得關
});

test('有任務在 playwright_running 的專案 env → 跳過不砍', async () => {
  const pid = await mkProject('busy-e2e');
  await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1,'running')", [pid]);
  await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'ns_e2e','odoo','T','playwright_running',$2)",
    [userId, pid]
  );
  await nightlyShutdown();
  const { rows: [e] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=$1', [pid]);
  expect(e.status).toBe('running');
});
