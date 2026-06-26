const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../notify', () => ({
  emitToUser: jest.fn(),
  emitAll: jest.fn(),
  setIo: jest.fn()
}));

const spawnEvents = {};
const mockProc = {
  stdout: { on: jest.fn((event, cb) => { spawnEvents['stdout_' + event] = cb; }) },
  stderr: { on: jest.fn((event, cb) => { spawnEvents['stderr_' + event] = cb; }) },
  on: jest.fn((event, cb) => { spawnEvents[event] = cb; })
};

jest.mock('child_process', () => ({
  spawn: jest.fn(() => mockProc)
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
    `INSERT INTO users (username, password_hash, display_name, role, odoo_settings, coding_cmd)
     VALUES ('coder', $1, 'C', 'user', $2, 'echo done')
     RETURNING id`,
    [hash, JSON.stringify({ git_repo_path: '/repo' })]
  );
  userId = uRows[0].id;

  const { rows: tRows } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, git_branch)
     VALUES ($1, 'task_code_1', 'odoo', 'Test', 'coding_running', 'task/task_code_1')
     RETURNING id`,
    [userId]
  );
  taskId = tRows[0].id;

  agentModule = require('../pipeline/coding-agent');
}, 10000);

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  require('../notify').emitToUser.mockReset();
  Object.keys(spawnEvents).forEach(k => delete spawnEvents[k]);
  require('child_process').spawn.mockClear();
  mockProc.stdout.on.mockClear();
  mockProc.stderr.on.mockClear();
  mockProc.on.mockClear();
});

test('runCodingAgent streams stdout and sets qa_running on exit 0', async () => {
  const promise = agentModule.runCodingAgent(taskId, userId);

  await new Promise(r => setTimeout(r, 50));
  spawnEvents['stdout_data']?.(Buffer.from('hello\n'));
  spawnEvents['close']?.(0);
  await promise;

  const { emitToUser } = require('../notify');
  const outputCalls = emitToUser.mock.calls.filter(c => c[1] === 'terminal:output');
  expect(outputCalls.length).toBeGreaterThan(0);
  expect(outputCalls[0][2].data).toContain('hello');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('qa_running');

  const doneCalls = emitToUser.mock.calls.filter(c => c[1] === 'terminal:done');
  expect(doneCalls[0][2].exitCode).toBe(0);
});

test('runCodingAgent sets stopped on exit code non-zero', async () => {
  await dbModule.query("UPDATE tasks SET status='coding_running' WHERE id=$1", [taskId]);

  const promise = agentModule.runCodingAgent(taskId, userId);
  await new Promise(r => setTimeout(r, 50));
  spawnEvents['close']?.(1);
  await promise;

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');
});

test('runCodingAgent sets stopped + config blocker when coding_cmd not set', async () => {
  await dbModule.query("UPDATE users SET coding_cmd=NULL WHERE id=$1", [userId]);
  await dbModule.query("UPDATE tasks SET status='coding_running' WHERE id=$1", [taskId]);

  await agentModule.runCodingAgent(taskId, userId);
  expect(require('child_process').spawn).not.toHaveBeenCalled();

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');

  // Restore
  await dbModule.query("UPDATE users SET coding_cmd='echo done' WHERE id=$1", [userId]);
});
