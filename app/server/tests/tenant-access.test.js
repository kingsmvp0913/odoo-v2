/**
 * tenant-access.test.js — 租戶範圍判斷的唯一真相（規格 §4.4、§5.2）
 *
 * validateRoleCompany 守的是「平台管理員不屬於任何公司、其他人一定屬於一家」這個不變式。
 * 這條不變式一破，req.actor.companyId 就可能是 undefined，
 * 而所有範圍查詢都拿它當條件 ⇒ 條件失效、看到全部人的資料。
 */
const { ROLES, validateRoleCompany } = require('../lib/tenant-access');

describe('validateRoleCompany', () => {
  test('平台管理員沒有公司 → 通過', () => {
    expect(validateRoleCompany(ROLES.PLATFORM_ADMIN, null).ok).toBe(true);
  });

  test('平台管理員帶了公司 → 拒絕（admin 一律看全部，掛公司會讓人誤以為受限）', () => {
    const r = validateRoleCompany(ROLES.PLATFORM_ADMIN, 3);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('平台管理員');
  });

  test('公司管理員必須有公司', () => {
    expect(validateRoleCompany(ROLES.COMPANY_ADMIN, 3).ok).toBe(true);
    expect(validateRoleCompany(ROLES.COMPANY_ADMIN, null).ok).toBe(false);
  });

  test('一般使用者必須有公司', () => {
    expect(validateRoleCompany(ROLES.USER, 3).ok).toBe(true);
    expect(validateRoleCompany(ROLES.USER, null).ok).toBe(false);
  });

  test('未知角色一律拒絕（打錯字的 companyAdmin 不能悄悄變成沒有公司的身分）', () => {
    expect(validateRoleCompany('companyAdmin', 3).ok).toBe(false);
    expect(validateRoleCompany('', 3).ok).toBe(false);
    expect(validateRoleCompany(undefined, 3).ok).toBe(false);
  });

  test('company_id 用字串 "3" 傳進來也算有值（HTTP body 不帶型別）', () => {
    expect(validateRoleCompany(ROLES.USER, '3').ok).toBe(true);
  });

  test('company_id 是 0 或空字串一律視為沒有（0 不是合法的 SERIAL id）', () => {
    expect(validateRoleCompany(ROLES.USER, 0).ok).toBe(false);
    expect(validateRoleCompany(ROLES.USER, '').ok).toBe(false);
  });
});
