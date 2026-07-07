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

test('pullBranch checkout 指定分支並從 origin pull', async () => {
  const calls = [];
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    calls.push(args);
    (typeof opts === 'function' ? opts : cb)(null, 'ok', '');
  });
  await gitModule.pullBranch('/repo', 'main');
  expect(calls).toContainEqual(['checkout', 'main']);
  expect(calls).toContainEqual(['pull', 'origin', 'main']);
});

test('pullBranch rejects when pull fails', async () => {
  mockExecFileFail('could not resolve host github.com');
  await expect(gitModule.pullBranch('/repo', 'main')).rejects.toThrow('could not resolve host');
});

test('pullBranch 容忍空遠端（couldn\'t find remote ref）→ 放行不 throw', async () => {
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    const done = (typeof opts === 'function') ? opts : cb;
    if (args[0] === 'pull') return done(new Error("fatal: couldn't find remote ref main"));
    done(null, 'ok', '');
  });
  await expect(gitModule.pullBranch('/repo', 'main')).resolves.toBeUndefined();
});

test('ensureMainBranch：無任何分支且無 commit → 建 main + 初始 empty commit', async () => {
  const calls = [];
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    const done = (typeof opts === 'function') ? opts : cb;
    calls.push(args);
    if (args[0] === 'show-ref') return done(new Error('not a valid ref'));   // refExists 全 false
    if (args[0] === 'rev-parse') return done(new Error('unknown revision')); // hasCommits false
    done(null, 'ok', '');
  });
  const branch = await gitModule.ensureMainBranch('/repo');
  expect(branch).toBe('main');
  expect(calls).toContainEqual(['checkout', '-B', 'main']);
  expect(calls.some(a => a[0] === '-c' && a.includes('commit') && a.includes('--allow-empty'))).toBe(true);
});

test('ensureMainBranch：本地已有 main → 直接 checkout，不建立', async () => {
  const calls = [];
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    const done = (typeof opts === 'function') ? opts : cb;
    calls.push(args);
    if (args[0] === 'show-ref') {
      return args[args.length - 1] === 'refs/heads/main' ? done(null, 'ok', '') : done(new Error('no'));
    }
    done(null, 'ok', '');
  });
  const branch = await gitModule.ensureMainBranch('/repo');
  expect(branch).toBe('main');
  expect(calls).toContainEqual(['checkout', 'main']);
  expect(calls.some(a => a.includes('--allow-empty'))).toBe(false);
});

test('mergeInto：target 分支不存在時從 main 建立再合併', async () => {
  const calls = [];
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    const done = (typeof opts === 'function') ? opts : cb;
    calls.push(args);
    if (args[0] === 'checkout' && args[1] === 'testing') return done(new Error("pathspec 'testing' did not match"));
    if (args[0] === 'show-ref') return args[args.length - 1] === 'refs/heads/main' ? done(null, 'ok', '') : done(new Error('no'));
    done(null, 'ok', '');
  });
  const r = await gitModule.mergeInto('/repo', 'testing', 'task/x');
  expect(r).toEqual({ hasConflicts: false, conflictFiles: [] });
  expect(calls).toContainEqual(['checkout', '-B', 'testing', 'main']);
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

// 意圖：tracked pyc（歷史誤入版控）被 Odoo 重編譯弄髒會擋住 merge，
// mergeInto 必須「先還原本地 pyc 改動、merge 後移出版控」，否則測試區每次併版都失敗。
test('mergeInto：merge 前還原 pyc 本地改動、merge 後把 pyc 移出版控', async () => {
  const calls = [];
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    calls.push(args);
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'diff' && args.includes('--cached')) return done(new Error('staged')); // 有 staged 變動 → 應 commit
    done(null, 'ok', '');
  });
  const result = await gitModule.mergeInto('/repo', 'testing', 'task/task_1');
  expect(result).toEqual({ hasConflicts: false, conflictFiles: [] });
  expect(calls).toContainEqual(['checkout', '--', '*.pyc']);                         // 先還原
  expect(calls).toContainEqual(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '*.pyc']); // 後移出版控
  expect(calls.some(a => a.includes('commit'))).toBe(true);                          // 有 staged → commit 清理
});

// 意圖：pyc 是 build 產物，衝突無意義；若衝突「只有 pyc」須自動化解完成 merge，不可卡任務。
test('mergeInto：pyc-only 假衝突自動化解，回傳無衝突', async () => {
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'merge') return done(new Error('x'), 'Automatic merge failed', '');
    if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
      return done(null, 'idx_x/models/__pycache__/sale_order.cpython-312.pyc\n', '');
    }
    done(null, 'ok', '');
  });
  const result = await gitModule.mergeInto('/repo', 'testing', 'task/task_1');
  expect(result).toEqual({ hasConflicts: false, conflictFiles: [] });
});

// 意圖：真正的原始碼衝突不得被 pyc 化解邏輯吞掉，仍要回報給人工處理。
test('mergeInto：pyc 與原始碼混合衝突時，仍回報非 pyc 檔', async () => {
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'merge') return done(new Error('x'), 'Automatic merge failed', '');
    if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
      return done(null, 'models/sale_order.py\nidx_x/models/__pycache__/sale_order.cpython-312.pyc\n', '');
    }
    done(null, 'ok', '');
  });
  const result = await gitModule.mergeInto('/repo', 'testing', 'task/task_1');
  expect(result.hasConflicts).toBe(true);
  expect(result.conflictFiles).toEqual(['models/sale_order.py']);
});

// 意圖：有 staged 變動才 commit 清理，無變動不得產生空 commit（避免污染歷史）。
test('untrackPyc：無 staged 變動時不 commit', async () => {
  const calls = [];
  childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
    calls.push(args);
    const done = typeof opts === 'function' ? opts : cb;
    done(null, 'ok', ''); // diff --cached --quiet 成功＝無變動
  });
  await gitModule.untrackPyc('/repo');
  expect(calls).toContainEqual(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '*.pyc']);
  expect(calls.some(a => a.includes('commit'))).toBe(false);
});
