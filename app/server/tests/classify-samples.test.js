// 意圖：regex 判不出（unknown）、交 haiku 分類的案例要留樣本（真因＋判定＋haiku 是否真判出），
// 供日後把高頻 pattern 升級成零 token regex（健檢：deploy-fix haiku fallback 缺回饋迴圈）。
// regex 自己判得出的失敗不留樣本（那些本就零成本、不需回饋）。記樣本 best-effort，絕不影響分類結果。
const { newDb } = require('pg-mem');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));

let dbModule, classifyFailureWithAgent, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,odoo_version) VALUES ('CP','17.0') RETURNING id");
  projectId = p.id;
  ({ classifyFailureWithAgent } = require('../pipeline/failure-classifier'));
});
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(async () => {
  mockRunClaude.mockReset();
  await dbModule.query('DELETE FROM classify_samples');
});

test('regex 判得出（env）→ 不叫 haiku、不留樣本（本就零成本）', async () => {
  const r = await classifyFailureWithAgent('could not connect to server: Connection refused', { projectId });
  expect(r).toBe('env');
  expect(mockRunClaude).not.toHaveBeenCalled();
  const { rows } = await dbModule.query('SELECT * FROM classify_samples');
  expect(rows.length).toBe(0);
});

test('unknown → haiku 判出 code → 留樣本（verdict=code、agent_ok=true、存真因文字）', async () => {
  mockRunClaude.mockResolvedValue({ text: '{"type":"code"}', usage: null, durationMs: null });
  const r = await classifyFailureWithAgent('some novel error line xyz', { taskId: 'task_odoo_9', projectId });
  expect(r).toBe('code');
  const { rows } = await dbModule.query('SELECT task_id, project_id, error_text, verdict, agent_ok FROM classify_samples');
  expect(rows.length).toBe(1);
  expect(rows[0].verdict).toBe('code');
  expect(rows[0].agent_ok).toBe(true);
  expect(rows[0].task_id).toBe('task_odoo_9');
  expect(rows[0].error_text).toContain('novel error');
});

test('unknown → haiku 出錯 → 留樣本（verdict=env fallback、agent_ok=false）', async () => {
  mockRunClaude.mockRejectedValue(new Error('agent down'));
  const r = await classifyFailureWithAgent('another weird error abc', { projectId });
  expect(r).toBe('env');
  const { rows } = await dbModule.query('SELECT verdict, agent_ok FROM classify_samples');
  expect(rows.length).toBe(1);
  expect(rows[0].verdict).toBe('env');
  expect(rows[0].agent_ok).toBe(false); // haiku 沒真的判出 → 這筆是預設 env，不是 haiku 的判定
});

test('unknown → haiku 回不合法內容 → 留樣本（verdict=env、agent_ok=false）', async () => {
  mockRunClaude.mockResolvedValue({ text: 'not json at all', usage: null, durationMs: null });
  const r = await classifyFailureWithAgent('yet another mystery zzz', { projectId });
  expect(r).toBe('env');
  const { rows } = await dbModule.query('SELECT verdict, agent_ok FROM classify_samples');
  expect(rows[0].verdict).toBe('env');
  expect(rows[0].agent_ok).toBe(false);
});
