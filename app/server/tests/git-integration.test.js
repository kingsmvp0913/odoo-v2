// 意圖：git.js 其餘測試全靠 mock，真實 git 的衝突／半殘 merge／worktree 行為從未被驗證——
// mock 抓不到 git 版本差異與真實狀態機（MERGE_HEAD、worktree 殘留）。本檔在 tmp 目錄
// 建真 repo，覆蓋最容易讓 pipeline 卡死的劇本：衝突偵測、衝突後自癒、worktree 冪等。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

const git = require('../pipeline/git');

// 每個測試自己的 tmp 空間；固定身分避免 CI 無 git 全域設定時 commit 失敗
const G = ['-c', 'user.email=t@test', '-c', 'user.name=T'];
async function sh(cwd, ...args) { return run('git', [...G, ...args], { cwd }); }
async function write(repo, file, content) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}

let base;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'git-int-')); });
afterEach(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } });

// 建一個含 main 與 origin 的標準 repo：main 上有初始 commit
async function makeRepo() {
  const origin = path.join(base, 'origin.git');
  const repo = path.join(base, 'repo');
  await run('git', ['init', '--bare', origin]);
  await run('git', ['clone', origin, repo]);
  await sh(repo, 'checkout', '-b', 'main');
  await write(repo, 'a.py', 'x = 1\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'init');
  await sh(repo, 'push', '-u', 'origin', 'main');
  return repo;
}

test('mergeInto：真衝突 → hasConflicts＋檔名；abortMerge 清掉 MERGE_HEAD', async () => {
  const repo = await makeRepo();
  // task 分支改同一行
  await sh(repo, 'checkout', '-b', 'task/t1');
  await write(repo, 'a.py', 'x = 2\n');
  await sh(repo, 'commit', '-am', 'task change');
  // main 也改同一行 → testing（從 main 建）與 task 衝突
  await sh(repo, 'checkout', 'main');
  await write(repo, 'a.py', 'x = 3\n');
  await sh(repo, 'commit', '-am', 'main change');

  const r = await git.mergeInto(repo, 'testing', 'task/t1');
  expect(r.hasConflicts).toBe(true);
  expect(r.conflictFiles).toContain('a.py');
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true); // 留給人工解（設計如此）

  await git.abortMerge(repo);
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false); // 清乾淨可自癒
}, 30000);

test('mergeInto：無衝突 → 併入成功、工作樹乾淨', async () => {
  const repo = await makeRepo();
  await sh(repo, 'checkout', '-b', 'task/t2');
  await write(repo, 'b.py', 'y = 1\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'add b');
  await sh(repo, 'checkout', 'main');

  const r = await git.mergeInto(repo, 'testing', 'task/t2');
  expect(r.hasConflicts).toBe(false);
  expect(fs.existsSync(path.join(repo, 'b.py'))).toBe(true);
  const { stdout } = await sh(repo, 'status', '--porcelain');
  expect(stdout.trim()).toBe('');
}, 30000);

// 修正回歸釘：pull 撞衝突曾留下 merge-in-progress（MERGE_HEAD），下次 checkout/pull 全失敗、
// 只能人工 merge --abort。現在 pullBranch 必須 throw 且自行清掉半殘狀態。
test('pullBranch：pull 衝突 → throw 且不留 MERGE_HEAD（可自癒）', async () => {
  const repo = await makeRepo();
  // 另一個 clone 推進 origin/main（同一行）
  const other = path.join(base, 'other');
  await run('git', ['clone', path.join(base, 'origin.git'), other]);
  await sh(other, 'checkout', 'main');
  await write(other, 'a.py', 'x = 9\n');
  await sh(other, 'commit', '-am', 'remote change');
  await sh(other, 'push', 'origin', 'main');
  // 本地 main 也改同一行（未推）→ pull 必衝突
  await write(repo, 'a.py', 'x = 8\n');
  await sh(repo, 'commit', '-am', 'local change');

  await expect(git.pullBranch(repo, 'main')).rejects.toThrow();
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
  // 後續操作不被半殘 merge 卡死：checkout 應可用
  await expect(sh(repo, 'checkout', 'main')).resolves.toBeTruthy();
}, 30000);

test('pullBranch：origin 無該分支（空遠端）→ 放行不 throw', async () => {
  const repo = await makeRepo();
  await sh(repo, 'checkout', '-b', 'feature/none');
  await expect(git.pullBranch(repo, 'feature/none')).resolves.toBeUndefined();
}, 30000);

test('ensureWorktreeAtMain：建立→冪等沿用（reset=false 保留內容）→ reset=true 歸零', async () => {
  const repo = await makeRepo();
  const wt = path.join(base, 'wt', 'repo');

  await git.ensureWorktreeAtMain(repo, wt, 'task/t3', 'main', true);
  expect(fs.readFileSync(path.join(wt, 'a.py'), 'utf8')).toBe('x = 1\n');

  // worktree 內做工作（未 commit），reset=false 再進：內容必須保留（branch_pending 沿用 analysis 的工作）
  await write(wt, 'a.py', 'x = 100\n');
  await git.ensureWorktreeAtMain(repo, wt, 'task/t3', 'main', false);
  expect(fs.readFileSync(path.join(wt, 'a.py'), 'utf8')).toBe('x = 100\n');

  // reset=true：回到 main 基準（analysis 重跑要讀最新乾淨碼）
  await git.ensureWorktreeAtMain(repo, wt, 'task/t3', 'main', true);
  expect(fs.readFileSync(path.join(wt, 'a.py'), 'utf8')).toBe('x = 1\n');
}, 30000);

test('syncWithMain：與 main 衝突 → hasConflicts＋檔名（不假成功）', async () => {
  const repo = await makeRepo();
  await sh(repo, 'checkout', '-b', 'task/t4');
  await write(repo, 'a.py', 'x = 5\n');
  await sh(repo, 'commit', '-am', 'task edit');
  await sh(repo, 'checkout', 'main');
  await write(repo, 'a.py', 'x = 6\n');
  await sh(repo, 'commit', '-am', 'main edit');
  await sh(repo, 'push', 'origin', 'main');
  await sh(repo, 'checkout', 'task/t4');

  const r = await git.syncWithMain(repo);
  expect(r.hasConflicts).toBe(true);
  expect(r.conflictFiles).toContain('a.py');
  await git.abortMerge(repo);
}, 30000);
