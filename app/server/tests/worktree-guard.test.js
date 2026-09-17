// app/server/tests/worktree-guard.test.js
// 意圖（09-17 裁決 R10→R12）：平台會在宿主、以任務 worktree 為 cwd 跑 git（merge／reset --hard／clean）。
// worktree 的 .git 檔與它的 admin 目錄（.git/worktrees/<name>/）容器都寫得到：
//  - admin HEAD 指到 testing（含 symlink＋影子 ref 這種「讀起來正常」的繞法）→ 宿主的 commit／reset 替 AI 移動 testing
//  - .git 檔／commondir 指到假 repo（config 放 filter.smudge）→ 宿主 reset --hard 執行任意指令
// 「讀出來檢查」擋不住捷徑繞法（R10 被實測繞過），所以改成：等該任務的容器結束，
// admin 目錄由宿主自己從主 clone 找（不信 .git 檔），再把指標一律寫回正確值（不跟 symlink）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { resetTaskWorktreePointers, findAdminDir } = require('../lib/worktree-guard');

let R, repo, wt, admin;
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const idle = async () => {};
const reset = (over = {}, deps = {}) => resetTaskWorktreePointers({ repoPath: repo, worktreePath: wt, branch: 'task/T1', ...over }, { waitForWorktreeIdle: idle, ...deps });
const rev = ref => git(repo, 'rev-parse', ref);

beforeEach(() => {
  R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtguard-')));
  repo = path.join(R, 'main'); fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a'), '1'); git(repo, 'add', 'a'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'branch', 'testing'); git(repo, 'branch', 'ai-dev');
  wt = path.join(R, '.worktrees', 'T1', 'main');
  git(repo, 'worktree', 'add', '-q', '-b', 'task/T1', wt);
  admin = path.join(repo, '.git', 'worktrees', 'main');
});
afterEach(() => fs.rmSync(R, { recursive: true, force: true }));

test('完好的 worktree：寫回後 commit／merge／reset --hard 照常可用，testing 不動', async () => {
  const testing = rev('testing');
  await expect(reset()).resolves.toBe(admin);
  fs.writeFileSync(path.join(wt, 'b'), '1'); git(wt, 'add', 'b'); git(wt, 'commit', '-q', '-m', 'work');
  git(repo, 'checkout', '-q', 'ai-dev'); fs.writeFileSync(path.join(repo, 'c'), '1'); git(repo, 'add', 'c'); git(repo, 'commit', '-q', '-m', 'ai'); git(repo, 'checkout', '-q', 'main');
  await reset();
  git(wt, 'merge', '--no-edit', 'ai-dev');
  await reset();
  git(wt, 'reset', '-q', '--hard', 'HEAD~1');
  expect(git(wt, 'symbolic-ref', 'HEAD')).toBe('refs/heads/task/T1');
  expect(rev('testing')).toBe(testing);
});

