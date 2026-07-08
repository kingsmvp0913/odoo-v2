// 意圖：E2E 改用 Odoo tour。tour-author agent 寫測試檔（副作用），Node 依 runTourTests exit code 判：
// exit0→review_pending；exit0 但 log 含「Chrome executable not found」＝tour 被 skip→env stopped；
// 失敗且分類 code→退 coding 計數（滿 PW_LIMIT→stopped）；分類 env→stopped/env。
const { newDb } = require('pg-mem');

process.env.APP_SECRET = 'test-app-secret';
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/claude-runner', () => ({ runClaude: jest.fn(), stopReason: (m) => m }));
jest.mock('../pipeline/agent-loader', () => ({ loadAgent: () => ({ model: 'sonnet', render: () => 'PROMPT' }) }));
jest.mock('../pipeline/task-agent', () => ({ getProjectInfo: jest.fn(), worktreeParent: () => '/cwd' }));
jest.mock('../pipeline/ensure-env', () => ({ ensureEnvRunning: jest.fn() }));
jest.mock('../pipeline/env-agent', () => ({ runTourTests: jest.fn() }));
jest.mock('../pipeline/failure-classifier', () => ({ classifyFailureWithAgent: jest.fn() }));
jest.mock('../pipeline/reentry', () => ({ bumpReentryOrStop: jest.fn().mockResolvedValue(false) }));

let dbModule, runTourStage, taskAgent, runClaude, ensureEnvRunning, envAgent, classifier, projectId, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('pw', $1, 'P') RETURNING id", [hash]);
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('PWP', '17.0') RETURNING id");
  projectId = p.id;

  taskAgent = require('../pipeline/task-agent');
  ({ runClaude } = require('../pipeline/claude-runner'));
  ({ ensureEnvRunning } = require('../pipeline/ensure-env'));
  envAgent = require('../pipeline/env-agent');
  classifier = require('../pipeline/failure-classifier');
  ({ runTourStage } = require('../pipeline/playwright-agent'));
});
afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  runClaude.mockReset(); runClaude.mockResolvedValue({ text: '', usage: {}, durationMs: 1 });
  taskAgent.getProjectInfo.mockReset(); taskAgent.getProjectInfo.mockResolvedValue({ root: '/repos/pwp' });
  ensureEnvRunning.mockReset(); ensureEnvRunning.mockResolvedValue(true);
  envAgent.runTourTests.mockReset();
  classifier.classifyFailureWithAgent.mockReset(); classifier.classifyFailureWithAgent.mockResolvedValue('code');
  require('../pipeline/reentry').bumpReentryOrStop.mockResolvedValue(false);
  await dbModule.query('DELETE FROM odoo_envs WHERE project_id=$1', [projectId]);
  await dbModule.query("INSERT INTO odoo_envs (project_id, status, url) VALUES ($1,'running','http://127.0.0.3:8070')", [projectId]);
});

let seq = 0;
async function makeTask(pwCount = 0) {
  seq++;
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status, project_id, analysis_yaml, pw_retry_count) VALUES ($1,$2,'manual','playwright_running',$3,'module: idx_x',$4) RETURNING id",
    [userId, `tt_${seq}`, projectId, pwCount]);
  return t.id;
}
const statusOf = async (id) => (await dbModule.query('SELECT status, blocker_type, pw_retry_count FROM tasks WHERE id=$1', [id])).rows[0];

test('tour 全過（exit0）→ review_pending', async () => {
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: 'idx_x: 1 passed, 0 failed' });
  const id = await makeTask();
  await runTourStage(id, userId);
  expect((await statusOf(id)).status).toBe('review_pending');
});

test('exit0 但 log 含 Chrome executable not found → env stopped（防假綠燈）', async () => {
  envAgent.runTourTests.mockResolvedValue({ ok: true, log: 'unittest.SkipTest: Chrome executable not found' });
  const id = await makeTask();
  await runTourStage(id, userId);
  const s = await statusOf(id);
  expect(s.status).toBe('stopped');
  expect(s.blocker_type).toBe('env');
});

test('tour 失敗且分類 code → 退 coding 並加計數', async () => {
  envAgent.runTourTests.mockRejectedValue(Object.assign(new Error('AssertionError: 備註T 欄位不存在'), { exitCode: 1 }));
  classifier.classifyFailureWithAgent.mockResolvedValue('code');
  const id = await makeTask(0);
  await runTourStage(id, userId);
  const s = await statusOf(id);
  expect(s.status).toBe('coding_running');
  expect(s.pw_retry_count).toBe(1);
});

test('tour 失敗且分類 env → stopped/env（不退 coding）', async () => {
  envAgent.runTourTests.mockRejectedValue(Object.assign(new Error('could not connect to database'), { exitCode: 1 }));
  classifier.classifyFailureWithAgent.mockResolvedValue('env');
  const id = await makeTask(0);
  await runTourStage(id, userId);
  const s = await statusOf(id);
  expect(s.status).toBe('stopped');
  expect(s.blocker_type).toBe('env');
});

test('code 失敗達 PW_LIMIT → stopped', async () => {
  envAgent.runTourTests.mockRejectedValue(Object.assign(new Error('AssertionError'), { exitCode: 1 }));
  classifier.classifyFailureWithAgent.mockResolvedValue('code');
  const id = await makeTask(2); // 第 3 次
  await runTourStage(id, userId);
  expect((await statusOf(id)).status).toBe('stopped');
});
