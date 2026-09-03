// cron 的 runForUser：維護中連同步都跳過（新任務進來也不派，等維護結束一次湧出）。
// 比照 cron.test.js 的 mock 方式（mock syncUser／runPipeline／node-cron），獨立成檔避免與
// maintenance-runner.test.js（真跑 runner）互相污染 jest.mock 的整檔 hoist。
jest.mock('../pipeline/sync', () => ({
  syncUser: jest.fn().mockResolvedValue({ odoo: { added: 0 }, service: { added: 0 } })
}));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 }) }));
jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));

const { newDb } = require('pg-mem');
const { syncUser } = require('../pipeline/sync');

let dbModule, cronModule, maintenance, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query('INSERT INTO teams_settings (id) VALUES (1) ON CONFLICT DO NOTHING');
  cronModule = require('../cron');
  maintenance = require('../pipeline/maintenance');
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('cronmaint','x','CM') RETURNING id"
  );
  userId = u.id;
});

afterAll(() => {
  cronModule.stopCron();
  dbModule._setPoolForTesting(null);
});

beforeEach(async () => {
  await maintenance.leaveMaintenance();
  syncUser.mockClear();
});

test('維護中：runForUser 跳過 syncUser', async () => {
  await maintenance.enterMaintenance(60000);
  await cronModule.runForUser(userId, { skipPipeline: true });
  expect(syncUser).not.toHaveBeenCalled();
});

test('非維護中：runForUser 照常呼叫 syncUser（對照組，證明上一支真的是維護擋下）', async () => {
  await cronModule.runForUser(userId, { skipPipeline: true });
  expect(syncUser).toHaveBeenCalledWith(userId);
});
