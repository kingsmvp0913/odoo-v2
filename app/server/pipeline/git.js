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
    const commitArgs = [...identArgs(gitEnv), 'commit', '-m', '移除誤入版控的 __pycache__/*.pyc（pipeline 自動清理）'];
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

// 會產生 commit 的 git 指令，無 gitEnv 時必須自帶身分：git 沒有 user.email 就直接失敗
// （"Committer identity unknown"），而部署機的服務帳號通常沒設 global config——本機開發者有設，
// 故此類失敗只在正式機出現。gitEnv 有值時不加，讓 GIT_COMMITTER_* 決定歸屬（見 lib/git-identity）。
function identArgs(gitEnv) {
  return gitEnv ? [] : ['-c', 'user.name=pipeline', '-c', 'user.email=pipeline@local'];
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

// 分支相對主分支改動的檔案清單（相對 repo 根的路徑陣列，空白行剔除）。
async function diffNameOnly(repoPath, baseBranch, branch) {
  // core.quotePath=false：非 ASCII 檔名（中文 docx 範本、idx_ 模組）預設會被 git 用引號＋八進位
  // 跳脫，下游 code-zip 拿去 fs.existsSync 解不到→整批改動被誤判為刪除、回「無可打包程式」。
  const { stdout } = await execFileAsync(
    'git', ['-c', 'core.quotePath=false', 'diff', '--name-only', `${baseBranch}...${branch}`],
    { cwd: repoPath, maxBuffer: 16 * 1024 * 1024 }
  );
  return stdout.split('\n').map(s => s.trim()).filter(Boolean);
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
    const commitArgs = [...identArgs(gitEnv), 'commit', '--allow-empty', '-m', '初始化 main 分支（pipeline 自動建立）'];
    await execFileAsync('git', commitArgs, gitOpts(repoPath, gitEnv));
  }
  return 'main';
}

// pipeline 的主線分支：AI 產出一律落在此，實體 main 只有人工在 GitHub 上合併時才會動。
const AI_BRANCH = 'ai-dev';

// 確保本地有 ai-dev 並 checkout；沒有就從實體 main 建立並 push -u。回傳 AI_BRANCH。
// 只在「首次建立」時推遠端——使用者要在 GitHub 上看得到這條分支才能合併它；push 失敗不擋
// （無 PAT／origin 不通時仍應可本地跑），approve 那次 push 會補上。
async function ensureAiBranch(repoPath, gitEnv) {
  if (await refExists(repoPath, `refs/heads/${AI_BRANCH}`)) {
    await execFileAsync('git', ['checkout', AI_BRANCH], gitOpts(repoPath, gitEnv));
    return AI_BRANCH;
  }
  if (await refExists(repoPath, `refs/remotes/origin/${AI_BRANCH}`)) {
    await execFileAsync('git', ['checkout', '-B', AI_BRANCH, `origin/${AI_BRANCH}`], gitOpts(repoPath, gitEnv));
    return AI_BRANCH;
  }
  // 完全沒有 → 從實體 main 建（ensureMainBranch 一併處理空 repo／僅遠端有 main 的情況）
  const main = await ensureMainBranch(repoPath, gitEnv);
  await execFileAsync('git', ['checkout', '-B', AI_BRANCH, main], gitOpts(repoPath, gitEnv));
  await execFileAsync('git', ['push', '-u', 'origin', AI_BRANCH], gitOpts(repoPath, gitEnv)).catch(() => {});
  return AI_BRANCH;
}

