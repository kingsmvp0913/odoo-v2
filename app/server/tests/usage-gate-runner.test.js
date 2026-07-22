// 只驗閘門對派工的效果：mock getGateState，真跑 runPipeline 的派工判斷
jest.mock('../pipeline/usage-gate', () => ({ getGateState: jest.fn() }));
// cs handler 不 mock 會真的 spawn claude CLI（慢、依賴網路/認證，且可能在測試逾時後仍背景跑完
// 寫入 task_events，導致下一個測試 beforeEach 的 DELETE FROM tasks 撞 FK）；比照其餘 real-runner
// 測試檔（runner.test.js 等）的既有慣例 mock 掉，保持本檔 hermetic。
jest.mock('../pipeline/cs-agent', () => ({ runCsAgent: jest.fn().mockResolvedValue(undefined) }));
const { newDb } = require('pg-mem');
const { getGateState } = require('../pipeline/usage-gate');

let dbModule, runner, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  runner = require('../pipeline/runner');
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('gate','x','G') RETURNING id"
  );
  userId = u.id;
});
afterAll(() => dbModule._setPoolForTesting(null));

beforeEach(async () => {
  getGateState.mockReset();
  // runTask 本身（不論 handler 是否 mock）都會寫 task_events；先清依賴表再清 tasks，
  // 否則上一輪真的派工過的任務會讓這裡的 DELETE FROM tasks 撞 FK（比照 runner.test.js 既有慣例）。
  await dbModule.query('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [userId]);
  await dbModule.query('DELETE FROM tasks WHERE user_id = $1', [userId]);
  // 一個 new 狀態任務：cs handler 會被派工（此處只斷言有無派工，不等它跑完）
  await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status) VALUES ($1,'gate_t','manual','new')",
    [userId]
  );
});

test('auto:true 且 blocked → 不派工（dispatched:0, blocked:true）', async () => {
  getGateState.mockResolvedValue({ enabled: true, blocked: true, reason: { window: '5h' } });
  const r = await runner.runPipeline(userId, { auto: true });
  expect(r).toEqual({ dispatched: 0, blocked: true });
  expect(getGateState).toHaveBeenCalled();
});

test('auto:false（手動）即使 blocked 也照派工，且不查閘門', async () => {
  getGateState.mockResolvedValue({ enabled: true, blocked: true, reason: {} });
  const r = await runner.runPipeline(userId);   // 單參數＝手動
  expect(r.dispatched).toBeGreaterThan(0);
  expect(getGateState).not.toHaveBeenCalled();
  await runner.whenIdle();                        // 收掉在飛任務，避免洩漏到別的測試
});

test('auto:true 但未 blocked → 照常派工', async () => {
  getGateState.mockResolvedValue({ enabled: true, blocked: false });
  const r = await runner.runPipeline(userId, { auto: true });
  expect(r.dispatched).toBeGreaterThan(0);
  await runner.whenIdle();
});
