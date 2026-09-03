// 意圖：畫面上那行 test_result 是人決定要不要採用這份修正的主要依據。它一度是 agent 的自我申報
// ——2026-08-21 實測，某次修正在 <result> 填 `pass`，同一份 notes 的最後一段卻寫著「9 failed」，
// 而人只看得到那個綠字。這一支釘住「平台自己跑過才算數」：把 measureTests 那段拿掉就會紅。
//
// runFix 現在會量兩次：改碼前（基線）、改碼後，判準是「有沒有新增紅燈」而非 exit code。
// npmResult 可傳陣列依序供應（第一次＝基線、第二次＝改後）；傳單一物件則兩次都回同一份
// （用於「基線與改後打平」情境）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fixtr-'));
process.env.FIX_WORKTREE_DIR = WORKTREE_ROOT;

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));
const mockQuery = jest.fn().mockResolvedValue({ rows: [{ id: 1, agent_label: 'x', diagnosis: 'd' }] });
jest.mock('../db', () => ({ query: (...args) => mockQuery(...args) }));
jest.mock('../pipeline/agent-loader', () => ({
  loadAgent: () => ({ model: 'test-model', render: () => 'prompt' })
}));
// agent 一律自報 pass——這正是要被推翻的那個說法
jest.mock('../pipeline/claude-runner', () => ({
  runClaude: async () => ({
    text: '<notes>改了 a.js</notes>\n<result>{"tests":"pass"}</result>', usage: {}, durationMs: 1
  })
}));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../lib/git-identity', () => ({ buildGitEnv: async () => ({}) }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

const { runFix } = require('../pipeline/finding-fix');

const worktree = path.join(WORKTREE_ROOT, 'fix-1');

// 最後一次 setStatus 寫進去的 test_result
const lastTestResult = () => {
  const [sql, params] = mockQuery.mock.calls.filter(([s]) => /UPDATE finding_fixes/.test(s)).pop();
  const idx = sql.split(',').findIndex(seg => /test_result/.test(seg));
  return { sql, params, value: params.find(p => typeof p === 'string' && /pass|fail|unknown/.test(p)), idx };
};

// jest 的總結行印在 stderr；紅燈時 exit≠0，promisify 過的 execFile 會 reject 並把兩股輸出掛在 err 上
let npmResult; // 單一物件或 [基線, 改後] 陣列
let npmCallCount;
beforeEach(() => {
  mockQuery.mockClear();
  npmResult = null;
  npmCallCount = 0;
  mockExecFile.mockImplementation((cmd, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    const line = args.join(' ');
    if (line.startsWith('worktree add')) {
      fs.mkdirSync(path.join(worktree, 'app'), { recursive: true });
      return done(null, { stdout: '', stderr: '' });
    }
    if (cmd === 'npm') {
      const seq = Array.isArray(npmResult) ? npmResult : [npmResult, npmResult];
      const result = seq[Math.min(npmCallCount, seq.length - 1)];
      npmCallCount += 1;
      if (result.fails) {
        const err = new Error('Command failed: npm run test:quiet');
        err.stdout = ''; err.stderr = result.stderr;
        return done(err);
      }
      return done(null, { stdout: '', stderr: result.stderr });
    }
    if (line.startsWith('status --porcelain')) {
      return done(null, { stdout: ' M app/server/pipeline/health-data.js\n', stderr: '' });
    }
    if (line.startsWith('diff --cached')) return done(null, { stdout: '--- a\n+++ b\n', stderr: '' });
    return done(null, { stdout: '', stderr: '' });
  });
});
afterAll(() => { fs.rmSync(WORKTREE_ROOT, { recursive: true, force: true }); });

test('測試實際是紅的就記 fail，並把 agent 自報的 pass 一起標出來', async () => {
  // 基線沒有紅燈，改後新增 9 個 → 判定退步，不是單看改後有沒有紅燈
  npmResult = [
    { fails: false, stderr: 'Tests:       3122 passed, 3122 total\n' },
    { fails: true, stderr: 'Tests:       9 failed, 3113 passed, 3122 total\n' },
  ];
  await runFix(1, { findingId: 9, startedBy: 2 });

  const { value } = lastTestResult();
  expect(value).toMatch(/^fail/);
  expect(value).toContain('9 failed');
  expect(value).toContain('3113 passed');
  // 自報與實測不一致要黏在同一行：分開兩處顯示的話，人只會看到前面那個字
  expect(value).toContain('agent 自報 pass');
});

test('基線與改後打平才記 pass，且不留下多餘的自報噪音', async () => {
  npmResult = { fails: false, stderr: 'Tests:       3 skipped, 3122 passed, 3125 total\n' };
  await runFix(1, { findingId: 9, startedBy: 2 });

  const { value } = lastTestResult();
  expect(value).toMatch(/^pass/);
  expect(value).toContain('3122 passed');
  expect(value).not.toContain('自報');
});

test('測試根本沒跑起來要記 unknown，不能因為沒有紅燈就當成綠的', async () => {
  npmResult = { fails: true, stderr: 'sh: npm: not found\n' };
  await runFix(1, { findingId: 9, startedBy: 2 });

  const { value } = lastTestResult();
  expect(value).toMatch(/^unknown/);
  expect(value).toContain('agent 自報 pass');
});
