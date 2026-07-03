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

test('addWorktree creates worktree on new branch from base', async () => {
  mockExecFileSuccess();
  await gitModule.addWorktree('/repo', '/repo/.worktrees/task_1/main', 'task/task_1', 'testing');
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'git', ['worktree', 'add', '/repo/.worktrees/task_1/main', '-b', 'task/task_1', 'testing'],
    { cwd: '/repo' }, expect.any(Function)
  );
});

test('addWorktree rejects when branch already exists', async () => {
  mockExecFileFail("branch 'task/task_1' already exists");
  await expect(
    gitModule.addWorktree('/repo', '/repo/.worktrees/task_1/main', 'task/task_1', 'testing')
  ).rejects.toThrow('already exists');
});

test('removeWorktree forces removal', async () => {
  mockExecFileSuccess();
  await gitModule.removeWorktree('/repo', '/repo/.worktrees/task_1/main');
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'git', ['worktree', 'remove', '--force', '/repo/.worktrees/task_1/main'],
    { cwd: '/repo' }, expect.any(Function)
  );
});

test('ensureTestingBranch checks out existing testing branch', async () => {
  mockExecFileSuccess();
  await gitModule.ensureTestingBranch('/repo');
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'git', ['checkout', 'testing'], { cwd: '/repo' }, expect.any(Function)
  );
});

test('ensureTestingBranch creates testing branch when checkout fails', async () => {
  const calls = [];
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    calls.push(args);
    const done = typeof opts === 'function' ? opts : cb;
    // First call (checkout testing) fails, second (checkout -b testing) succeeds
    if (args[1] === 'testing' && args.length === 2) return done(new Error('did not match any'));
    done(null, 'ok', '');
  });
  await gitModule.ensureTestingBranch('/repo');
  expect(calls).toContainEqual(['checkout', '-b', 'testing']);
});

test('mergeInto returns no conflicts on clean merge into testing', async () => {
  mockExecFileSuccess();
  const result = await gitModule.mergeInto('/repo', 'testing', 'task/task_1');
  expect(result).toEqual({ hasConflicts: false, conflictFiles: [] });
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'git', ['checkout', 'testing'], { cwd: '/repo' }, expect.any(Function)
  );
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'git', ['merge', '--no-ff', '--no-edit', 'task/task_1'], { cwd: '/repo' }, expect.any(Function)
  );
});

test('mergeInto reports conflict files when merge fails with conflicts', async () => {
  // 真實 git：衝突訊息寫在 stdout（非 stderr、非 message）。此測試守住 stdout 判斷路徑。
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'merge') {
      const err = new Error('Command failed: git merge');  // message 不含衝突關鍵字
      return done(err, 'CONFLICT (content): Merge conflict in f.txt\nAutomatic merge failed', '');
    }
    if (args[0] === 'diff') return done(null, 'models/sale_order.py\n', '');
    done(null, 'ok', '');
  });
  const result = await gitModule.mergeInto('/repo', 'testing', 'task/task_1');
  expect(result.hasConflicts).toBe(true);
  expect(result.conflictFiles).toEqual(['models/sale_order.py']);
});
