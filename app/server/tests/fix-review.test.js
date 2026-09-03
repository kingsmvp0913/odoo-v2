// 意圖：fix-review 是「意見回饋通道」的第二道 AI 審核，半夜無人監督時自動核准或擋下一份修正。
// 這一支釘住三件事：
//   1. 送進 runClaude 的 prompt 絕不能包含 finding_fixes.notes（被審者自己寫的辯護詞）——
//      已實測的失敗模式是 agent 讀了 notes 就跟著採信裡面的自我解釋。
//   2. agent 回不出 JSON 一律當 reject（不確定一律 reject，代價不對稱）。
//   3. 截圖失敗要走無截圖路徑，並把原因帶進 reason／prompt，不能無聲無息當作沒發生。

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...args) => mockQuery(...args) }));

const mockRender = jest.fn(() => 'RENDERED-PROMPT');
jest.mock('../pipeline/agent-loader', () => ({
  loadAgent: () => ({ model: 'opus', render: (...args) => mockRender(...args) })
}));

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: (...args) => mockRunClaude(...args) }));

jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));

const mockCapture = jest.fn();
jest.mock('../pipeline/ui-preview', () => ({ captureBeforeAfter: (...args) => mockCapture(...args) }));

const { reviewFix } = require('../pipeline/fix-review');

const NOTES_MARKER = '這是被審者寫的辯護詞不該被讀到';

beforeEach(() => {
  mockQuery.mockReset();
  mockRender.mockClear();
  mockRunClaude.mockReset();
  mockCapture.mockReset();
});

function mockFix(overrides = {}) {
  mockQuery.mockResolvedValue({
    rows: [{
      diff: 'diff --git a/app/server/foo.js b/app/server/foo.js\n+x',
      test_result: 'pass（基線 4 failed／100 passed → 改後 4 failed／101 passed）',
      worktree: '/tmp/some-worktree',
      notes: NOTES_MARKER,
      ...overrides
    }]
  });
}

describe('prompt 不含 notes', () => {
  test('render 收到的參數裡不包含 finding_fixes.notes 的內容', async () => {
    mockFix();
    mockRunClaude.mockResolvedValue({
      text: '<notes>審核意見</notes>\n<result>{"verdict":"approve","reason":"ok"}</result>',
      usage: {}, durationMs: 1
    });
    await reviewFix(1, { title: 't', detail: 'd', action: 'a' });

    expect(mockRender).toHaveBeenCalledTimes(1);
    const renderArgs = mockRender.mock.calls[0][0];
    const serialized = JSON.stringify(renderArgs);
    expect(serialized).not.toContain(NOTES_MARKER);
  });
});

describe('agent 回不出 JSON → 當成 reject', () => {
  test('沒有 <result> 標籤', async () => {
    mockFix();
    mockRunClaude.mockResolvedValue({ text: '我覺得這份修正還可以，但沒有照格式回答', usage: {}, durationMs: 1 });
    const result = await reviewFix(1, { title: 't', detail: 'd', action: 'a' });
    expect(result.verdict).toBe('reject');
  });

  test('<result> 內是壞掉的 JSON', async () => {
    mockFix();
    mockRunClaude.mockResolvedValue({ text: '<result>{not valid json</result>', usage: {}, durationMs: 1 });
    const result = await reviewFix(1, { title: 't', detail: 'd', action: 'a' });
    expect(result.verdict).toBe('reject');
  });

  test('runClaude 執行失敗 → reject', async () => {
    mockFix();
    mockRunClaude.mockRejectedValue(new Error('claude 掛了'));
    const result = await reviewFix(1, { title: 't', detail: 'd', action: 'a' });
    expect(result.verdict).toBe('reject');
    expect(result.reason).toMatch(/claude 掛了/);
  });
});

describe('verify_route 為空 → 不起任何伺服器、不截圖', () => {
  test('finding.verify_route 未提供', async () => {
    mockFix({ diff: 'diff --git a/app/public/js/x.js b/app/public/js/x.js\n+x' });
    mockRunClaude.mockResolvedValue({
      text: '<result>{"verdict":"approve","reason":"ok"}</result>', usage: {}, durationMs: 1
    });
    await reviewFix(1, { title: 't', detail: 'd', action: 'a' });
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('diff 只動 app/server/ → 不截圖', () => {
  test('即使 verify_route 有值也不截圖', async () => {
    mockFix({ diff: 'diff --git a/app/server/foo.js b/app/server/foo.js\n+x' });
    mockRunClaude.mockResolvedValue({
      text: '<result>{"verdict":"approve","reason":"ok"}</result>', usage: {}, durationMs: 1
    });
    await reviewFix(1, { title: 't', detail: 'd', action: 'a', verify_route: '#/tasks' });
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('動到 app/public/ 且有 verify_route → 會截圖', () => {
  test('截圖成功時把路徑帶進 render 參數', async () => {
    mockFix({ diff: 'diff --git a/app/public/js/x.js b/app/public/js/x.js\n+x' });
    mockCapture.mockResolvedValue({ before: '/tmp/before.png', after: '/tmp/after.png' });
    mockRunClaude.mockResolvedValue({
      text: '<result>{"verdict":"approve","reason":"ok"}</result>', usage: {}, durationMs: 1
    });
    await reviewFix(1, { title: 't', detail: 'd', action: 'a', verify_route: '#/tasks' });

    expect(mockCapture).toHaveBeenCalledWith('/tmp/some-worktree', '#/tasks');
    const renderArgs = mockRender.mock.calls[0][0];
    expect(renderArgs.before_screenshot).toBe('/tmp/before.png');
    expect(renderArgs.after_screenshot).toBe('/tmp/after.png');
  });
});

describe('截圖失敗 → 走無截圖路徑，原因要帶得到', () => {
  test('captureBeforeAfter 回 null 時 render 參數要標明失敗原因，且仍照常審', async () => {
    mockFix({ diff: 'diff --git a/app/public/js/x.js b/app/public/js/x.js\n+x' });
    mockCapture.mockResolvedValue(null);
    mockRunClaude.mockResolvedValue({
      text: '<result>{"verdict":"reject","reason":"看不到畫面"}</result>', usage: {}, durationMs: 1
    });
    const result = await reviewFix(1, { title: 't', detail: 'd', action: 'a', verify_route: '#/tasks' });

    expect(mockCapture).toHaveBeenCalled();
    const renderArgs = mockRender.mock.calls[0][0];
    expect(renderArgs.before_screenshot).toMatch(/截圖失敗/);
    expect(renderArgs.after_screenshot).toMatch(/截圖失敗/);
    expect(result.verdict).toBe('reject');
  });
});

describe('修正紀錄不存在', () => {
  test('查無資料 → reject', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const result = await reviewFix(999, { title: 't' });
    expect(result.verdict).toBe('reject');
    expect(mockRunClaude).not.toHaveBeenCalled();
  });
});
