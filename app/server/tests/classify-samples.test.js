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

// —— 以下四例：驗證前面已修正的分類行為各一個點（健檢 R1 過載、task 84 env 釘死、反轉舉證不誤判 code、text task_id 一致）——

test('regex 判得出（transient：API 過載 529）→ 不叫 haiku、不留樣本（等幾秒重試幾乎必過，健檢 R1）', async () => {
  const r = await classifyFailureWithAgent('API Error: 529 {"type":"overloaded_error","message":"Overloaded"}', { projectId });
  expect(r).toBe('transient');
  expect(mockRunClaude).not.toHaveBeenCalled(); // 過載屬 regex transient，直接重試、不進 haiku（否則白花 token 又停等人工）
  const { rows } = await dbModule.query('SELECT * FROM classify_samples');
  expect(rows.length).toBe(0);
});

test('regex 判得出（env：depends 模組不在 addons path）→ 不叫 haiku、不留樣本（task 84 震盪根因用 regex 釘死）', async () => {
  const r = await classifyFailureWithAgent('module idx_sale_x depends on module base_geoengine. But the latter module is not available in your system.', { projectId });
  expect(r).toBe('env');
  expect(mockRunClaude).not.toHaveBeenCalled(); // 若落 unknown 交 haiku，會因「depends 寫在 manifest」被誤判 code 退 coding 空轉（task 84）
  const { rows } = await dbModule.query('SELECT * FROM classify_samples');
  expect(rows.length).toBe(0);
});

test('裸 Traceback + ValidationError（env 也會印）→ 不判 code、落 unknown 交 haiku（留樣本）（反轉舉證：只收明確開發錯）', async () => {
  mockRunClaude.mockResolvedValue({ text: '{"type":"code"}', usage: null, durationMs: null });
  const r = await classifyFailureWithAgent(
    'Traceback (most recent call last):\n  File "sale_order.py", line 12, in _check\n    raise ValidationError(...)\nodoo.exceptions.ValidationError: 金額不可為負',
    { taskId: 'task_odoo_84', projectId }
  );
  // 關鍵：CODE regex 刻意不收裸 Traceback/ValidationError（每個 env 失敗也都印這些）。此例必須「落 unknown → 叫 haiku」，
  // 而非被 regex 直接判 code——若 mockRunClaude 沒被呼叫，代表 regex 又把環境問題誤收成 code（task 84 回歸）。
  expect(mockRunClaude).toHaveBeenCalled();
  expect(r).toBe('code'); // 這裡的 code 來自 haiku 明確判定，非 regex 誤判
  const { rows } = await dbModule.query('SELECT agent_ok FROM classify_samples');
  expect(rows.length).toBe(1);
  expect(rows[0].agent_ok).toBe(true);
});

test('taskId 傳整數 → 樣本 task_id 以字串存（classify_samples.task_id 為 text，需 String() 一致）', async () => {
  mockRunClaude.mockResolvedValue({ text: '{"type":"code"}', usage: null, durationMs: null });
  await classifyFailureWithAgent('some brand new mystery error QQ', { taskId: 777, projectId });
  const { rows } = await dbModule.query('SELECT task_id FROM classify_samples');
  expect(rows.length).toBe(1);
  expect(rows[0].task_id).toBe('777'); // 整數 id 經 String() 轉存，與 text 欄位一致（勿存成數字型別）
});
