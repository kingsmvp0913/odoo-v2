const fs = require('fs');

// 只攔 lib 自己會讀的兩個路徑：本機 creds（避免真的讀開發機憑證）與磁碟 snapshot
//（讓每支測試都從「沒有 lastGood」起跑）。其餘一律放行到真實實作——
// 全攔會讓 jest/babel 讀自己的檔案時也吃到這份假 JSON，改動 lib 使 transform 快取失效後，
// 整支套件會以 SyntaxError: Unexpected token ':' 全滅，且錯誤完全不指向成因。
const realReadFileSync = fs.readFileSync;
function mockReadFileSync(token) {
  return (p, ...rest) => {
    const s = String(p);
    if (s.endsWith('.credentials.json')) return JSON.stringify({ claudeAiOauth: { accessToken: token } });
    if (s.endsWith('claude-usage.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (s.endsWith('plan-usage-history.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return realReadFileSync(p, ...rest);
  };
}

describe('lib/claude-usage getUsage', () => {
  let lib;
  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(fs, 'readFileSync').mockImplementation(mockReadFileSync('test-token'));
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

  // Desktop 呼叫後會更新 plan-usage-history.json；主憑證必須優先使用最新取樣，
  // 否則畫面與閘門會被受限流影響的 OAuth API 舊值誤導。
  test('桌面 JSON 有新取樣 → 優先採用 fh/sd，且不打 API', async () => {
    const now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    fs.readFileSync.mockImplementation((p, ...rest) => {
      const s = String(p);
      if (s.endsWith('.credentials.json')) return JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } });
      if (s.endsWith('claude-usage.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (s.endsWith('plan-usage-history.json')) return JSON.stringify({
        version: 2,
        samples: [{ t: now - 60_000, org: 'org-1', u: { fh: 12, sd: 54 } }]
      });
      return realReadFileSync(p, ...rest);
    });
    global.fetch = jest.fn();
    const u = await lib.getUsage();
    expect(u).toMatchObject({ source: 'desktop_json', five_hour: { utilization: 12 }, seven_day: { utilization: 54 } });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('桌面 JSON 超過 45 分鐘未更新 → 回退 OAuth API', async () => {
    const now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    fs.readFileSync.mockImplementation((p, ...rest) => {
      const s = String(p);
      if (s.endsWith('.credentials.json')) return JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } });
      if (s.endsWith('claude-usage.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (s.endsWith('plan-usage-history.json')) return JSON.stringify({
        version: 2,
        samples: [{ t: now - 46 * 60 * 1000, u: { fh: 12, sd: 54 } }]
      });
      return realReadFileSync(p, ...rest);
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ five_hour: { utilization: 21 }, seven_day: { utilization: 65 } }) });
    const u = await lib.getUsage();
    expect(u.five_hour.utilization).toBe(21);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('抓取失敗但有前一筆好資料 → 回 stale 舊值', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ five_hour: { utilization: 55, resets_at: 'x' } }) })
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null } });
    await lib.getUsage();            // 建立 lastGood
    lib._resetCacheForTesting();     // 清 TTL cache，強制再抓
    const u = await lib.getUsage();  // 第二次 429
    expect(u.stale).toBe(true);
    expect(u.five_hour.utilization).toBe(55);
  });

  // /api/oauth/usage 限流很兇：每分鐘打一次會把配額燒光，之後整整半小時全是 429，
  // 畫面就卡在 stale 不動。快取拉長是止血的主手段，不是最佳化。
  test('數分鐘內重複呼叫只打一次 API', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ five_hour: { utilization: 5, resets_at: 'x' } })
    });
    await lib.getUsage();
    now += 5 * 60 * 1000;
    await lib.getUsage();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // 429 的 Retry-After 是分鐘級，且窗口會自然倒數、不因重打而延長 → 冷卻期間再送請求
  // 只是白白耗掉配額。實測 Retry-After=1877s，而平台原本每 60s 硬打一次。
  test('429 帶 Retry-After → 冷卻窗內不再打 API，仍回 stale 舊值', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ five_hour: { utilization: 55, resets_at: 'x' } }) })
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '1800' } });
    await lib.getUsage();            // 建立 lastGood
    lib._resetCacheForTesting();
    await lib.getUsage();            // 429 → 記下冷卻到期
    lib._resetCacheForTesting();     // 就算 TTL 過了
    const u = await lib.getUsage();  // 也不該再打
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(u.stale).toBe(true);
    expect(u.five_hour.utilization).toBe(55);
  });

  // 冷卻只綁在被限流的那把憑證上；連坐會讓「主帳號滿了就切備用」的閘門看不到備用的真實用量。
  test('主憑證被限流不影響備用憑證量測', async () => {
    const auth = require('../lib/claude-auth');
    auth._setForTesting('primary-tok', 'backup-tok', 'primary');
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '1800' } })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ five_hour: { utilization: 3, resets_at: 'y' } }) });
    await lib.getUsage('primary');
    const b = await lib.getUsage('backup');
    expect(b.five_hour.utilization).toBe(3);
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
    jest.spyOn(fs, 'readFileSync').mockImplementation(mockReadFileSync('local-creds-token'));
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
