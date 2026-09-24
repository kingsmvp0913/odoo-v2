/**
 * company-anthropic-key-lib.test.js — 設定客戶 API key 的規則本體（純函式層）
 *
 * 同名的 company-anthropic-key.test.js 是**更早就存在的 HTTP 層測試**（commit e440f46e），
 * 兩支不重疊：那支從端點打進去驗「回應不夾帶 key、壞 key 不蓋掉好 key、列表旗標」，
 * 這支驗規則本身的分支。
 *
 * 這一組規則有**兩個入口**（平台管理員代填、公司管理員自己換），所以它被抽成一支
 * 共用模組。這支測的是那份規則；兩個入口只是薄殼，各自的權限另有測試。
 *
 * 錯誤政策是刻意的、不對稱的：**認證失敗擋下不存，其他失敗照存但回報沒驗成功**。
 * 寫反了不會報錯——只會在「換 key 的那天剛好 API 過載」時把客戶鎖在外面，
 * 而那正是最需要換 key 的時候。所以兩個方向都要釘。
 */
const {
  CompanyKeyError, setCompanyAnthropicKey, clearCompanyAnthropicKey, companyKeyConfigured,
} = require('../lib/company-anthropic-key');
const { decrypt } = require('../lib/crypto');

const CUSTOMER = [{ id: 7, is_internal: false }];
const INTERNAL = [{ id: 1, is_internal: true }];

// 記下所有查詢，才驗得到「被擋下時完全沒有 UPDATE」
function fakeDb(selectRows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^\s*UPDATE/i.test(sql)) return { rows: [{ id: params[0] }] };
      return { rows: selectRows };
    },
  };
}
const updates = (db) => db.calls.filter((c) => /^\s*UPDATE/i.test(c.sql));

let savedSecret;
beforeAll(() => { savedSecret = process.env.APP_SECRET; process.env.APP_SECRET = 'test-company-key-secret'; });
afterAll(() => { if (savedSecret === undefined) delete process.env.APP_SECRET; else process.env.APP_SECRET = savedSecret; });

const ok = async () => ({});                       // 探針成功
const authFail = async () => { const e = new Error('Invalid API key'); e.claudeStatus = 'auth'; throw e; };
const flaky = async () => { throw new Error('529 Overloaded'); };

describe('設定 key', () => {
  test('探針過了 → 存密文、沒有警告', async () => {
    const db = fakeDb(CUSTOMER);
    const r = await setCompanyAnthropicKey(
      { companyId: 7, apiKey: 'sk-real', actorUserId: 2 },
      { query: db.query, runClaude: ok, looksLikeAuthFailure: () => false });
    expect(r.warning).toBeNull();
    const up = updates(db);
    expect(up).toHaveLength(1);
    // 存的必須是密文，而且解得回原值。存明文的症狀：資料庫一被看到，客戶的 key 就外流。
    expect(up[0].params[1]).not.toBe('sk-real');
    expect(decrypt(up[0].params[1])).toBe('sk-real');
  });

  // ⚠ 這條與下一條是整支最重要的一對，方向相反
  test('認證失敗 → 400，而且一次 UPDATE 都沒有', async () => {
    const db = fakeDb(CUSTOMER);
    await expect(setCompanyAnthropicKey(
      { companyId: 7, apiKey: 'sk-bad', actorUserId: 2 },
      { query: db.query, runClaude: authFail, looksLikeAuthFailure: () => false }
    )).rejects.toMatchObject({ status: 400, message: '憑證無效或已撤銷，未儲存' });
    expect(updates(db)).toHaveLength(0);
  });

  // 換 key 的時機往往正是服務不穩的時候，一次 529 就把人鎖在外面是更糟的失敗模式
  test('非認證失敗（API 過載）→ 照存，但據實回報沒驗成功', async () => {
    const db = fakeDb(CUSTOMER);
    const r = await setCompanyAnthropicKey(
      { companyId: 7, apiKey: 'sk-real', actorUserId: 2 },
      { query: db.query, runClaude: flaky, looksLikeAuthFailure: () => false });
    expect(r.warning).toContain('529');
    expect(updates(db)).toHaveLength(1);
  });

  // claudeStatus 沒帶時靠字面認——runner 不是每條路徑都設得了那個欄位
  test('靠訊息字面認出認證失敗，同樣擋下', async () => {
    const db = fakeDb(CUSTOMER);
    await expect(setCompanyAnthropicKey(
      { companyId: 7, apiKey: 'sk-bad', actorUserId: 2 },
      { query: db.query, runClaude: flaky, looksLikeAuthFailure: () => true }
    )).rejects.toMatchObject({ status: 400 });
    expect(updates(db)).toHaveLength(0);
  });

  test('空白 key → 400（前後空白也算空）', async () => {
    const db = fakeDb(CUSTOMER);
    for (const v of ['', '   ', null, undefined]) {
      await expect(setCompanyAnthropicKey({ companyId: 7, apiKey: v, actorUserId: 2 }, { query: db.query }))
        .rejects.toMatchObject({ status: 400 });
    }
    expect(updates(db)).toHaveLength(0);
  });

  test('找不到公司 → 404', async () => {
    const db = fakeDb([]);
    await expect(setCompanyAnthropicKey({ companyId: 99, apiKey: 'sk', actorUserId: 2 }, { query: db.query }))
      .rejects.toMatchObject({ status: 404 });
  });

  // 存了也永遠不會被用到（內部一律走平台訂閱），只會讓人以為設定生效了
  test('內部公司 → 400 擋下，不是照存', async () => {
    const db = fakeDb(INTERNAL);
    await expect(setCompanyAnthropicKey({ companyId: 1, apiKey: 'sk', actorUserId: 2 }, { query: db.query }))
      .rejects.toMatchObject({ status: 400 });
    expect(updates(db)).toHaveLength(0);
  });

  // 存明文比不存更糟，所以這裡是硬擋而不是降級
  test('沒有 APP_SECRET → 500，不得存明文', async () => {
    const keep = process.env.APP_SECRET;
    delete process.env.APP_SECRET;
    const db = fakeDb(CUSTOMER);
    await expect(setCompanyAnthropicKey({ companyId: 7, apiKey: 'sk', actorUserId: 2 }, { query: db.query }))
      .rejects.toMatchObject({ status: 500 });
    expect(updates(db)).toHaveLength(0);
    process.env.APP_SECRET = keep;
  });
});

describe('清除與查詢', () => {
  test('清除 → true；找不到 → false', async () => {
    expect(await clearCompanyAnthropicKey(7, { query: async () => ({ rows: [{ id: 7 }] }) })).toBe(true);
    expect(await clearCompanyAnthropicKey(9, { query: async () => ({ rows: [] }) })).toBe(false);
  });

  test('查詢只回「有沒有設」，不回 key 也不回密文', async () => {
    const r = await companyKeyConfigured(7, {
      query: async () => ({ rows: [{ configured: true, is_internal: false }] }) });
    expect(r).toEqual({ configured: true, is_internal: false });
    expect(JSON.stringify(r)).not.toMatch(/sk-|enc/);
  });

  test('查詢找不到公司 → 404', async () => {
    await expect(companyKeyConfigured(99, { query: async () => ({ rows: [] }) }))
      .rejects.toMatchObject({ status: 404 });
  });
});

test('錯誤帶得動 HTTP 狀態，兩個入口才回得出一樣的訊息', () => {
  const e = new CompanyKeyError(400, '壞了');
  expect(e.status).toBe(400);
  expect(e.code).toBe('COMPANY_KEY');
});
