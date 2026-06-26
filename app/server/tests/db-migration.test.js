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
