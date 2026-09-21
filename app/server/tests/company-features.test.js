/**
 * company-features.test.js — 公司功能開關（規格 §5.3 考試那一列，2026-09-21 使用者裁決）
 *
 * 為什麼要這支：考試系統本來就是給內部一般使用者考的，不能鎖成平台管理員限定；
 * 但客戶公司進來之後也不該看得到內部題庫。所以用「哪家公司能用哪些功能」來管。
 * 「沒有公司」一律當成有全部功能——平台管理員沒有公司，寫反會把管理員自己鎖死。
 */
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-feat-jwt';
process.env.APP_SECRET = 'test-feat-secret';

let dbModule, coOn, coOff, coDefault, coInternal, uOn, uOff, uNoCompany;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const mkCo = async (name, features) => (await one(
    'INSERT INTO companies (name, is_active, features) VALUES ($1, true, $2) RETURNING id',
    [name, features === undefined ? null : JSON.stringify(features)]
  )).id;
  coOn = await mkCo('有考試的公司', { exam: true });
  coOff = await mkCo('沒考試的公司', { exam: false });
  coDefault = await mkCo('沒設過的公司');   // features 是 NULL
  coInternal = (await one(
    'INSERT INTO companies (name, is_active, is_internal) VALUES ($1, true, true) RETURNING id', ['內部']
  )).id;                                     // features 也是 NULL，但它是內部公司

  const mkUser = async (username, companyId) => (await one(
    'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4) RETURNING id',
    [username, 'x', 'user', companyId]
  )).id;
  uOn = await mkUser('feat-on', coOn);
  uOff = await mkUser('feat-off', coOff);
  uNoCompany = await mkUser('feat-none', null);
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('companyHasFeature', () => {
  const { companyHasFeature } = require('../lib/company-features');

  test('公司開了 → true', async () => expect(await companyHasFeature(coOn, 'exam')).toBe(true));
  test('公司關了 → false', async () => expect(await companyHasFeature(coOff, 'exam')).toBe(false));
  test('公司沒設過（features 為 NULL）→ false（客戶預設不給）', async () => {
    expect(await companyHasFeature(coDefault, 'exam')).toBe(false);
  });
  test('沒有公司 → true（平台管理員沒有公司，寫反會把管理員鎖死）', async () => {
    expect(await companyHasFeature(null, 'exam')).toBe(true);
    expect(await companyHasFeature(undefined, 'exam')).toBe(true);
  });
  test('查不到那家公司 → true（不認識的不歸這支管，交給上游的授權擋）', async () => {
    expect(await companyHasFeature(999999, 'exam')).toBe(true);
  });
  test('內部公司 → true，即使 features 沒設過（這一條防的是把自己人鎖在外面）', async () => {
    expect(await companyHasFeature(coInternal, 'exam')).toBe(true);
  });
  test('內部公司連還沒發明的功能也算有（加新功能不必回頭補內部公司的資料）', async () => {
    expect(await companyHasFeature(coInternal, 'exam')).toBe(true);
    const row = await one('SELECT features FROM companies WHERE id = $1', [coInternal]);
    expect(row.features).toBe(null);
  });
  test('不認得的功能名稱 → false（打錯字不該變成全開）', async () => {
    expect(await companyHasFeature(coOn, 'no-such-feature')).toBe(false);
  });
});

describe('normalizeFeatures', () => {
  const { normalizeFeatures } = require('../lib/company-features');

  test('只留認得的 key（打錯字的欄位不該被存下來）', () => {
    expect(normalizeFeatures({ exam: true, bogus: true })).toEqual({ exam: true });
  });
  test('字串 true 算開啟（表單與 query string 會把布林印成字串）', () => {
    expect(normalizeFeatures({ exam: 'true' })).toEqual({ exam: true });
  });
  test('其餘一律關閉——字串 false 如果被當成 truthy，功能會被悄悄打開而且沒有任何徵狀', () => {
    expect(normalizeFeatures({ exam: 'false' })).toEqual({ exam: false });
    expect(normalizeFeatures({ exam: 'yes' })).toEqual({ exam: false });
    expect(normalizeFeatures({ exam: 1 })).toEqual({ exam: false });
  });
  test('null／非物件 → 空物件', () => {
    expect(normalizeFeatures(null)).toEqual({});
    expect(normalizeFeatures('exam')).toEqual({});
  });
});

describe('requireFeature middleware', () => {
  const { requireFeature } = require('../lib/company-features');
  const mkRes = () => {
    const res = { code: null, body: null };
    res.status = c => { res.code = c; return res; };
    res.json = b => { res.body = b; return res; };
    return res;
  };

  test('有功能 → 放行', async () => {
    const res = mkRes(); let nexted = false;
    await requireFeature('exam')({ actor: { companyId: coOn } }, res, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(res.code).toBe(null);
  });

  test('沒有功能 → 404，訊息不說「你沒權限」（說了等於告訴對方這功能存在）', async () => {
    const res = mkRes(); let nexted = false;
    await requireFeature('exam')({ actor: { companyId: coOff } }, res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.code).toBe(404);
  });

  test('沒有 actor（未登入就到這支）→ 404，不當成「沒有公司」放行', async () => {
    const res = mkRes(); let nexted = false;
    await requireFeature('exam')({}, res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.code).toBe(404);
  });
});