// 把實體 main 的新 commit 帶進 ai-dev（初期仍有工程師直接改 main，不同步 AI 會拿過期的碼寫）。
// 回傳形狀比照 mergeInto，讓上層沿用同一套衝突處理。呼叫端須先 ensureAiBranch。
// 刻意不 push：ai-dev 只有平台會寫，累積到 approve 那次 push 一起送，減少網路往返。
async function syncMainIntoAi(repoPath, gitEnv) {
  const main = await getMainBranch(repoPath);
  await pullBranch(repoPath, main, gitEnv);      // checkout main + pull（origin 無此分支則放行）
  await pullBranch(repoPath, AI_BRANCH, gitEnv); // checkout ai-dev + pull
  ensureGitignorePyc(repoPath);
  await discardPyc(repoPath);
  try {
    await execFileAsync('git', [...identArgs(gitEnv), 'merge', '--no-ff', '--no-edit', main], gitOpts(repoPath, gitEnv));
    return { hasConflicts: false, conflictFiles: [] };
  } catch (err) {
    // git merge 衝突訊息寫在 stdout（非 stderr），三者都要看
    const msg = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`.toLowerCase();
    if (msg.includes('conflict') || msg.includes('automatic merge failed')) {
      const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], gitOpts(repoPath, gitEnv)).catch(() => ({ stdout: '' }));
      return { hasConflicts: true, conflictFiles: stdout.trim().split('\n').filter(Boolean) };
    }
    if (msg.includes('already up to date') || msg.includes('already up-to-date')) {
      return { hasConflicts: false, conflictFiles: [] };
    }
    throw err;
  }
}

// 讓任務 worktree 跟上 ai-dev。worktree 是 analysis 當下建的，任務常在規格審核／確認閘門停留
// 數天，期間 ai-dev 會被別的任務核准與實體 main 回流推進——不跟上的話 coding 在過期的碼上寫，
// 下載 zip 也會把期間的人工修正一起蓋掉。
// 允許 fast-forward：分支尚無自己的 commit（首次進 coding）時等同 reset，不生多餘的 merge commit。
// 衝突／任何失敗一律 abort 回乾淨狀態再回報，不 throw——同步失敗不該擋住任務（穩定 > 準確），
// 但半套 merge 留在 worktree 會讓 coding agent 把衝突標記當程式碼改。
async function syncBranchWithAi(worktreePath, gitEnv) {
  try {
    await execFileAsync('git', [...identArgs(gitEnv), 'merge', '--no-edit', AI_BRANCH], gitOpts(worktreePath, gitEnv));
    return { synced: true, conflictFiles: [], error: null };
  } catch (err) {
    // git merge 衝突訊息寫在 stdout（非 stderr），三者都要看
    const msg = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`.toLowerCase();
    if (msg.includes('already up to date') || msg.includes('already up-to-date')) {
      return { synced: true, conflictFiles: [], error: null };
    }
    let conflictFiles = [];
    if (msg.includes('conflict') || msg.includes('automatic merge failed')) {
      const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], gitOpts(worktreePath, gitEnv)).catch(() => ({ stdout: '' }));
      conflictFiles = stdout.trim().split('\n').filter(Boolean);
    }
    await abortMerge(worktreePath);
    return { synced: false, conflictFiles, error: err.message };
  }
}

