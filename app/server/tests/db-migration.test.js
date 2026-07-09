const { newDb } = require('pg-mem');

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('migrate 建立 task_events 表（執行歷程持久化）', async () => {
  const { rows } = await dbModule.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='task_events'"
  );
  expect(rows.length).toBe(1);
});

test('migrate 加 tasks.resume_status 欄位（解決阻塞回到中斷階段用）', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tasks' AND column_name='resume_status'"
  );
  expect(rows.length).toBe(1);
});

test('migrate 加 tasks.approved_at 欄位（人工審核通過標記，用於禁刪/隱藏刪除鈕）', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tasks' AND column_name='approved_at'"
  );
  expect(rows.length).toBe(1);
});

test('migrate is idempotent — calling twice does not throw', async () => {
  let threw = false;
  try { await dbModule.migrate(); } catch { threw = true; }
  expect(threw).toBe(false);
});

test('projects table has expected columns', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='projects'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('name');
  expect(cols).toContain('odoo_version');
});

test('project_repos table has expected columns', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='project_repos'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('project_id');
  expect(cols).toContain('repo_url');
  expect(cols).toContain('is_primary');
});

test('wiki_pages table has expected columns', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='wiki_pages'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('project_id');
  expect(cols).toContain('slug');
  expect(cols).toContain('content');
});

test('tasks table has project_id column after migration', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tasks' AND column_name='project_id'"
  );
  expect(rows.length).toBe(1);
});

test('token_usage table exists after migrate', async () => {
  const { rows } = await dbModule.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='token_usage'"
  );
  expect(rows.length).toBe(1);
});

test('projects has odoo_project_name column', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='projects' AND column_name='odoo_project_name'"
  );
  expect(rows.length).toBe(1);
});

test('projects has service_respondent_name column', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='projects' AND column_name='service_respondent_name'"
  );
  expect(rows.length).toBe(1);
});

test('wiki_pages has parent_id column', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='wiki_pages' AND column_name='parent_id'"
  );
  expect(rows.length).toBe(1);
});

test('wiki_pages has node_type column', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='wiki_pages' AND column_name='node_type'"
  );
  expect(rows.length).toBe(1);
});

test('tasks 具有 qa_retry_count / pw_retry_count / done_at 欄位', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tasks'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('qa_retry_count');
  expect(cols).toContain('pw_retry_count');
  expect(cols).toContain('done_at');
});

test('users 具有 password_enc 欄位', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='password_enc'"
  );
  expect(rows.length).toBe(1);
});

test('migrate 把已移除狀態的舊任務遷移為 stopped', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('mig1','x','MIG') RETURNING id"
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status) VALUES ($1,'mig_final','manual','final_pending') RETURNING id",
    [u.id]
  );
  await dbModule.migrate(); // 冪等，重跑會套用一次性遷移
  const { rows: [after] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('stopped');
  expect(after.blocker_content).toContain('流程改版');
});

test('project_chats 具有 user_id 與 last_read_message_id 欄位', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('m1','x','M1') RETURNING id"
  );
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('P','17.0') RETURNING id"
  );
  const { rows: [c] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'t',$2) RETURNING id, user_id, last_read_message_id",
    [p.id, u.id]
  );
  expect(c.user_id).toBe(u.id);
  expect(c.last_read_message_id).toBe(0);
});

test('migrate 建立 task_attachments 表', async () => {
  const { rows } = await dbModule.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='task_attachments'"
  );
  expect(rows.length).toBe(1);
});

test('task_attachments 具有 origin / external_attachment_id / synced_to_odoo 欄位', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='task_attachments'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('origin');
  expect(cols).toContain('external_attachment_id');
  expect(cols).toContain('synced_to_odoo');
  expect(cols).toContain('message_id');
});

test('tasks 具有 stage_label / classification_label / has_attachment 欄位', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tasks'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('stage_label');
  expect(cols).toContain('classification_label');
  expect(cols).toContain('has_attachment');
});
