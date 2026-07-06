const { execFile, exec } = require('child_process');

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      // execFile 失敗時 stdout/stderr 只在 callback 參數，需掛回 error 供上層判斷
      // （git merge 衝突訊息寫在 stdout，非 stderr）
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

async function createBranch(repoPath, branchName) {
  await execFileAsync('git', ['checkout', '-b', branchName], { cwd: repoPath });
}

async function checkoutDefault(repoPath) {
  try {
    await execFileAsync('git', ['checkout', 'master'], { cwd: repoPath });
    return 'master';
  } catch {
    await execFileAsync('git', ['checkout', 'main'], { cwd: repoPath });
    return 'main';
  }
}

async function mergeBranch(repoPath, branchName, strategy = 'merge') {
  const mergeArgs = strategy === 'squash'
    ? ['merge', '--squash', branchName]
    : ['merge', '--no-ff', branchName];
  await execFileAsync('git', mergeArgs, { cwd: repoPath });
}

function runDeploy(deployCmd) {
  if (!deployCmd) return Promise.resolve();
  return new Promise((resolve, reject) => {
    exec(deployCmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

async function getMainBranch(repoPath) {
  try {
    await execFileAsync('git', ['show-ref', '--verify', 'refs/remotes/origin/main'], { cwd: repoPath });
    return 'main';
  } catch {
    return 'master';
  }
}

async function syncWithMain(repoPath) {
  const main = await getMainBranch(repoPath);
  await execFileAsync('git', ['fetch', 'origin', main], { cwd: repoPath }).catch(() => {});

  for (const target of [`origin/${main}`, main]) {
    try {
      await execFileAsync('git', ['merge', target, '--no-edit'], { cwd: repoPath });
      return { hasConflicts: false, conflictFiles: [] };
    } catch (err) {
      const msg = (err.stderr || err.message || '').toLowerCase();
      if (msg.includes('conflict') || msg.includes('automatic merge failed')) {
        const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repoPath }).catch(() => ({ stdout: '' }));
        const conflictFiles = stdout.trim().split('\n').filter(Boolean);
        return { hasConflicts: true, conflictFiles };
      }
      if (msg.includes('already up to date') || msg.includes('already up-to-date')) {
        return { hasConflicts: false, conflictFiles: [] };
      }
    }
  }
  return { hasConflicts: false, conflictFiles: [] };
}

async function abortMerge(repoPath) {
  await execFileAsync('git', ['merge', '--abort'], { cwd: repoPath }).catch(() => {});
}

async function commitAll(repoPath, message) {
  await execFileAsync('git', ['add', '-A'], { cwd: repoPath });
  await execFileAsync('git', ['commit', '-m', message], { cwd: repoPath });
}

async function mergeToMain(repoPath, branchName) {
  const main = await getMainBranch(repoPath);
  await execFileAsync('git', ['checkout', main], { cwd: repoPath });
  try {
    await execFileAsync('git', ['merge', '--no-ff', branchName, '-m', `Merge branch '${branchName}'`], { cwd: repoPath });
  } catch (err) {
    await execFileAsync('git', ['checkout', branchName], { cwd: repoPath }).catch(() => {});
    throw err;
  }
}

async function deleteBranchLocal(repoPath, branchName) {
  await execFileAsync('git', ['branch', '-d', branchName], { cwd: repoPath });
}

// 確保主 clone 有 testing 分支並 checkout（常駐測試區分支，供測試環境部署）
async function ensureTestingBranch(repoPath) {
  try {
    await execFileAsync('git', ['checkout', 'testing'], { cwd: repoPath });
  } catch {
    await execFileAsync('git', ['checkout', '-b', 'testing'], { cwd: repoPath });
  }
}

// checkout 指定分支並從 origin pull 最新（分析前確保讀到最新碼）。失敗會 throw 供上層停止任務。
async function pullBranch(repoPath, branch) {
  await execFileAsync('git', ['checkout', branch], { cwd: repoPath });
  await execFileAsync('git', ['pull', 'origin', branch], { cwd: repoPath });
}

// 從主 clone 長出任務 worktree（branchName 從 baseBranch 建立）
async function addWorktree(mainRepoPath, worktreePath, branchName, baseBranch) {
  await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', branchName, baseBranch], { cwd: mainRepoPath });
}

// 移除任務 worktree（rollback 或封存清理用）
async function removeWorktree(mainRepoPath, worktreePath) {
  await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: mainRepoPath });
}

// 在主 clone 把 sourceBranch 併進 targetBranch（例：task/<id> → testing）。
// 回傳格式比照 syncWithMain，讓上層沿用衝突處理。
async function mergeInto(mainRepoPath, targetBranch, sourceBranch) {
  await execFileAsync('git', ['checkout', targetBranch], { cwd: mainRepoPath });
  try {
    await execFileAsync('git', ['merge', '--no-ff', '--no-edit', sourceBranch], { cwd: mainRepoPath });
    return { hasConflicts: false, conflictFiles: [] };
  } catch (err) {
    // git merge 衝突訊息寫在 stdout（非 stderr），三者都要看
    const msg = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`.toLowerCase();
    if (msg.includes('conflict') || msg.includes('automatic merge failed')) {
      const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: mainRepoPath }).catch(() => ({ stdout: '' }));
      const conflictFiles = stdout.trim().split('\n').filter(Boolean);
      return { hasConflicts: true, conflictFiles };
    }
    if (msg.includes('already up to date') || msg.includes('already up-to-date')) {
      return { hasConflicts: false, conflictFiles: [] };
    }
    throw err;
  }
}

module.exports = { createBranch, checkoutDefault, mergeBranch, runDeploy, getMainBranch, syncWithMain, abortMerge, commitAll, mergeToMain, deleteBranchLocal, ensureTestingBranch, pullBranch, addWorktree, removeWorktree, mergeInto };
