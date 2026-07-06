// 意圖：E2E 依 SD 打測試區。pass→人工審核；fail→退 coding 並計數，滿上限 stopped；
// 缺登入憑證（未曾登入建立 password_enc）視為無法測試，停止並提示重新登入。
const { newDb } = require('pg-mem');

process.env.APP_SECRET = 'test-app-secret';

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn() }));
jest.mock('../pipeline/task-agent', () => {
  const actual = jest.requireActual('../pipeline/task-agent');
  return { ...actual, spawnClaude: jest.fn(), getProjectInfo: jest.fn() };
});

let dbModule, runPlaywrightAgent, taskAgent, crypto;
let userWithCreds, userNoCreds, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  crypto = require('../lib/crypto');

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u1] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, password_enc) VALUES ('pw', $1, 'P', $2) RETURNING id",
    [hash, crypto.encrypt('e2epass')]
  );
  userWithCreds = u1.id;
  const { rows: [u2] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('nocreds', $1, 'N') RETURNING id", [hash]
  );
  userNoCreds = u2.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('PWP', '17.0') RETURNING id"
  );
  projectId = p.id;
  await dbModule.query("INSERT INTO odoo_envs (project_id, status, url) VALUES ($1,'running','http://localhost:8069')", [projectId]);

  taskAgent = require('../pipeline/task-agent');
  ({ runPlaywrightAgent } = require('../pipeline/playwright-agent'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  taskAgent.spawnClaude.mockReset();
  taskAgent.getProjectInfo.mockReset();
  taskAgent.getProjectInfo.mockResolvedValue({ name: 'PWP', odoo_version: '17.0', root: '/repos/pwp', repos: [] });
});

let seq = 0;
async function makeTask(ownerId, pwCount = 0) {
  seq++;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, git_branch, analysis_yaml, pw_retry_count)
     VALUES ($1,$2,'odoo','T','playwright_running',$3,'task/x','module: sale',$4) RETURNING id`,
    [ownerId, `pw_${seq}`, projectId, pwCount]
  );
  return t.id;
}
function claudeReturns(json) {
  taskAgent.spawnClaude.mockResolvedValue({
    text: `---RESULT-JSON---\n${JSON.stringify(json)}\n---END-RESULT---`, usage: null, durationMs: null
  });
}

test('verdict pass → review_pending', async () => {
  claudeReturns({ verdict: 'pass', plan: 'p', report: 'r' });
  const id = await makeTask(userWithCreds);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('review_pending');
});

test('verdict fail 未達上限 → coding_running、計數+1', async () => {
  claudeReturns({ verdict: 'fail', report: '登入後找不到選單' });
  const id = await makeTask(userWithCreds, 0);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status, pw_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.pw_retry_count).toBe(1);
});

test('verdict fail 第 3 次 → stopped', async () => {
  claudeReturns({ verdict: 'fail', report: '又失敗' });
  const id = await makeTask(userWithCreds, 2);
  await runPlaywrightAgent(id, userWithCreds);
  const { rows: [t] } = await dbModule.query('SELECT status, pw_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.pw_retry_count).toBe(3);
});

test('無 E2E 憑證 → stopped（提示重新登入）', async () => {
  claudeReturns({ verdict: 'pass' });
  const id = await makeTask(userNoCreds);
  await runPlaywrightAgent(id, userNoCreds);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_content).toContain('重新登入');
  expect(taskAgent.spawnClaude).not.toHaveBeenCalled();
});
