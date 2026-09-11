// 意圖：「合併並套用」會把碼推上 origin 再重啟整個平台——這是本專案唯一一顆會停掉自己的按鈕。
// 釘住的是三道不能被繞過的守衛：不在主分支不動、會被一起帶走的髒東西不動、有任務在飛就不重啟。
// 任一道失守的代價分別是：合併到錯的分支、把別人的工作一起 commit、砍掉在跑的 agent。
// 第二道刻意只擋「已暫存」與「與這次要合併的檔重疊」——擋過頭的代價同樣真實：2026-09-08 一個
// 不相干的檔沒提交，當晚五組修正一組都沒併進去，而畫面上只留一行「留待下批重試」。
const os = require('os');

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));
const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...args) => mockQuery(...args) }));
jest.mock('../lib/git-identity', () => ({ buildGitEnv: async () => ({ GIT_AUTHOR_NAME: 't' }) }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

const { applyFix, pickSelfContainer } = require('../pipeline/finding-fix');

// execFile 的 promisify 版走 (cmd, args, opts, cb)；這裡照 cmd+args 決定回什麼
let gitBranch, gitDirty, mergeFails, ffFails, pushFails, gitCounts, mergeFiles, headBlobs, workBlobs;
const calls = () => mockExecFile.mock.calls.map(c => [c[0], ...c[1]].join(' '));

beforeEach(() => {
  gitBranch = 'master'; gitDirty = ''; mergeFails = false; ffFails = false; pushFails = false;
  // 暫存檔在 HEAD／工作區的 blob。預設兩邊不同＝真的有人改；要演殘影就把兩邊設成同一個值
  headBlobs = {}; workBlobs = {};
  // behind \t ahead（origin/master...master 的左右計數）
  gitCounts = '0\t0';
  mergeFiles = 'app/server/pipeline/runner.js\n';
  mockExecFile.mockReset();
  mockExecFile.mockImplementation((cmd, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    const line = args.join(' ');
    if (cmd === 'docker' && line.startsWith('ps')) return done(null, { stdout: 'odoo-v2\nother\n', stderr: '' });
    if (cmd === 'docker' && line.startsWith('inspect')) {
      return done(null, { stdout: `/odoo-v2\t${os.hostname()}\n/other\tsomewhere\n`, stderr: '' });
    }
    if (cmd === 'docker' && line.startsWith('restart')) return done(null, { stdout: '', stderr: '' });
    if (line.startsWith('rev-parse --abbrev-ref')) return done(null, { stdout: gitBranch + '\n', stderr: '' });
    if (line === 'rev-parse HEAD') return done(null, { stdout: 'abc1234\n', stderr: '' });
    if (line.startsWith('status --porcelain')) return done(null, { stdout: gitDirty, stderr: '' });
    if (line.startsWith('rev-parse -q --verify HEAD:')) {
      const f = line.slice('rev-parse -q --verify HEAD:'.length);
      return done(null, { stdout: (headBlobs[f] || `head-${f}`) + '\n', stderr: '' });
    }
    if (line.startsWith('hash-object -- ')) {
      const f = line.slice('hash-object -- '.length);
      return done(null, { stdout: (workBlobs[f] || `work-${f}`) + '\n', stderr: '' });
    }
    // 限定路徑的 reset＝把 index 同步回 HEAD；之後再問 status 就是乾淨的
    if (line.startsWith('reset -q -- ')) { gitDirty = ''; return done(null, { stdout: '', stderr: '' }); }
    if (line.startsWith('rev-list --left-right')) return done(null, { stdout: gitCounts + '\n', stderr: '' });
    if (line.startsWith('diff --name-only')) return done(null, { stdout: mergeFiles, stderr: '' });
    if (line.startsWith('merge --ff-only') && ffFails) return done(new Error('Not possible to fast-forward'));
    if (line.startsWith('merge --no-ff') && mergeFails) return done(new Error('CONFLICT (content)'));
    if (line.startsWith('push') && pushFails) return done(new Error('! [rejected] master -> master (fetch first)'));
    return done(null, { stdout: '', stderr: '' });
  });
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [{ id: 1, status: 'adopted', branch: 'fix/finding-9-1', finding_id: 9 }] });
});