async function syncWithMain(repoPath, gitEnv) {
  const main = await getMainBranch(repoPath);
  // fetch 失敗容忍（離線時退而 merge 本地 main），但要留下 lastErr 供最終歸因
  await execFileAsync('git', ['fetch', 'origin', main], gitOpts(repoPath, gitEnv)).catch(() => {});

  let lastErr = null;
  for (const target of [`origin/${main}`, main]) {
    try {
      await execFileAsync('git', [...identArgs(gitEnv), 'merge', target, '--no-edit'], gitOpts(repoPath, gitEnv));
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
  await execFileAsync('git', [...identArgs(gitEnv), 'commit', '-m', message], gitOpts(repoPath, gitEnv));
}

// 解衝突後只 stage「衝突檔本身」再 commit。git merge 撞衝突時已把非衝突變更放進 index，
// 這裡不可用 git add -A——否則會把工作樹裡未追蹤的產物（如 graphify 輸出、暫存檔）一併掃進
// testing，污染部署產物且撐大歷史。files 為空時仍 commit（涵蓋非衝突變更已入 index 的情形）。
async function commitResolved(repoPath, files, message, gitEnv) {
  if (files && files.length) {
    await execFileAsync('git', ['add', '--', ...files], gitOpts(repoPath, gitEnv));
  }
  await execFileAsync('git', [...identArgs(gitEnv), 'commit', '-m', message], gitOpts(repoPath, gitEnv));
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

// merge_conflict 逐檔裁決「取一側」：從 merge index 的某一 stage 取整檔內容覆蓋工作樹再 stage。
// side='theirs'＝被併入分支（task 分支，git stage 3）；side='ours'＝target 分支（testing，stage 2）。
// checkout --theirs/--ours 直接讀 index stage，不管工作樹現況（即使被 AI 寫壞也會被乾淨覆蓋）。
async function checkoutSide(repoPath, file, side) {
  const flag = side === 'ours' ? '--ours' : '--theirs';
  await execFileAsync('git', ['checkout', flag, '--', file], { cwd: repoPath });
  await execFileAsync('git', ['add', '--', file], { cwd: repoPath });
}

// 把某檔還原成「帶衝突標記」的狀態（-m＝recreate merge conflict）。用於自動解失敗／語法壞掉的檔：
// 若不還原，工作樹會留下 AI 寫壞的內容（無標記的散文/壞碼），走人工手解時看到的是垃圾而非真衝突。
async function restoreConflictMarkers(repoPath, file) {
  await execFileAsync('git', ['checkout', '-m', '--', file], { cwd: repoPath }).catch(() => {});
}

async function listUnmerged(repoPath) {
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repoPath });
  return stdout.trim().split('\n').filter(Boolean);
}

// merge_conflict 逐檔裁決套用（塊 C）：對 repo 內每個仍 unmerged 的檔——
// - choices 有指定 take_theirs/take_ours → 取該側；'manual' → 保留衝突（人工另解）。
// - 未指定的 unmerged 檔＝merge-agent 已自動解好、只是尚未 stage（失敗檔存在時不會 commitResolved）→
//   接受工作樹內容 stage 之。回傳套用後「仍 unmerged」的檔（manual／未決者）。
async function applyConflictChoices(repoPath, choices) {
  for (const f of await listUnmerged(repoPath)) {
    const action = choices.get(f);
    if (action === 'take_theirs') await checkoutSide(repoPath, f, 'theirs');
    else if (action === 'take_ours') await checkoutSide(repoPath, f, 'ours');
    else if (action === 'manual') { /* 保留衝突，人工另解 */ }
    else await execFileAsync('git', ['add', '--', f], { cwd: repoPath }); // 自動解好的檔：接受工作樹
  }
  return listUnmerged(repoPath);
}

// 審核通過後把任務分支併入 ai-dev 並推遠端。實體 main 不碰——使用者自行在 GitHub 上合併 ai-dev → main。
// ai-dev 只有平台會寫，故不存在「他人推了 main 導致本地過期」的非 fast-forward 競態。
async function mergeToAiBranch(repoPath, branchName, gitEnv) {
  ensureGitignorePyc(repoPath);
  await discardPyc(repoPath); // 避免 testing 工作樹上 tracked pyc 的改動擋住 checkout
  try {
    await execFileAsync('git', ['checkout', AI_BRANCH], gitOpts(repoPath, gitEnv));
  } catch {
    // 防禦：正常流程 analysis 已建好 ai-dev，此處僅涵蓋異常狀態
    const main = await getMainBranch(repoPath);
    await execFileAsync('git', ['checkout', '-B', AI_BRANCH, main], gitOpts(repoPath, gitEnv));
  }
  try {
    await execFileAsync('git', [...identArgs(gitEnv), 'merge', '--no-ff', branchName, '-m', `Merge branch '${branchName}'`], gitOpts(repoPath, gitEnv));
    await untrackPyc(repoPath, gitEnv); // 停止 ai-dev 追蹤 pyc → 之後從它長出的 task 分支不再帶 pyc
    // 沒推的話審核通過的程式碼只留在 server 本機 clone，遠端看不到（健檢：approve 缺 push）
    await execFileAsync('git', ['push', 'origin', AI_BRANCH], gitOpts(repoPath, gitEnv));
  } catch (err) {
    await execFileAsync('git', ['checkout', branchName], gitOpts(repoPath, gitEnv)).catch(() => {});
    throw err;
  }
}

// 把主 clone 切回常駐的 testing 分支（測試環境 addons 來源）。停在 main 會讓下一次 deploy
// 部署到錯的分支。回 true 代表沒切回去——呼叫端須明講，不可靜默。
async function restoreTestingCheckout(repoPath) {
  try {
    await discardPyc(repoPath);
    await ensureTestingBranch(repoPath);
    return false;
  } catch { return true; }
}

// 「上正式」：把 ai-dev 併進實體 main 並推遠端，與 mergeToAiBranch 反向，由使用者按按鈕觸發。
// 回 { merged, hasConflicts, conflictFiles, restoreFailed }；ai-dev 不存在（專案從未跑過任務）
// 回 merged:false 而非拋錯。衝突刻意不交給 AI 解——這是正式區，退回讓人在 GitHub 上處理。
async function releaseAiToMain(repoPath, gitEnv) {
  // 主 clone 的工作樹是 deploy 目標，常被 odoo-bin 弄髒；不先清，第一步 checkout 就會被
  // 「local changes would be overwritten」擋住。
  ensureGitignorePyc(repoPath);
  await discardPyc(repoPath);
  if (!(await refExists(repoPath, `refs/heads/${AI_BRANCH}`))) {
    return { merged: false, hasConflicts: false, conflictFiles: [], restoreFailed: false };
  }
  const main = await getMainBranch(repoPath);
  let result;
  try {
    // 本地 main 落後 origin/main（有人在 GitHub 上動過）時直接 merge+push 會被 non-fast-forward 打回
    await pullBranch(repoPath, main, gitEnv);
    const { hasConflicts, conflictFiles } = await mergeInto(repoPath, main, AI_BRANCH, gitEnv);
    if (hasConflicts) {
      await abortMerge(repoPath);
      result = { merged: false, hasConflicts: true, conflictFiles };
    } else {
      await execFileAsync('git', ['push', 'origin', main], gitOpts(repoPath, gitEnv));
      result = { merged: true, hasConflicts: false, conflictFiles: [] };
    }
  } catch (err) {
    await restoreTestingCheckout(repoPath); // 失敗也不能把主 clone 留在 main
    throw err;
  }
  result.restoreFailed = await restoreTestingCheckout(repoPath);
  return result;
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

// 重建 testing：checkout testing（缺則建）後 reset --hard 到最新 ai-dev。
// approved 任務碼已在 ai-dev，reset 到 ai-dev 即自動含入；呼叫端再重併在飛任務。
// ai-dev 尚未建立（專案從未跑過任務、僅用「更新 repo」）→ 退回實體 main，不讓重建整個失敗。
// 主 clone 工作樹是 deploy 目標，odoo-bin -u 會在其中留下產物；若沿用普通 checkout，從別的分支
// 切回 testing 會被「local/untracked would be overwritten」擋住 → 整個重建默默失敗（實測 task 84 卡住主因）。
// 重建本就是破壞性操作，故切換前先清 pyc、用 -f 強制切換、reset 後 clean 未追蹤殘留。
async function resetTestingToAiBranch(repoPath) {
  const base = (await refExists(repoPath, `refs/heads/${AI_BRANCH}`)) ? AI_BRANCH : await getMainBranch(repoPath);
  ensureGitignorePyc(repoPath);
  await discardPyc(repoPath);
  // 切換前先清未追蹤殘留（deploy/graphify 產物）：未追蹤檔若與 testing 追蹤的檔路徑相撞，
  // 連 checkout -f 都會被「untracked working tree files would be overwritten」擋住。-d 不含 -x，保留 .gitignore 忽略項。
  await execFileAsync('git', ['clean', '-fd'], { cwd: repoPath }).catch(() => {});
  // -f 強制切換，丟棄 tracked 檔的髒改動（deploy 目標工作樹常被 odoo-bin 弄髒）
  try {
    await execFileAsync('git', ['checkout', '-f', 'testing'], { cwd: repoPath });
  } catch {
    await execFileAsync('git', ['checkout', '-f', '-B', 'testing', base], { cwd: repoPath });
  }
  await execFileAsync('git', ['reset', '--hard', base], { cwd: repoPath });
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
// reset=true 才重置到最新 main（供 analysis 重跑讀最新碼），
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
    // reset 的原意是「分析重跑要讀最新碼」，前提是此階段尚無程式變更——但 respec（分診判需調整
    // 規格）會把已跑完 coding 的任務打回分析，此時分支上早有實作 commit，reset --hard 會把它整包
    // 丟掉、逼 coding 從零重寫（實測 task 157：只為改兩顆按鈕的 CSS class 重寫 179 行）。
    // 有領先 commit 就改用 merge 帶進最新 base，一樣達成「讀最新碼」，實作保留給下一輪外科式修改。
    const { stdout } = await execFileAsync('git', ['rev-list', '--count', `${base}..HEAD`], { cwd: worktreePath });
    if (Number(stdout.trim()) > 0) {
      // 併不進來（與 base 撞同幾行）→ abort 後維持原樣：寧可讓分析讀到略舊的碼，也不能丟掉實作。
      // 真正的衝突本來就由既有的 merge 關（task → testing）處理，不必在這裡搶著解。
      await execFileAsync('git', ['merge', '--no-edit', base], { cwd: worktreePath })
        .catch(async () => { await execFileAsync('git', ['merge', '--abort'], { cwd: worktreePath }).catch(() => {}); });
      return;
    }
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
    await execFileAsync('git', [...identArgs(gitEnv), 'merge', '--no-ff', '--no-edit', sourceBranch], gitOpts(mainRepoPath, gitEnv));
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
          await execFileAsync('git', [...identArgs(gitEnv), 'commit', '--no-edit'], gitOpts(mainRepoPath, gitEnv)).catch(() => {});
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

module.exports = { createBranch, checkoutDefault, mergeBranch, runDeploy, getMainBranch, ensureMainBranch, AI_BRANCH, ensureAiBranch, syncMainIntoAi, syncBranchWithAi, syncWithMain, abortMerge, commitAll, commitResolved, concludeMerge, checkoutSide, restoreConflictMarkers, listUnmerged, applyConflictChoices, mergeToAiBranch, releaseAiToMain, deleteBranchLocal, ensureTestingBranch, revParse, resetTestingToAiBranch, resetTestingTo, pullBranch, addWorktree, removeWorktree, ensureWorktreeAtMain, mergeInto, discardPyc, untrackPyc, diffBranch, diffNameOnly, refExists };
