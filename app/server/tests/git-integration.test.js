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

// 意圖：reset 的前提是「此階段尚無程式變更」，但 respec（分診判需調整規格）會把已跑完 coding 的
// 任務打回分析，此時分支上早有實作 commit。無條件 reset --hard 會整包丟掉、逼 coding 從零重寫
// （實測 task 157：只為改兩顆按鈕的 CSS class 重寫 179 行）。有領先 commit 時改用 merge。
test('ensureWorktreeAtMain：分支已有領先 base 的 commit → reset=true 不得丟掉實作', async () => {
  const repo = await makeRepo();
  const wt = path.join(base, 'wt-ahead', 'repo');
  await git.ensureWorktreeAtMain(repo, wt, 'task/t12', 'main', true);

  // coding 完成並 commit（分支領先 main 一個 commit）
  await write(wt, 'feature.py', 'done = True\n');
  await sh(wt, 'add', '-A');
  await sh(wt, 'commit', '-m', 'impl');

  // 期間 main 也前進（別的任務核准併入）
  await write(repo, 'b.py', 'y = 2\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'main moves');

  await git.ensureWorktreeAtMain(repo, wt, 'task/t12', 'main', true);
  expect(fs.existsSync(path.join(wt, 'feature.py'))).toBe(true);   // 實作保住
  expect(fs.existsSync(path.join(wt, 'b.py'))).toBe(true);         // 最新 base 仍帶進來（分析讀得到新碼）
}, 30000);

// 併不進來時（與 base 撞同幾行）寧可讓分析讀到略舊的碼，也不能丟掉實作——半殘的 merge 狀態
// 更要清乾淨，留著 MERGE_HEAD 會讓後續 coding 的 commit 整個卡住。
test('ensureWorktreeAtMain：領先 commit 與 base 衝突 → 保住實作且不留半殘 merge', async () => {
  const repo = await makeRepo();
  const wt = path.join(base, 'wt-conflict', 'repo');
  await git.ensureWorktreeAtMain(repo, wt, 'task/t13', 'main', true);

  await write(wt, 'a.py', 'x = 99\n');       // 改 main 也會改的同一行
  await sh(wt, 'commit', '-am', 'impl');
  await write(repo, 'a.py', 'x = 50\n');
  await sh(repo, 'commit', '-am', 'main moves');

  await git.ensureWorktreeAtMain(repo, wt, 'task/t13', 'main', true);
  // 行尾用 trim 比對：Windows 的 autocrlf 會讓 checkout 出來的檔變 CRLF（同檔既有紅燈的成因）
  expect(fs.readFileSync(path.join(wt, 'a.py'), 'utf8').trim()).toBe('x = 99');  // 實作沒被丟掉
  expect(fs.existsSync(path.join(wt, '.git'))).toBe(true);
  const { stdout } = await sh(wt, 'status', '--porcelain');
  expect(stdout.trim()).toBe('');                                                 // 無衝突標記殘留
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

// 意圖：worktree 是 analysis 當下建的，任務常在規格審核／確認閘門停留數天，期間 ai-dev 會被
// 別的任務核准與實體 main 回流推進。不跟上的話 coding 是在過期的碼上寫，下載 zip 也會把
// 期間的人工修正一起蓋掉（實測 3864／3868 落後 37 檔 3886 行）。
test('syncBranchWithAi：任務分支尚無自己的 commit → fast-forward 拿到 ai-dev 最新內容', async () => {
  const repo = await makeRepo();
  await sh(repo, 'checkout', '-B', 'ai-dev', 'main');
  const wt = path.join(base, 'wt', 'repo');
  await git.ensureWorktreeAtMain(repo, wt, 'task/t9', 'ai-dev', true); // analysis 當下的切點

  // 任務卡在人工閘門期間，ai-dev 前進
  await sh(repo, 'checkout', 'ai-dev');
  await write(repo, 'b.py', 'y = 2\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'ai-dev moved on');
  expect(fs.existsSync(path.join(wt, 'b.py'))).toBe(false); // 同步前看不到＝觀察到的處境

  const r = await git.syncBranchWithAi(wt);
  expect(r.synced).toBe(true);
  // trim：Windows autocrlf 會把 git checkout 出來的檔轉成 CRLF，逐字比對會假紅
  expect(fs.readFileSync(path.join(wt, 'b.py'), 'utf8').trim()).toBe('y = 2');
}, 30000);

// 意圖：QA 彈跳後重跑時分支已有 AI 的 commit，同步不得把它洗掉——兩邊改動必須並存。
// 只驗 fast-forward 那條的話，這個「會弄丟已完成工作」的失敗模式完全測不到。
test('syncBranchWithAi：分支已有 commit → 三方合併，AI 的改動與 ai-dev 的新進並存', async () => {
  const repo = await makeRepo();
  await sh(repo, 'checkout', '-B', 'ai-dev', 'main');
  const wt = path.join(base, 'wt', 'repo');
  await git.ensureWorktreeAtMain(repo, wt, 'task/t10', 'ai-dev', true);

  await write(wt, 'task_file.py', 'ai = 1\n');   // AI 已寫的碼
  await sh(wt, 'add', '-A');
  await sh(wt, 'commit', '-m', 'ai work');

  await sh(repo, 'checkout', 'ai-dev');           // 同期 ai-dev 動了別的檔
  await write(repo, 'b.py', 'y = 2\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'ai-dev moved on');

  const r = await git.syncBranchWithAi(wt);
  expect(r.synced).toBe(true);
  expect(fs.readFileSync(path.join(wt, 'task_file.py'), 'utf8').trim()).toBe('ai = 1');
  expect(fs.readFileSync(path.join(wt, 'b.py'), 'utf8').trim()).toBe('y = 2');
}, 30000);

// 意圖：衝突時最危險的不是「沒同步」，是留下半套 merge——worktree 帶著 MERGE_HEAD 與衝突標記
// 交給 coding agent，它會把 <<<<<<< 當成程式碼一起改。必須 abort 回乾淨狀態並如實回報。
test('syncBranchWithAi：衝突 → synced=false＋檔名，且 worktree 不留 MERGE_HEAD／衝突標記', async () => {
  const repo = await makeRepo();
  await sh(repo, 'checkout', '-B', 'ai-dev', 'main');
  const wt = path.join(base, 'wt', 'repo');
  await git.ensureWorktreeAtMain(repo, wt, 'task/t11', 'ai-dev', true);

  await write(wt, 'a.py', 'x = 5\n');             // 兩邊改同一行
  await sh(wt, 'commit', '-am', 'ai edit');
  await sh(repo, 'checkout', 'ai-dev');
  await write(repo, 'a.py', 'x = 6\n');
  await sh(repo, 'commit', '-am', 'ai-dev edit');

  const r = await git.syncBranchWithAi(wt);
  expect(r.synced).toBe(false);
  expect(r.conflictFiles).toContain('a.py');
  await expect(sh(wt, 'rev-parse', '--verify', 'MERGE_HEAD')).rejects.toThrow();
  expect(fs.readFileSync(path.join(wt, 'a.py'), 'utf8').trim()).toBe('x = 5'); // 保留 AI 的版本，無衝突標記
}, 30000);

// 意圖：主 clone 工作樹是 deploy 目標，odoo-bin -u 會在其中留下產物弄髒工作樹。
// 舊版用普通 checkout，從別的分支（updateMainClone 先 pull 把樹切到 main）切回
// testing 時會被「local changes would be overwritten」擋住 → 整個重建默默失敗、testing 沒跟上 main
// （task 84 實測卡住主因）。此測驗證髒工作樹下（ai-dev 不存在、退回 main）仍能強制重長 testing。
test('resetTestingToAiBranch：工作樹髒（tracked 改動＋未追蹤碰撞）仍強制重長 testing 到最新 main', async () => {
  const repo = await makeRepo();                 // main: a.py=x=1
  // testing 從舊 main 建，且獨有一個 main 沒有的追蹤檔（供製造未追蹤碰撞）
  await sh(repo, 'checkout', '-b', 'testing');
  await write(repo, 't_only.py', 'only=1\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'testing 獨有檔');
  // main 前進：改碼＋新增依賴模組目錄（模擬使用者後來 push 的 web_login_styles）
  await sh(repo, 'checkout', 'main');
  await write(repo, 'a.py', 'x = 2\n');
  await write(repo, 'dep_mod/__init__.py', '# dep\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'main 前進：改碼＋加依賴模組');
  // 模擬 updateMainClone：pull 後工作樹停在 main，再被 deploy 產物弄髒兩種方式：
  await sh(repo, 'checkout', 'main');
  await write(repo, 'a.py', 'x = 999  # tracked 髒改動\n');       // (1) tracked 改動 → 普通 checkout 被擋
  await write(repo, 't_only.py', 'untracked collide\n');          // (2) 未追蹤檔，與 testing 追蹤路徑相撞 → 連 -f 都被擋

  // 舊碼在此會拋錯（checkout testing 被兩種髒法擋住）→ 重建默默失敗；新碼先 clean 再 -f 強制切換後 reset
  await git.resetTestingToAiBranch(repo);

  expect((await sh(repo, 'branch', '--show-current')).stdout.trim()).toBe('testing');
  const testingSha = (await sh(repo, 'rev-parse', 'testing')).stdout.trim();
  const mainSha = (await sh(repo, 'rev-parse', 'main')).stdout.trim();
  expect(testingSha).toBe(mainSha);                                              // testing 已重長到最新 main
  expect(fs.existsSync(path.join(repo, 'dep_mod', '__init__.py'))).toBe(true);   // 依賴模組進了 testing
  expect(fs.existsSync(path.join(repo, 't_only.py'))).toBe(false);              // reset 到 main（無此檔）→ 移除
  expect(fs.readFileSync(path.join(repo, 'a.py'), 'utf8').replace(/\r/g, '')).toBe('x = 2\n'); // 髒改動丟棄、還原成 main 版（正規化 CRLF）
  expect((await sh(repo, 'status', '--porcelain')).stdout.trim()).toBe('');      // 工作樹乾淨
}, 30000);

test('resetTestingToAiBranch：testing 重長到 ai-dev（含尚未進 main 的成果）', async () => {
  const repo = await makeRepo();
  await git.ensureAiBranch(repo);
  await write(repo, 'approved.py', 'done = 1\n'); // 已核准、還沒進 main
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'approved work');

  await git.resetTestingToAiBranch(repo);

  const { stdout: t } = await sh(repo, 'rev-parse', 'testing');
  const { stdout: a } = await sh(repo, 'rev-parse', 'ai-dev');
  expect(t.trim()).toBe(a.trim());
  expect(fs.existsSync(path.join(repo, 'approved.py'))).toBe(true); // 不會從測試環境消失
}, 30000);

test('resetTestingToAiBranch：ai-dev 不存在時退回 main，不整個炸掉', async () => {
  const repo = await makeRepo();
  await git.resetTestingToAiBranch(repo);
  const { stdout: t } = await sh(repo, 'rev-parse', 'testing');
  const { stdout: m } = await sh(repo, 'rev-parse', 'main');
  expect(t.trim()).toBe(m.trim());
}, 30000);

test('ensureAiBranch：本地與遠端都沒有 → 從 main 建立、內容相同、遠端出現該分支', async () => {
  const repo = await makeRepo();
  const b = await git.ensureAiBranch(repo);
  expect(b).toBe('ai-dev');

  // 已 checkout 到 ai-dev
  const { stdout: cur } = await sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  expect(cur.trim()).toBe('ai-dev');
  // 內容 == main（初次建立時兩者同一顆 commit）
  const { stdout: a } = await sh(repo, 'rev-parse', 'ai-dev');
  const { stdout: m } = await sh(repo, 'rev-parse', 'main');
  expect(a.trim()).toBe(m.trim());
  // 已推上遠端：使用者要在 GitHub 上看得到並合併它
  // 遠端名帶主分支後綴（本地仍是 ai-dev）：同一 repo 被多個專案用時才不會互相覆蓋
  const { stdout: remote } = await sh(repo, 'ls-remote', '--heads', 'origin');
  expect(remote).toContain('refs/heads/ai-dev-main');
}, 30000);

test('ensureAiBranch：已存在 → 冪等，不改動 SHA', async () => {
  const repo = await makeRepo();
  await git.ensureAiBranch(repo);
  await write(repo, 'c.py', 'z = 1\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'ai work');
  const { stdout: before } = await sh(repo, 'rev-parse', 'ai-dev');

  await sh(repo, 'checkout', 'main'); // 模擬別的流程把 clone 切走
  const b = await git.ensureAiBranch(repo);

  expect(b).toBe('ai-dev');
  const { stdout: after } = await sh(repo, 'rev-parse', 'ai-dev');
  expect(after.trim()).toBe(before.trim()); // 既有工作不得被重建覆蓋
  const { stdout: cur } = await sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  expect(cur.trim()).toBe('ai-dev');
}, 30000);

test('syncMainIntoAi：main 有新 commit → 帶進 ai-dev', async () => {
  const repo = await makeRepo();
  await git.ensureAiBranch(repo);
  // 模擬工程師直接改 main
  await sh(repo, 'checkout', 'main');
  await write(repo, 'eng.py', 'engineer = 1\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'engineer change');

  const r = await git.syncMainIntoAi(repo);

  expect(r.hasConflicts).toBe(false);
  const { stdout: cur } = await sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  expect(cur.trim()).toBe('ai-dev');
  expect(fs.existsSync(path.join(repo, 'eng.py'))).toBe(true); // 工程師的碼進到 ai-dev 了
}, 30000);

test('syncMainIntoAi：main 沒有新東西 → 無衝突且不動 ai-dev', async () => {
  const repo = await makeRepo();
  await git.ensureAiBranch(repo);
  await write(repo, 'ai.py', 'ai = 1\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'ai work');
  const { stdout: before } = await sh(repo, 'rev-parse', 'ai-dev');

  const r = await git.syncMainIntoAi(repo);

  expect(r.hasConflicts).toBe(false);
  const { stdout: after } = await sh(repo, 'rev-parse', 'ai-dev');
  expect(after.trim()).toBe(before.trim()); // 沒東西可併就不該產生 commit
}, 30000);

test('syncMainIntoAi：兩邊改同一行 → hasConflicts＋檔名，留 MERGE_HEAD 給人工', async () => {
  const repo = await makeRepo();
  await git.ensureAiBranch(repo);
  await write(repo, 'a.py', 'x = 2\n');   // AI 在 ai-dev 上改
  await sh(repo, 'commit', '-am', 'ai change');
  await sh(repo, 'checkout', 'main');
  await write(repo, 'a.py', 'x = 3\n');   // 工程師在 main 上改同一行
  await sh(repo, 'commit', '-am', 'engineer change');

  const r = await git.syncMainIntoAi(repo);

  expect(r.hasConflicts).toBe(true);
  expect(r.conflictFiles).toContain('a.py');
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
}, 30000);

test('mergeToAiBranch：併入 ai-dev 並推遠端，實體 main 完全不動', async () => {
  const repo = await makeRepo();
  await git.ensureAiBranch(repo);
  const { stdout: mainBefore } = await sh(repo, 'rev-parse', 'main');

  await sh(repo, 'checkout', '-b', 'task/t9', 'ai-dev');
  await write(repo, 'feat.py', 'feat = 1\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'feature');

  await git.mergeToAiBranch(repo, 'task/t9');

  // 併進 ai-dev：直接列 ai-dev 那顆 commit 的完整 tree，確認 feat.py 真的在裡面
  // （git show --stat 對 merge commit 預設不列變更檔，故不能拿它斷言）
  const { stdout: files } = await sh(repo, 'ls-tree', '-r', '--name-only', 'ai-dev');
  expect(files.split('\n')).toContain('feat.py');
  expect(fs.existsSync(path.join(repo, 'feat.py'))).toBe(true);
  // 推上遠端（本地 ai-dev ↔ 遠端 ai-dev-main，靠 upstream 綁定）
  const { stdout: remoteAi } = await sh(repo, 'rev-parse', 'origin/ai-dev-main');
  const { stdout: localAi } = await sh(repo, 'rev-parse', 'ai-dev');
  expect(remoteAi.trim()).toBe(localAi.trim());
  // 實體 main 一步都沒動——這是本次改動的核心保證
  const { stdout: mainAfter } = await sh(repo, 'rev-parse', 'main');
  expect(mainAfter.trim()).toBe(mainBefore.trim());
}, 30000);

test('mergeToAiBranch：遠端 ai-dev 被另一實例推進（不同檔）→ 自動 fetch 併回再推，不拋錯', async () => {
  const repo = await makeRepo();
  await git.ensureAiBranch(repo); // 建 ai-dev 並 push -u origin
  // 模擬「另一個平台實例」：另 clone 一份，在遠端 ai-dev 推一個不同檔
  const other = path.join(base, 'other');
  await run('git', ['clone', path.join(base, 'origin.git'), other]);
  // 另一實例同樣走 ensureAiBranch，於是也綁到 ai-dev-main；裸 push 走 upstream
  await git.ensureAiBranch(other);
  await write(other, 'other.py', 'o = 1\n');
  await sh(other, 'add', '-A');
  await sh(other, 'commit', '-m', 'other instance');
  await sh(other, 'push', 'origin', 'ai-dev:refs/heads/ai-dev-main');
  // 本 repo 的任務分支改不同檔
  await sh(repo, 'checkout', '-b', 'task/t', 'ai-dev');
  await write(repo, 'mine.py', 'm = 1\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'my task');

  // approve 當下本機 ai-dev 落後遠端 → 應被打回後自動對齊再推，不得拋錯
  await git.mergeToAiBranch(repo, 'task/t');

  const { stdout: remoteAi } = await sh(repo, 'rev-parse', 'origin/ai-dev-main');
  const { stdout: localAi } = await sh(repo, 'rev-parse', 'ai-dev');
  expect(remoteAi.trim()).toBe(localAi.trim()); // 本機＝遠端，push 成功
  // 兩實例的碼都在（沒有誰蓋掉誰）
  const { stdout: files } = await sh(repo, 'ls-tree', '-r', '--name-only', 'ai-dev');
  expect(files.split('\n')).toEqual(expect.arrayContaining(['mine.py', 'other.py']));
}, 30000);

test('mergeToAiBranch：遠端 ai-dev 與本任務改同一檔且衝突 → 拋 AiPushConflictError 並留 MERGE_HEAD', async () => {
  const repo = await makeRepo();
  await git.ensureAiBranch(repo);
  const other = path.join(base, 'other');
  await run('git', ['clone', path.join(base, 'origin.git'), other]);
  await git.ensureAiBranch(other);
  await write(other, 'shared.txt', 'OTHER VERSION\n');
  await sh(other, 'add', '-A');
  await sh(other, 'commit', '-m', 'other version');
  await sh(other, 'push', 'origin', 'ai-dev:refs/heads/ai-dev-main');
  // 本任務改「同一檔」為不同內容（模擬兩實例跑同一任務、各產一份）
  await sh(repo, 'checkout', '-b', 'task/t', 'ai-dev');
  await write(repo, 'shared.txt', 'MY VERSION\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-m', 'my version');

  await expect(git.mergeToAiBranch(repo, 'task/t')).rejects.toMatchObject({
    name: 'AiPushConflictError',
    conflictFiles: expect.arrayContaining(['shared.txt']),
  });
  // 留 MERGE_HEAD 給裁決端點的 concludeMerge 收尾（不可被 abort）
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
  // 遠端沒被本機推壞——仍是另一實例的版本
  const { stdout: remoteAi } = await sh(repo, 'rev-parse', 'origin/ai-dev-main');
  const { stdout: otherHead } = await sh(other, 'rev-parse', 'ai-dev');
  expect(remoteAi.trim()).toBe(otherHead.trim());
}, 30000);

describe('ai-dev 隔離：端到端', () => {
  test('全新專案 → 建 ai-dev → 任務從 ai-dev 切 → approve 後 ai-dev 前進而 main 不動', async () => {
    const repo = await makeRepo();
    const { stdout: mainAtStart } = await sh(repo, 'rev-parse', 'main');

    // 1. 第一張任務開工：ai-dev 自動建立，內容 == main
    await git.ensureAiBranch(repo, undefined);
    await git.syncMainIntoAi(repo, undefined);
    const { stdout: aiInit } = await sh(repo, 'rev-parse', 'ai-dev');
    expect(aiInit.trim()).toBe(mainAtStart.trim());

    // 2. 任務 A 從 ai-dev 切、寫碼、核准
    await sh(repo, 'checkout', '-b', 'task/a', 'ai-dev');
    await write(repo, 'a_feature.py', 'a = 1\n');
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-m', 'task a');
    await git.mergeToAiBranch(repo, 'task/a', undefined);

    // 3. 任務 B 從 ai-dev 切 → 看得到 A 的成果（這是切點選 ai-dev 的全部理由）
    await git.ensureAiBranch(repo, undefined);
    await sh(repo, 'checkout', '-b', 'task/b', 'ai-dev');
    expect(fs.existsSync(path.join(repo, 'a_feature.py'))).toBe(true);

    // 4. 實體 main 從頭到尾一步都沒動
    const { stdout: mainAtEnd } = await sh(repo, 'rev-parse', 'main');
    expect(mainAtEnd.trim()).toBe(mainAtStart.trim());
    // 遠端 main 也沒動
    const { stdout: remoteMain } = await sh(repo, 'rev-parse', 'origin/main');
    expect(remoteMain.trim()).toBe(mainAtStart.trim());
  }, 60000);

  test('工程師手推 commit 到 main → 下一張任務開工後該 commit 出現在 ai-dev', async () => {
    const repo = await makeRepo();
    await git.ensureAiBranch(repo, undefined);
    // AI 先做了一版
    await write(repo, 'ai.py', 'ai = 1\n');
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-m', 'ai work');
    // 工程師直接改 main（不同檔，不衝突）
    await sh(repo, 'checkout', 'main');
    await write(repo, 'hotfix.py', 'fix = 1\n');
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-m', 'engineer hotfix');

    await git.syncMainIntoAi(repo, undefined);

    // 兩邊的碼都在 ai-dev 上
    expect(fs.existsSync(path.join(repo, 'ai.py'))).toBe(true);
    expect(fs.existsSync(path.join(repo, 'hotfix.py'))).toBe(true);
  }, 60000);

  test('testing 重長到 ai-dev 後，含已核准但未進 main 的成果', async () => {
    const repo = await makeRepo();
    await git.ensureAiBranch(repo, undefined);
    await sh(repo, 'checkout', '-b', 'task/c', 'ai-dev');
    await write(repo, 'c.py', 'c = 1\n');
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-m', 'task c');
    await git.mergeToAiBranch(repo, 'task/c', undefined);

    await git.resetTestingToAiBranch(repo);

    expect(fs.existsSync(path.join(repo, 'c.py'))).toBe(true);
    const { stdout: t } = await sh(repo, 'rev-parse', 'testing');
    const { stdout: a } = await sh(repo, 'rev-parse', 'ai-dev');
    expect(t.trim()).toBe(a.trim());
  }, 60000);
});

// 意圖：客戶 repo 的主分支不一定叫 main／master（develop、trunk 都常見）。舊版硬清單找不到就
// fallback 回字串 'main'，後果是三重且全靜默：ensureMainBranch 憑空 checkout -B main 建一條假
// 主分支、syncMainIntoAi 之後同步的都是那條 origin 上不存在的假分支（工程師在真主分支的新
// commit 永遠進不了 ai-dev，AI 一路在 clone 當下的快照上開發）、approve 還會 push 出一條假 main
// 到客戶 GitHub。origin/HEAD 是「遠端預設分支」的權威答案，能認出任何命名。
describe('主分支非 main／master', () => {
  // 建一個遠端預設分支為 develop 的 repo（bare 端直接改 HEAD，不依賴 git init -b 的版本支援）
  async function makeDevelopRepo() {
    const origin = path.join(base, 'origin-dev.git');
    const repo = path.join(base, 'repo-dev');
    await run('git', ['init', '--bare', origin]);
    await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/develop'], { cwd: origin });
    await run('git', ['clone', origin, repo]);
    await sh(repo, 'checkout', '-b', 'develop');
    await write(repo, 'a.py', 'x = 1\n');
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-m', 'init');
    await sh(repo, 'push', '-u', 'origin', 'develop');
    await sh(repo, 'remote', 'set-head', 'origin', '-a'); // clone 空 repo 時 origin/HEAD 還沒成形
    return repo;
  }

  test('getMainBranch：認得出 develop，不硬回 main', async () => {
    const repo = await makeDevelopRepo();
    expect(await git.getMainBranch(repo)).toBe('develop');
  }, 30000);

  test('ensureMainBranch：不得憑空建一條假 main', async () => {
    const repo = await makeDevelopRepo();
    expect(await git.ensureMainBranch(repo, undefined)).toBe('develop');
    expect(await git.refExists(repo, 'refs/heads/main')).toBe(false);
  }, 30000);

  // 有鑑別力的反例：origin/HEAD 未設（如平台自建、遠端只有 ai-dev 的 repo）時仍要走既有硬清單，
  // 不能因為偵測不到就壞掉。
  test('origin/HEAD 未設 → 沿用 main／master 硬清單', async () => {
    const repo = await makeRepo();
    await sh(repo, 'remote', 'set-head', 'origin', '-d').catch(() => {});
    expect(await git.getMainBranch(repo)).toBe('main');
  }, 30000);
});

// ---- ai-dev 基底診斷與重建 ----
// 意圖：重現實際壞掉的那個劇本——ai-dev 長自 main，但真正的主分支是 kangyue，兩者分家後各走
// 自己的路。這種情況下同步會炸出一整包「內容衝突」，但真因是基底選錯。判斷「能不能安全重建」
// 只能靠真 git 的分支包含關係，mock 不出來。
describe('ai-dev 基底', () => {
  // main 與 kangyue 從同一點分家後各走一個 commit；ai-dev 長在 main 上（＝基底選錯的樣子）
  async function makeDivergedRepo() {
    const repo = await makeRepo();
    await sh(repo, 'checkout', '-b', 'kangyue', 'main');
    await write(repo, 'k.py', 'k = 1\n');
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-m', 'kangyue work');
    await sh(repo, 'push', '-u', 'origin', 'kangyue');

    await sh(repo, 'checkout', 'main');
    await write(repo, 'm.py', 'm = 1\n');
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-m', 'main work');
    await sh(repo, 'push', 'origin', 'main');

    await sh(repo, 'checkout', '-b', 'ai-dev', 'main');
    await sh(repo, 'push', '-u', 'origin', 'ai-dev');
    return repo;
  }

  test('aiBranchBase 認出 ai-dev 其實長在 main 上（而非設定中的主分支）', async () => {
    const repo = await makeDivergedRepo();
    expect(await git.aiBranchBase(repo)).toBe('main');
  }, 30000);

  // 這支是整個功能的關鍵防線：早期用的天真判準 `origin/<base>..ai-dev` 會把「另一條分支的歷史」
  // 算成 AI 產出，於是守衛擋下重建、專案永遠修不好（實測該判準在真實案例回 120，真值是 0）。
  test('aiOwnCommits 只算真正的 AI 產出，不把別條分支的歷史算進來', async () => {
    const repo = await makeDivergedRepo();
    expect(await git.aiOwnCommits(repo, 'kangyue')).toBe(0);

    // 對照組：天真判準在同一個 repo 上會得到非 0（證明本測試分得出兩者，不是恰好都對）
    const { stdout } = await sh(repo, 'rev-list', '--count', 'origin/kangyue..origin/ai-dev');
    expect(Number(stdout.trim())).toBeGreaterThan(0);
  }, 30000);

  test('ai-dev 上有真產出時 aiOwnCommits > 0（那些 commit 只存在於 ai-dev，不可捨棄）', async () => {
    const repo = await makeDivergedRepo();
    await write(repo, 'ai.py', 'ai = 1\n');
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-m', 'AI 產出');
    await sh(repo, 'push', 'origin', 'ai-dev');
    expect(await git.aiOwnCommits(repo, 'kangyue')).toBe(1);
  }, 30000);

  test('rebuildAiBranch：把 ai-dev 重長到主分支上並推遠端', async () => {
    const repo = await makeDivergedRepo();
    const r = await git.rebuildAiBranch(repo, 'kangyue');
    expect(r.oldSha).not.toBe(r.newSha);
    const { stdout: aiSha } = await sh(repo, 'rev-parse', 'ai-dev');
    const { stdout: kSha } = await sh(repo, 'rev-parse', 'origin/kangyue');
    expect(aiSha.trim()).toBe(kSha.trim());
    // 遠端也要跟著換掉，否則下次 pullBranch 會把舊的拉回來＝等於沒修
    const { stdout: remoteSha } = await sh(repo, 'rev-parse', 'refs/remotes/origin/ai-dev');
    expect(remoteSha.trim()).toBe(kSha.trim());
  }, 30000);

  test('rebuildAiBranch：有 AI 產出時拒絕（守衛自驗，不信呼叫端）', async () => {
    const repo = await makeDivergedRepo();
    await write(repo, 'ai.py', 'ai = 1\n');
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-m', 'AI 產出');
    await sh(repo, 'push', 'origin', 'ai-dev');
    await expect(git.rebuildAiBranch(repo, 'kangyue')).rejects.toThrow(/AI 產出/);
  }, 30000);

  test('rebuildAiBranch：還有任務 worktree 掛著時拒絕（否則它們指向消失的 commit）', async () => {
    const repo = await makeDivergedRepo();
    await sh(repo, 'worktree', 'add', path.join(base, 'wt-task1'), '-b', 'task/t1', 'ai-dev');
    await expect(git.rebuildAiBranch(repo, 'kangyue')).rejects.toThrow(/worktree/);
  }, 30000);

  // 遠端分支分化：同一客戶 repo 被多個專案使用時，本地都叫 ai-dev（分支語意散落各處，不改），
  // 靠 upstream 綁到不同的遠端分支。沒有這層，兩個專案會互相 force push 覆蓋且完全靜默。
  test('remoteAiBranchName：帶主分支後綴，且把 / 換掉（否則與同前綴分支互斥）', () => {
    expect(git.remoteAiBranchName('kangyue')).toBe('ai-dev-kangyue');
    expect(git.remoteAiBranchName('feature/x')).toBe('ai-dev-feature-x');
    expect(git.remoteAiBranchName('')).toBe('ai-dev'); // 推導不出主分支時退回裸名
  });

  test('ensureAiBranch：新 repo 的遠端 ai 分支帶後綴，本地仍是 ai-dev', async () => {
    const repo = await makeRepo();
    await git.ensureAiBranch(repo);
    expect(await git.refExists(repo, 'refs/heads/ai-dev')).toBe(true); // 本地名不變
    const { stdout } = await sh(repo, 'ls-remote', '--heads', 'origin');
    expect(stdout).toContain('refs/heads/ai-dev-main');
    expect(await git.remoteAiRef(repo)).toBe('ai-dev-main');           // upstream 綁對了
  }, 30000);

  test('ensureAiBranch：遠端已是裸名 ai-dev（既有專案）→ 沿用，不另建帶後綴的', async () => {
    const repo = await makeRepo();
    await sh(repo, 'checkout', '-b', 'ai-dev', 'main');
    await sh(repo, 'push', '-u', 'origin', 'ai-dev');
    await sh(repo, 'checkout', 'main');
    await sh(repo, 'branch', '-D', 'ai-dev'); // 模擬換機器重 clone：只剩遠端有

    await git.ensureAiBranch(repo);
    expect(await git.remoteAiRef(repo)).toBe('ai-dev'); // 既有產出都在它上面，不可丟下
    const { stdout } = await sh(repo, 'ls-remote', '--heads', 'origin');
    expect(stdout).not.toContain('ai-dev-main');
  }, 30000);

  // 這支是整個遠端分化的存在理由：沒有它，兩個專案的 AI 產出會在同一條遠端分支上互相覆蓋。
  test('兩個專案跟不同主分支共用同一 repo → 各推各的遠端分支，互不覆蓋', async () => {
    const origin = path.join(base, 'origin.git');
    const seed = path.join(base, 'seed');
    await run('git', ['init', '--bare', origin]);
    await run('git', ['clone', origin, seed]);
    await sh(seed, 'checkout', '-b', 'main');
    await write(seed, 'a.py', 'x = 1\n');
    await sh(seed, 'add', '-A');
    await sh(seed, 'commit', '-m', 'init');
    await sh(seed, 'push', '-u', 'origin', 'main');
    await sh(seed, 'checkout', '-b', 'kangyue');
    await write(seed, 'k.py', 'k = 1\n');
    await sh(seed, 'add', '-A');
    await sh(seed, 'commit', '-m', 'kangyue');
    await sh(seed, 'push', '-u', 'origin', 'kangyue');

    // 兩個專案各自 clone（平台就是這樣：每個專案一份獨立的 local_path）
    const a = path.join(base, 'projA');
    const b = path.join(base, 'projB');
    await run('git', ['clone', origin, a]);
    await run('git', ['clone', origin, b]);
    await sh(a, 'remote', 'set-head', 'origin', 'main');
    await sh(b, 'remote', 'set-head', 'origin', 'kangyue');

    await git.ensureAiBranch(a);
    await git.ensureAiBranch(b);

    const { stdout } = await run('git', ['ls-remote', '--heads', origin]);
    expect(stdout).toContain('refs/heads/ai-dev-main');
    expect(stdout).toContain('refs/heads/ai-dev-kangyue');
    expect(await git.remoteAiRef(a)).toBe('ai-dev-main');
    expect(await git.remoteAiRef(b)).toBe('ai-dev-kangyue');

    // 而且 A 推東西不會動到 B 的分支。裸 push（走 upstream）＝平台實際的推送路徑，
    // 同時也驗證了 upstream 真的綁對——綁錯的話這一步就會推到 B 的分支上。
    await write(a, 'ai.py', 'ai = 1\n');
    await sh(a, 'add', '-A');
    await sh(a, 'commit', '-m', 'A 的產出');
    await sh(a, 'push', 'origin', 'ai-dev:refs/heads/ai-dev-main');
    const { stdout: heads } = await run('git', ['ls-remote', '--heads', origin]);
    const shaOf = (name) => (heads.split('\n').find(l => l.endsWith(`refs/heads/${name}`)) || '').split('\t')[0];
    expect(shaOf('ai-dev-main')).not.toBe(shaOf('ai-dev-kangyue'));
  }, 30000);

  test('listRemoteBranchesByUrl：clone 前就讀得到分支與遠端預設分支', async () => {
    const repo = await makeDivergedRepo();
    await sh(repo, 'push', 'origin', 'HEAD:refs/heads/main');
    const origin = path.join(base, 'origin.git');
    await run('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/kangyue']);
    const r = await git.listRemoteBranchesByUrl(origin);
    expect(r.branches).toEqual(expect.arrayContaining(['main', 'kangyue', 'ai-dev']));
    // 沒有這個值，「新增 repo 時預選主分支」就永遠預選不到（--heads 會把 HEAD 濾掉，故不能加）
    expect(r.defaultBranch).toBe('kangyue');
  }, 30000);
});
