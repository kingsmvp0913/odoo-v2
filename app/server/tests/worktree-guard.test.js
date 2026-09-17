// app/server/tests/worktree-guard.test.js
// 意圖（09-17 裁決 R10）：平台會在宿主、以任務 worktree 為 cwd 跑 git（merge／reset --hard／clean）。
// worktree 的 .git 檔與它的 admin 目錄容器都寫得到：
//  - admin HEAD 改成 refs/heads/testing → 宿主的 merge／reset 會替 AI 移動 testing（繞過掛載鎖）
//  - .git 檔／commondir 指到假 repo（config 裡放 filter.smudge）→ 宿主 reset --hard 會執行任意指令（逃出容器）
// 所以宿主每次跑 git 前都要驗，任何一項不對就丟例外，不自動修、不自動刪。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertTaskWorktreeIntact } = require('../lib/worktree-guard');

let R, repo, wt, admin;
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const check = (over = {}) => assertTaskWorktreeIntact({ repoPath: repo, worktreePath: wt, branch: 'task/T1', ...over });

beforeEach(() => {
  R = fs.mkdtempSync(path.join(os.tmpdir(), 'wtguard-'));
  repo = path.join(R, 'main'); fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a'), '1'); git(repo, 'add', 'a'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'branch', 'testing');
  wt = path.join(R, '.worktrees', 'T1', 'main');
  git(repo, 'worktree', 'add', '-q', '-b', 'task/T1', wt);
  admin = fs.realpathSync(path.join(repo, '.git', 'worktrees', 'main'));
});
afterEach(() => fs.rmSync(R, { recursive: true, force: true }));

test('完好的 worktree → 通過，回傳 admin 目錄', () => {
  expect(check()).toBe(admin);
});

test('local_path 經過 symlink 也不誤判（兩邊都取 realpath）', () => {
  const link = path.join(R, 'link-main'); fs.symlinkSync(repo, link);
  expect(check({ repoPath: link })).toBe(admin);
});

test('HEAD 被改成 refs/heads/testing → 丟例外', () => {
  fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/testing\n');
  expect(() => check()).toThrow(/HEAD/);
});

test('HEAD 是 detached（sha）→ 丟例外', () => {
  fs.writeFileSync(path.join(admin, 'HEAD'), `${git(repo, 'rev-parse', 'HEAD')}\n`);
  expect(() => check()).toThrow(/HEAD/);
});

test('.git 檔換成 symlink → 丟例外', () => {
  const real = path.join(R, 'gitfile'); fs.copyFileSync(path.join(wt, '.git'), real);
  fs.rmSync(path.join(wt, '.git')); fs.symlinkSync(real, path.join(wt, '.git'));
  expect(() => check()).toThrow(/\.git/);
});

test('.git 換成整個目錄（假 repo）→ 丟例外', () => {
  fs.rmSync(path.join(wt, '.git')); fs.mkdirSync(path.join(wt, '.git'));
  expect(() => check()).toThrow(/\.git/);
});

test('gitdir 指到 <repo>/.git/worktrees/ 以外（假 repo）→ 丟例外', () => {
  const fake = path.join(R, 'fake'); fs.mkdirSync(fake); git(fake, 'init', '-q');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(fake, '.git')}\n`);
  expect(() => check()).toThrow(/gitdir/);
});

test('.git 檔第一行不是 gitdir: → 丟例外', () => {
  fs.writeFileSync(path.join(wt, '.git'), `junk\ngitdir: ${admin}\n`);
  expect(() => check()).toThrow(/gitdir/);
});

test('admin 目錄是 symlink → 丟例外', () => {
  const moved = path.join(R, 'admin-moved'); fs.renameSync(admin, moved); fs.symlinkSync(moved, admin);
  expect(() => check()).toThrow(/admin/);
});

test('commondir 被改到假 repo、或不見了 → 丟例外', () => {
  const fake = path.join(R, 'fake'); fs.mkdirSync(fake); git(fake, 'init', '-q');
  fs.writeFileSync(path.join(admin, 'commondir'), `${path.join(fake, '.git')}\n`);
  expect(() => check()).toThrow(/commondir/);
  fs.rmSync(path.join(admin, 'commondir'));
  expect(() => check()).toThrow(/commondir/);
});

test('admin 的 gitdir 不再指回這個 worktree → 丟例外', () => {
  fs.writeFileSync(path.join(admin, 'gitdir'), `${path.join(R, 'elsewhere', '.git')}\n`);
  expect(() => check()).toThrow(/gitdir/);
});

test('admin 裡出現 config.worktree → 丟例外', () => {
  fs.writeFileSync(path.join(admin, 'config.worktree'), '[filter "x"]\n\tsmudge = touch /tmp/pwned\n');
  expect(() => check()).toThrow(/config\.worktree/);
});

test('admin 目錄不在（主 clone 重建後的死工作樹）→ code=WORKTREE_ADMIN_MISSING，其餘竄改 code=WORKTREE_TAMPERED', () => {
  fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/testing\n');
  expect(() => check()).toThrow(expect.objectContaining({ code: 'WORKTREE_TAMPERED' }));
  fs.rmSync(admin, { recursive: true, force: true });
  expect(() => check()).toThrow(expect.objectContaining({ code: 'WORKTREE_ADMIN_MISSING' }));
});

test('worktree 目錄不在 → code=WORKTREE_MISSING', () => {
  expect(() => check({ worktreePath: path.join(R, 'nope') })).toThrow(expect.objectContaining({ code: 'WORKTREE_MISSING' }));
});

// 靜態守衛：宿主以任務 worktree 為 cwd 跑 git 的每個函式，都要先呼叫驗證（呼叫點清單見 3.13 報告 Fix round 2）
test('宿主在任務 worktree 跑 git 的函式，都先呼叫 assertTaskWorktreeIntact', () => {
  const body = (file, fn) => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const i = src.indexOf(`async function ${fn}(`);
    expect(i).toBeGreaterThan(-1);
    const next = src.indexOf('\nasync function ', i + 1);
    return src.slice(i, next === -1 ? undefined : next);
  };
  const cases = [
    ['pipeline/git.js', 'ensureWorktreeAtMain', /execFileAsync\('git', \['rev-parse'/],
    ['pipeline/git.js', 'syncBranchWithAi', /execFileAsync\('git'/],
    ['pipeline/task-agent.js', 'readHeads', /revParse\(/],
  ];
  for (const [file, fn, firstGit] of cases) {
    const b = body(file, fn);
    const guard = b.indexOf('assertTaskWorktreeIntact(');
    const m = firstGit.exec(b);
    expect({ fn, hasGuard: guard > -1 }).toEqual({ fn, hasGuard: true });
    expect(m).not.toBeNull();
    expect(guard).toBeLessThan(m.index);
  }
});
