// app/server/lib/agent-objects.js
/**
 * agent-objects.js — 每張任務自己的 git 物件庫（子專案 0，09-17 使用者裁決 D2）
 *
 * 任務 repo 的 `.git/objects` 是所有分支共用的（testing／main／ai-dev／每張任務），容器可寫的話，
 * 被注入的 AI 刪得掉別人的內容、放 info/alternates、或把 fanout 目錄換成 symlink 讓宿主把物件寫到別處。
 * 所以容器裡共用物件庫一律唯讀，commit 落在 repos/<專案>/.agent-objects/<任務>/（GIT_OBJECT_DIRECTORY；
 * 刻意不放 data/ 底下——data/ 有總鑰匙，整個目錄禁止掛進容器），
 * 共用庫以 GIT_ALTERNATE_OBJECT_DIRECTORIES 唯讀引用。
 *
 * 宿主要用到任務分支之前（容器結束時、合併前、在 worktree 跑 git 前）呼叫 importTaskObjects：
 *  1. 任務物件庫是 AI 可寫的：lstat 走一遍，有 symlink／非一般檔／alternates 一律拒收（不跟隨）
 *  2. 以 pack-objects 從任務分支頂端打包「共用庫還沒有的物件」，交給 index-pack --strict 收進共用庫——
 *     物件雜湊由 git 從內容重算並做 fsck 檢查，壞物件收不進來
 *  3. 收完再以不帶 alternates 的 rev-list 確認任務分支在共用庫裡是完整的，缺物件就丟例外
 * 同一個任務物件庫的搬移在行程內排隊，避免一邊搬一邊被清空。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { assertTaskBranchRef } = require('./worktree-guard');

const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };

function tampered(msg) {
  return Object.assign(new Error(`任務的 git 物件庫疑似被竄改，已停止（不會自動修復，需由管理員確認）：${msg}`), { code: 'OBJECTS_TAMPERED' });
}

// 同一專案的 repo 都在 repos/<folder>/<label>，與任務 worktree（repos/<folder>/.worktrees/<task_id>）並排
function objectDirFor(repoPath, branch) {
  assertBranch(branch);
  return path.join(path.resolve(path.dirname(repoPath)), '.agent-objects', branch.slice('task/'.length));
}
function assertBranch(branch) {
  if (typeof branch !== 'string' || !/^task\/[A-Za-z0-9._-]+$/.test(branch) || /^task\/\.+$/.test(branch)) {
    throw new Error(`任務分支名不合法：${branch}`);
  }
}

// 同專案所有 repo 的共用物件庫（宿主自己的、容器寫不到）：多 repo 任務的物件可能引用別的 repo 已有的 blob
function projectObjectDirs(repoPath) {
  const root = path.dirname(repoPath);
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  return names.map(n => path.join(root, n, '.git', 'objects')).filter(p => { const s = lstat(p); return s && s.isDirectory(); });
}

// 回傳是否有任何檔案；有不該有的東西就丟例外
function scanObjectDir(dir) {
  let files = 0;
  const walk = cur => {
    for (const name of fs.readdirSync(cur)) {
      const p = path.join(cur, name);
      const s = fs.lstatSync(p);
      const rel = path.relative(dir, p);
      if (s.isSymbolicLink()) throw tampered(`${rel} 是捷徑`);
      if (s.isDirectory()) { walk(p); continue; }
      if (!s.isFile()) throw tampered(`${rel} 不是一般檔案`);
      if (/^info\/(http-)?alternates$/.test(rel)) throw tampered(`${rel} 不允許存在`);
      files++;
    }
  };
  walk(dir);
  return files > 0;
}

function run(cmd, args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; let err = '';
    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => { err += b; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} ${args[0]} 失敗（exit ${code}）：${err.trim()}`))));
    if (input) input.pipe(child.stdin); else child.stdin.end();
  });
}

// 宿主自己的 ref（非 task/*）：它們指到的物件一定在共用庫；task/* 可能指到別張任務還沒搬進來的物件，不能拿來當排除基準
async function hostRefs(repoPath) {
  const out = String(await run('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: repoPath }));
  return out.split('\n').map(l => l.trim().split(' ')).filter(([ref, sha]) => ref && sha && !ref.startsWith('refs/heads/task/')).map(([, sha]) => sha);
}

// 直接看 ref 檔：show-ref／for-each-ref 會把「指到壞物件或不存在物件」的 ref 當成不存在而略過，
// 那樣竄改過的物件會被誤判成「這個 repo 沒有這條分支」直接放行（測試實際踩過）
function refFileExists(repoPath, ref) {
  const gitDir = path.join(repoPath, '.git');
  if (lstat(path.join(gitDir, ...ref.split('/')))) return true;
  let packed = '';
  try { packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8'); } catch { return false; }
  return packed.split('\n').some(l => l.endsWith(` ${ref}`));
}

async function complete(repoPath, tip, exclude) {
  try {
    await run('git', ['rev-list', '--objects', '--quiet', '--stdin'], { cwd: repoPath, env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: '' }, input: require('stream').Readable.from([`${tip}\n--not\n${exclude.join('\n')}\n`]) });
    return true;
  } catch { return false; }
}

async function importOne(repoPath, branch, dir) {
  const ref = `refs/heads/${branch}`;
  let tip;
  try { tip = String(await run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{object}`], { cwd: repoPath, env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: dir } })).trim(); } catch { tip = ''; }
  if (!tip) {
    // 分支不存在（該 repo 沒有這張任務的 worktree）就略過；分支在但頂端物件哪裡都找不到＝壞掉
    if (!refFileExists(repoPath, ref)) return;
    throw tampered(`${ref} 指到的物件不存在：${repoPath}`);
  }
  const exclude = await hostRefs(repoPath);
  if (await complete(repoPath, tip, exclude)) return;
  const alternates = [dir, ...projectObjectDirs(repoPath).filter(p => path.resolve(p) !== path.resolve(repoPath, '.git', 'objects'))].join(':');
  const pack = await run('git', ['pack-objects', '--stdout', '--revs', '-q'], {
    cwd: repoPath, env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates },
    input: require('stream').Readable.from([`${tip}\n--not\n${exclude.join('\n')}\n`]),
  });
  await run('git', ['index-pack', '--stdin', '--strict', '--fix-thin'], {
    cwd: repoPath, env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: '' }, input: require('stream').Readable.from([pack]),
  });
  if (!(await complete(repoPath, tip, exclude))) throw tampered(`${ref} 搬進共用物件庫後仍不完整：${repoPath}`);
}

const queues = new Map();
function serialize(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

/**
 * @param {{ repoPath?: string, repoPaths?: string[], branch: string, clear?: boolean }} opts
 *   clear：全部 repo 搬完後清空任務物件庫（呼叫端必須傳入這張任務的全部 repo）
 */
async function importTaskObjects({ repoPath, repoPaths, branch, clear = false }) {
  const repos = repoPaths || [repoPath];
  if (!repos.length) return;
  const dir = objectDirFor(repos[0], branch);
  // 沒跑過容器的任務（開關 off 或舊任務）沒有物件庫：直接結束，不碰 repo
  if (!lstat(dir)) return;
  for (const r of repos) assertTaskBranchRef(r, branch);
  for (const r of repos) {
    if (objectDirFor(r, branch) !== dir) throw new Error(`同一張任務的 repo 必須在同一個專案目錄下：${r}`);
  }
  await serialize(dir, async () => {
    const s = lstat(dir);
    if (!s) return;
    if (!s.isDirectory()) throw tampered('任務物件庫不是一般目錄');
    if (!scanObjectDir(dir)) return;
    for (const r of repos) await importOne(r, branch, dir);
    if (clear) for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  });
}

function removeTaskObjectDir({ repoPath, branch }) {
  const dir = objectDirFor(repoPath, branch);
  return serialize(dir, async () => { fs.rmSync(dir, { recursive: true, force: true }); });
}

module.exports = { objectDirFor, importTaskObjects, removeTaskObjectDir };
