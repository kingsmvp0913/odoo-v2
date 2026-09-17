// 意圖：容器裡的 AI 不能寫共用的 git 物件庫（否則刪得掉 testing／main 的內容），commit 只落在每任務自己的物件庫；
// 平台要能把那些物件「驗證後」搬進共用庫，而物件庫是 AI 可寫的——捷徑、alternates、壞物件一律拒收、共用庫不受影響。
// 全部用真的 git，容器的權限配置用 chmod 模擬（root 跑測試時 chmod 擋不住，整支略過）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ao = require('../lib/agent-objects');

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const d = asRoot ? describe.skip : describe;

d('agent-objects', () => {
  let tmp, root, repoA, repoB;
  const git = (cwd, args, env = {}) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  const BRANCH = 'task/T1';

  function makeRepo(name) {
    const r = path.join(root, name);
    fs.mkdirSync(r, { recursive: true });
    git(r, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(r, 'base.txt'), `base-${name}\n`);
    git(r, ['add', 'base.txt']);
    git(r, ['commit', '-q', '-m', 'base']);
    git(r, ['branch', 'testing']);
    git(r, ['branch', 'ai-dev']);
    git(r, ['worktree', 'add', '-q', '-b', BRANCH, path.join(root, '.worktrees', 'T1', name), 'ai-dev']);
    git(r, ['pack-refs', '--all']);
    return r;
  }

  // 模擬容器：共用物件庫唯讀，commit 走任務物件庫
  function commitInContainer(name, file, content) {
    const r = path.join(root, name);
    const dir = ao.objectDirFor(r, BRANCH);
    fs.mkdirSync(dir, { recursive: true });
    const objs = [repoA, repoB].map(x => path.join(x, '.git', 'objects'));
    for (const o of objs) execFileSync('chmod', ['-R', 'a-w', o]);
    try {
      const wt = path.join(root, '.worktrees', 'T1', name);
      fs.writeFileSync(path.join(wt, file), content);
      const env = { GIT_OBJECT_DIRECTORY: dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: objs.join(':') };
      git(wt, ['add', file], env);
      git(wt, ['commit', '-q', '-m', `edit ${file}`], env);
      return git(wt, ['rev-parse', 'HEAD'], env);
    } finally {
      for (const o of objs) execFileSync('chmod', ['-R', 'u+w', o]);
    }
  }
  const has = (repo, sha) => { try { git(repo, ['cat-file', '-e', sha]); return true; } catch { return false; } };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-objects-'));
    root = path.join(tmp, 'repos', 'proj');
    repoA = makeRepo('a');
    repoB = makeRepo('b');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('容器 commit 只寫進任務物件庫；共用庫在搬移前查不到、搬移後查得到且可合併進 testing', async () => {
    const sha = commitInContainer('a', 'x.txt', 'hello\n');
    expect(has(repoA, sha)).toBe(false);
    await ao.importTaskObjects({ repoPath: repoA, branch: BRANCH });
    expect(has(repoA, sha)).toBe(true);
    git(repoA, ['checkout', '-q', 'testing']);
    git(repoA, ['merge', '-q', '--no-edit', BRANCH]);
    expect(fs.readFileSync(path.join(repoA, 'x.txt'), 'utf8')).toBe('hello\n');
    expect(git(repoA, ['fsck', '--no-dangling'])).toBe('');
  });

  test('多 repo：各自搬進自己的共用庫；全部搬完才清空任務物件庫', async () => {
    const shaA = commitInContainer('a', 'x.txt', 'A\n');
    const shaB = commitInContainer('b', 'y.txt', 'B\n');
    const dir = ao.objectDirFor(repoA, BRANCH);
    expect(ao.objectDirFor(repoB, BRANCH)).toBe(dir);
    await ao.importTaskObjects({ repoPaths: [repoA, repoB], branch: BRANCH, clear: true });
    expect(has(repoA, shaA) && has(repoB, shaB)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('任務物件庫放在專案 repo 根目錄底下（不在平台 data/，那裡有總鑰匙）', () => {
    expect(ao.objectDirFor(repoA, BRANCH)).toBe(path.join(root, '.agent-objects', 'T1'));
    expect(() => ao.objectDirFor(repoA, 'task/..')).toThrow();
    expect(() => ao.objectDirFor(repoA, 'testing')).toThrow();
  });

  test('任務物件庫不存在或是空的 → 什麼都不做', async () => {
    await expect(ao.importTaskObjects({ repoPath: repoA, branch: BRANCH })).resolves.toBeUndefined();
  });

  test('任務物件庫裡有捷徑 → 拒收，共用庫不變', async () => {
    const sha = commitInContainer('a', 'x.txt', 'hello\n');
    const dir = ao.objectDirFor(repoA, BRANCH);
    fs.symlinkSync(path.join(repoA, '.git', 'objects'), path.join(dir, 'zz'));
    await expect(ao.importTaskObjects({ repoPath: repoA, branch: BRANCH })).rejects.toMatchObject({ code: 'OBJECTS_TAMPERED' });
    expect(has(repoA, sha)).toBe(false);
  });

  test('任務物件庫裡有 info/alternates → 拒收', async () => {
    commitInContainer('a', 'x.txt', 'hello\n');
    const dir = ao.objectDirFor(repoA, BRANCH);
    fs.mkdirSync(path.join(dir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'info', 'alternates'), '/etc\n');
    await expect(ao.importTaskObjects({ repoPath: repoA, branch: BRANCH })).rejects.toMatchObject({ code: 'OBJECTS_TAMPERED' });
  });

  test('物件內容被竄改（跟雜湊對不上）→ 搬移失敗，共用庫沒有收到', async () => {
    const sha = commitInContainer('a', 'x.txt', 'hello\n');
    const dir = ao.objectDirFor(repoA, BRANCH);
    const f = path.join(dir, sha.slice(0, 2), sha.slice(2));
    fs.chmodSync(f, 0o644);
    fs.writeFileSync(f, require('zlib').deflateSync(Buffer.from('commit 5\0evil!')));
    await expect(ao.importTaskObjects({ repoPath: repoA, branch: BRANCH })).rejects.toMatchObject({ code: 'OBJECTS_TAMPERED' });
    expect(has(repoA, sha)).toBe(false);
  });

  test('容器的權限配置下刪不掉共用庫的物件', () => {
    const obj = path.join(repoA, '.git', 'objects');
    execFileSync('chmod', ['-R', 'a-w', obj]);
    try {
      const fan = fs.readdirSync(obj).find(f => /^[0-9a-f]{2}$/.test(f));
      const loose = path.join(obj, fan, fs.readdirSync(path.join(obj, fan))[0]);
      expect(() => fs.unlinkSync(loose)).toThrow(/EACCES/);
    } finally {
      execFileSync('chmod', ['-R', 'u+w', obj]);
    }
  });

  test('已經搬過（物件都在）→ 不重複打包', async () => {
    commitInContainer('a', 'x.txt', 'hello\n');
    await ao.importTaskObjects({ repoPath: repoA, branch: BRANCH });
    const packs = () => fs.readdirSync(path.join(repoA, '.git', 'objects', 'pack')).length;
    const before = packs();
    await ao.importTaskObjects({ repoPath: repoA, branch: BRANCH });
    expect(packs()).toBe(before);
  });

  test('該 repo 沒有這條任務分支 → 略過', async () => {
    commitInContainer('a', 'x.txt', 'hello\n');
    await expect(ao.importTaskObjects({ repoPath: repoA, branch: 'task/NOPE' })).resolves.toBeUndefined();
  });

  test('分支名稱不是 task/<id> → 丟例外（名字會進路徑與 git 參數）', async () => {
    await expect(ao.importTaskObjects({ repoPath: repoA, branch: '--upload-pack=x' })).rejects.toThrow();
  });
});
