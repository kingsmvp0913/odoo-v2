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

// 備用憑證的用量：切到備用憑證跑任務後，畫面若還顯示主帳號的百分比，那個數字就是誤導
//（實際在燒的是另一個帳號）。閘門也要靠它判斷「備用是不是也超標了」，故必須能分別量兩把。
describe('lib/claude-usage 依憑證分別量用量', () => {
  let lib, auth;
  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'local-creds-token' } })
    );
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    auth = require('../lib/claude-auth');
    lib = require('../lib/claude-usage');
    lib._resetCacheForTesting();
    auth._setForTesting(null, null, 'primary');
  });
  afterEach(() => jest.restoreAllMocks());

  test('主憑證有設定 → 用它打 API，而不是本機憑證檔（跑任務用哪把就量哪把）', async () => {
    auth._setForTesting('primary-tok', 'backup-tok', 'primary');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ five_hour: { utilization: 12, resets_at: 'x' } })
    });
    await lib.getUsage('primary');
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer primary-tok');
  });

  test('未設定主憑證 → 退回本機憑證檔（既有行為不變）', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ five_hour: { utilization: 12, resets_at: 'x' } })
    });
    await lib.getUsage('primary');
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer local-creds-token');
  });

  test('量備用 → 用備用 token 打 API', async () => {
    auth._setForTesting('primary-tok', 'backup-tok', 'primary');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ five_hour: { utilization: 7, resets_at: 'x' } })
    });
    const u = await lib.getUsage('backup');
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer backup-tok');
    expect(u.five_hour.utilization).toBe(7);
  });

  // 沒貼備用憑證時絕不能拿本機憑證檔頂替——那會把主帳號的用量當成備用帳號的回報，
  // 閘門看到「備用還很空」就切過去，實際上切到同一個已超標的帳號。
  test('沒設備用憑證 → available:false，且不得打 API', async () => {
    auth._setForTesting('primary-tok', null, 'primary');
    global.fetch = jest.fn();
    const u = await lib.getUsage('backup');
    expect(u.available).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('兩份快取各自獨立——量過主帳號不會讓備用讀到主帳號的數字', async () => {
    auth._setForTesting('primary-tok', 'backup-tok', 'primary');
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ five_hour: { utilization: 91, resets_at: 'x' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ five_hour: { utilization: 3, resets_at: 'y' } }) });
    const p = await lib.getUsage('primary');
    const b = await lib.getUsage('backup');
    expect(p.five_hour.utilization).toBe(91);
    expect(b.five_hour.utilization).toBe(3);
  });
});
