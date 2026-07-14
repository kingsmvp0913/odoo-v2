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
async function untrackPyc(repoPath, gitEnv) {
  await execFileAsync('git', ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '*.pyc'], gitOpts(repoPath, gitEnv)).catch(() => {});
  try {
    // diff --cached --quiet：有 staged 變動時以非 0 離開 → 進 catch 才 commit
    await execFileAsync('git', ['diff', '--cached', '--quiet'], gitOpts(repoPath, gitEnv));
  } catch {
    const commitArgs = gitEnv
      ? ['commit', '-m', '移除誤入版控的 __pycache__/*.pyc（pipeline 自動清理）']
      : ['-c', 'user.name=pipeline', '-c', 'user.email=pipeline@local',
         'commit', '-m', '移除誤入版控的 __pycache__/*.pyc（pipeline 自動清理）'];
    await execFileAsync('git', commitArgs, gitOpts(repoPath, gitEnv)).catch(() => {});
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

// gitEnv 有值才把 env 併入 opts；無值維持 { cwd }，確保既有呼叫端與測試不受影響。
function gitOpts(cwd, gitEnv, extra) {
  const o = { cwd, ...extra };
  if (gitEnv) o.env = { ...process.env, ...gitEnv };
  return o;
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

// 任務分支相對主分支的完整 diff（三點語法＝只看分支自己的變更），供人工審核檢視
async function diffBranch(repoPath, baseBranch, branch) {
  const { stdout } = await execFileAsync(
    'git', ['diff', `${baseBranch}...${branch}`],
    { cwd: repoPath, maxBuffer: 16 * 1024 * 1024 }
  );
  return stdout;
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
async function ensureMainBranch(repoPath, gitEnv) {
  // 1) 本地已有 main/master
  for (const b of ['main', 'master']) {
    if (await refExists(repoPath, `refs/heads/${b}`)) {
      await execFileAsync('git', ['checkout', b], gitOpts(repoPath, gitEnv));
      return b;
    }
  }
  // 2) 僅遠端有 → 建立本地追蹤分支
  for (const b of ['main', 'master']) {
    if (await refExists(repoPath, `refs/remotes/origin/${b}`)) {
      await execFileAsync('git', ['checkout', '-B', b, `origin/${b}`], gitOpts(repoPath, gitEnv));
      return b;
    }
  }
  // 3) 完全沒有（空 repo / 未初始化）→ 本地建立 main；無 commit 則補一個空初始 commit
  await execFileAsync('git', ['checkout', '-B', 'main'], gitOpts(repoPath, gitEnv));
  if (!(await hasCommits(repoPath))) {
    const commitArgs = gitEnv
      ? ['commit', '--allow-empty', '-m', '初始化 main 分支（pipeline 自動建立）']
      : ['-c', 'user.name=pipeline', '-c', 'user.email=pipeline@local',
         'commit', '--allow-empty', '-m', '初始化 main 分支（pipeline 自動建立）'];
    await execFileAsync('git', commitArgs, gitOpts(repoPath, gitEnv));
  }
  return 'main';
}

async function syncWithMain(repoPath, gitEnv) {
  const main = await getMainBranch(repoPath);
  // fetch 失敗容忍（離線時退而 merge 本地 main），但要留下 lastErr 供最終歸因
  await execFileAsync('git', ['fetch', 'origin', main], gitOpts(repoPath, gitEnv)).catch(() => {});

  let lastErr = null;
  for (const target of [`origin/${main}`, main]) {
    try {
      await execFileAsync('git', ['merge', target, '--no-edit'], gitOpts(repoPath, gitEnv));
      return { hasConflicts: false, conflictFiles: [] };
    } catch (err) {
      const msg = (err.stderr || err.message || '').toLowerCase();
      if (msg.includes('conflict') || msg.includes('automatic merge failed')) {
        const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], gitOpts(repoPath, gitEnv)).catch(() => ({ stdout: '' }));
        const conflictFiles = stdout.trim().split('\n').filter(Boolean);
        return { hasConflicts: true, conflictFiles };
      }
      if (msg.includes('already up to date') || msg.includes('already up-to-date')) {
        return { hasConflicts: false, conflictFiles: [] };
      }
      lastErr = err;
    }
  }
  // 兩個 target 都以「非衝突、非 up-to-date」的原因失敗（unrelated histories、index 殘留等）＝真失敗，
  // 必須 throw——回「無衝突成功」會讓未實際同步的碼被當成已同步繼續往下跑（假成功）
  throw lastErr || new Error('syncWithMain：merge 失敗且無可歸因錯誤');
}

async function abortMerge(repoPath) {
  await execFileAsync('git', ['merge', '--abort'], { cwd: repoPath }).catch(() => {});
}

async function commitAll(repoPath, message, gitEnv) {
  await execFileAsync('git', ['add', '-A'], gitOpts(repoPath, gitEnv));
  await execFileAsync('git', ['commit', '-m', message], gitOpts(repoPath, gitEnv));
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

async function mergeToMain(repoPath, branchName, gitEnv) {
  ensureGitignorePyc(repoPath);
  await discardPyc(repoPath); // 避免 testing 工作樹上 tracked pyc 的改動擋住 checkout main
  const main = await getMainBranch(repoPath);
  await execFileAsync('git', ['checkout', main], gitOpts(repoPath, gitEnv));
  try {
    await execFileAsync('git', ['merge', '--no-ff', branchName, '-m', `Merge branch '${branchName}'`], gitOpts(repoPath, gitEnv));
    await untrackPyc(repoPath, gitEnv); // 停止 main 追蹤 pyc → 之後從 main 長出的 task 分支不再帶 pyc
    // 併入本機 main 後同步推遠端；沒推的話審核通過的程式碼只留在 server 本機 clone，遠端看不到（健檢：approve 缺 push）
    await execFileAsync('git', ['push', 'origin', main], gitOpts(repoPath, gitEnv));
  } catch (err) {
    await execFileAsync('git', ['checkout', branchName], gitOpts(repoPath, gitEnv)).catch(() => {});
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

// 讀某 ref 的 commit SHA（供重建 testing 前備份；呼叫端自行 catch 處理不存在的情況）
async function revParse(repoPath, ref) {
  const { stdout } = await execFileAsync('git', ['rev-parse', ref], { cwd: repoPath });
  return stdout.trim();
}

// 重建 testing：checkout testing（缺則建）後 reset --hard 到最新 main。
// approved 任務碼已在 main，reset 到 main 即自動含入；呼叫端再重併在飛任務。
async function resetTestingToMain(repoPath) {
  const main = await getMainBranch(repoPath);
  await ensureTestingBranch(repoPath);
  await execFileAsync('git', ['reset', '--hard', main], { cwd: repoPath });
}

// 還原 testing 到指定 SHA（重建失敗時回滾）
async function resetTestingTo(repoPath, sha) {
  await execFileAsync('git', ['checkout', 'testing'], { cwd: repoPath }).catch(() => {});
  await execFileAsync('git', ['reset', '--hard', sha], { cwd: repoPath });
}

// checkout 指定分支並從 origin pull 最新（分析前確保讀到最新碼）。
// origin 尚無該分支（空 repo / 尚未 push）→ 視為無可 pull、放行；其餘失敗（origin 不通／本地髒）→ throw 停任務。
async function pullBranch(repoPath, branch, gitEnv) {
  await execFileAsync('git', ['checkout', branch], gitOpts(repoPath, gitEnv));
  try {
    await execFileAsync('git', ['pull', 'origin', branch], gitOpts(repoPath, gitEnv));
  } catch (err) {
    const msg = `${err.stderr || ''}${err.message || ''}`.toLowerCase();
    if (msg.includes("couldn't find remote ref") || msg.includes('no such ref')) return;
    // pull 撞衝突會把主 clone 留在 merge-in-progress（MERGE_HEAD＋衝突標記），
    // 下次 checkout/pull 都會失敗、無法自癒——throw 前先清掉半殘 merge（best-effort）
    await abortMerge(repoPath);
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

// 任務 worktree（analysis 建、coding 沿用、approve 併 main 後才刪）：
// 確保在 <base>（最新 main）長出的 task 分支 worktree 存在。冪等——已存在時，
// reset=true 才重置到最新 main（供 analysis 重跑讀最新碼；此階段尚無程式變更），
// reset=false 則保留現有內容（branch_pending 沿用 analysis 已建好的，不動已有工作）。
async function ensureWorktreeAtMain(mainRepoPath, worktreePath, branch, base, reset) {
  ensureGitignorePyc(mainRepoPath);
  const isWorktree = fs.existsSync(path.join(worktreePath, '.git'));
  if (!isWorktree) {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: mainRepoPath }).catch(() => {});
    await execFileAsync('git', ['worktree', 'prune'], { cwd: mainRepoPath }).catch(() => {});
    await execFileAsync('git', ['worktree', 'add', '-B', branch, worktreePath, base], { cwd: mainRepoPath });
    return;
  }
  if (reset) {
    await execFileAsync('git', ['reset', '--hard', base], { cwd: worktreePath });
    await execFileAsync('git', ['clean', '-fd'], { cwd: worktreePath });
  }
}

// 在主 clone 把 sourceBranch 併進 targetBranch（例：task/<id> → testing）。
// 回傳格式比照 syncWithMain，讓上層沿用衝突處理。
async function mergeInto(mainRepoPath, targetBranch, sourceBranch, gitEnv) {
  // 確保 target 分支存在：沒有（空 repo / 尚未建 testing）就從主分支建出來，避免 checkout 失敗卡住
  try {
    await execFileAsync('git', ['checkout', targetBranch], gitOpts(mainRepoPath, gitEnv));
  } catch {
    const base = await getMainBranch(mainRepoPath);
    await execFileAsync('git', ['checkout', '-B', targetBranch, base], gitOpts(mainRepoPath, gitEnv));
  }
  ensureGitignorePyc(mainRepoPath); // 讓 target 工作樹既有的未追蹤 pyc 變 ignored，merge 才不會被擋
  await discardPyc(mainRepoPath);   // 再還原 tracked pyc 的本地改動，解除「local changes would be overwritten」
  try {
    await execFileAsync('git', ['merge', '--no-ff', '--no-edit', sourceBranch], gitOpts(mainRepoPath, gitEnv));
    await untrackPyc(mainRepoPath, gitEnv); // merge 後把 target（testing）上的 pyc 移出版控，之後不再累積
    return { hasConflicts: false, conflictFiles: [] };
  } catch (err) {
    // git merge 衝突訊息寫在 stdout（非 stderr），三者都要看
    const msg = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`.toLowerCase();
    if (msg.includes('conflict') || msg.includes('automatic merge failed')) {
      const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], gitOpts(mainRepoPath, gitEnv)).catch(() => ({ stdout: '' }));
      let conflictFiles = stdout.trim().split('\n').filter(Boolean);
      // pyc 是 build 產物，衝突無意義：移除後若已無真正衝突就完成這次 merge，避免假衝突卡任務
      const pyc = conflictFiles.filter(f => f.endsWith('.pyc'));
      if (pyc.length) {
        await execFileAsync('git', ['rm', '-f', '--quiet', '--ignore-unmatch', ...pyc], gitOpts(mainRepoPath, gitEnv)).catch(() => {});
        conflictFiles = conflictFiles.filter(f => !f.endsWith('.pyc'));
        if (conflictFiles.length === 0) {
          const commitArgs = gitEnv
            ? ['commit', '--no-edit']
            : ['-c', 'user.name=pipeline', '-c', 'user.email=pipeline@local', 'commit', '--no-edit'];
          await execFileAsync('git', commitArgs, gitOpts(mainRepoPath, gitEnv)).catch(() => {});
          await untrackPyc(mainRepoPath, gitEnv);
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

module.exports = { createBranch, checkoutDefault, mergeBranch, runDeploy, getMainBranch, ensureMainBranch, syncWithMain, abortMerge, commitAll, concludeMerge, mergeToMain, deleteBranchLocal, ensureTestingBranch, revParse, resetTestingToMain, resetTestingTo, pullBranch, addWorktree, removeWorktree, ensureWorktreeAtMain, mergeInto, discardPyc, untrackPyc, diffBranch, refExists };
