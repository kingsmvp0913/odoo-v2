// 租戶範圍判斷的唯一真相（規格 §5.2）。
// 為什麼公司管理員不重用 role='admin'：全平台至少 6 處散落的 role === 'admin' 檢查
//（auth.js、index.js×2、project-routes.js、token-report-routes.js、pipeline-routes.js），
// 漏改一處，客戶的公司管理員就在那裡變成平台管理員。用新值的話，
// 既有檢查天生把公司管理員擋在外面——漏改的結果是「少一個功能」而不是「客戶拿到平台權限」。
const ROLES = { PLATFORM_ADMIN: 'admin', COMPANY_ADMIN: 'company_admin', USER: 'user' };

// company_id 從 HTTP body 進來時可能是字串；0 與空字串不是合法的 SERIAL id。
const hasCompany = (companyId) =>
  companyId !== null && companyId !== undefined && companyId !== '' && Number(companyId) > 0;

// 角色 ↔ 公司的一致性（規格 §4.4）。純函式，所有建立／修改帳號的路徑都要先過它。
function validateRoleCompany(role, companyId) {
  if (role === ROLES.PLATFORM_ADMIN) {
    return hasCompany(companyId)
      ? { ok: false, error: '平台管理員不能屬於任何公司' }
      : { ok: true };
  }
  if (role === ROLES.COMPANY_ADMIN || role === ROLES.USER) {
    return hasCompany(companyId)
      ? { ok: true }
      : { ok: false, error: '公司管理員與一般使用者必須指定公司' };
  }
  return { ok: false, error: `未知的角色：${role}` };
}

module.exports = { ROLES, validateRoleCompany, hasCompany };
