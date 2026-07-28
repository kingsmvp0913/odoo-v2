// 意圖：池滿時要能徵收「閒著沒人用」的測試區讓位，但正在跑 deploy/E2E 的絕不可被砍——
// 砍了會讓 pipeline 中途死掉並被誤歸因為程式問題。徵收門檻（15 分）比背景回收門檻（60 分）短：
// 有人在等的時候才積極讓位，沒人等就別打擾。
const { newDb } = require('pg-mem');

let dbModule, findReclaimable, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('pr','h','P') RETURNING id"
  );
  userId = u.id;
  ({ findReclaimable } = require('../lib/port-reclaim'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  await dbModule.query('DELETE FROM tasks');
  await dbModule.query('DELETE FROM odoo_envs');
  await dbModule.query('DELETE FROM projects');
});

// idleMin：距今幾分鐘前最後活動
async function mkRunningEnv(name, port, idleMin) {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ($1,'17.0') RETURNING id", [name]
  );
  await dbModule.query(
    `INSERT INTO odoo_envs (project_id, status, port, last_active_at)
     VALUES ($1,'running',$2, NOW() - ($3 || ' minutes')::interval)`,
    [p.id, port, String(idleMin)]
  );
  return p.id;
}

async function mkBusyTask(projectId, status) {
  await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,$2,'odoo','T',$3,$4)",
    [userId, `pr_${projectId}_${status}`, status, projectId]
  );
}

test('閒置 20 分（≥15 分門檻）→ 可徵收', async () => {
  const pid = await mkRunningEnv('a', 21000, 20);
  const got = await findReclaimable();
  expect(got?.project_id).toBe(pid);
});

test('閒置 5 分（未達 15 分門檻）→ 不可徵收', async () => {
  await mkRunningEnv('a', 21000, 5);
  expect(await findReclaimable()).toBeNull();
});

// 意圖：這是鐵則——正在跑的 pipeline 絕不能被腰斬。
test('閒置夠久但該專案正在 deploy_testing → 不可徵收', async () => {
  const pid = await mkRunningEnv('a', 21000, 120);
  await mkBusyTask(pid, 'deploy_testing');
  expect(await findReclaimable()).toBeNull();
});

test('閒置夠久但該專案正在 playwright_running → 不可徵收', async () => {
  const pid = await mkRunningEnv('a', 21000, 120);
  await mkBusyTask(pid, 'playwright_running');
  expect(await findReclaimable()).toBeNull();
});

test('多個候選 → 挑 last_active_at 最舊的', async () => {
  await mkRunningEnv('newer', 21000, 20);
  const oldest = await mkRunningEnv('older', 21001, 90);
  const got = await findReclaimable();
  expect(got?.project_id).toBe(oldest);
});

test('status 非 running（idle）→ 不列入徵收候選', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('idle-one','17.0') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO odoo_envs (project_id, status, port, last_active_at) VALUES ($1,'idle',21000, NOW() - interval '90 minutes')",
    [p.id]
  );
  expect(await findReclaimable()).toBeNull();
});

// 意圖：從沒被掃描過（last_active_at 為 NULL）的環境不該被當成「無限閒置」而優先砍掉，
// 也不該永遠免疫——以啟動時間（created_at）當退路。
test('last_active_at 為 NULL 但已啟動很久 → 仍可徵收', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('nullact','17.0') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO odoo_envs (project_id, status, port, last_active_at, updated_at) VALUES ($1,'running',21000, NULL, NOW() - interval '90 minutes')",
    [p.id]
  );
  const got = await findReclaimable();
  expect(got?.project_id).toBe(p.id);
});
