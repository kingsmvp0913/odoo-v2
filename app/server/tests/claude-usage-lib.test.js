const fs = require('fs');

describe('lib/claude-usage getUsage', () => {
  let lib;
  beforeEach(() => {
    jest.resetModules();
    // 讓 fetchUsage 讀得到 token（避免真的讀開發機 creds）
    jest.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } })
    );
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    lib = require('../lib/claude-usage');
    lib._resetCacheForTesting();
  });
  afterEach(() => jest.restoreAllMocks());

  test('成功抓取 → available:true 帶 five_hour/seven_day utilization', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 42, resets_at: '2026-07-22T10:00:00Z' },
        seven_day: { utilization: 71, resets_at: '2026-07-28T00:00:00Z' }
      })
    });
    const u = await lib.getUsage();
    expect(u.available).toBe(true);
    expect(u.five_hour.utilization).toBe(42);
    expect(u.seven_day.utilization).toBe(71);
  });

  test('抓取失敗但有前一筆好資料 → 回 stale 舊值', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ five_hour: { utilization: 55, resets_at: 'x' } }) })
      .mockResolvedValueOnce({ ok: false, status: 429 });
    await lib.getUsage();            // 建立 lastGood
    lib._resetCacheForTesting();     // 清 TTL cache，強制再抓
    const u = await lib.getUsage();  // 第二次 429
    expect(u.stale).toBe(true);
    expect(u.five_hour.utilization).toBe(55);
  });

  test('從未成功抓過 → available:false', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    const u = await lib.getUsage();
    expect(u.available).toBe(false);
  });
});
