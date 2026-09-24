/**
 * exam-scope.test.js — 考試場次歸屬與可見範圍的判準
 * （規格 `2026-09-24-exam-tenant-scope-design.md` §3.2）
 *
 * 每一條分支錯了都不會報錯：放太寬＝客戶看到內部同事的考卷（不會有人來說），
 * 放太嚴＝內部同事的考試不見了（會有人來說）。所以兩個方向都要釘。
 */
const {
  seesAllBanks, bankOwnerForActor, bankOwnerForUser, bankScopeClause, canSeeBank, requireInternal,
} = require('../lib/exam/scope');

const actor = (o = {}) => ({
  isPlatformAdmin: false, isCompanyAdmin: false, isInternal: false, companyId: null, ...o,
});
const platformAdmin = actor({ isPlatformAdmin: true });
const internalUser = actor({ isInternal: true, companyId: 1 });
const custUser = actor({ companyId: 7 });

describe('誰看得到全部場次', () => {
  test('平台管理員與內部公司成員看得到全部', () => {
    expect(seesAllBanks(platformAdmin)).toBe(true);
    expect(seesAllBanks(internalUser)).toBe(true);
  });

  // 「沒有公司 ⇒ 算內部」是全平台既有的同一條慣例（tenant-access 的
  // isUserCompanyInternal、company-features 的 companyHasFeature、agent-home 的
  // resolveHomeBucket 都這樣判）。客戶一定有公司（validateRoleCompany 強制），
  // 所以這條不會把客戶放進來；會落在這裡的是遷移前的舊帳號。
  // 在這裡自創另一套判法，症狀是內部同事的考試突然不見了。
  test('沒有公司的帳號算內部（與全平台既有慣例一致）', () => {
    expect(seesAllBanks(actor({ companyId: null }))).toBe(true);
    expect(seesAllBanks(actor({ companyId: undefined }))).toBe(true);
  });

  test('客戶公司成員不是', () => {
    expect(seesAllBanks(custUser)).toBe(false);
    expect(seesAllBanks(actor({ isCompanyAdmin: true, companyId: 7 }))).toBe(false);
  });

  // 沒有身分不該落在「看得到全部」。這道閘門的失敗方向只能是看不到。
  test('沒有 actor → false', () => {
    expect(seesAllBanks(null)).toBe(false);
    expect(seesAllBanks(undefined)).toBe(false);
  });
});

describe('新場次掛在誰底下', () => {
  test('內部人員開的場次掛 null（＝內部）', () => {
    expect(bankOwnerForActor(platformAdmin)).toBeNull();
    expect(bankOwnerForActor(internalUser)).toBeNull();
  });

  test('客戶開的場次掛他自己的公司', () => {
    expect(bankOwnerForActor(custUser)).toBe(7);
  });

  // 上傳那條路沒有 req.actor（通行碼與本機上傳都不經 verifyToken）
  describe('只有 userId 時（上傳路徑）', () => {
    const q = (rows) => async () => ({ rows });

    test('客戶公司的人 → 他的公司', async () => {
      expect(await bankOwnerForUser(9, { query: q([{ id: 7, is_internal: false }]) })).toBe(7);
    });

    test('內部公司的人 → null', async () => {
      expect(await bankOwnerForUser(9, { query: q([{ id: 1, is_internal: true }]) })).toBeNull();
    });

    // 本機上傳（免 token）沒有身分，而且**不該查 DB**：落點必須是確定的，
    // 不可以因為查詢結果而飄到某家客戶的場次上。比照 lib/agent-home.js 的同一條約定。
    test('沒有 userId → null，而且完全不查 DB', async () => {
      const boom = async () => { throw new Error('不該查 DB'); };
      expect(await bankOwnerForUser(null, { query: boom })).toBeNull();
      expect(await bankOwnerForUser(undefined, { query: boom })).toBeNull();
    });

    test('查不到人（帳號已刪）→ null，不是丟例外', async () => {
      expect(await bankOwnerForUser(9, { query: q([]) })).toBeNull();
    });
  });
});

describe('列表的範圍條件', () => {
  test('看得到全部的人 → TRUE，不帶參數（呼叫端不必分支）', () => {
    expect(bankScopeClause(platformAdmin, 'b.company_id')).toEqual({ sql: 'TRUE', params: [] });
    expect(bankScopeClause(internalUser, 'b.company_id')).toEqual({ sql: 'TRUE', params: [] });
  });

  test('客戶 → 限自己公司，參數位置可指定（這些查詢多半已經有別的參數）', () => {
    expect(bankScopeClause(custUser, 'b.company_id')).toEqual({ sql: 'b.company_id = $1', params: [7] });
    expect(bankScopeClause(custUser, 'b.company_id', 3)).toEqual({ sql: 'b.company_id = $3', params: [7] });
  });

  // 不是內部、又沒有公司：理論上不存在，但失敗方向只能是「看不到」。
  test('完全沒有 actor → FALSE（不是 TRUE）', () => {
    expect(bankScopeClause(null, 'b.company_id')).toEqual({ sql: 'FALSE', params: [] });
    expect(bankScopeClause(undefined, 'b.company_id')).toEqual({ sql: 'FALSE', params: [] });
  });
});

