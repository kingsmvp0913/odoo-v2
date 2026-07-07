const { execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// 讓 git 忽略 __pycache__/*.pyc（Odoo/py_compile 產物）。寫進主 clone 的 .git/info/exclude，
// linked worktree 共用 common git dir 一併生效。效果：git add -A 不會 commit pyc；merge 時
// 未追蹤的 pyc 變成 ignored → git 直接覆蓋、不再報「untracked working tree files would be overwritten」。
function ensureGitignorePyc(mainRepoPath) {
  try {
    const excludeFile = path.join(mainRepoPath, '.git', 'info', 'exclude');
    let cur = '';
    try { cur = fs.readFileSync(excludeFile, 'utf8'); } catch { /* 檔案不存在則新建 */ }
    const lines = cur.split(/\r?\n/);
    const need = ['__pycache__/', '*.pyc'].filter(p => !lines.includes(p));
    if (need.length) fs.appendFileSync(excludeFile, (cur && !cur.endsWith('\n') ? '\n' : '') + need.join('\n') + '\n');
  } catch { /* best-effort，不阻斷流程 */ }
}

// 丟掉「已被追蹤（tracked）的 pyc」在工作樹的本地改動：Odoo 重新編譯會弄髒這些歷史誤入版控的
// build 產物 → 擋住 merge/checkout（git 報「Your local changes to the following files would be
// overwritten」）。exclude 只對未追蹤檔生效，救不到 tracked pyc，故需此步先還原。
async function discardPyc(repoPath) {
  await execFileAsync('git', ['checkout', '--', '*.pyc'], { cwd: repoPath }).catch(() => {});
}

// 把 tracked pyc 從 index 移除（配合 exclude 永久忽略），有 staged 變動才 commit（避免空 commit）。
// 一次根治：之後該分支不再追蹤 pyc，從它長出的分支／併入它的 merge 都不再被 build 產物干擾。
async function untrackPyc(repoPath) {
  await execFileAsync('git', ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '*.pyc'], { cwd: repoPath }).catch(() => {});
  try {
    // diff --cached --quiet：有 staged 變動時以非 0 離開 → 進 catch 才 commit
    await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: repoPath });
  } catch {
    await execFileAsync('git', [
      '-c', 'user.name=pipeline', '-c', 'user.email=pipeline@local',
      'commit', '-m', '移除誤入版控的 __pycache__/*.pyc（pipeline 自動清理）'
    ], { cwd: repoPath }).catch(() => {});
  }
}

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

// ref 是否存在（本地/遠端分支）
async function refExists(repoPath, ref) {
  try {
    await execFileAsync('git', ['show-ref', '--verify', '--quiet', ref], { cwd: repoPath });
    return true;
  } catch { return false; }
}

// repo 是否已有任何 commit（unborn HEAD → false）
async function hasCommits(repoPath) {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repoPath });
    return true;
  } catch { return false; }
}

// 偵測 repo 的主分支：依序查本地 main/master、origin/main/master；都沒有則預設 'main'
// （不再盲目 fallback 'master'，避免對只有 main 或空 repo 的專案 checkout master 失敗）
async function getMainBranch(repoPath) {
  const refs = ['refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master'];
  for (const ref of refs) {
    if (await refExists(repoPath, ref)) return ref.split('/').pop();
  }
  return 'main';
}

