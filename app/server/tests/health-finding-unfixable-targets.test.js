// 意圖：提案指名的檔案全在 finding-fix.js 的 DENY／可修改範圍外時，結構上不可能通過最後那道逐檔檢查。
// 這種提案若照樣落 approved，platform-fix 會跑完整輪（平均 454 秒、約 $2）才被整份作廢，
// 下次健檢又重提一次。入口就要攔下：落 pending、寫明「只能人工修」、不開意見回饋單。
// 反過來，只要有一支可以動（或根本沒指名檔案），必須維持原本的自動核准——攔過頭等於把自動修關掉。
const { newDb } = require('pg-mem');
const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/health-data', () => ({
  buildTaskSummary: jest.fn(),
  buildWindowSummary: jest.fn().mockResolvedValue({
    window: { since: '2026-09-13T00:00:00.000Z', until: '2026-09-14T00:00:00.000Z' },
    volume: { agent_calls: 12, tasks_touched: 4, cost_usd: 1.2, wall_clock: {} },
    per_stage: {}, tasks: [], rejections: []
  })
}));

const { MACHINE_RETIRE_PREFIX } = require('../pipeline/retire-prefix');

let db, runAudit;
beforeAll(async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  db = require('../db');
  db._setPoolForTesting(new Pool());
  await db.migrate();
  ({ runAudit } = require('../pipeline/health-check-runner'));
});
afterAll(() => db._setPoolForTesting(null));

async function auditWith(proposal) {
  mockRunClaude.mockResolvedValue({
    text: '<result>' + JSON.stringify({ severity: 'medium', proposals: [
      { kind: 'proposal', layer: 'platform', severity: 'medium', target_metric: 'm', metric_baseline: 'b', ...proposal }
    ] }) + '</result>',
    usage: { input_tokens: 1 }, durationMs: 10
  });
  const { rows: [r] } = await db.query(
    "INSERT INTO health_check_runs (status, since_at) VALUES ('running', NOW() - INTERVAL '1 day') RETURNING id");
  await runAudit(r.id, { sinceAt: new Date(Date.now() - 86400000) });
  const { rows: [f] } = await db.query(
    "SELECT id, status, verdict_note FROM health_check_findings WHERE run_id=$1 AND kind='proposal'", [r.id]);
  const { rows: fb } = await db.query('SELECT id FROM feedback WHERE finding_id=$1', [f.id]);
  return { ...f, feedbackCount: fb.length };
}

test('指名的檔案全在 DENY 內（只寫檔名＋行號也認得）→ 落 pending、寫明只能人工修、不開單', async () => {
  const f = await auditWith({
    title: '守門碼的白名單漏了一條',
    detail: '`finding-fix.js:49` 的 DENY 清單少擋一支。',
    action: '改 finding-fix.js，並同步 `.claude/agents/fix-review.md` 的判準。'
  });
  expect(f.status).toBe('pending');
  expect(f.verdict_note.startsWith(MACHINE_RETIRE_PREFIX)).toBe(true);   // 機器判的，不能冒充人的裁決
  expect(f.verdict_note).toContain('app/server/pipeline/finding-fix.js');
  expect(f.verdict_note).toContain('.claude/agents/fix-review.md');
  expect(f.feedbackCount).toBe(0);                                        // 不開單＝夜間批次撈不到
});

test('指名的檔案有一支可以動 → 維持 approved 並開單（入口判斷只在「全部擋死」時介入）', async () => {
  const f = await auditWith({
    title: '入口沒檢查 DENY',
    detail: '`finding-fix.js:49` 的清單是對的，問題在 `health-check-runner.js:190` 沒比對。',
    action: '在 health-check-runner.js 的 insertFinding 比對。'
  });
  expect(f.status).toBe('approved');
  expect(f.verdict_note).toBeNull();
  expect(f.feedbackCount).toBe(1);
});

test('完全沒指名檔案 → 維持原本的 approved（認不出來不能當成擋死）', async () => {
  const f = await auditWith({ title: '退回顆粒度不足', detail: '退回沒有欄位可判斷是否精準', action: '加一個退回原因欄位' });
  expect(f.status).toBe('approved');
  expect(f.feedbackCount).toBe(1);
});

test('指名的是新測試檔路徑（不存在於 repo）與 DENY 檔 → 不存在的檔不計，仍算全部擋死', async () => {
  const f = await auditWith({
    title: '夜間保險絲算錯',
    detail: 'nightly-fix.js 的預算判斷有誤。',
    action: '修 nightly-fix.js，並新增 tests/nightly-fuse-new-case-xyz.test.js。'
  });
  expect(f.status).toBe('pending');
  expect(f.verdict_note).toContain('app/server/pipeline/nightly-fix.js');
});
