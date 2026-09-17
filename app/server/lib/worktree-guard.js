// app/server/lib/worktree-guard.js
/**
 * worktree-guard.js — 任務 worktree 的 git 中繼資料驗證（子專案 0，09-17 裁決 R10）
 *
 * 容器寫得到任務 worktree 的 `.git` 檔與它在主 clone 的 admin 目錄（.git/worktrees/<name>/），
 * 而平台會在宿主、以該 worktree 為 cwd 跑 git（merge／reset --hard／clean）。不先驗就跑：
 *  - admin HEAD 改成 refs/heads/testing → 宿主的 merge／reset 替 AI 移動 testing，繞過掛載層的 refs 鎖
 *  - .git 檔或 commondir 指到假 repo（config 放 filter.smudge）→ 宿主 reset --hard 執行任意指令
 * 容器掛載（agent-mounts.js）與宿主 git（pipeline/git.js、task-agent.js）共用這一份規則。
 * 驗不過一律丟例外；不自動修、不自動刪，由管理員重建 worktree。
 */
const fs = require('fs');
const path = require('path');

function fail(code, msg) {
  return Object.assign(new Error(`任務 worktree 的 git 中繼資料不合法（可能被竄改），需由管理員重建：${msg}`), { code });
}

// 回傳 admin 目錄（realpath）。錯誤 code：
//  WORKTREE_MISSING       worktree 目錄不存在
//  WORKTREE_ADMIN_MISSING .git 檔指向本 repo 的 .git/worktrees/<name>，但 admin 目錄已不在（主 clone 重建後的死工作樹）
//  WORKTREE_TAMPERED      其餘一切不符
function assertTaskWorktreeIntact({ repoPath, worktreePath, branch }, deps = {}) {
  const lstat = deps.lstatSync || fs.lstatSync;
  const realpath = deps.realpathSync || fs.realpathSync;
  const read = p => String((deps.readFileSync || fs.readFileSync)(p, 'utf8'));
  const tryLstat = p => { try { return lstat(p); } catch { return null; } };
  const T = msg => fail('WORKTREE_TAMPERED', msg);
  if (!repoPath || !worktreePath || !branch) throw T('缺少 repoPath／worktreePath／branch');

  const wtStat = tryLstat(worktreePath);
  if (!wtStat) throw fail('WORKTREE_MISSING', `worktree 不存在：${worktreePath}`);
  if (!wtStat.isDirectory()) throw T(`worktree 不是一般目錄：${worktreePath}`);

  let commonGit;
  try { commonGit = realpath(path.join(repoPath, '.git')); } catch { throw T(`讀不到主 clone 的 .git：${repoPath}`); }
  const adminRoot = path.join(commonGit, 'worktrees');

  const gitFile = path.join(worktreePath, '.git');
  const gfStat = tryLstat(gitFile);
  if (!gfStat || !gfStat.isFile()) throw T(`${gitFile} 不是一般檔案（symlink／目錄／不存在）`);
  let content;
  try { content = read(gitFile); } catch (e) { throw T(`讀不到 ${gitFile}：${e.message}`); }
  const m = /^gitdir: (.+)$/.exec(content.split('\n')[0]);
  if (!m) throw T(`${gitFile} 第一行不是 gitdir: <path>`);
  const gitdir = path.resolve(worktreePath, m[1]);

  const adminStat = tryLstat(gitdir);
  if (!adminStat) {
    let parent = null;
    try { parent = realpath(path.dirname(gitdir)); } catch { parent = path.dirname(gitdir); }
    if (parent === adminRoot || path.dirname(gitdir) === path.join(repoPath, '.git', 'worktrees')) {
      throw fail('WORKTREE_ADMIN_MISSING', `admin 目錄不在：${gitdir}`);
    }
    throw T(`gitdir 不在 ${adminRoot}/ 底下：${gitdir}`);
  }
  if (adminStat.isSymbolicLink() || !adminStat.isDirectory()) throw T(`admin 目錄不是一般目錄：${gitdir}`);
  const admin = realpath(gitdir);
  if (path.dirname(admin) !== adminRoot) throw T(`gitdir 不在 ${adminRoot}/ 底下：${admin}`);

  const commondirFile = path.join(admin, 'commondir');
  let common;
  try { common = realpath(path.resolve(admin, read(commondirFile).trim())); } catch { throw T(`admin 的 commondir 不存在或讀不到：${commondirFile}`); }
  if (common !== commonGit) throw T(`admin 的 commondir 沒有指回主 clone（${common}）`);

  let back;
  try { back = realpath(path.resolve(admin, read(path.join(admin, 'gitdir')).trim())); } catch { back = null; }
  if (back !== realpath(gitFile)) throw T(`admin 的 gitdir 沒有指回這個 worktree（${back}）`);

  let head;
  try { head = read(path.join(admin, 'HEAD')).replace(/\n$/, ''); } catch { head = null; }
  if (head !== `ref: refs/heads/${branch}`) throw T(`HEAD 不是 refs/heads/${branch}（${head}）`);

  if (tryLstat(path.join(admin, 'config.worktree'))) throw T(`admin 裡不該有 config.worktree：${admin}`);
  return admin;
}

module.exports = { assertTaskWorktreeIntact };