// 確保本地有可用的主分支並 checkout；沒有就建立（空 repo 補一個初始 commit）。回傳分支名。
// 供分析前使用：避免「repo 無 main」時整條流程卡死。
async function ensureMainBranch(repoPath) {
  // 1) 本地已有 main/master
  for (const b of ['main', 'master']) {
    if (await refExists(repoPath, `refs/heads/${b}`)) {
      await execFileAsync('git', ['checkout', b], { cwd: repoPath });
      return b;
    }
  }
  // 2) 僅遠端有 → 建立本地追蹤分支
  for (const b of ['main', 'master']) {
    if (await refExists(repoPath, `refs/remotes/origin/${b}`)) {
      await execFileAsync('git', ['checkout', '-B', b, `origin/${b}`], { cwd: repoPath });
      return b;
    }
  }
  // 3) 完全沒有（空 repo / 未初始化）→ 本地建立 main；無 commit 則補一個空初始 commit
  await execFileAsync('git', ['checkout', '-B', 'main'], { cwd: repoPath });
  if (!(await hasCommits(repoPath))) {
    await execFileAsync('git', [
      '-c', 'user.name=pipeline', '-c', 'user.email=pipeline@local',
      'commit', '--allow-empty', '-m', '初始化 main 分支（pipeline 自動建立）'
    ], { cwd: repoPath });
  }
  return 'main';
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

// merge_conflict 人工解完後的收尾驗證：仍有未解衝突就拋錯擋下；有 MERGE_HEAD 就 commit 了結。
// 沒有這道防線，半套 merge（衝突標記）會直接進 deploy，Python SyntaxError 被誤歸因為程式問題。
async function concludeMerge(repoPath) {
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repoPath });
  const unmerged = stdout.trim().split('\n').filter(Boolean);
  if (unmerged.length) throw new Error(`仍有未解的衝突檔：${unmerged.join(', ')}`);
  if (fs.existsSync(path.join(repoPath, '.git', 'MERGE_HEAD'))) {
    await commitAll(repoPath, '[merge] resolve conflicts (manual)');
  }
}

async function mergeToMain(repoPath, branchName) {
  ensureGitignorePyc(repoPath);
  await discardPyc(repoPath); // 避免 testing 工作樹上 tracked pyc 的改動擋住 checkout main
  const main = await getMainBranch(repoPath);
  await execFileAsync('git', ['checkout', main], { cwd: repoPath });
  try {
    await execFileAsync('git', ['merge', '--no-ff', branchName, '-m', `Merge branch '${branchName}'`], { cwd: repoPath });
    await untrackPyc(repoPath); // 停止 main 追蹤 pyc → 之後從 main 長出的 task 分支不再帶 pyc
  } catch (err) {
    await execFileAsync('git', ['checkout', branchName], { cwd: repoPath }).catch(() => {});
    throw err;
  }
}

async function deleteBranchLocal(repoPath, branchName, force = false) {
  await execFileAsync('git', ['branch', force ? '-D' : '-d', branchName], { cwd: repoPath });
}

// 確保主 clone 有 testing 分支並 checkout（常駐測試區分支，供測試環境部署）
async function ensureTestingBranch(repoPath) {
  try {
    await execFileAsync('git', ['checkout', 'testing'], { cwd: repoPath });
  } catch {
    await execFileAsync('git', ['checkout', '-b', 'testing'], { cwd: repoPath });
  }
}

// checkout 指定分支並從 origin pull 最新（分析前確保讀到最新碼）。
// origin 尚無該分支（空 repo / 尚未 push）→ 視為無可 pull、放行；其餘失敗（origin 不通／本地髒）→ throw 停任務。
async function pullBranch(repoPath, branch) {
  await execFileAsync('git', ['checkout', branch], { cwd: repoPath });
  try {
    await execFileAsync('git', ['pull', 'origin', branch], { cwd: repoPath });
  } catch (err) {
    const msg = `${err.stderr || ''}${err.message || ''}`.toLowerCase();
    if (msg.includes("couldn't find remote ref") || msg.includes('no such ref')) return;
    throw err;
  }
}

// 從主 clone 長出任務 worktree（branchName 從 baseBranch 建立）。
// 先清掉同名的殘留 worktree／分支，讓重跑可冪等（前一輪 stopped 未清乾淨時，重分診不會再撞「已存在」）。
async function addWorktree(mainRepoPath, worktreePath, branchName, baseBranch) {
  ensureGitignorePyc(mainRepoPath);
  await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: mainRepoPath }).catch(() => {});
  await execFileAsync('git', ['worktree', 'prune'], { cwd: mainRepoPath }).catch(() => {});
  await execFileAsync('git', ['branch', '-D', branchName], { cwd: mainRepoPath }).catch(() => {});
  await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', branchName, baseBranch], { cwd: mainRepoPath });
}

