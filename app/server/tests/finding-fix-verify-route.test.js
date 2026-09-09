// 意圖：釘住「截圖要開哪一頁由改碼的那一關回報」這條新契約（2026-09-09）。
//
// 以前這個路由由入口的翻譯 agent 猜，寫在 feedback 表上。那有兩個後果：猜的人沒讀過任何程式碼；
// 而 health_check_findings 根本沒有這個欄位 ⇒ 健檢提案改前端也永遠拍不到對照圖。改成由
// platform-fix 回報、存 finding_fixes.verify_route 之後，兩個問題一起消失。
//
// 這一支同時釘住路由的過濾：它會被直接送進 captureBeforeAfter 組成瀏覽器要開的網址，
// 等於 agent 輸出直通瀏覽器。只收 `#/` 開頭的平台 hash 路由，其餘一律當沒填。
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fixvr-'));
process.env.FIX_WORKTREE_DIR = WORKTREE_ROOT;

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));

// 第一次查詢是撈提案本身，之後才是各種 UPDATE；附件查詢用 rows:[] 就夠（另一支測附件內容）
const mockQuery = jest.fn().mockResolvedValue({ rows: [{ id: 1, agent_label: 'x', diagnosis: 'd' }] });
jest.mock('../db', () => ({ query: (...args) => mockQuery(...args) }));

const mockRender = jest.fn(() => 'prompt');
jest.mock('../pipeline/agent-loader', () => ({
  loadAgent: () => ({ model: 'test-model', render: (...args) => mockRender(...args) })
}));

// 變數名必須以 mock 開頭：jest.mock 的工廠不准引用其他外部變數
let mockAgentResult;
jest.mock('../pipeline/claude-runner', () => ({
  runClaude: async () => ({ text: mockAgentResult, usage: {}, durationMs: 1 })
}));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../lib/git-identity', () => ({ buildGitEnv: async () => ({}) }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

const { runFix } = require('../pipeline/finding-fix');
const worktree = path.join(WORKTREE_ROOT, 'fix-1');

const GREEN = 'Tests:       10 passed, 10 total\n';

// setStatus 是動態組 SQL（`verify_route=$N`），所以要靠欄位在 SQL 裡的位置取值，
// 不能用「找看起來像路由的那個字串」——那樣過濾失敗時會靜默取到別的欄位而測試照樣綠。
function lastVerifyRoute() {
  const [sql, params] = mockQuery.mock.calls.filter(([s]) => /UPDATE finding_fixes SET/.test(s)).pop();
  const cols = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('finished_at')).split(',');
  const idx = cols.findIndex(seg => /verify_route\s*=\s*\$/.test(seg));
  if (idx < 0) return undefined;
  const n = Number(/\$(\d+)/.exec(cols[idx])[1]);
  return params[n - 1];
}

beforeEach(() => {
  mockQuery.mockClear();
  mockRender.mockClear();
  mockAgentResult = '<notes>改了 a.js</notes>\n<result>{"changed":true,"tests":"pass"}</result>';
  mockExecFile.mockImplementation((cmd, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    const line = args.join(' ');
    if (line.startsWith('worktree add')) {
      fs.mkdirSync(path.join(worktree, 'app'), { recursive: true });
      return done(null, { stdout: '', stderr: '' });
    }
    if (cmd === 'npm') return done(null, { stdout: '', stderr: GREEN });
    if (line.startsWith('status --porcelain')) {
      return done(null, { stdout: ' M app/public/js/ui-next/pages/AdminFeedback.js\n', stderr: '' });
    }
    if (line.startsWith('diff --cached')) return done(null, { stdout: '--- a\n+++ b\n', stderr: '' });
    return done(null, { stdout: '', stderr: '' });
  });
});
afterAll(() => { fs.rmSync(WORKTREE_ROOT, { recursive: true, force: true }); });

test('回報合法的 hash 路由 → 寫進 finding_fixes.verify_route', async () => {
  mockAgentResult = '<notes>n</notes>\n<result>{"changed":true,"tests":"pass","verify_route":"#/admin/feedback"}</result>';
  await runFix(1, { findingId: 9, startedBy: 2 });
  expect(lastVerifyRoute()).toBe('#/admin/feedback');
});

test('沒回報路由（後端改動沒有畫面可拍）→ 存 null，不是空字串', async () => {
  await runFix(1, { findingId: 9, startedBy: 2 });
  // 空字串與 null 在 needsScreenshot 都不截圖，但存 null 才分得出「沒填」與「填了個空的」
  expect(lastVerifyRoute()).toBeNull();
});

// 這個值會被拼進瀏覽器要開的網址（見 ui-preview.js）。agent 的輸出＝不可信的外部輸入：
// 放行任意字串等於讓半夜無人監督的 agent 決定審查機器要連到哪裡去。
test.each([
  ['http://evil.example/x', '絕對網址'],
  ['javascript:alert(1)', 'javascript scheme'],
  ['/admin/feedback', '少了 # 的裸路徑'],
  ['#沒有斜線', '# 後面不是 /'],
])('非法路由 %s（%s）→ 一律當沒填', async (route) => {
  mockAgentResult = `<notes>n</notes>\n<result>{"changed":true,"tests":"pass","verify_route":"${route}"}</result>`;
  await runFix(1, { findingId: 9, startedBy: 2 });
  expect(lastVerifyRoute()).toBeNull();
});

// 使用者附的截圖常常是一則意見裡講得最清楚的部分。翻譯關是原本唯一會讀圖的地方，
// 拿掉之後若沒接到這裡，圖就再也沒有任何 agent 看得到，而且完全無訊號。
describe('使用者附件要送進 prompt', () => {
  test('沒有意見成員 → 明講「無」，不是留空讓 placeholder 露出來', async () => {
    await runFix(1, { findingId: 9, startedBy: 2 });
    expect(mockRender.mock.calls[0][0].attachments).toContain('無');
  });

  test('有意見成員的附件 → 絕對路徑＋唯讀授權（相對路徑 agent 打不開，而且靜默）', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM feedback_attachments/.test(sql)) {
        return { rows: [{ filename: '畫面.png', mimetype: 'image/png', file_path: 'feedback_7/a.png' }] };
      }
      return { rows: [{ id: 1, agent_label: 'x', diagnosis: 'd' }] };
    });
    await runFix(1, { findingId: 9, startedBy: 2, members: [{ source: 'feedback', row: { id: 7 } }] });

    const note = mockRender.mock.calls[0][0].attachments;
    expect(note).toContain('畫面.png');
    expect(note).toContain('image/png');
    expect(path.isAbsolute(note.split('：').pop().trim())).toBe(true);
    expect(note).toContain('唯讀');
  });
});
