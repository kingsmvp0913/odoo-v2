// 意圖：fix-verify 是夜間改善通道「合併進 master 之前」的最後一道關卡，全程無人監督。
// 它跟 fix-review 的差別是它跑在工作區內、有權直接改碼——這個權力也是它最大的風險來源。
// 這一支釘住的是「平台不採信 agent 自報」這條防線的三個面向：
//   1. 它到底有沒有動手 → 比對前後的 staged diff，不看它自己填的 changed 欄位。
//      （自報 false 卻改了東西 ⇒ 未經測試的改動會被直接合併進 master，這是最貴的失敗模式。）
//   2. 它改的東西在不在可修改範圍 → 重跑 classifyChanges，且要排在跑測試之前（省四分鐘）。
//   3. 它改完測試有沒有退步 → 跟「改碼前」的基線比，不是跟改碼後比。
// 以及「檢查不了」與「檢查過了」不可以是同一個結果——解析不出來／沒有工作區一律擋下。

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...args) => mockQuery(...args) }));

const mockRender = jest.fn(() => 'RENDERED-PROMPT');
jest.mock('../pipeline/agent-loader', () => ({
  loadAgent: () => ({ model: 'opus', render: (...args) => mockRender(...args) })
}));

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: (...args) => mockRunClaude(...args) }));

jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));

const mockGit = jest.fn();
const mockMeasure = jest.fn();
// classifyChanges／compareToBaseline 刻意用真貨：它們就是這一關的判準本體，換成 mock 等於
// 把「範圍檢查」「退步判定」這兩件要驗的事一起假掉，測試會全綠而防線是空的。
jest.mock('../pipeline/finding-fix', () => {
  const actual = jest.requireActual('../pipeline/finding-fix');
  return {
    ...actual,
    measureTests: (...args) => mockMeasure(...args),
    linkNodeModules: jest.fn(),
    unlinkNodeModules: jest.fn(),
    git: (...args) => mockGit(...args),
  };
});

const { verifyFix } = require('../pipeline/fix-verify');

const FINDING = { title: 't', detail: 'd', action: 'a' };
const DIFF_BEFORE = 'diff --git a/app/server/foo.js b/app/server/foo.js\n+before';
const DIFF_AFTER = 'diff --git a/app/server/foo.js b/app/server/foo.js\n+after';

// git mock：只有 `diff --cached` 需要依呼叫序回不同值（複檢前 / 複檢後），其餘回空。
// diffs 給一個值時代表「前後相同」＝agent 沒動手。
function mockGitWith({ diffs, porcelain = 'M  app/server/foo.js' }) {
  let i = 0;
  mockGit.mockImplementation((cwd, args) => {
    if (args[0] === 'diff') return Promise.resolve({ stdout: diffs[Math.min(i++, diffs.length - 1)] });
    if (args[0] === 'status') return Promise.resolve({ stdout: porcelain });
    return Promise.resolve({ stdout: '' });
  });
}

function mockFixRow(overrides = {}) {
  mockQuery.mockResolvedValue({
    rows: [{
      diff: DIFF_BEFORE,
      test_result: 'pass（基線 4 failed／100 passed → 改後 4 failed／101 passed）',
      worktree: '/tmp/wt-1',
      baseline_failed: 4,
      baseline_passed: 100,
      ...overrides
    }]
  });
}

