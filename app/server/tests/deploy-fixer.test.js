const { newDb } = require('pg-mem');

const mockCallClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ callClaude: mockCallClaude }));

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({ execFile: mockExecFile }));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));

let dbModule, runDeployFixer;
let userSeq = 0;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ runDeployFixer } = require('../pipeline/deploy-fixer'));
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => { mockCallClaude.mockReset(); mockExecFile.mockReset(); });

async function makeTask(overrides = {}) {
  userSeq++;
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: [user] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ('df${userSeq}', $1, 'DF') RETURNING id`,
    [hash]
  );
  const { rows: [task] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, deploy_retry_count)
     VALUES ($1, $2, 'odoo', 'Deploy Test', 'deploy_fixing', $3) RETURNING id`,
    [user.id, `deploy${userSeq}`, overrides.retryCount || 0]
  );
  return { userId: user.id, taskId: task.id };
}

test('odoo_error → coding_running', async () => {
  mockCallClaude.mockResolvedValueOnce({ text: '{"type":"odoo_error","fix_bin":null,"fix_args":null}', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask();
  await runDeployFixer(taskId, userId, 'odoo.exceptions.UserError: Field does not exist');
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('coding_running');
});

test('env_error_fixable → fix ok → deploy_pending', async () => {
  mockCallClaude.mockResolvedValueOnce({ text: '{"type":"env_error_fixable","fix_bin":"pip","fix_args":["install","requests"]}', usage: null, durationMs: null });
  mockExecFile.mockImplementation((bin, args, opts, cb) => cb(null, 'Installed', ''));
  const { userId, taskId } = await makeTask();
  await runDeployFixer(taskId, userId, 'ModuleNotFoundError: No module named requests');
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('deploy_pending');
  expect(mockExecFile).toHaveBeenCalledWith('pip', ['install', 'requests'], expect.any(Object), expect.any(Function));
});

test('env_error_fixable → fix fails → stopped', async () => {
  mockCallClaude.mockResolvedValueOnce({ text: '{"type":"env_error_fixable","fix_bin":"pip","fix_args":["install","bad-pkg"]}', usage: null, durationMs: null });
  mockExecFile.mockImplementation((bin, args, opts, cb) => cb(new Error('fail'), '', 'pkg not found'));
  const { userId, taskId } = await makeTask();
  await runDeployFixer(taskId, userId, 'error');
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('stopped');
});

test('env_error_needs_auth → stopped', async () => {
  mockCallClaude.mockResolvedValueOnce({ text: '{"type":"env_error_needs_auth","fix_bin":null,"fix_args":null}', usage: null, durationMs: null });
  const { userId, taskId } = await makeTask();
  await runDeployFixer(taskId, userId, 'sudo apt-get install ...');
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('stopped');
});

test('max retry exceeded → stopped without calling API', async () => {
  const { userId, taskId } = await makeTask({ retryCount: 3 });
  await runDeployFixer(taskId, userId, 'some error');
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_content).toContain('上限');
  expect(mockCallClaude).not.toHaveBeenCalled();
});

test('API error → falls back to needs_auth → stopped', async () => {
  mockCallClaude.mockRejectedValueOnce(new Error('API down'));
  const { userId, taskId } = await makeTask();
  await runDeployFixer(taskId, userId, 'some error');
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskId]);
  expect(t.status).toBe('stopped');
});
