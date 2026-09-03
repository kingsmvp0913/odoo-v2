// runPipeline 的 auto 路徑被維護視窗擋、手動不受限。
// 只驗閘門對派工的效果：mock getGateState 讓用量閘門恆不擋，維護旗標走真的 DB 查詢（真跑 runner）。
// 比照 usage-gate-runner.test.js 的 real-runner 慣例；獨立成檔是因為 jest.mock() 整檔 hoist，
// 與 maintenance-cron.test.js（mock 掉整個 runner 模組）混在同檔會互相污染。
jest.mock('../pipeline/usage-gate', () => ({ getGateState: jest.fn() }));
jest.mock('../pipeline/cs-agent', () => ({ runCsAgent: jest.fn().mockResolvedValue(undefined) }));

const { newDb } = require('pg-mem');
const { getGateState } = require('../pipeline/usage-gate');

let dbModule, runner, maintenance, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query('INSERT INTO teams_settings (id) VALUES (1) ON CONFLICT DO NOTHING');
  runner = require('../pipeline/runner');
  maintenance = require('../pipeline/maintenance');
  getGateState.mockResolvedValue({ enabled: true, blocked: false });
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('maint','x','M') RETURNING id"
  );
  userId = u.id;
});

afterAll(() => dbModule._setPoolForTesting(null));

beforeEach(async () => {
  await maintenance.leaveMaintenance();
  await dbModule.query('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE user_id = $1)', [userId]);
  await dbModule.query('DELETE FROM tasks WHERE user_id = $1', [userId]);
  await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status) VALUES ($1,'maint_t','manual','new')",
    [userId]
  );
});

test('auto:true 且維護中 → 不派工（dispatched:0, blocked:true, maintenance:true）', async () => {
  await maintenance.enterMaintenance(60000);
  const r = await runner.runPipeline(userId, { auto: true });
  expect(r).toEqual({ dispatched: 0, blocked: true, maintenance: true });
});

test('auto:false（手動）即使維護中也照派工，不受限', async () => {
  await maintenance.enterMaintenance(60000);
  const r = await runner.runPipeline(userId); // 單參數＝手動（auto:false）
  expect(r.dispatched).toBeGreaterThan(0);
  await runner.whenIdle(); // 收掉在飛任務，避免洩漏到別的測試
});

test('auto:true 但不在維護中 → 照常派工（對照組）', async () => {
  const r = await runner.runPipeline(userId, { auto: true });
  expect(r.dispatched).toBeGreaterThan(0);
  await runner.whenIdle();
});
