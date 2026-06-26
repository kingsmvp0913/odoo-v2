const { execFile, exec } = require('child_process');

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
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

module.exports = { createBranch, checkoutDefault, mergeBranch, runDeploy, getMainBranch, syncWithMain, abortMerge, commitAll, mergeToMain, deleteBranchLocal };
