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
 * 容器掛載（agent-mounts.js）找 admin 目錄也用同一個 findAdminDir。
 */
const fs = require('fs');
const path = require('path');

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

async function resetTaskWorktreePointers({ repoPath, worktreePath, branch }, deps = {}) {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.split('/').some(x => !x || x === '.' || x === '..')) {
    throw new Error(`任務分支名不合法：${branch}`);
  }
  const wait = deps.waitForWorktreeIdle || ((...a) => require('../pipeline/sandbox-run').waitForWorktreeIdle(...a));
  await wait(worktreePath);
  const admin = findAdminDir(repoPath, worktreePath);
  const commonGit = path.dirname(path.dirname(admin));
  const put = (p, content) => { fs.rmSync(p, { recursive: true, force: true }); fs.writeFileSync(p, content, { flag: 'wx' }); };
  put(path.join(worktreePath, '.git'), `gitdir: ${admin}\n`);
  put(path.join(admin, 'HEAD'), `ref: refs/heads/${branch}\n`);
  put(path.join(admin, 'commondir'), '../..\n');
  put(path.join(admin, 'gitdir'), `${path.join(fs.realpathSync(worktreePath), '.git')}\n`);
  // 平台用不到的 per-worktree 設定與 refs（bisect／rewritten…）、以及可被換成 symlink 讓宿主附加寫入的 reflog：一律移除
  for (const x of ['config.worktree', 'refs', 'logs']) fs.rmSync(path.join(admin, x), { recursive: true, force: true });
  // index／本任務分支的 ref 與 reflog（refs/heads/task 容器可寫）：不是一般檔案就移除，免得宿主經由 symlink 讀寫別處
  for (const p of [
    path.join(admin, 'index'),
    path.join(commonGit, 'refs', 'heads', ...branch.split('/')),
    path.join(commonGit, 'logs', 'refs', 'heads', ...branch.split('/')),
  ]) {
    const s = lstat(p);
    if (s && !s.isFile()) fs.rmSync(p, { recursive: true, force: true });
  }
  return admin;
}

module.exports = { findAdminDir, resetTaskWorktreePointers };
