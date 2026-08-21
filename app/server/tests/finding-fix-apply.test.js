// 意圖：「合併並套用」會把碼推上 origin 再重啟整個平台——這是本專案唯一一顆會停掉自己的按鈕。
// 釘住的是三道不能被繞過的守衛：不在主分支不動、主 clone 髒不動、有任務在飛就不重啟。
// 任一道失守的代價分別是：合併到錯的分支、把別人未提交的工作一起 commit、砍掉在跑的 agent。
const os = require('os');

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));
const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...args) => mockQuery(...args) }));
jest.mock('../lib/git-identity', () => ({ buildGitEnv: async () => ({ GIT_AUTHOR_NAME: 't' }) }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

const { applyFix, pickSelfContainer } = require('../pipeline/finding-fix');

// execFile 的 promisify 版走 (cmd, args, opts, cb)；這裡照 cmd+args 決定回什麼
let gitBranch, gitDirty, mergeFails, ffFails, pushFails;
const calls = () => mockExecFile.mock.calls.map(c => [c[0], ...c[1]].join(' '));

beforeEach(() => {
  gitBranch = 'master'; gitDirty = ''; mergeFails = false; ffFails = false; pushFails = false;
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

test('主 clone 有未提交變更就不合併：此 repo 常態多股平行工作，硬合併會把別人的東西一起帶走', async () => {
  gitDirty = ' M app/server/other-work.js\n';
  await expect(applyFix(1, 2, [])).rejects.toThrow(/未提交/);
  expect(calls().some(c => c.includes('merge'))).toBe(false);
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

test('推上去之後提案要標 done：留在 pending 的話，下一輪健檢會把同一件事再提一次', async () => {
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

test('與遠端分岔就停手：本地那些沒推上去的東西是誰放的、要不要留，只有人知道', async () => {
  ffFails = true;
  await expect(applyFix(1, 2, [])).rejects.toThrow(/分岔/);
  expect(calls().some(c => c.includes('merge --no-ff'))).toBe(false);
  expect(calls().some(c => c.startsWith('git push'))).toBe(false);
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