test('HEAD 換成 symlink 指到 testing（admin 內放影子 ref 讓「讀內容」看起來正常）→ 寫回後 commit／reset 不會動到 testing', async () => {
  const testing = rev('testing');
  fs.mkdirSync(path.join(admin, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(admin, 'refs', 'heads', 'testing'), 'ref: refs/heads/task/T1\n');
  fs.rmSync(path.join(admin, 'HEAD')); fs.symlinkSync('refs/heads/testing', path.join(admin, 'HEAD'));
  expect(git(wt, 'symbolic-ref', 'HEAD')).toBe('refs/heads/testing'); // 攻擊成立的前提
  await reset();
  expect(fs.lstatSync(path.join(admin, 'HEAD')).isFile()).toBe(true);
  expect(git(wt, 'symbolic-ref', 'HEAD')).toBe('refs/heads/task/T1');
  fs.writeFileSync(path.join(wt, 'a'), 'evil'); git(wt, 'commit', '-q', '-am', 'evil');
  git(wt, 'reset', '-q', '--hard', 'main');
  expect(rev('testing')).toBe(testing);
});

test('.git 檔指到帶 smudge filter 的假 repo → 寫回後 reset --hard 不會執行 filter', async () => {
  const marker = path.join(R, 'pwned');
  const fake = path.join(R, 'fake'); fs.mkdirSync(fake);
  git(fake, 'init', '-q', '-b', 'x');
  const script = path.join(R, 'smudge.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  fs.appendFileSync(path.join(fake, '.git', 'config'), `[filter "x"]\n\tsmudge = ${script}\n\tclean = cat\n`);
  fs.writeFileSync(path.join(fake, '.gitattributes'), 'a filter=x\n'); fs.writeFileSync(path.join(fake, 'a'), 'z');
  git(fake, 'add', '.'); git(fake, 'commit', '-q', '-m', 'f');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(fake, '.git')}\n`);
  fs.writeFileSync(path.join(wt, '.gitattributes'), 'a filter=x\n'); fs.rmSync(path.join(wt, 'a'));
  git(wt, 'reset', '-q', '--hard'); // 對照組：不寫回就會執行
  expect(fs.existsSync(marker)).toBe(true);
  fs.rmSync(marker);
  fs.writeFileSync(path.join(wt, '.gitattributes'), 'a filter=x\n'); fs.rmSync(path.join(wt, 'a'));
  await reset();
  git(wt, 'reset', '-q', '--hard');
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.readFileSync(path.join(wt, '.git'), 'utf8')).toBe(`gitdir: ${admin}\n`);
});

test('commondir／gitdir 被改、.git 換成目錄、config.worktree／admin logs 出現 → 全部寫回或移除', async () => {
  fs.writeFileSync(path.join(admin, 'commondir'), '/somewhere/else\n');
  fs.rmSync(path.join(wt, '.git')); fs.mkdirSync(path.join(wt, '.git'));
  fs.writeFileSync(path.join(admin, 'config.worktree'), '[core]\n\tbare = true\n');
  fs.rmSync(path.join(admin, 'logs'), { recursive: true, force: true }); fs.mkdirSync(path.join(admin, 'logs'));
  fs.symlinkSync(path.join(R, 'victim'), path.join(admin, 'logs', 'HEAD'));
  await reset();
  expect(fs.readFileSync(path.join(admin, 'commondir'), 'utf8')).toBe('../..\n');
  expect(fs.readFileSync(path.join(admin, 'gitdir'), 'utf8')).toBe(`${path.join(wt, '.git')}\n`);
  expect(fs.lstatSync(path.join(wt, '.git')).isFile()).toBe(true);
  expect(fs.existsSync(path.join(admin, 'config.worktree'))).toBe(false);
  fs.writeFileSync(path.join(wt, 'a'), '2'); git(wt, 'commit', '-q', '-am', 'w');
  expect(fs.existsSync(path.join(R, 'victim'))).toBe(false); // reflog 沒有經由 symlink 寫到宿主別的檔
});

test('本任務分支的 reflog 被換成 symlink → 移除，宿主 commit 不會把紀錄附加到別的檔', async () => {
  const victim = path.join(R, 'victim2'); fs.writeFileSync(victim, 'keep\n');
  const log = path.join(repo, '.git', 'logs', 'refs', 'heads', 'task', 'T1');
  fs.rmSync(log); fs.symlinkSync(victim, log);
  await reset();
  fs.writeFileSync(path.join(wt, 'a'), '3'); git(wt, 'commit', '-q', '-am', 'w');
  expect(fs.readFileSync(victim, 'utf8')).toBe('keep\n');
});

test('admin 目錄由宿主從主 clone 找，不信 worktree 的 .git 檔', () => {
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(R, 'elsewhere')}\n`);
  expect(findAdminDir(repo, wt)).toBe(admin);
});

