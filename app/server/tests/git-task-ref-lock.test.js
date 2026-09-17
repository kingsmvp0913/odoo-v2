// app/server/tests/git-task-ref-lock.test.js
// 意圖（09-17 裁決 R8）：容器裡的 AI 要能在任務 worktree commit，卻不能改 testing／main 指標或另開分支——
// 否則被注入的 AI 可以把 testing 指到自己的 commit、繞過 QA 與人工審核直接進部署。
// 這裡用真的 git 與 chmod 模擬 gitDirMounts 給出的讀寫配置（唯讀＝整棵拿掉寫入權、可寫＝那幾棵加回來），
// 證明「只開這幾處」確實夠 commit、也確實擋得住改 ref。docker 的 bind mount 唯讀比 chmod 更嚴，行為同向。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { gitDirMounts } = require('../lib/agent-sandbox');

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
// root 無視檔案權限，chmod 模擬不出唯讀；這支只能以一般使用者跑
const maybe = isRoot ? test.skip : test;

let R, repo, wt, objEnv = {};
// 容器內的 git 帶任務物件庫 env（D2，見 agent-mounts）；宿主端（repo 當 cwd 的查詢）不帶
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'gc.auto=0', ...a],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(cwd === wt ? objEnv : {}) } }).trim();
const chmodTree = (p, add) => {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  fs.chmodSync(p, add ? (st.mode | 0o200) : (st.mode & ~0o222));
  if (st.isDirectory()) for (const f of fs.readdirSync(p)) chmodTree(path.join(p, f), add);
};

beforeEach(() => {
  R = fs.mkdtempSync(path.join(os.tmpdir(), 'reflock-'));
  repo = path.join(R, 'main'); fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a'), '1'); git(repo, 'add', 'a'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'branch', 'testing');
  wt = path.join(R, '.worktrees', 'T1', 'main');
  git(repo, 'worktree', 'add', '-q', '-b', 'task/T1', wt);
  git(repo, 'pack-refs', '--all'); // 分支被 pack 掉時 refs/heads/task 目錄不在，commit 仍要能寫回
  // 比照 agent-mounts：先在宿主建出 bind mount 來源
  for (const d of [['refs', 'heads', 'task'], ['logs', 'refs', 'heads', 'task']]) fs.mkdirSync(path.join(repo, '.git', ...d), { recursive: true });
  const admin = path.resolve(wt, fs.readFileSync(path.join(wt, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim());
  const objDir = path.join(R, '.agent-objects', 'T1');
  fs.mkdirSync(objDir, { recursive: true });
  objEnv = { GIT_OBJECT_DIRECTORY: objDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(repo, '.git', 'objects') };
  const mounts = [...gitDirMounts(repo, 'rw', admin), { source: objDir, readonly: false }];
  chmodTree(path.join(repo, '.git'), false);
  for (const m of mounts) if (!m.readonly) chmodTree(m.source, true);
});
afterEach(() => { chmodTree(R, true); fs.rmSync(R, { recursive: true, force: true }); });

maybe('任務分支可以 commit（即使原本被 pack）', () => {
  fs.writeFileSync(path.join(wt, 'a'), '2');
  git(wt, 'commit', '-q', '-am', 'work');
  expect(git(wt, 'log', '-1', '--format=%s', 'task/T1')).toBe('work');
  // 共用物件庫沒被寫：commit 只在任務物件庫（宿主端查不到，要等 agent-objects 搬進來）
  expect(() => git(repo, 'cat-file', '-e', git(wt, 'rev-parse', 'task/T1'))).toThrow();
  expect(git(repo, 'log', '-1', '--format=%s', 'testing')).toBe('base');
});

maybe('共用物件庫寫不進去（D2）', () => {
  expect(() => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: wt, input: 'x', stdio: ['pipe', 'pipe', 'pipe'] })).toThrow(/permission/i);
});

maybe('改 testing 指標、另開分支、改 main 都失敗', () => {
  const head = git(repo, 'rev-parse', 'HEAD');
  const evil = git(wt, 'commit-tree', '-m', 'evil', `${head}^{tree}`); // 寫進任務物件庫本來就允許
  expect(() => git(wt, 'update-ref', 'refs/heads/testing', evil)).toThrow(/Permission denied|unable to/i);
  expect(() => git(wt, 'branch', 'evil')).toThrow(/Permission denied|unable to|cannot/i);
  expect(() => git(wt, 'update-ref', 'refs/heads/main', evil)).toThrow(/Permission denied|unable to/i);
  expect(git(repo, 'rev-parse', 'testing')).toBe(head);
  expect(git(repo, 'rev-parse', 'main')).toBe(head);
});

if (isRoot) test.skip('以 root 執行：檔案權限不生效，無法模擬唯讀掛載（此測試需一般使用者）', () => {});
