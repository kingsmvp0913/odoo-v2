// 意圖：工作區的 app/node_modules 是 symlink，而 .gitignore 的 `node_modules/` 帶尾斜線只匹配目錄
// ——git 因此把它當未追蹤檔案吐出來，範圍檢查判「超出可修改範圍」，整份修正無條件作廢。
// 2026-08-21 實測：fix #1 測試 pass、notes 完整，卻 status=rejected、diff 清空，人只看得到「被拒」。
// 這一支把「檢查變更前必須先拆掉連結」釘住：git status 的 mock 依連結是否還在決定輸出，忠實反映
// 真實行為，所以把 unlinkNodeModules 那行刪掉就會紅。
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fixwt-'));
process.env.FIX_WORKTREE_DIR = WORKTREE_ROOT;

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));
const mockQuery = jest.fn().mockResolvedValue({ rows: [{ id: 1, agent_label: 'x', diagnosis: 'd' }] });
jest.mock('../db', () => ({ query: (...args) => mockQuery(...args) }));
jest.mock('../pipeline/agent-loader', () => ({
  loadAgent: () => ({ model: 'test-model', render: () => 'prompt' })
}));
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
const link = path.join(worktree, 'app', 'node_modules');

// 落到 setStatus 的最後一次狀態
const lastStatus = () => {
  const write = mockQuery.mock.calls.filter(([sql]) => /UPDATE finding_fixes/.test(sql)).pop();
  return write && write[1][1];
};
const lastExtra = () => {
  const [sql, params] = mockQuery.mock.calls.filter(([s]) => /UPDATE finding_fixes/.test(s)).pop();
  return { sql, params };
};

beforeAll(() => {
  mockExecFile.mockImplementation((cmd, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    const line = args.join(' ');
    // worktree add 只建目錄（真 git 會 checkout 一份，這裡只要 app/ 存在讓 symlink 掛得上）
    if (line.startsWith('worktree add')) {
      fs.mkdirSync(path.join(worktree, 'app'), { recursive: true });
      return done(null, { stdout: '', stderr: '' });
    }
    // 真 git 的行為：連結還在就會以未追蹤檔現身（gitignore 的 `node_modules/` 匹配不到 symlink）
    if (line.startsWith('status --porcelain')) {
      const stray = fs.existsSync(link) ? '?? app/node_modules\n' : '';
      return done(null, { stdout: stray + ' M app/server/pipeline/health-data.js\n', stderr: '' });
    }
    if (line.startsWith('diff --cached')) return done(null, { stdout: '--- a\n+++ b\n', stderr: '' });
    return done(null, { stdout: '', stderr: '' });
  });
});
afterAll(() => { fs.rmSync(WORKTREE_ROOT, { recursive: true, force: true }); });

test('掛著 node_modules 連結跑完的修正要判 ready，不能被自己的範圍檢查作廢', async () => {
  await runFix(1, { findingId: 9, startedBy: 2 });

  expect(lastStatus()).toBe('ready');
  const { params } = lastExtra();
  expect(params.join(' ')).not.toMatch(/node_modules/);
});