test('local_path 經過 symlink 也找得到', async () => {
  const link = path.join(R, 'link-main'); fs.symlinkSync(repo, link);
  await expect(reset({ repoPath: link })).resolves.toBe(admin);
});

test('找不到 admin（主 clone 重建後的死工作樹）→ WORKTREE_ADMIN_MISSING；worktree 不在 → WORKTREE_MISSING', async () => {
  fs.rmSync(path.join(repo, '.git', 'worktrees'), { recursive: true, force: true });
  await expect(reset()).rejects.toMatchObject({ code: 'WORKTREE_ADMIN_MISSING' });
  await expect(reset({ worktreePath: path.join(R, 'nope') })).rejects.toMatchObject({ code: 'WORKTREE_MISSING' });
});

test('兩個 admin 目錄都宣稱是這個 worktree、或 worktree 本身是 symlink → 丟例外（不猜）', async () => {
  fs.cpSync(admin, path.join(repo, '.git', 'worktrees', 'main9'), { recursive: true });
  await expect(reset()).rejects.toMatchObject({ code: 'WORKTREE_TAMPERED' });
  fs.rmSync(path.join(repo, '.git', 'worktrees', 'main9'), { recursive: true });
  const moved = `${wt}-real`; fs.renameSync(wt, moved); fs.symlinkSync(moved, wt);
  await expect(reset()).rejects.toMatchObject({ code: 'WORKTREE_TAMPERED' });
});

test('先等該任務的容器結束才動手；等不到就丟例外、什麼都不寫', async () => {
  fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/testing\n');
  const order = [];
  await reset({}, { waitForWorktreeIdle: async (p) => { order.push(['wait', p]); } });
  expect(order).toEqual([['wait', wt]]);
  fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/testing\n');
  await expect(reset({}, { waitForWorktreeIdle: async () => { throw new Error('容器仍在執行'); } })).rejects.toThrow(/容器/);
  expect(fs.readFileSync(path.join(admin, 'HEAD'), 'utf8')).toBe('ref: refs/heads/testing\n');
});

test('分支名不合法 → 丟例外', async () => {
  await expect(reset({ branch: '../../HEAD' })).rejects.toThrow(/分支/);
  await expect(reset({ branch: 'a\nb' })).rejects.toThrow(/分支/);
});

// ===== 09-17 R14：寫回幾個指標不夠——admin 目錄裡其他檔（ORIG_HEAD／MERGE_MSG…）與任務分支 ref 本身容器也寫得到 =====
const taskRef = () => path.join(repo, '.git', 'refs', 'heads', 'task', 'T1');
const commitInWt = (name) => { fs.writeFileSync(path.join(wt, name), name); git(wt, 'add', name); git(wt, 'commit', '-q', '-m', name); };
const aiDevCommit = () => { git(repo, 'checkout', '-q', 'ai-dev'); fs.writeFileSync(path.join(repo, 'c'), '1'); git(repo, 'add', 'c'); git(repo, 'commit', '-q', '-m', 'ai'); git(repo, 'checkout', '-q', 'main'); };

test('A1：任務分支 ref 被寫成 symref 指向 testing → 丟例外（不跟隨、不修），宿主不會替它移動 testing', async () => {
  const testing = rev('testing');
  fs.writeFileSync(taskRef(), 'ref: refs/heads/testing\n');
  await expect(reset()).rejects.toMatchObject({ code: 'WORKTREE_TAMPERED', message: expect.stringMatching(/任務分支.*ref.*竄改/) });
  expect(fs.readFileSync(taskRef(), 'utf8')).toBe('ref: refs/heads/testing\n'); // 不自動修
  expect(rev('testing')).toBe(testing);
});

