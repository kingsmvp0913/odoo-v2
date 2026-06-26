const { newDb } = require('pg-mem');

const mockCallClaude = jest.fn().mockResolvedValue({ text: '{"slug":"test-feature","title":"測試功能","content":"# 測試\\n\\n這是測試功能說明。"}', usage: null, durationMs: null });

jest.mock('../pipeline/claude-runner', () => ({ callClaude: mockCallClaude }));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));

let dbModule, runLibraryAgent;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ runLibraryAgent } = require('../pipeline/library-agent'));
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

let userSeq = 0;
async function createUserAndProject() {
  userSeq++;
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: [user] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, role) VALUES ('libtest${userSeq}', $1, 'Lib', 'user') RETURNING id`,
    [hash]
  );
  const { rows: [proj] } = await dbModule.query(
    `INSERT INTO projects (name, odoo_version) VALUES ('LibProj${userSeq}', '17.0') RETURNING id`
  );
  return { userId: user.id, projectId: proj.id };
}

test('no project_id → sets done, no wiki created', async () => {
  const { userId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1, 'T001', 'odoo', 'Test', 'wiki_updating') RETURNING id",
    [userId]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [updated] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
  const { rows: wikiRows } = await dbModule.query('SELECT * FROM wiki_pages WHERE project_id IS NULL');
  expect(wikiRows.length).toBe(0);
});

test('with project_id → upserts wiki page and sets done', async () => {
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1, 'T002', 'odoo', 'Feature X', 'wiki_updating', $2) RETURNING id",
    [userId, projectId]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [updated] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
  const { rows: wikiRows } = await dbModule.query('SELECT * FROM wiki_pages WHERE project_id=$1', [projectId]);
  expect(wikiRows.length).toBe(1);
  expect(wikiRows[0].slug).toBe('test-feature');
});

test('API error → still sets task done', async () => {
  mockCallClaude.mockRejectedValueOnce(new Error('API down'));
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1, 'T003', 'odoo', 'Feature Y', 'wiki_updating', $2) RETURNING id",
    [userId, projectId]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [updated] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
});
