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

const { newDb } = require('pg-mem');
const { canSeeProject, loadProjectForActor, canReleaseProject, canManageCompanyUsers } = require('../lib/tenant-access');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

describe('範圍函式（規格 §5.2）', () => {
  let dbModule, internalId, aId, bId, pShared, pAOnly, pInternalOnly;

  beforeAll(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    dbModule = require('../db');
    dbModule._setPoolForTesting(new Pool());
    await dbModule.migrate();

    const mkCo = async (name, isInternal) => {
      const { rows } = await dbModule.query(
        'INSERT INTO companies (name, is_active, is_internal) VALUES ($1, true, $2) RETURNING id',
        [name, isInternal]
      );
      return rows[0].id;
    };
    const mkPr = async (name) => {
      const { rows } = await dbModule.query(
        "INSERT INTO projects (name, odoo_version) VALUES ($1, '17') RETURNING id", [name]
      );
      return rows[0].id;
    };
    const bind = (p, c, canRelease = false) => dbModule.query(
      'INSERT INTO project_companies (project_id, company_id, can_release) VALUES ($1, $2, $3)', [p, c, canRelease]
    );

    internalId = await mkCo('內部', true);
    aId = await mkCo('甲公司', false);
    bId = await mkCo('乙公司', false);

    pShared = await mkPr('共用專案');       // 甲、乙、內部都綁
    pAOnly = await mkPr('甲專屬專案');       // 只有甲 + 內部
    pInternalOnly = await mkPr('內部專案');  // 只有內部

    await bind(pShared, internalId);
    await bind(pShared, aId, true);   // 甲可以按上正式
    await bind(pShared, bId, false);  // 乙不行
    await bind(pAOnly, internalId);
    await bind(pAOnly, aId, false);
    await bind(pInternalOnly, internalId);
  });

  afterAll(() => dbModule._setPoolForTesting(null));

  const actor = (over) => ({
    userId: 1, role: 'user', companyId: null,
    isPlatformAdmin: false, isCompanyAdmin: false, isInternal: false, companyUsable: true, ...over
  });

  test('平台管理員看得到全部專案', async () => {
    const a = actor({ role: 'admin', isPlatformAdmin: true });
    expect(await canSeeProject(a, pShared)).toBe(true);
    expect(await canSeeProject(a, pInternalOnly)).toBe(true);
  });

  test('甲公司看得到綁給它的，看不到沒綁的', async () => {
    const a = actor({ companyId: aId });
    expect(await canSeeProject(a, pShared)).toBe(true);
    expect(await canSeeProject(a, pAOnly)).toBe(true);
    expect(await canSeeProject(a, pInternalOnly)).toBe(false);
  });

  test('乙公司只看得到共用那一個', async () => {
    const a = actor({ companyId: bId });
    expect(await canSeeProject(a, pShared)).toBe(true);
    expect(await canSeeProject(a, pAOnly)).toBe(false);
  });

  test('內部公司不特判：它看得到全部是因為全部都綁了，不是因為程式開後門', async () => {
    const a = actor({ companyId: internalId, isInternal: true });
    expect(await canSeeProject(a, pInternalOnly)).toBe(true);
    // 解掉一個綁定，它就該看不到那一個
    await dbModule.query('DELETE FROM project_companies WHERE project_id = $1 AND company_id = $2',
      [pInternalOnly, internalId]);
    expect(await canSeeProject(a, pInternalOnly)).toBe(false);
    await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1, $2)',
      [pInternalOnly, internalId]);
  });

  test('沒有公司又不是平台管理員 → 什麼都看不到', async () => {
    expect(await canSeeProject(actor({ companyId: null }), pShared)).toBe(false);
  });

  test('loadProjectForActor 看得到回列、看不到回 null（路由要據此回 404，不是 403）', async () => {
    const req = { actor: actor({ companyId: bId }) };
    const ok = await loadProjectForActor(pShared, req, 'id, name');
    expect(ok.name).toBe('共用專案');
    expect(await loadProjectForActor(pAOnly, req, 'id, name')).toBeNull();
  });

  test('canReleaseProject：公司管理員 + 該綁定勾了才行', async () => {
    const ca = (companyId) => actor({ role: 'company_admin', isCompanyAdmin: true, companyId });
    expect(await canReleaseProject(ca(aId), pShared)).toBe(true);   // 甲的綁定勾了
    expect(await canReleaseProject(ca(bId), pShared)).toBe(false);  // 乙的沒勾
    expect(await canReleaseProject(ca(aId), pAOnly)).toBe(false);   // 甲對這個沒勾
  });

  test('canReleaseProject：一般使用者一律不行，即使綁定勾了', async () => {
    expect(await canReleaseProject(actor({ companyId: aId }), pShared)).toBe(false);
  });

  test('canReleaseProject：平台管理員一律可以', async () => {
    expect(await canReleaseProject(actor({ role: 'admin', isPlatformAdmin: true }), pInternalOnly)).toBe(true);
  });

  test('canManageCompanyUsers：平台管理員管全部，公司管理員只管自己公司', async () => {
    expect(canManageCompanyUsers(actor({ role: 'admin', isPlatformAdmin: true }), bId)).toBe(true);
    const ca = actor({ role: 'company_admin', isCompanyAdmin: true, companyId: aId });
    expect(canManageCompanyUsers(ca, aId)).toBe(true);
    expect(canManageCompanyUsers(ca, bId)).toBe(false);
    expect(canManageCompanyUsers(actor({ companyId: aId }), aId)).toBe(false); // 一般使用者不行
  });
});
