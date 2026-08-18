jest.mock('../lib/claude-auth', () => ({
  hasBackupToken: jest.fn(() => false),
  setActiveCredential: jest.fn(),
  getActiveCredential: jest.fn(() => 'primary')
}));
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

// ── 備用憑證備援 ──────────────────────────────────────────────────────
// 意圖：主帳號撞閘門時整條 pipeline 停下等視窗重置，是最貴的等待。管理員貼第二份訂閱的
// 憑證後改用它繼續跑，主帳號降回門檻下自動切回。開關預設關閉——沒開就是過去的行為。
describe('用量閘門：備用憑證備援', () => {
  const auth = require('../lib/claude-auth');

  async function setFallback({ enabled = true, th5 = 90, th7 = 95, fallback = true } = {}) {
    await dbModule.query('DELETE FROM teams_settings');
    await dbModule.query(
      `INSERT INTO teams_settings (id, usage_gate_enabled, usage_gate_5h_threshold, usage_gate_7d_threshold, usage_gate_fallback_enabled)
       VALUES (1,$1,$2,$3,$4)`,
      [enabled, th5, th7, fallback]
    );
  }
  const OVER = { available: true, five_hour: { utilization: 97, resets_at: 'r5' }, seven_day: { utilization: 10 } };
  const UNDER = { available: true, five_hour: { utilization: 8 }, seven_day: { utilization: 20 } };
  // 依 which 分派：主／備各自回不同用量，才驗得出「判斷用的是哪一份」
  function mockByCredential(primary, backup) {
    getUsage.mockImplementation(which => Promise.resolve(which === 'backup' ? backup : primary));
  }

  beforeEach(() => {
    auth.hasBackupToken.mockReturnValue(true);
    auth.setActiveCredential.mockClear();
    gate._resetForTesting();
  });

  test('主超標、備用還有額度 → 切備用繼續跑，不擋', async () => {
    await setFallback();
    mockByCredential(OVER, UNDER);
    const s = await gate.getGateState();
    expect(s.blocked).toBe(false);
    expect(s.active_credential).toBe('backup');
    expect(auth.setActiveCredential).toHaveBeenCalledWith('backup');
  });

  test('主超標、備用也超標 → 擋（回到原本的暫停行為）', async () => {
    await setFallback();
    mockByCredential(OVER, OVER);
    const s = await gate.getGateState();
    expect(s.blocked).toBe(true);
    expect(s.active_credential).toBe('primary');
  });

  test('備援開關關閉 → 主超標即擋，且不去量備用（不該白打一次 API）', async () => {
    await setFallback({ fallback: false });
    mockByCredential(OVER, UNDER);
    const s = await gate.getGateState();
    expect(s.blocked).toBe(true);
    expect(getUsage).not.toHaveBeenCalledWith('backup');
  });

  test('開關開著但沒貼備用憑證 → 主超標即擋', async () => {
    await setFallback();
    auth.hasBackupToken.mockReturnValue(false);
    mockByCredential(OVER, UNDER);
    const s = await gate.getGateState();
    expect(s.blocked).toBe(true);
    expect(s.active_credential).toBe('primary');
  });

  // A 方案的核心：切回的判準是主帳號的用量，主帳號本來就量得到，
  // 所以就算備用帳號的用量完全量不到，自動切回照樣運作。
  test('主帳號用量降回門檻下 → 自動切回主憑證', async () => {
    await setFallback();
    mockByCredential(OVER, UNDER);
    expect((await gate.getGateState()).active_credential).toBe('backup');
    gate._resetForTesting();
    mockByCredential(UNDER, UNDER);
    const s = await gate.getGateState();
    expect(s.active_credential).toBe('primary');
    expect(auth.setActiveCredential).toHaveBeenLastCalledWith('primary');
  });

  // 長效 setup-token 打不打得了 usage API 未經證實。量不到時比照既有的
  // available:false 慣例 fail-open——切過去讓任務跑，而不是因為「量不到」就整條停住。
  test('備用帳號的用量量不到 → 仍切過去（比照既有 fail-open）', async () => {
    await setFallback();
    mockByCredential(OVER, { available: false, error: 'usage api 401' });
    const s = await gate.getGateState();
    expect(s.blocked).toBe(false);
    expect(s.active_credential).toBe('backup');
    expect(s.backup.available).toBe(false);
  });

  test('閘門總開關關閉 → 一律回主憑證（不能停在備用上無限燒第二份訂閱）', async () => {
    await setFallback({ enabled: false });
    const s = await gate.getGateState();
    expect(s.active_credential).toBe('primary');
    expect(auth.setActiveCredential).toHaveBeenCalledWith('primary');
  });
});
