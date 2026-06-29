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

test('migrate adds coding_cmd column to users', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='coding_cmd'"
  );
  expect(rows.length).toBe(1);
});

test('migrate adds qa_cmd column to users', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='qa_cmd'"
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
