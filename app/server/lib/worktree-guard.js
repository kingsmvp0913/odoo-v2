// app/server/lib/worktree-guard.js
/**
 * worktree-guard.js — 宿主對任務 worktree 跑 git 前，把 git 指標寫回正確值（子專案 0，09-17 裁決 R12）
 *
 * 容器寫得到任務 worktree 的 `.git` 檔與它在主 clone 的 admin 目錄（.git/worktrees/<name>/），
 * 而平台會在宿主、以該 worktree 為 cwd 跑 git（merge／reset --hard／clean）。放著不管：
 *  - admin HEAD 指到 testing → 宿主的 commit／reset 替 AI 移動 testing，繞過掛載層的 refs 鎖
 *  - .git 檔或 commondir 指到假 repo（config 放 filter.smudge）→ 宿主 reset --hard 執行任意指令
 * R10 的「讀出來驗」擋不住捷徑繞法（HEAD 做成 symlink、admin 裡放影子 ref，讀內容照樣正常），
 * 所以改成不驗、直接寫回：
 *  1. 先等掛著這個 worktree 的容器真的結束（sandbox-run.waitForWorktreeIdle），否則寫完還會被改
 *  2. admin 目錄由宿主從主 clone 的 .git/worktrees/*／gitdir 自己找，不信 worktree 的 .git 檔
 *  3. 指標檔一律「先刪再以 wx 建立」：不跟隨既有 symlink，也不會寫穿到別處
 *  4. （R14）admin 目錄整個清空重建（只留一般檔 index）；任務分支 ref 只接受 commit id，否則停下
 * 容器掛載（agent-mounts.js）找 admin 目錄也用同一個 findAdminDir。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const execFileAsync = require('util').promisify(execFile);

function fail(code, msg) {
  return Object.assign(new Error(`任務 worktree 的 git 中繼資料不合法（可能被竄改），需由管理員重建：${msg}`), { code });
}
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };
function readNoFollow(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
}

// 錯誤 code：
//  WORKTREE_MISSING       worktree 目錄不存在
//  WORKTREE_ADMIN_MISSING 主 clone 沒有任何 admin 目錄認領這個 worktree（主 clone 重建後的死工作樹）
//  WORKTREE_TAMPERED      其餘（worktree 是 symlink、多個 admin 同時認領…）
function findAdminDir(repoPath, worktreePath) {
  const st = lstat(worktreePath);
  if (!st) throw fail('WORKTREE_MISSING', `worktree 不存在：${worktreePath}`);
  if (!st.isDirectory()) throw fail('WORKTREE_TAMPERED', `worktree 不是一般目錄：${worktreePath}`);
  let commonGit;
  try { commonGit = fs.realpathSync(path.join(repoPath, '.git')); } catch { throw fail('WORKTREE_TAMPERED', `讀不到主 clone 的 .git：${repoPath}`); }
  const wtReal = fs.realpathSync(worktreePath);
  const root = path.join(commonGit, 'worktrees');
  let names = [];
  try { names = fs.readdirSync(root); } catch { names = []; }
  const hits = [];
  for (const n of names) {
    const admin = path.join(root, n);
    const s = lstat(admin);
    if (!s || !s.isDirectory()) continue;
    let g;
    try { g = readNoFollow(path.join(admin, 'gitdir')).trim(); } catch { continue; }
    const target = path.dirname(path.resolve(admin, g));
    let real;
    try { real = fs.realpathSync(target); } catch { real = target; }
    if (real === wtReal) hits.push(admin);
  }
  if (!hits.length) throw fail('WORKTREE_ADMIN_MISSING', `主 clone 裡沒有 admin 目錄認領 ${worktreePath}`);
  if (hits.length > 1) throw fail('WORKTREE_TAMPERED', `多個 admin 目錄同時認領 ${worktreePath}：${hits.join(', ')}`);
  return hits[0];
}

// 任務分支 ref 的完整性（09-17 R14）：refs/heads/task/ 與 logs/refs/heads/task/ 容器可寫。
// loose ref 被寫成 `ref: refs/heads/testing` 這種 symref，宿主的 commit／merge／reset，甚至重建路徑的
// `worktree add -B`，都會經由它移動 testing。只接受「不存在（在唯讀的 packed-refs）」或「內容只有 commit id
// 的一般檔」；其餘一律丟例外——不跟隨、不自動修（停下交人工）。
// reflog 不是一般檔（symlink／目錄）就移除：宿主寫 reflog 是 append，會經由 symlink 寫到宿主別的檔。
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?\n?$/;
function tamperedRef(msg) {
  return Object.assign(new Error(`任務分支的 ref 疑似被竄改，已停止（不會自動修復，需由管理員確認）：${msg}`), { code: 'WORKTREE_TAMPERED' });
}
function assertBranchName(branch) {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.split('/').some(x => !x || x === '.' || x === '..')) {
    throw new Error(`任務分支名不合法：${branch}`);
  }
}
function assertTaskBranchRef(repoPath, branch) {
  assertBranchName(branch);
  let commonGit;
  try { commonGit = fs.realpathSync(path.join(repoPath, '.git')); } catch { throw tamperedRef(`讀不到主 clone 的 .git：${repoPath}`); }
  const parts = branch.split('/');
  // 中間層目錄（refs/heads/task、logs/refs/heads/task）：不存在可以（git 會自己建），存在就必須是真目錄
  const checkDirs = base => {
    let cur = base;
    for (const seg of parts.slice(0, -1)) {
      cur = path.join(cur, seg);
      const s = lstat(cur);
      if (!s) return false;
      if (!s.isDirectory()) throw tamperedRef(`${path.relative(commonGit, cur)} 不是一般目錄`);
    }
    return true;
  };
  const refFile = path.join(commonGit, 'refs', 'heads', ...parts);
  if (checkDirs(path.join(commonGit, 'refs', 'heads'))) {
    const s = lstat(refFile);
    if (s) {
      if (!s.isFile()) throw tamperedRef(`refs/heads/${branch} 不是一般檔案`);
      let content;
      try { content = readNoFollow(refFile); } catch (e) { throw tamperedRef(`讀不到 refs/heads/${branch}：${e.message}`); }
      if (!SHA_RE.test(content)) throw tamperedRef(`refs/heads/${branch} 的內容不是 commit id`);
    }
  }
  const logFile = path.join(commonGit, 'logs', 'refs', 'heads', ...parts);
  if (checkDirs(path.join(commonGit, 'logs', 'refs', 'heads'))) {
    const s = lstat(logFile);
    if (s && !s.isFile()) fs.rmSync(logFile, { recursive: true, force: true });
  }
}

// 清空 admin 目錄（09-17 R14）：R12 只寫回四個指標，ORIG_HEAD／MERGE_MSG／AUTO_MERGE… 等其餘檔容器照樣寫得到，
// 宿主的 merge／reset 會經由 symref 移動 testing、經由 symlink 覆寫宿主檔案。與其逐一列舉，不如整個清掉：
// 只保留一般檔的 index（使用者／AI 已暫存的變更），其餘不論是檔、symlink 或目錄一律移除（不跟隨 symlink）。
function wipeAdminDir(admin) {
  for (const name of fs.readdirSync(admin)) {
    const p = path.join(admin, name);
    const s = lstat(p);
    if (!s) continue;
    if (name === 'index' && s.isFile()) continue;
    if (s.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  }
}

// 呼叫前提：呼叫端已在拿專案鎖「之前」await sandbox-run.waitForWorktreeIdle（會等到容器結束）。
// 這裡預設只做不阻塞的檢查：容器仍掛著就丟 WORKTREE_BUSY，由呼叫端離開鎖、下一輪再試（09-17 R14，
// 否則最長 50 分鐘的等待會卡在專案鎖裡，同專案 merge／deploy 全部排隊）。
async function resetTaskWorktreePointers({ repoPath, worktreePath, branch }, deps = {}) {
  assertBranchName(branch);
  const wait = deps.waitForWorktreeIdle || (p => require('../pipeline/sandbox-run').waitForWorktreeIdle(p, { timeoutMs: 0 }));
  await wait(worktreePath);
  // worktree 不存在（MISSING）照舊優先回報；其餘 findAdminDir 的錯誤（含 ADMIN_MISSING）要等任務 ref 驗過才丟，
  // 讓「偽造 admin 不見了」也先撞上 ref 檢查
  let admin, adminErr = null;
  try { admin = findAdminDir(repoPath, worktreePath); } catch (e) {
    if (e.code === 'WORKTREE_MISSING') throw e;
    adminErr = e;
  }
  assertTaskBranchRef(repoPath, branch);
  if (adminErr) throw adminErr;
  const s = lstat(admin);
  if (!s || !s.isDirectory()) throw fail('WORKTREE_TAMPERED', `admin 目錄不是一般目錄：${admin}`);
  const put = (p, content) => { fs.rmSync(p, { recursive: true, force: true }); fs.writeFileSync(p, content, { flag: 'wx' }); };
  // 清空前先記下是不是停在 rebase 中途（清空後就看不出來了）
  const midRebase = ['rebase-merge', 'rebase-apply'].some(n => lstat(path.join(admin, n)));
  const rewrite = () => {
    wipeAdminDir(admin);
    put(path.join(admin, 'HEAD'), `ref: refs/heads/${branch}\n`);
    put(path.join(admin, 'commondir'), '../..\n');
    put(path.join(admin, 'gitdir'), `${path.join(fs.realpathSync(worktreePath), '.git')}\n`);
    put(path.join(worktreePath, '.git'), `gitdir: ${admin}\n`);
  };
  rewrite();
  // 收掉半套狀態（最終審查 IMPORTANT-1）：清空 admin 刪掉了 MERGE_HEAD／rebase-merge，但 index 與工作樹還停在
  // 中斷當下——留著的話 merge 報 unmerged files、merge --abort 因沒有 MERGE_HEAD 失敗，worktree 永遠卡著衝突標記。
  //  - index 有未解衝突（中斷的 merge／rebase／cherry-pick）→ reset --merge（等同 merge --abort 的作法）
  //  - 停在 rebase 中途 → 同樣 reset --merge：HEAD 已寫回任務分支頂端（rebase 中途分支 ref 還沒動），
  //    index／工作樹裡「已套用一半的 rebase 結果」回到分支頂端＝放棄這次 rebase；未暫存的工作樹修改 reset --merge 會保留
  //    （與 index 內容衝突時 git 拒絕並丟例外，交呼叫端處理，不硬蓋）
  // 此時指標都已是宿主寫的值，才可以在 worktree 跑 git。
  const cwd = { cwd: worktreePath };
  const { stdout: unmerged } = await execFileAsync('git', ['ls-files', '-u'], cwd);
  if (midRebase || unmerged.trim()) {
    await execFileAsync('git', ['reset', '-q', '--merge'], cwd);
    rewrite(); // reset 會留下 ORIG_HEAD／logs：再清一次，離開時 admin 目錄仍只有宿主寫的四個檔
  }
  return admin;
}

module.exports = { findAdminDir, resetTaskWorktreePointers, assertTaskBranchRef };
