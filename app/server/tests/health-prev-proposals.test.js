// 意圖：跨輪記憶（previousProposals）餵回 auditor 的那份清單必須誠實。
// 兩件事各自會讓 auditor 停止追蹤一個還沒解決的問題：
//   (1) 夜間批次的施工紀錄列（run.cadence='nightly-fix'）每晚新增、id 永遠最大，會把 LIMIT
//       的名額從真提案手上搶走；
//   (2) 那些列一律帶 status='done'，真正的處置結果只在 applied_at——沒有 applied_at 卻印成
//       「處理完成」，等於告訴 auditor 一個被駁回的修正已經修好了。
// 本檔另開一支而不併進 health-check-runner.test.js：那支已存在的測試檔不得修改。
const { newDb } = require('pg-mem');
const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
jest.mock('../pipeline/health-data', () => ({
  buildAgentSummary: jest.fn().mockResolvedValue({ token: {}, tasks: {}, rejections: null }),
  buildTaskSummary: jest.fn().mockResolvedValue({ scope: 'task:1', task: {}, sequence: [], per_stage: {} }),
  buildWindowSummary: jest.fn().mockResolvedValue({
    window: { since: '2026-09-12T00:00:00.000Z', until: '2026-09-13T00:00:00.000Z' },
    volume: { agent_calls: 12, tasks_touched: 4, cost_usd: 1.2, wall_clock: {} },
    per_stage: {}, tasks: [], rejections: []
  })
}));

let db2, runAudit;
beforeAll(async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  db2 = require('../db');
  db2._setPoolForTesting(new Pool());
  await db2.migrate();
  ({ runAudit } = require('../pipeline/health-check-runner'));
});
afterAll(() => db2._setPoolForTesting(null));
beforeEach(() => mockRunClaude.mockReset());

const AUDIT_OK = {
  text: '<summary>本輪無新事。</summary><result>' + JSON.stringify({ severity: 'ok', proposals: [] }) + '</result>',
  usage: { input_tokens: 1 }, durationMs: 10
};

async function newRun(cadence) {
  const { rows: [r] } = await db2.query(
    "INSERT INTO health_check_runs (status, since_at, cadence) VALUES ('running', NOW() - INTERVAL '1 day', $1) RETURNING id",
    [cadence]);
  return r.id;
}

async function addFinding(runId, { diagnosis, status, appliedAt = null, agent = '__audit__' }) {
  await db2.query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, kind, layer, status, applied_at)
     VALUES ($1,$2,'提案',$3,'medium','proposal','code',$4,$5)`,
    [runId, agent, diagnosis, status, appliedAt]);
}

async function promptOf() {
  mockRunClaude.mockResolvedValue(AUDIT_OK);
  await runAudit(await newRun('daily'), { sinceAt: new Date(Date.now() - 86400000), startedBy: null });
  return mockRunClaude.mock.calls.at(-1)[0];
}

test('previousProposals：夜間批次的施工紀錄列不進跨輪記憶，名額留給真提案', async () => {
  const auditRun = await newRun('daily');
  await addFinding(auditRun, { diagnosis: '真提案：QA 反覆震盪', status: 'pending' });
  // 施工紀錄列：批次 run 底下、agent_name='feedback'、狀態一律 done。id 比真提案大，
  // 沒有排除的話它會排在前面把名額吃掉。
  const batchRun = await newRun('nightly-fix');
  await addFinding(batchRun, { diagnosis: '施工紀錄：某個意見回饋', status: 'done', agent: 'feedback' });

  const prompt = await promptOf();
  expect(prompt).toContain('真提案：QA 反覆震盪');
  expect(prompt).not.toContain('施工紀錄：某個意見回饋');
});

test('previousProposals：status=done 但沒有 applied_at 不得印成「處理完成」', async () => {
  const auditRun = await newRun('daily');
  await addFinding(auditRun, { diagnosis: '沒合併的提案：修正被駁回', status: 'done' });
  await addFinding(auditRun, { diagnosis: '真的合併了的提案', status: 'done', appliedAt: new Date() });

  const prompt = await promptOf();
  const rejected = prompt.split('\n').find(l => l.includes('沒合併的提案：修正被駁回'));
  expect(rejected).toBeTruthy();
  expect(rejected).not.toContain('處理完成');
  expect(rejected).toContain('仍未解決');
  // 真的合併的那筆不受影響，否則 auditor 會回頭重提已經修好的東西
  const merged = prompt.split('\n').find(l => l.includes('真的合併了的提案'));
  expect(merged).toContain('處理完成');
});