test('不在主分支就不合併：主 clone 停在別的分支時代為切換等於替別人做決定', async () => {
  gitBranch = 'testing';
  await expect(applyFix(1, 2, [])).rejects.toThrow(/testing/);
  expect(calls().some(c => c.includes('merge'))).toBe(false);
});

test('staged 的變更就不合併：git add 過的東西會被一起包進 merge commit', async () => {
  gitDirty = 'M  app/server/other-work.js\n';   // 第一欄＝index
  await expect(applyFix(1, 2, [])).rejects.toThrow(/暫存/);
  expect(calls().some(c => c.includes('merge --no-ff'))).toBe(false);
});

// 2026-09-11：有人用私有 index 提交後漏了同步，共用 index 停在提交前的樹 ⇒ status 冒出一排「已暫存」，
// 但工作區內容其實全等於 HEAD。舊版照樣拒絕合併，兩條已過審的修正卡了一整晚。
// mergeFiles 刻意包含殘影檔：同步前的 status 那一欄是 'MM'，若沒有重新讀 status，下面「工作區改動與
// 要合併的檔重疊」那道檢查會拿過期的結果把它誤擋下來。
test('暫存區只剩殘影（內容＝HEAD）→ 限定路徑同步回 HEAD，再照常合併', async () => {
  gitDirty = 'MM app/package.json\nD  app/jest.setup.js\n';
  headBlobs = { 'app/package.json': 'b1', 'app/jest.setup.js': 'b2' };
  workBlobs = { 'app/package.json': 'b1', 'app/jest.setup.js': 'b2' };
  mergeFiles = 'app/package.json\n';
  const r = await applyFix(1, 2, [{ taskId: 1, userId: 2, startedAt: Date.now() }]);
  expect(r).toMatchObject({ merged: true });
  const seq = calls();
  const reset = seq.indexOf('git reset -q -- app/package.json app/jest.setup.js');
  expect(reset).toBeGreaterThanOrEqual(0);
  expect(reset).toBeLessThan(seq.findIndex(c => c.includes('merge --no-ff')));
});

test('殘影混著真的暫存 → 照樣擋下、只點名真的那個，暫存區一個都不動', async () => {
  gitDirty = 'MM app/package.json\nM  app/server/other-work.js\n';
  headBlobs = { 'app/package.json': 'b1' };
  workBlobs = { 'app/package.json': 'b1' };
  const err = await applyFix(1, 2, []).catch(e => e);
  expect(err.message).toMatch(/other-work\.js/);
  expect(err.message).not.toMatch(/package\.json/);
  expect(calls().some(c => c.startsWith('git reset'))).toBe(false);
  expect(calls().some(c => c.includes('merge --no-ff'))).toBe(false);
});

// 舊版是「有任何未提交的檔就整批放棄」，害一個不相干的檔擋掉整晚的自動合併（2026-09-08 實際發生：
// chat.md 改了一行沒提交，五組修正一組都沒併進去）。工作區的未暫存變更不會進 merge commit，
// 真正會出事的只有「它跟這次要合併的檔重疊」——那時 git 自己也會拒絕，但錯誤訊息看不出所以然。
test('只有工作區改動、且不碰這次要合併的檔 → 照常合併', async () => {
  gitDirty = ' M .claude/agents/chat.md\n';
  mergeFiles = 'app/server/pipeline/runner.js\napp/server/pipeline/spec-version.js\n';
  const r = await applyFix(1, 2, [{ taskId: 1, userId: 2, startedAt: Date.now() }]);
  expect(r).toMatchObject({ merged: true });
  expect(calls().some(c => c.includes('merge --no-ff'))).toBe(true);
});

