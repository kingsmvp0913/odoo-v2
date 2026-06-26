const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../notify', () => ({
  emitToUser: jest.fn(),
  emitAll: jest.fn(),
  setIo: jest.fn()
}));

const qaSpawnEvents = {};
const mockQaProc = {
  stdout: { on: jest.fn((event, cb) => { qaSpawnEvents['stdout_' + event] = cb; }) },
  stderr: { on: jest.fn((event, cb) => { qaSpawnEvents['stderr_' + event] = cb; }) },
  on: jest.fn((event, cb) => { qaSpawnEvents[event] = cb; })
};

jest.mock('child_process', () => ({
  spawn: jest.fn(() => mockQaProc)
}));

let dbModule, agentModule, userId, taskId;

beforeAll(async () => {
  const db = require('pg-mem').newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: uRows } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, role, odoo_settings, qa_cmd)
     VALUES ('qa_user', $1, 'Q', 'user', $2, 'npm test')
     RETURNING id`,
    [hash, JSON.stringify({ git_repo_path: '/repo' })]
  );
  userId = uRows[0].id;

  const { rows: tRows } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, git_branch)
     VALUES ($1, 'task_qa_1', 'odoo', 'Test', 'qa_running', 'task/task_qa_1')
     RETURNING id`,
    [userId]
  );
  taskId = tRows[0].id;

  agentModule = require('../pipeline/qa-agent');
}, 10000);

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  require('../notify').emitToUser.mockReset();
  Object.keys(qaSpawnEvents).forEach(k => delete qaSpawnEvents[k]);
  require('child_process').spawn.mockClear();
  mockQaProc.stdout.on.mockClear();
  mockQaProc.stderr.on.mockClear();
  mockQaProc.on.mockClear();
});

test('runQaAgent sets deploy_pending on exit 0', async () => {
  const promise = agentModule.runQaAgent(taskId, userId);
  await new Promise(r => setTimeout(r, 50));
  qaSpawnEvents['stdout_data']?.(Buffer.from('tests passed\n'));
  qaSpawnEvents['close']?.(0);
  await promise;

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('deploy_pending');

  const { emitToUser } = require('../notify');
  const doneCalls = emitToUser.mock.calls.filter(c => c[1] === 'terminal:done');
  expect(doneCalls[0][2].exitCode).toBe(0);
});

test('runQaAgent sets stopped on exit code non-zero', async () => {
  await dbModule.query("UPDATE tasks SET status='qa_running' WHERE id=$1", [taskId]);

  const promise = agentModule.runQaAgent(taskId, userId);
  await new Promise(r => setTimeout(r, 50));
  qaSpawnEvents['close']?.(2);
  await promise;

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');
});

test('runQaAgent sets stopped + config blocker when qa_cmd not set', async () => {
  await dbModule.query("UPDATE users SET qa_cmd=NULL WHERE id=$1", [userId]);
  await dbModule.query("UPDATE tasks SET status='qa_running' WHERE id=$1", [taskId]);

  await agentModule.runQaAgent(taskId, userId);
  expect(require('child_process').spawn).not.toHaveBeenCalled();

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');

  await dbModule.query("UPDATE users SET qa_cmd='npm test' WHERE id=$1", [userId]);
});