function agentSays(json, notes = '複檢說明') {
  mockRunClaude.mockResolvedValue({
    text: `<notes>${notes}</notes>\n<result>${JSON.stringify(json)}</result>`,
    usage: {}, durationMs: 1
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockRender.mockClear();
  mockRunClaude.mockReset();
  mockGit.mockReset();
  mockMeasure.mockReset();
});

describe('不採信 agent 自報', () => {
  test('自報 changed=false 但工作區實際被改過時，仍然重跑測試才放行', async () => {
    mockFixRow();
    // 這就是最貴的失敗模式：agent 順手改了東西卻填 false。信了它就會把一份沒跑過測試的
    // 改動直接合併進 master，而平台合併後會自動重啟——早上就是壞的。
    agentSays({ verdict: 'pass', changed: false, reason: '看起來沒問題' });
    mockGitWith({ diffs: [DIFF_BEFORE, DIFF_AFTER, DIFF_AFTER] });
    mockMeasure.mockResolvedValue({ ok: true, failed: 4, passed: 101, suiteFailed: 0 });

    const r = await verifyFix(1, FINDING);

    expect(mockMeasure).toHaveBeenCalledTimes(1);
    expect(r.pass).toBe(true);
    expect(r.changed).toBe(true);      // 以實際 diff 為準，不是 agent 說的 false
    expect(r.diff).toBe(DIFF_AFTER);   // 合併進去的必須是複檢後那一份
  });

  test('自報 changed=true 但工作區其實沒變時，不浪費一次全套測試', async () => {
    mockFixRow();
    agentSays({ verdict: 'pass', changed: true, reason: '我改了（其實沒有）' });
    mockGitWith({ diffs: [DIFF_BEFORE] });

    const r = await verifyFix(1, FINDING);

    expect(mockMeasure).not.toHaveBeenCalled();
    expect(r.pass).toBe(true);
    expect(r.changed).toBe(false);
  });
});

describe('複檢改動要重新過同一套關卡', () => {
  test('改到不該動的檔案（守門碼本體）→ 擋下，而且不跑測試', async () => {
    mockFixRow();
    agentSays({ verdict: 'pass', changed: true, reason: '順手把守門碼也改了' });
    // nightly-fix.js 在 DENY 清單裡：自動通道不得改掉自己的守門機制。
    mockGitWith({ diffs: [DIFF_BEFORE, DIFF_AFTER], porcelain: 'M  app/server/pipeline/nightly-fix.js' });

    const r = await verifyFix(1, FINDING);

    expect(r.pass).toBe(false);
    expect(r.reason).toContain('不該動的檔案');
    // 範圍檢查必須排在測試之前：先跑四分鐘的全套再發現整份要作廢是白花的
    expect(mockMeasure).not.toHaveBeenCalled();
  });

  test('改到既有測試檔 → 擋下（既有測試只能新增不能改）', async () => {
    mockFixRow();
    agentSays({ verdict: 'pass', changed: true, reason: '調整了測試' });
    mockGitWith({ diffs: [DIFF_BEFORE, DIFF_AFTER], porcelain: 'M  app/server/tests/foo.test.js' });

    const r = await verifyFix(1, FINDING);

    expect(r.pass).toBe(false);
    expect(r.reason).toContain('不得修改或刪除既有測試');
  });

  test('複檢改動後測試退步 → 擋下，且比的是「改碼前」的基線', async () => {
    mockFixRow();
    agentSays({ verdict: 'pass', changed: true, reason: '修好了' });
    mockGitWith({ diffs: [DIFF_BEFORE, DIFF_AFTER] });
    // 基線是 4 failed；複檢後 5 failed ⇒ 退步。若拿「改碼後」當基準就會漏判。
    mockMeasure.mockResolvedValue({ ok: false, failed: 5, passed: 100, suiteFailed: 0 });

    const r = await verifyFix(1, FINDING);

    expect(r.pass).toBe(false);
    expect(r.reason).toContain('測試退步');
  });

  test('基線量不到（改碼時測試沒跑起來）→ 判 unknown 並擋下', async () => {
    mockFixRow({ baseline_failed: null, baseline_passed: null });
    agentSays({ verdict: 'pass', changed: true, reason: '修好了' });
    mockGitWith({ diffs: [DIFF_BEFORE, DIFF_AFTER] });
    mockMeasure.mockResolvedValue({ ok: true, failed: 0, passed: 100, suiteFailed: 0 });

    const r = await verifyFix(1, FINDING);

    expect(r.pass).toBe(false);
    expect(r.reason).toContain('unknown');
  });
});

describe('檢查不了 ≠ 檢查過了', () => {
  test('agent 回不出可解析的 verdict → 擋下', async () => {
    mockFixRow();
    mockRunClaude.mockResolvedValue({ text: '我覺得應該可以吧', usage: {}, durationMs: 1 });
    mockGitWith({ diffs: [DIFF_BEFORE] });

    const r = await verifyFix(1, FINDING);

    expect(r.pass).toBe(false);
    expect(r.reason).toContain('無法解析');
  });

  test('沒有工作區 → 擋下，不呼叫 agent', async () => {
    mockFixRow({ worktree: null });

    const r = await verifyFix(1, FINDING);

    expect(r.pass).toBe(false);
    expect(mockRunClaude).not.toHaveBeenCalled();
  });

  test('agent 執行失敗（CLI 掛掉）→ 擋下', async () => {
    mockFixRow();
    mockGitWith({ diffs: [DIFF_BEFORE] });
    mockRunClaude.mockRejectedValue(new Error('claude exited with code 1'));

    const r = await verifyFix(1, FINDING);

    expect(r.pass).toBe(false);
    expect(r.reason).toContain('複檢執行失敗');
  });

  test('verdict=fail → 擋下並帶回它的理由', async () => {
    mockFixRow();
    agentSays({ verdict: 'fail', changed: false, reason: '做法整個選錯' });
    mockGitWith({ diffs: [DIFF_BEFORE] });

    const r = await verifyFix(1, FINDING);

    expect(r.pass).toBe(false);
    expect(r.reason).toBe('做法整個選錯');
  });

  test('大小寫與空白不穩定的 verdict 仍判得出來（PASS 不該被當成無法解析）', async () => {
    mockFixRow();
    agentSays({ verdict: ' PASS ', changed: false, reason: 'ok' });
    mockGitWith({ diffs: [DIFF_BEFORE] });

    const r = await verifyFix(1, FINDING);

    expect(r.pass).toBe(true);
  });
});

describe('稽核材料', () => {
  test('notes 在 pass 與 fail 兩條路徑都帶得回來', async () => {
    mockFixRow();
    agentSays({ verdict: 'fail', changed: false, reason: 'r' }, '我查了呼叫端，第二處沒改到');
    mockGitWith({ diffs: [DIFF_BEFORE] });
    const failed = await verifyFix(1, FINDING);
    expect(failed.notes).toContain('第二處沒改到');

    mockFixRow();
    agentSays({ verdict: 'pass', changed: false, reason: 'r' }, '逐條查過，沒有連帶影響');
    mockGitWith({ diffs: [DIFF_BEFORE] });
    const passed = await verifyFix(1, FINDING);
    expect(passed.notes).toContain('沒有連帶影響');
  });

  test('prompt 帶得到工作區路徑（agent 要在那裡面查東西）', async () => {
    mockFixRow();
    agentSays({ verdict: 'pass', changed: false, reason: 'ok' });
    mockGitWith({ diffs: [DIFF_BEFORE] });

    await verifyFix(1, FINDING);

    expect(mockRender.mock.calls[0][0].worktree).toBe('/tmp/wt-1');
  });
});