test('任務分支 ref 只接受 commit id（或不存在＝在 packed-refs）；目錄／symlink／垃圾內容一律丟例外', async () => {
  await expect(reset()).resolves.toBe(admin); // loose sha
  git(repo, 'pack-refs', '--all');
  expect(fs.existsSync(taskRef())).toBe(false);
  await expect(reset()).resolves.toBe(admin); // packed
  const sha = rev('main');
  for (const make of [
    () => fs.writeFileSync(taskRef(), `${sha}\nref: refs/heads/testing\n`),
    () => fs.writeFileSync(taskRef(), 'HEAD\n'),
    () => fs.symlinkSync(path.join(repo, '.git', 'refs', 'heads', 'main'), taskRef()),
    () => fs.mkdirSync(taskRef()),
  ]) {
    fs.rmSync(taskRef(), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(taskRef()), { recursive: true }); // pack-refs 會把空的 task 目錄一起清掉
    make();
    await expect(reset()).rejects.toMatchObject({ code: 'WORKTREE_TAMPERED' });
  }
  fs.rmSync(taskRef(), { recursive: true, force: true });
  const dir = path.join(repo, '.git', 'refs', 'heads', 'task');
  fs.renameSync(dir, `${dir}-x`); fs.symlinkSync(`${dir}-x`, dir);
  await expect(reset()).rejects.toMatchObject({ code: 'WORKTREE_TAMPERED' });
});

test('任務分支 reflog 目錄是 symlink → 丟例外；reflog 本身是目錄 → 移除', async () => {
  const logs = path.join(repo, '.git', 'logs', 'refs', 'heads', 'task');
  fs.rmSync(path.join(logs, 'T1')); fs.mkdirSync(path.join(logs, 'T1'));
  await reset();
  expect(fs.existsSync(path.join(logs, 'T1'))).toBe(false);
  fs.renameSync(logs, `${logs}-x`); fs.symlinkSync(`${logs}-x`, logs);
  await expect(reset()).rejects.toMatchObject({ code: 'WORKTREE_TAMPERED' });
});

test('A2：admin ORIG_HEAD 是指向 testing 的 symref → 清掉，宿主 merge／reset 不會把 testing 設成任務 HEAD', async () => {
  commitInWt('b'); aiDevCommit();
  const testing = rev('testing');
  for (const op of [() => git(wt, 'merge', '--no-edit', 'ai-dev'), () => git(wt, 'reset', '-q', '--hard', 'main')]) {
    fs.writeFileSync(path.join(admin, 'ORIG_HEAD'), 'ref: refs/heads/testing\n');
    await reset();
    op();
    expect(rev('testing')).toBe(testing);
  }
});

test('A3：admin MERGE_MSG 等被換成 symlink → 清掉，宿主非 ff merge 不會覆寫宿主上的檔', async () => {
  commitInWt('b'); aiDevCommit();
  const victim = path.join(R, 'victim-config'); fs.writeFileSync(victim, 'SECRET\n');
  for (const n of ['MERGE_MSG', 'MERGE_HEAD', 'MERGE_MODE', 'COMMIT_EDITMSG', 'AUTO_MERGE', 'SQUASH_MSG']) { fs.rmSync(path.join(admin, n), { force: true }); fs.symlinkSync(victim, path.join(admin, n)); }
  fs.mkdirSync(path.join(admin, 'rebase-merge'));
  await reset();
  expect(fs.readdirSync(admin).sort()).toEqual(['HEAD', 'commondir', 'gitdir', 'index']);
  git(wt, 'merge', '--no-edit', 'ai-dev');
  expect(fs.readFileSync(victim, 'utf8')).toBe('SECRET\n');
  expect(git(wt, 'log', '-1', '--format=%s')).toMatch(/Merge branch 'ai-dev'/);
});

test('清空 admin 目錄時保留 index（一般檔）：已暫存的變更還在；index 是 symlink 就移除', async () => {
  fs.writeFileSync(path.join(wt, 'staged'), 's'); git(wt, 'add', 'staged');
  await reset();
  expect(git(wt, 'diff', '--cached', '--name-only')).toBe('staged');
  const victim = path.join(R, 'victim-index'); fs.writeFileSync(victim, 'keep');
  fs.rmSync(path.join(admin, 'index')); fs.symlinkSync(victim, path.join(admin, 'index'));
  await reset();
  expect(fs.existsSync(path.join(admin, 'index'))).toBe(false);
  expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
});

