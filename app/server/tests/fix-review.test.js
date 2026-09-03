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

// health-auditor.md:61 明寫 risk_if_wrong「是下游 fix-review 審查這條修正時的基準」。
// DB 有欄、health-check-runner 有寫入，但沒人撈出來餵進 prompt 的話，那句話等於空頭支票，
// 而且不會有任何徵狀（審查照跑、只是少看一個維度）。
describe('risk_if_wrong 要真的餵進 prompt', () => {
  test('finding 直接帶了 risk_if_wrong → 用它，不必回頭查 DB', async () => {
    mockFix();
    mockRunClaude.mockResolvedValue({
      text: '<result>{"verdict":"approve","reason":"ok"}</result>', usage: {}, durationMs: 1
    });
    await reviewFix(1, { title: 't', detail: 'd', action: 'a', risk_if_wrong: '會弄壞 QA 關的退回路由' });

    expect(mockRender.mock.calls[0][0].risk_if_wrong).toBe('會弄壞 QA 關的退回路由');
    // 沒有回頭 JOIN health_check_findings
    expect(mockQuery.mock.calls.filter(([sql]) => /health_check_findings/.test(sql))).toHaveLength(0);
  });

  test('finding 沒帶 → 自己 JOIN health_check_findings 撈', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ diff: 'diff --git a/app/server/x.js b/app/server/x.js', test_result: 'pass', worktree: '/tmp/w', notes: NOTES_MARKER }] })
      .mockResolvedValueOnce({ rows: [{ risk_if_wrong: '會讓部署關無限重試' }] });
    mockRunClaude.mockResolvedValue({
      text: '<result>{"verdict":"approve","reason":"ok"}</result>', usage: {}, durationMs: 1
    });
    await reviewFix(1, { title: 't', detail: 'd', action: 'a' });

    expect(mockRender.mock.calls[0][0].risk_if_wrong).toBe('會讓部署關無限重試');
  });

  test('兩邊都沒有 → 明白標示「沒有宣告失敗模式」，不留空字串', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ diff: 'd', test_result: 'pass', worktree: '/tmp/w' }] })
      .mockResolvedValueOnce({ rows: [] });
    mockRunClaude.mockResolvedValue({
      text: '<result>{"verdict":"approve","reason":"ok"}</result>', usage: {}, durationMs: 1
    });
    await reviewFix(1, { title: 't' });

    expect(mockRender.mock.calls[0][0].risk_if_wrong).toMatch(/沒有宣告失敗模式/);
  });
});

// fix-review.md 對 agent 說 <notes>「這段是給人事後複核用的」。這是無人監督閘門唯一的
// 人類稽核材料——只留一句 reason 的話，事後想知道「它為什麼這樣判」就再也查不到。
describe('agent 的 <notes> 不得丟棄', () => {
  test('notes 要被接出來回傳', async () => {
    mockFix();
    mockRunClaude.mockResolvedValue({
      text: '<notes>判準 3 沒過：改了行為卻沒有對應測試。</notes>\n'
          + '<result>{"verdict":"reject","reason":"缺測試"}</result>',
      usage: {}, durationMs: 1
    });
    const result = await reviewFix(1, { title: 't' });
    expect(result.notes).toBe('判準 3 沒過：改了行為卻沒有對應測試。');
    expect(result.verdict).toBe('reject');
  });

  test('解析不出 result 時也要保住 notes（那時最需要人來看它在想什麼）', async () => {
    mockFix();
    mockRunClaude.mockResolvedValue({
      text: '<notes>我覺得怪怪的但講不清楚</notes>\n沒有 result 標籤', usage: {}, durationMs: 1
    });
    const result = await reviewFix(1, { title: 't' });
    expect(result.verdict).toBe('reject');
    expect(result.notes).toBe('我覺得怪怪的但講不清楚');
  });
});

// rules/pipeline.md#72：模型輸出的大小寫與尾隨空白不穩定。
// 方向雖然安全（不正規化只會多 reject 不會多 approve），但那是「無辜的 reject」。
describe('verdict 大小寫與空白要正規化', () => {
  test.each(['Approve', 'APPROVE', ' approve ', 'approve\n'])('%p → approve', async (raw) => {
    mockFix();
    mockRunClaude.mockResolvedValue({
      text: `<result>{"verdict":${JSON.stringify(raw)},"reason":"ok"}</result>`, usage: {}, durationMs: 1
    });
    const result = await reviewFix(1, { title: 't' });
    expect(result.verdict).toBe('approve');
  });

  test('"Reject" 一樣正規化', async () => {
    mockFix();
    mockRunClaude.mockResolvedValue({
      text: '<result>{"verdict":"Reject","reason":"不行"}</result>', usage: {}, durationMs: 1
    });
    expect((await reviewFix(1, { title: 't' })).verdict).toBe('reject');
  });
});

// 夜間跑幾條就疊幾份 PNG，沒有人回收。ui-preview 刻意把暫存目錄交出來，就是要在這裡收。
describe('暫存截圖用完要刪', () => {
  const realFs = jest.requireActual('fs');
  const os = require('os');
  const path = require('path');

  test('審完之後暫存目錄不留下（approve 路徑）', async () => {
    const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'uiprev-test-'));
    realFs.writeFileSync(path.join(dir, 'before.png'), 'x');
    mockFix({ diff: 'diff --git a/app/public/js/x.js b/app/public/js/x.js' });
    mockCapture.mockResolvedValue({ before: `${dir}/before.png`, after: `${dir}/after.png`, dir });
    mockRunClaude.mockResolvedValue({
      text: '<result>{"verdict":"approve","reason":"ok"}</result>', usage: {}, durationMs: 1
    });

    await reviewFix(1, { title: 't', verify_route: '#/tasks' });
    expect(realFs.existsSync(dir)).toBe(false);
  });

  test('agent 執行失敗那條路也要刪（否則失敗越多殘留越多）', async () => {
    const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'uiprev-test-'));
    mockFix({ diff: 'diff --git a/app/public/js/x.js b/app/public/js/x.js' });
    mockCapture.mockResolvedValue({ before: `${dir}/before.png`, after: `${dir}/after.png`, dir });
    mockRunClaude.mockRejectedValue(new Error('claude 掛了'));

    const result = await reviewFix(1, { title: 't', verify_route: '#/tasks' });
    expect(result.verdict).toBe('reject');
    expect(realFs.existsSync(dir)).toBe(false);
  });
});

// 這一支是閘門，而 runClaude 帶 --dangerously-skip-permissions。不指定 cwd 會讓它跑在
// 平台的 live checkout 上，等於給審查者一把可以動被審程式碼的鑰匙。
describe('審查者不得跑在平台 live checkout 上', () => {
  test('runClaude 要帶 cwd，且不是平台 repo', async () => {
    mockFix();
    mockRunClaude.mockResolvedValue({
      text: '<result>{"verdict":"approve","reason":"ok"}</result>', usage: {}, durationMs: 1
    });
    await reviewFix(1, { title: 't' });

    const opts = mockRunClaude.mock.calls[0][1];
    expect(opts.cwd).toBeTruthy();
    expect(opts.cwd).not.toContain('odoo-v2');
  });
});
