jest.mock('../lib/claude-usage', () => ({ getUsage: jest.fn() }));
jest.mock('../notify', () => ({ emitAll: jest.fn(), notifyAction: jest.fn(), emitToUser: jest.fn() }));
jest.mock('../notify-webhook', () => ({ sendWebhook: jest.fn().mockResolvedValue(true) }));
jest.mock('../teams', () => ({
  getSettings: jest.fn().mockResolvedValue({}), isConfigured: jest.fn().mockReturnValue(false),
  sendChannelMessage: jest.fn()
}));
const { newDb } = require('pg-mem');
const { getUsage } = require('../lib/claude-usage');
const notify = require('../notify');
const webhook = require('../notify-webhook');

let dbModule, gate;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query('INSERT INTO teams_settings (id) VALUES (1)'); // 預設 enabled/90/95
  gate = require('../pipeline/usage-gate');
});
afterAll(() => dbModule._setPoolForTesting(null));

beforeEach(() => {
  getUsage.mockReset();
  notify.emitAll.mockClear();
  webhook.sendWebhook.mockClear();
  gate._resetForTesting();
});

function usage(u5, u7) {
  return { available: true, five_hour: { utilization: u5, resets_at: 'r5' }, seven_day: { utilization: u7, resets_at: 'r7' } };
}

test('未 blocked→blocked：發一次通知（socket + webhook）', async () => {
  getUsage.mockResolvedValue(usage(95, 10));
  await gate.evaluateAndNotify();
  expect(notify.emitAll).toHaveBeenCalledTimes(1);
  expect(webhook.sendWebhook).toHaveBeenCalledTimes(1);
});

test('持續 blocked：不重發', async () => {
  getUsage.mockResolvedValue(usage(95, 10));
  await gate.evaluateAndNotify(); // 邊緣，發
  await gate.evaluateAndNotify(); // 持續，不發
  expect(webhook.sendWebhook).toHaveBeenCalledTimes(1);
});

test('回落 blocked→false 後再次超標：重置旗標，會再發一次', async () => {
  getUsage.mockResolvedValueOnce(usage(95, 10)); // blocked → 發
  await gate.evaluateAndNotify();
  getUsage.mockResolvedValueOnce(usage(10, 10)); // 回落
  await gate.evaluateAndNotify();
  getUsage.mockResolvedValueOnce(usage(95, 10)); // 再超 → 再發
  await gate.evaluateAndNotify();
  expect(webhook.sendWebhook).toHaveBeenCalledTimes(2);
});