// 移除任務 worktree（rollback 或封存清理用）
async function removeWorktree(mainRepoPath, worktreePath) {
  await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: mainRepoPath });
}

// 拋棄式唯讀 worktree：於指定 ref（如 main）建立 detached HEAD 的隔離工作目錄。
// 供 analysis 讀乾淨 main，不受共用主 clone 當下 checkout 哪個分支影響（健檢 U7）。
async function addDetachedWorktree(mainRepoPath, worktreePath, ref) {
  await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: mainRepoPath }).catch(() => {});
  await execFileAsync('git', ['worktree', 'prune'], { cwd: mainRepoPath }).catch(() => {});
  await execFileAsync('git', ['worktree', 'add', '--detach', worktreePath, ref], { cwd: mainRepoPath });
}

// 在主 clone 把 sourceBranch 併進 targetBranch（例：task/<id> → testing）。
// 回傳格式比照 syncWithMain，讓上層沿用衝突處理。
async function mergeInto(mainRepoPath, targetBranch, sourceBranch) {
  // 確保 target 分支存在：沒有（空 repo / 尚未建 testing）就從主分支建出來，避免 checkout 失敗卡住
  try {
    await execFileAsync('git', ['checkout', targetBranch], { cwd: mainRepoPath });
  } catch {
    const base = await getMainBranch(mainRepoPath);
    await execFileAsync('git', ['checkout', '-B', targetBranch, base], { cwd: mainRepoPath });
  }
  ensureGitignorePyc(mainRepoPath); // 讓 target 工作樹既有的未追蹤 pyc 變 ignored，merge 才不會被擋
  await discardPyc(mainRepoPath);   // 再還原 tracked pyc 的本地改動，解除「local changes would be overwritten」
  try {
    await execFileAsync('git', ['merge', '--no-ff', '--no-edit', sourceBranch], { cwd: mainRepoPath });
    await untrackPyc(mainRepoPath); // merge 後把 target（testing）上的 pyc 移出版控，之後不再累積
    return { hasConflicts: false, conflictFiles: [] };
  } catch (err) {
    // git merge 衝突訊息寫在 stdout（非 stderr），三者都要看
    const msg = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`.toLowerCase();
    if (msg.includes('conflict') || msg.includes('automatic merge failed')) {
      const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: mainRepoPath }).catch(() => ({ stdout: '' }));
      let conflictFiles = stdout.trim().split('\n').filter(Boolean);
      // pyc 是 build 產物，衝突無意義：移除後若已無真正衝突就完成這次 merge，避免假衝突卡任務
      const pyc = conflictFiles.filter(f => f.endsWith('.pyc'));
      if (pyc.length) {
        await execFileAsync('git', ['rm', '-f', '--quiet', '--ignore-unmatch', ...pyc], { cwd: mainRepoPath }).catch(() => {});
        conflictFiles = conflictFiles.filter(f => !f.endsWith('.pyc'));
        if (conflictFiles.length === 0) {
          await execFileAsync('git', [
            '-c', 'user.name=pipeline', '-c', 'user.email=pipeline@local', 'commit', '--no-edit'
          ], { cwd: mainRepoPath }).catch(() => {});
          await untrackPyc(mainRepoPath);
          return { hasConflicts: false, conflictFiles: [] };
        }
      }
      return { hasConflicts: true, conflictFiles };
    }
    if (msg.includes('already up to date') || msg.includes('already up-to-date')) {
      return { hasConflicts: false, conflictFiles: [] };
    }
    throw err;
  }
}

module.exports = { createBranch, checkoutDefault, mergeBranch, runDeploy, getMainBranch, ensureMainBranch, syncWithMain, abortMerge, commitAll, concludeMerge, mergeToMain, deleteBranchLocal, ensureTestingBranch, pullBranch, addWorktree, removeWorktree, addDetachedWorktree, mergeInto, discardPyc, untrackPyc };