test('預設的等待是「不阻塞」：容器還掛著就立刻丟 WORKTREE_BUSY（真正的等待由呼叫端在拿專案鎖之前做）', async () => {
  const sr = require('../pipeline/sandbox-run');
  const spy = jest.spyOn(sr, 'waitForWorktreeIdle').mockImplementation(async () => { throw Object.assign(new Error('忙'), { code: 'WORKTREE_BUSY' }); });
  try {
    fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/testing\n');
    await expect(resetTaskWorktreePointers({ repoPath: repo, worktreePath: wt, branch: 'task/T1' })).rejects.toMatchObject({ code: 'WORKTREE_BUSY' });
    expect(spy).toHaveBeenCalledWith(wt, { timeoutMs: 0 });
    expect(fs.readFileSync(path.join(admin, 'HEAD'), 'utf8')).toBe('ref: refs/heads/testing\n'); // 什麼都沒寫
  } finally { spy.mockRestore(); }
});

// 靜態守衛：宿主以任務 worktree 為 cwd 跑 git 的每個函式，都要先寫回指標（呼叫點清單見 3.13 報告 Fix round 3）
test('宿主在任務 worktree 跑 git 的函式，都先 await resetTaskWorktreePointers；tour 的 diff 改在主 clone 跑', () => {
  const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const body = (file, fn) => {
    const s = src(file);
    const i = s.indexOf(`async function ${fn}(`);
    expect(i).toBeGreaterThan(-1);
    const next = s.indexOf('\nasync function ', i + 1);
    return s.slice(i, next === -1 ? undefined : next);
  };
  const cases = [
    ['pipeline/git.js', 'ensureWorktreeAtMain', /execFileAsync\('git', \['rev-parse'/],
    ['pipeline/git.js', 'syncBranchWithAi', /execFileAsync\('git'/],
    ['pipeline/task-agent.js', 'readHeads', /revParse\(/],
  ];
  for (const [file, fn, firstGit] of cases) {
    const b = body(file, fn);
    const guard = b.indexOf('await resetTaskWorktreePointers(');
    const m = firstGit.exec(b);
    expect({ fn, guard: guard > -1, git: !!m }).toEqual({ fn, guard: true, git: true });
    expect(guard).toBeLessThan(m.index);
  }
  // 重建路徑（ADMIN_MISSING／全新建立）的 worktree add -B 之前也要先驗任務分支 ref（R14）
  const ens = body('pipeline/git.js', 'ensureWorktreeAtMain');
  expect(ens.indexOf('assertTaskBranchRef(')).toBeGreaterThan(-1);
  expect(ens.indexOf('assertTaskBranchRef(')).toBeLessThan(ens.indexOf("'worktree', 'remove'"));
  expect(ens.indexOf('assertTaskBranchRef(')).toBeLessThan(ens.indexOf("'worktree', 'add'"));
  // readHeads 不在專案鎖內：先阻塞等容器，再做不阻塞的寫回
  const rh = body('pipeline/task-agent.js', 'readHeads');
  expect(rh.indexOf('waitForWorktreeIdle(')).toBeGreaterThan(-1);
  expect(rh.indexOf('waitForWorktreeIdle(')).toBeLessThan(rh.indexOf('resetTaskWorktreePointers('));
  const tour = body('pipeline/playwright-agent.js', 'tourTestClasses');
  expect(tour).toMatch(/diffNameOnly\(repo\.local_path,/);
  // 不再有「讀 .git 檔來驗」的舊做法殘留
  for (const f of ['pipeline/git.js', 'pipeline/task-agent.js', 'lib/agent-mounts.js']) expect(src(f)).not.toMatch(/assertTaskWorktreeIntact/);
});
