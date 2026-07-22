jest.mock('../lib/claude-usage', () => ({ getUsage: jest.fn() }));
const { newDb } = require('pg-mem');
const { getUsage } = require('../lib/claude-usage');

let dbModule, gate;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  gate = require('../pipeline/usage-gate');
});
afterAll(() => dbModule._setPoolForTesting(null));

async function setGate({ enabled = true, th5 = 90, th7 = 95 } = {}) {
  await dbModule.query('DELETE FROM teams_settings');
  await dbModule.query(
    'INSERT INTO teams_settings (id, usage_gate_enabled, usage_gate_5h_threshold, usage_gate_7d_threshold) VALUES (1,$1,$2,$3)',
    [enabled, th5, th7]
  );
}

beforeEach(() => getUsage.mockReset());

test('5h 超門檻 → blocked（reason.window=5h）', async () => {
  await setGate();
  getUsage.mockResolvedValue({ available: true, five_hour: { utilization: 92, resets_at: 'r5' }, seven_day: { utilization: 10 } });
  const s = await gate.getGateState();
  expect(s.blocked).toBe(true);
  expect(s.reason.window).toBe('5h');
  expect(s.reason.current).toBe(92);
  expect(s.reason.threshold).toBe(90);
});

test('7d 超門檻（5h 未超）→ blocked（reason.window=7d）', async () => {
  await setGate();
  getUsage.mockResolvedValue({ available: true, five_hour: { utilization: 10 }, seven_day: { utilization: 96, resets_at: 'r7' } });
  const s = await gate.getGateState();
  expect(s.blocked).toBe(true);
  expect(s.reason.window).toBe('7d');
});

test('OR：兩者皆超 → blocked（優先報 5h）', async () => {
  await setGate();
  getUsage.mockResolvedValue({ available: true, five_hour: { utilization: 99 }, seven_day: { utilization: 99 } });
  const s = await gate.getGateState();
  expect(s.blocked).toBe(true);
  expect(s.reason.window).toBe('5h');
});

test('皆低於門檻 → 不擋', async () => {
  await setGate();
  getUsage.mockResolvedValue({ available: true, five_hour: { utilization: 50 }, seven_day: { utilization: 80 } });
  expect((await gate.getGateState()).blocked).toBe(false);
});

test('總開關關閉 → 不擋且不讀用量', async () => {
  await setGate({ enabled: false });
  getUsage.mockResolvedValue({ available: true, five_hour: { utilization: 99 }, seven_day: { utilization: 99 } });
  const s = await gate.getGateState();
  expect(s.enabled).toBe(false);
  expect(s.blocked).toBe(false);
  expect(getUsage).not.toHaveBeenCalled();
});

test('從未成功抓過用量（available:false）→ fail-open 不擋', async () => {
  await setGate();
  getUsage.mockResolvedValue({ available: false, error: 'x' });
  const s = await gate.getGateState();
  expect(s.blocked).toBe(false);
  expect(s.available).toBe(false);
});

test('stale 但超門檻 → 仍擋（reason.stale=true）', async () => {
  await setGate();
  getUsage.mockResolvedValue({ available: true, stale: true, five_hour: { utilization: 95 }, seven_day: { utilization: 10 } });
  const s = await gate.getGateState();
  expect(s.blocked).toBe(true);
  expect(s.reason.stale).toBe(true);
});