describe('看得到這一場嗎', () => {
  const bank = (companyId) => async () => ({ rows: [{ company_id: companyId }] });
  const none = async () => ({ rows: [] });

  test('內部的場次：內部看得到，客戶看不到', async () => {
    expect(await canSeeBank(internalUser, 5, { query: bank(null) })).toBe(true);
    expect(await canSeeBank(actor({ companyId: null }), 5, { query: bank(null) })).toBe(true);
    expect(await canSeeBank(platformAdmin, 5, { query: bank(null) })).toBe(true);
    expect(await canSeeBank(custUser, 5, { query: bank(null) })).toBe(false);
  });

  test('甲公司的場次：甲看得到，乙看不到，內部看得到', async () => {
    expect(await canSeeBank(custUser, 5, { query: bank(7) })).toBe(true);
    expect(await canSeeBank(actor({ companyId: 8 }), 5, { query: bank(7) })).toBe(false);
    expect(await canSeeBank(internalUser, 5, { query: bank(7) })).toBe(true);
  });

  test('場次不存在 → false（呼叫端回 404，與「看不到」同一個結果）', async () => {
    expect(await canSeeBank(internalUser, 5, { query: none })).toBe(false);
  });

  // id 不是數字時不要把它送進 SQL
  test('id 不合法 → false', async () => {
    const boom = async () => { throw new Error('不該查 DB'); };
    expect(await canSeeBank(internalUser, 'abc', { query: boom })).toBe(false);
    expect(await canSeeBank(internalUser, undefined, { query: boom })).toBe(false);
  });
});

describe('題庫管理限內部的中介層', () => {
  const run = (a) => new Promise((resolve) => {
    const req = { actor: a };
    const res = { status(c) { this._c = c; return this; }, json(p) { resolve({ code: this._c, p }); } };
    requireInternal(req, res, () => resolve({ code: 200, p: null }));
  });

  test('內部與平台管理員放行', async () => {
    expect((await run(internalUser)).code).toBe(200);
    expect((await run(platformAdmin)).code).toBe(200);
  });

  // 404 而不是 403：客戶不需要知道有這個東西存在（與 requireFeature 同一條原則）
  test('客戶一律 404，不是 403', async () => {
    const r = await run(custUser);
    expect(r.code).toBe(404);
    expect(r.p.error).toBe('找不到這個功能');
  });

  test('沒有 actor → 404（不把「沒有身分」當成放行）', async () => {
    expect((await run(undefined)).code).toBe(404);
  });
});

// 「這次上傳落在誰的場次」與「看得到哪些場」是兩個不同的問題。合併的話內部會出事：
// 看得到全部 ⇒ 條件 TRUE ⇒ 上傳會落進**任何**一場還沒結束的考試，包含客戶的。
describe('上傳該落在誰的場次（與可見範圍不同的問題）', () => {
  const { bankOwnerClause } = require('../lib/exam/scope');

  // = NULL 在 SQL 裡永遠不成立。寫錯的症狀是內部每次上傳都開一場新考試，
  // 而畫面上只看得出「場次列表一直變長」，沒有任何錯誤。
  test('內部（null）→ IS NULL，不是 = NULL', () => {
    expect(bankOwnerClause(null, 'b.company_id')).toEqual({ sql: 'b.company_id IS NULL', params: [] });
    expect(bankOwnerClause(undefined, 'b.company_id')).toEqual({ sql: 'b.company_id IS NULL', params: [] });
  });

  test('客戶 → 限他的公司', () => {
    expect(bankOwnerClause(7, 'b.company_id')).toEqual({ sql: 'b.company_id = $1', params: [7] });
    expect(bankOwnerClause(7, 'company_id', 2)).toEqual({ sql: 'company_id = $2', params: [7] });
  });

  // 對照：同一個內部身分，兩支的答案必須相反
  test('內部：看得到全部（TRUE），但只落在內部的場次（IS NULL）', () => {
    const internal = { isInternal: true, companyId: 1 };
    expect(bankScopeClause(internal, 'company_id').sql).toBe('TRUE');
    expect(bankOwnerClause(bankOwnerForActor(internal), 'company_id').sql).toBe('company_id IS NULL');
  });
});