test('工作區改動與要合併的檔重疊 → 擋下，並指名是哪個檔', async () => {
  gitDirty = ' M app/server/pipeline/runner.js\n';
  mergeFiles = 'app/server/pipeline/runner.js\n';
  await expect(applyFix(1, 2, [])).rejects.toThrow(/runner\.js/);
  expect(calls().some(c => c.includes('merge --no-ff'))).toBe(false);
});

test('合併衝突要 abort：留著衝突會讓主 clone 卡在 MERGING，之後每個 git 動作都失敗', async () => {
  mergeFails = true;
  await expect(applyFix(1, 2, [])).rejects.toThrow(/合併失敗/);
  expect(calls()).toContain('git merge --abort');
  expect(calls().some(c => c.startsWith('git push'))).toBe(false);
});

test('有任務在飛就不重啟，但碼照樣合併推送——狀態記 merged，下次按只補重啟那一步', async () => {
  const r = await applyFix(1, 2, [{ taskId: 77, userId: 2, startedAt: Date.now() }]);
  expect(r).toMatchObject({ merged: true, restarted: false });
  expect(r.inflight).toHaveLength(1);
  expect(calls().some(c => c.startsWith('docker restart'))).toBe(false);
  expect(mockQuery.mock.calls.some(([sql, p]) => /UPDATE finding_fixes/.test(sql) && p[1] === 'merged')).toBe(true);
  // 提案此時**不能**標 done：畫面靠它決定還要不要給按鈕，提早標會把「還差重啟」那顆一起藏掉
  expect(mockQuery.mock.calls.some(([sql]) => /UPDATE health_check_findings/.test(sql))).toBe(false);
});

test('沒有任務在飛：合併→推 origin→重啟自己所在的容器', async () => {
  jest.useFakeTimers();
  try {
    const r = await applyFix(1, 2, []);
    expect(r).toMatchObject({ merged: true, restarted: true, container: 'odoo-v2' });
    // 重啟刻意延遲：這道指令會把自己這個行程一起帶走，HTTP 回應得先送出去
    expect(calls().some(c => c.startsWith('docker restart'))).toBe(false);
    jest.runAllTimers();
    expect(calls()).toContain('docker restart odoo-v2');
    expect(calls()).toContain('git push origin master');
  } finally { jest.useRealTimers(); }
});

test('status=merged 不重複合併，只補重啟：上一次已經推上去了，再合一次會產生空 merge commit', async () => {
  jest.useFakeTimers();
  try {
    mockQuery.mockResolvedValue({ rows: [{ id: 1, status: 'merged', branch: 'fix/finding-9-1', finding_id: 9 }] });
    await applyFix(1, 2, []);
    expect(calls().some(c => c.includes('merge --no-ff'))).toBe(false);
    expect(calls().some(c => c.startsWith('git push'))).toBe(false);
    jest.runAllTimers();
    expect(calls()).toContain('docker restart odoo-v2');
  } finally { jest.useRealTimers(); }
});

test('合併前必須先跟遠端對齊：遠端被別股工作推進過的話，直接合併只會換來 push 被拒', async () => {
  jest.useFakeTimers();
  try {
    await applyFix(1, 2, []);
    const seq = calls();
    const fetched = seq.findIndex(c => c.startsWith('git fetch origin master'));
    const ff = seq.findIndex(c => c.startsWith('git merge --ff-only origin/master'));
    const merged = seq.findIndex(c => c.includes('merge --no-ff'));
    expect(fetched).toBeGreaterThanOrEqual(0);
    expect(ff).toBeGreaterThan(fetched);
    expect(merged).toBeGreaterThan(ff);
  } finally { jest.useRealTimers(); }
});

