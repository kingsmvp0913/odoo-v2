// 意圖：健檢 runner 遍歷有 stage 的 agent（排除 workflow_health 自己）落 findings，best-effort，run 收尾（工作流程健檢子專案 2）。
const { newDb } = require('pg-mem');
const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
// 只健檢兩個假 agent，避免依賴真實 .md 清單
jest.mock('../pipeline/agent-loader', () => {
  const actual = jest.requireActual('../pipeline/agent-loader');
  return {
    ...actual,
    listAgents: () => ([
      { name: 'coding-project', stage: 'coding', label: '開發' },
      { name: 'qa', stage: 'qa', label: 'QA' },
      { name: 'workflow-health', stage: 'workflow_health', label: '健檢' } // 應被排除
    ]),
    loadAgent: (n) => n === 'workflow-health'
      ? { name: n, model: 'opus', render: () => 'RENDERED' }
      : actual.loadAgent(n)
  };
});
jest.mock('../pipeline/health-data', () => ({
  buildAgentSummary: jest.fn().mockResolvedValue({ token: {}, tasks: {}, rejections: null })
}));

let dbModule2, runHealthCheck;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule2 = require('../db');
  dbModule2._setPoolForTesting(new Pool());
  await dbModule2.migrate();
  ({ runHealthCheck } = require('../pipeline/health-check-runner'));
});
afterAll(() => dbModule2._setPoolForTesting(null));
beforeEach(() => mockRunClaude.mockReset());

async function newRun() {
  const { rows: [r] } = await dbModule2.query(
    "INSERT INTO health_check_runs (status, window_days) VALUES ('running',30) RETURNING id");
  return r.id;
}

test('runHealthCheck：遍歷有 stage 的 agent（排除 workflow_health），每個落 finding，run 設 done', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<result>{"diagnosis":"ok","severity":"low","suggested_prompt":null,"rationale":"r"}</result>',
    usage: { input_tokens: 1 }, durationMs: 10
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30, startedBy: null });

  const { rows: fs } = await dbModule2.query('SELECT agent_name, severity FROM health_check_findings WHERE run_id=$1 ORDER BY agent_name', [runId]);
  expect(fs.map(f => f.agent_name)).toEqual(['coding-project', 'qa']); // 排除 workflow-health
  const { rows: [run] } = await dbModule2.query('SELECT status, finished_at FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('done');
  expect(run.finished_at).not.toBeNull();
});

test('某 agent 解析失敗 → 落 severity=error finding，其他 agent 照跑，run 仍 done', async () => {
  // 兩個 agent × (主呼叫 + haiku 補救) 都回壞資料 → parseAgentResult 回 null
  mockRunClaude.mockResolvedValue({ text: '不是結果', usage: null, durationMs: 5 });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: fs } = await dbModule2.query('SELECT severity FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(fs.length).toBe(2);
  expect(fs.every(f => f.severity === 'error')).toBe(true);
  const { rows: [run] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('done');
});
