// 意圖：重改的那一輪要看得到「之前為什麼被駁回」。
//
// 2026-09-14 實際卡住的形狀：意見 #34 當晚被審核駁回（fix 43：越界改 qa-agent.js、analysis 降級沒測試），
// 重改一次（fix 44）仍以「analysis 降級沒測試」再被駁回。重改輪拿到的提示詞與第一輪逐字相同，
// 同一個錯再犯一次是結構上必然——健檢兩度點名（提案 147、169），回溯 40 筆修正有 2 個來源同類再犯。
//
// 兩條斷線都要接上：
//   1. 同一晚重改：同一個 finding_id。
//   2. 隔晚重跑：意見每晚都會被開成**新的** finding 列，finding_id 對不上，只能靠 members 認同一個來源。
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fixprev-'));
process.env.FIX_WORKTREE_DIR = WORKTREE_ROOT;

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));

// 撈駁回紀錄那一句回 mockRejected，其餘（提案本身、附件、UPDATE）照舊
let mockRejected = [];
const mockQuery = jest.fn(async (sql) => {
  if (/FROM finding_fixes/.test(sql) && /rejected/.test(sql)) return { rows: mockRejected };
  if (/FROM feedback_attachments/.test(sql)) return { rows: [] };
  return { rows: [{ id: 1, agent_label: 'x', diagnosis: 'd' }] };
});
jest.mock('../db', () => ({ query: (...args) => mockQuery(...args) }));

const mockRender = jest.fn(() => 'prompt');
jest.mock('../pipeline/agent-loader', () => ({
  loadAgent: () => ({ model: 'test-model', render: (...args) => mockRender(...args) })
}));
jest.mock('../pipeline/claude-runner', () => ({
  runClaude: async () => ({ text: '<notes>n</notes>\n<result>{"changed":false,"tests":"skip"}</result>', usage: {}, durationMs: 1 })
}));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../lib/git-identity', () => ({ buildGitEnv: async () => ({}) }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

const { runFix } = require('../pipeline/finding-fix');
const worktree = path.join(WORKTREE_ROOT, 'fix-50');

beforeEach(() => {
  mockRejected = [];
  mockQuery.mockClear();
  mockRender.mockClear();
  mockExecFile.mockImplementation((cmd, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args.join(' ').startsWith('worktree add')) fs.mkdirSync(path.join(worktree, 'app'), { recursive: true });
    if (cmd === 'npm') return done(null, { stdout: '', stderr: 'Tests:       10 passed, 10 total\n' });
    return done(null, { stdout: '', stderr: '' });
  });
});
afterAll(() => { fs.rmSync(WORKTREE_ROOT, { recursive: true, force: true }); });

const rendered = () => mockRender.mock.calls[0][0].previous_rejections;

test('第一次施工 → 明講「無」，不是空字串讓 placeholder 那行懸空', async () => {
  await runFix(50, { findingId: 171, members: [{ source: 'feedback', row: { id: 34 } }] });
  expect(rendered()).toContain('無');
});

test('隔晚重跑：finding 列是新開的，靠 members 認出同一則意見，舊理由要帶進來', async () => {
  mockRejected = [
    { id: 44, finding_id: 170, members: [{ source: 'feedback', id: 34 }], reject_reason: 'analysis 降級後記的值沒有測試' },
  ];
  await runFix(50, { findingId: 171, members: [{ source: 'feedback', row: { id: 34 } }] });
  expect(rendered()).toContain('analysis 降級後記的值沒有測試');
});

test('members 是字串（pg-mem 的 JSONB 有時回原始字串）也要認得', async () => {
  mockRejected = [
    { id: 44, finding_id: 170, members: JSON.stringify([{ source: 'feedback', id: 34 }]), reject_reason: '越界改了 qa-agent.js' },
  ];
  await runFix(50, { findingId: 171, members: [{ source: 'feedback', row: { id: 34 } }] });
  expect(rendered()).toContain('越界改了 qa-agent.js');
});

test('同一晚重改：同一個 finding_id，就算舊列沒有 members（人工按「修這條」建的）也要帶', async () => {
  mockRejected = [{ id: 49, finding_id: 171, members: null, reject_reason: '夾帶提案沒要求的門檻放寬' }];
  await runFix(50, { findingId: 171, members: [{ source: 'feedback', row: { id: 34 } }] });
  expect(rendered()).toContain('夾帶提案沒要求的門檻放寬');
});

test('別的來源被駁回的理由不准混進來——那會讓 agent 去修一個不存在的問題', async () => {
  mockRejected = [
    { id: 45, finding_id: 160, members: [{ source: 'feedback', id: 35 }], reject_reason: '別人的理由' },
    // 同樣的 id 但來源種類不同（健檢提案 #34 ≠ 意見 #34）
    { id: 46, finding_id: 34, members: [{ source: 'finding', id: 34 }], reject_reason: '同號不同種' },
  ];
  await runFix(50, { findingId: 171, members: [{ source: 'feedback', row: { id: 34 } }] });
  expect(rendered()).not.toContain('別人的理由');
  expect(rendered()).not.toContain('同號不同種');
  expect(rendered()).toContain('無');
});

test('最多帶最近 3 次、新的在前——舊到那時的平台檢查可能早就修掉了', async () => {
  mockRejected = [44, 43, 40, 39].map(id => (
    { id, finding_id: 171, members: null, reject_reason: `理由-${id}` }));
  await runFix(50, { findingId: 171 });
  const text = rendered();
  expect(text.indexOf('理由-44')).toBeLessThan(text.indexOf('理由-43'));
  expect(text.indexOf('理由-43')).toBeLessThan(text.indexOf('理由-40'));
  expect(text).not.toContain('理由-39');
});

test('撈的時候排除本輪自己這一列', async () => {
  await runFix(50, { findingId: 171 });
  const [, params] = mockQuery.mock.calls.find(([sql]) => /FROM finding_fixes/.test(sql) && /rejected/.test(sql));
  expect(params).toContain(50);
});

// 反方向的鐵則 1：JS 傳了值、提示詞卻沒有對應的 placeholder ⇒ render 什麼也不替換，理由靜默丟掉、零紅燈。
test('platform-fix.md 真的有 {{previous_rejections}} 接住這份資料', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.claude', 'agents', 'platform-fix.md'), 'utf8');
  expect(md).toContain('{{previous_rejections}}');
});
