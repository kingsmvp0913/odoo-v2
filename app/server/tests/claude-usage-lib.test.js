const fs = require('fs');

// 只攔 lib 自己會讀的兩個路徑：本機 creds（避免真的讀開發機憑證）與磁碟 snapshot
//（讓每支測試都從「沒有 lastGood」起跑）。其餘一律放行到真實實作——
// 全攔會讓 jest/babel 讀自己的檔案時也吃到這份假 JSON，改動 lib 使 transform 快取失效後，
// 整支套件會以 SyntaxError: Unexpected token ':' 全滅，且錯誤完全不指向成因。
const realReadFileSync = fs.readFileSync;
const realStatSync = fs.statSync;
function mockReadFileSync(token) {
  return (p, ...rest) => {
    const s = String(p);
    if (s.endsWith('.credentials.json')) return JSON.stringify({ claudeAiOauth: { accessToken: token } });
    if (s.endsWith('claude-usage.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (s.endsWith('claude-rate-limit.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
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
    jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    // 同上：statSync 只攔校準檔，全攔會讓 jest 自己的 transform cache 壞掉
    //（實測 TypeError: The "uid" argument must be of type number）。
    jest.spyOn(fs, 'statSync').mockImplementation((p, ...rest) =>
      String(p).endsWith('claude-usage-calibration.jsonl') ? { size: 1 } : realStatSync(p, ...rest));
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

  // 校準樣本是日後「API 抓不到時自行推估百分比」的唯一依據；只有真值可以入樣本，
  // 拿 stale／推估值回填會讓係數愈校愈偏。
  test('API 回真值 → 追加一筆校準樣本', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 42, resets_at: '2026-07-22T10:00:00Z' },
        seven_day: { utilization: 71, resets_at: '2026-07-28T00:00:00Z' }
      })
    });
    await lib.getUsage();
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
    const [p, line] = fs.appendFileSync.mock.calls[0];
    expect(String(p)).toMatch(/claude-usage-calibration\.jsonl$/);
    expect(JSON.parse(line)).toMatchObject({
      five_hour: 42, seven_day: 71, five_hour_resets_at: '2026-07-22T10:00:00Z'
    });
  });

  test('抓取失敗回 stale → 不得寫入校準樣本', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ five_hour: { utilization: 55 } }) });
    await lib.getUsage();
    lib._resetCacheForTesting();
    fs.appendFileSync.mockClear();
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429, headers: { get: () => null } });
    const u = await lib.getUsage();
    expect(u.stale).toBe(true);
    expect(fs.appendFileSync).not.toHaveBeenCalled();
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

  // 前端多個分頁＋usage-gate 每關評估都會呼叫，沒有快取就是每次都真打。TTL 是 60 秒
  //（2026-08-31 實測端點門檻約「5 分鐘 6 次」，見 lib/claude-usage.js 的註解），
  // 兩個斷言夾住它：窗內不得重打、窗外必須重打——只驗前者的話 TTL 被改成任意大值都不會紅。
  test('TTL 窗內重複呼叫只打一次 API，窗外才重打', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ five_hour: { utilization: 5, resets_at: 'x' } })
    });
    await lib.getUsage();
    now += 30 * 1000;
    await lib.getUsage();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    now += 60 * 1000;
    await lib.getUsage();
    expect(global.fetch).toHaveBeenCalledTimes(2);
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

// pipeline 的 stream-json 本來就帶 rate_limit_event，攔下來等於不花任何 API 配額就知道
// 「跑任務那把憑證」的額度狀態——usage endpoint 被 429 擋住時，這是唯一還會更新的來源。
describe('lib/claude-usage rate_limit_event', () => {
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

  test('沒有事件進來 → 狀態為 null，呼叫端才分得出「沒資料」與「正常」', () => {
    expect(lib.getRateLimitState()).toBeNull();
  });

  test('記錄事件 → resetsAt 由 epoch 秒換成 ISO 並落檔', () => {
    // 實測值：1787809200 對應 2026-08-27T05:40:00Z，與同時間 API 回的 five_hour.resets_at 一致。
    const state = lib.recordRateLimitEvent({
      status: 'allowed', resetsAt: 1787809200, rateLimitType: 'five_hour',
      overageStatus: 'allowed', overageResetsAt: 1788220800, isUsingOverage: false
    });
    expect(state).toMatchObject({
      status: 'allowed', rate_limit_type: 'five_hour',
      resets_at: '2026-08-27T05:40:00.000Z', is_using_overage: false
    });
    expect(lib.getRateLimitState()).toEqual(state);
    const [p] = fs.writeFileSync.mock.calls.at(-1);
    expect(String(p)).toMatch(/claude-rate-limit\.json$/);
  });

  test('status 缺漏 → 整筆不留，不得寫入半筆殘值', () => {
    expect(lib.recordRateLimitEvent({ resetsAt: 1787809200 })).toBeNull();
    expect(lib.recordRateLimitEvent(null)).toBeNull();
    expect(lib.getRateLimitState()).toBeNull();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  test('resetsAt 不是有效數字 → 該欄位留 null，其餘照收', () => {
    const state = lib.recordRateLimitEvent({ status: 'rejected', resetsAt: null });
    expect(state).toMatchObject({ status: 'rejected', resets_at: null });
  });
});