test('整套做完（含重啟）才把提案標 done：留在 pending 的話，下一輪健檢會把同一件事再提一次', async () => {
  jest.useFakeTimers();
  try {
    await applyFix(1, 2, []);
    const marked = mockQuery.mock.calls.find(([sql]) => /UPDATE health_check_findings/.test(sql));
    expect(marked).toBeDefined();
    expect(marked[0]).toMatch(/status='done'/);
    // applied_at 是回頭驗成效的起算點，重按不該把它往後推
    expect(marked[0]).toMatch(/COALESCE\(applied_at/);
    expect(marked[1]).toEqual([9, 2]);
  } finally { jest.useRealTimers(); }
});

test('真的分岔（兩邊各有各的 commit）就停手：本地那些是誰放的、要不要留只有人知道', async () => {
  gitCounts = '3\t2';   // origin 多 3、本地多 2
  await expect(applyFix(1, 2, [])).rejects.toThrow(/分岔/);
  expect(calls().some(c => c.includes('merge --no-ff'))).toBe(false);
  expect(calls().some(c => c.startsWith('git push'))).toBe(false);
});

// 「commit 了但忘記 push」跟「分岔」不是同一件事：遠端沒有本地沒有的東西時，本地那幾顆推上去
// 就對齊了，不需要人裁決。舊版把兩者混為一談，於是忘記 push 一次＝當晚全部白跑。
test('只是忘記 push（本地領先、遠端沒新東西）→ 先推上去再合併', async () => {
  gitCounts = '0\t2';
  const r = await applyFix(1, 2, [{ taskId: 1, userId: 2, startedAt: Date.now() }]);
  expect(r).toMatchObject({ merged: true });
  const seq = calls();
  const pushed = seq.findIndex(c => c === 'git push origin master');
  const merged = seq.findIndex(c => c.includes('merge --no-ff'));
  expect(pushed).toBeGreaterThanOrEqual(0);
  expect(pushed).toBeLessThan(merged);
});

test('追不上 origin 仍要停手，不能默默往下合併', async () => {
  ffFails = true;
  await expect(applyFix(1, 2, [])).rejects.toThrow(/追上/);
  expect(calls().some(c => c.includes('merge --no-ff'))).toBe(false);
});

test('push 失敗要把合併節點收回去：留著會讓主分支多一顆只有本機看得到的 commit，重按也解不開', async () => {
  pushFails = true;
  await expect(applyFix(1, 2, [])).rejects.toThrow(/推送失敗/);
  // 回到合併前那一顆；沒有這步，下次按 merge 會回 Already up to date、push 依然被拒
  expect(calls()).toContain('git reset --hard abc1234');
  expect(mockQuery.mock.calls.some(([sql, p]) => /UPDATE finding_fixes/.test(sql) && p[1] === 'merged')).toBe(false);
  expect(calls().some(c => c.startsWith('docker restart'))).toBe(false);
});

test('ready（還沒採用）不能套用：diff 都還沒進 commit，合併過去是空的', async () => {
  mockQuery.mockResolvedValue({ rows: [{ id: 1, status: 'ready', branch: 'fix/finding-9-1' }] });
  await expect(applyFix(1, 2, [])).rejects.toThrow(/不能套用/);
});

describe('pickSelfContainer', () => {
  const out = ['/odoo-v2\tai-server', '/odoo-test\tabc123', '/vpn\tai-server'].join('\n');

  test('用 hostname 反查容器名：容器名沒有任何管道傳進來，env 只有 hostname', () => {
    expect(pickSelfContainer('/odoo-v2\tai-server\n/odoo-test\tabc123', 'ai-server')).toBe('odoo-v2');
  });

  test('命中不唯一寧可失敗：重啟錯的容器會停掉別人的服務', () => {
    expect(() => pickSelfContainer(out, 'ai-server')).toThrow(/命中 2 個/);
  });

  test('一個都沒命中也要失敗，不能默默回第一個', () => {
    expect(() => pickSelfContainer(out, 'nobody')).toThrow(/命中 0 個/);
  });
});
