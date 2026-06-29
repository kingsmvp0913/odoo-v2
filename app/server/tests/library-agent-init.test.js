const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');

const mockCallClaude = jest.fn().mockResolvedValue({
  text: '{"slug":"overview","title":"專案概論","content":"# 總覽\\n專案說明"}', usage: null, durationMs: null
});
jest.mock('../pipeline/claude-runner', () => ({ callClaude: mockCallClaude }));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));

let dbModule, initProjectWiki, tmpRepo;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ initProjectWiki } = require('../pipeline/library-agent'));

  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wikirepo-'));
  for (const m of ['sale_ext', 'hr_ext']) {
    fs.mkdirSync(path.join(tmpRepo, m), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, m, '__manifest__.py'),
      `{\n 'name': '${m} 名稱',\n 'version': '1.0',\n 'summary': '${m} 摘要',\n}`);
  }
}, 30000);

afterAll(() => {
  dbModule._setPoolForTesting(null);
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

async function makeProjectWithRepo() {
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('InitProj', '17.0') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, clone_status) VALUES ($1, 'main', 'x', $2, 'done')",
    [proj.id, tmpRepo]
  );
  return proj.id;
}

test('initProjectWiki creates one overview + one module node per manifest', async () => {
  const projectId = await makeProjectWithRepo();
  const result = await initProjectWiki(projectId, 1);
  expect(result.modules).toBe(2);

  const { rows: ov } = await dbModule.query(
    "SELECT * FROM wiki_pages WHERE project_id=$1 AND node_type='overview'", [projectId]
  );
  expect(ov.length).toBe(1);
  expect(ov[0].parent_id).toBeNull();

  const { rows: mods } = await dbModule.query(
    "SELECT * FROM wiki_pages WHERE project_id=$1 AND node_type='module' ORDER BY slug", [projectId]
  );
  expect(mods.length).toBe(2);
  expect(mods[0].slug).toBe('module-hr_ext');
  expect(mods[0].parent_id).toBe(ov[0].id);
});
