jest.mock('child_process', () => ({
  execFile: jest.fn(),
  exec: jest.fn()
}));

const childProcess = require('child_process');
let gitModule;

beforeAll(() => {
  gitModule = require('../pipeline/git');
});

beforeEach(() => {
  childProcess.execFile.mockReset();
  childProcess.exec.mockReset();
});

function mockExecFileSuccess() {
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    if (typeof opts === 'function') { opts(null, 'ok', ''); return; }
    cb(null, 'ok', '');
  });
}

function mockExecFileFail(msg) {
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    if (typeof opts === 'function') { opts(new Error(msg)); return; }
    cb(new Error(msg));
  });
}

test('createBranch calls git checkout -b with correct args', async () => {
  mockExecFileSuccess();
  await gitModule.createBranch('/repo', 'task/task_odoo_1');
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'git', ['checkout', '-b', 'task/task_odoo_1'],
    { cwd: '/repo' }, expect.any(Function)
  );
});

test('createBranch rejects on git error', async () => {
  mockExecFileFail('branch already exists');
  await expect(gitModule.createBranch('/repo', 'task/existing')).rejects.toThrow('branch already exists');
});

test('mergeBranch strategy=merge calls git merge --no-ff', async () => {
  mockExecFileSuccess();
  await gitModule.mergeBranch('/repo', 'task/task_odoo_1', 'merge');
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'git', ['merge', '--no-ff', 'task/task_odoo_1'],
    { cwd: '/repo' }, expect.any(Function)
  );
});

test('mergeBranch strategy=squash calls git merge --squash', async () => {
  mockExecFileSuccess();
  await gitModule.mergeBranch('/repo', 'task/task_odoo_1', 'squash');
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'git', ['merge', '--squash', 'task/task_odoo_1'],
    { cwd: '/repo' }, expect.any(Function)
  );
});

test('runDeploy resolves immediately when deployCmd is empty', async () => {
  await expect(gitModule.runDeploy('')).resolves.toBeUndefined();
  await expect(gitModule.runDeploy(null)).resolves.toBeUndefined();
  expect(childProcess.exec).not.toHaveBeenCalled();
});

test('runDeploy executes shell command when deployCmd is set', async () => {
  childProcess.exec.mockImplementation((cmd, opts, cb) => {
    cb(null, 'deployed', '');
  });
  const result = await gitModule.runDeploy('make deploy');
  expect(childProcess.exec).toHaveBeenCalledWith('make deploy', { timeout: 120000 }, expect.any(Function));
  expect(result).toEqual({ stdout: 'deployed', stderr: '' });
});
