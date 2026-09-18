const { query } = require('../db');

// 租戶範圍判斷的唯一真相（規格 §5.2）。
// 為什麼公司管理員不重用 role='admin'：全平台散落至少 21 處判斷 role 是否為 'admin' 的檢查、
// 橫跨 13 個檔案（auth.js、index.js、admin-routes.js、project-routes.js、token-report-routes.js、
// pipeline-routes.js…，非窮舉，之後還會再長），漏改一處，客戶的公司管理員就在那裡變成平台
// 管理員。用新值的話，
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

// 這家公司綁了這個專案嗎（規格 §5.2）。
// 內部公司刻意不特判——它看得到全部專案是因為遷移把全部都綁給它了，不是因為程式開後門。
// 解掉某個綁定，它就該看不到那一個，這正是我們要的行為。
async function canSeeProject(actor, projectId) {
  if (!actor) return false;
  if (actor.isPlatformAdmin) return true;
  if (!hasCompany(actor.companyId)) return false;
  const { rows } = await query(
    'SELECT 1 FROM project_companies WHERE project_id = $1 AND company_id = $2',
    [projectId, actor.companyId]
  );
  return rows.length > 0;
}

// 欄位清單只允許「識別字、逗號、空白」與單獨一個 *。
// 這支函式把 columns 直接串進 SQL 文字（沿用 loadTaskForActor 的既有形狀），
// 第 1 部零呼叫端所以安全；第 2 部開始從路由呼叫它，只要有人把 request 來的東西
// 當欄位清單傳進來就是注入洞。白名單擋在這裡，比每個呼叫端各自小心可靠。
const SAFE_COLUMNS = /^\s*(\*|[A-Za-z_][A-Za-z0-9_]*(\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*$/;
function assertSafeColumns(columns) {
  if (!SAFE_COLUMNS.test(columns)) {
    throw new Error(`欄位清單只能是欄位名或 *，收到：${columns}`);
  }
}

// 比照 lib/task-access.js 的 loadTaskForActor。
// 看不到時回 null，路由要據此回 404——回 403 等於告訴對方「這個 id 存在，只是你不能看」，
// 那本身就是資料外洩。
async function loadProjectForActor(projectId, req, columns = '*') {
  assertSafeColumns(columns);
  if (!await canSeeProject(req.actor, projectId)) return null;
  const { rows } = await query(`SELECT ${columns} FROM projects WHERE id = $1`, [projectId]);
  return rows[0] || null;
}

// 能不能對這個專案按「上正式」（規格 §5.2、§4.3）。
// 一般使用者一律不行：上正式是專案層批次，會帶上同事已核准的任務，必須有人負責。
async function canReleaseProject(actor, projectId) {
  if (!actor) return false;
  if (actor.isPlatformAdmin) return true;
  if (!actor.isCompanyAdmin || !hasCompany(actor.companyId)) return false;
  const { rows } = await query(
    'SELECT can_release FROM project_companies WHERE project_id = $1 AND company_id = $2',
    [projectId, actor.companyId]
  );
  return rows[0]?.can_release === true;
}

// 能不能管這家公司的帳號（規格 §5.2）。純同步——只看身分，不必查 DB。
function canManageCompanyUsers(actor, companyId) {
  if (!actor) return false;
  if (actor.isPlatformAdmin) return true;
  return actor.isCompanyAdmin
    && hasCompany(actor.companyId)
    && Number(actor.companyId) === Number(companyId);
}

// 平台管理員限定的中介層（規格 §5.3）。放在 verifyToken 之後，所以 req.actor 一定在。
// 為什麼不重用各 route 檔自己那份 requireAdmin：那五份都另外查一次 DB，而 verifyToken
// 已經把身分載好了。新掛的守衛一律用這支；既有那五份不動（零順手重構）。
function requirePlatformAdmin(req, res, next) {
  if (!req.actor?.isPlatformAdmin) {
    return res.status(403).json({ error: '只有平台管理員能使用這個功能' });
  }
  next();
}

module.exports = {
  ROLES, validateRoleCompany, hasCompany,
  canSeeProject, loadProjectForActor, canReleaseProject, canManageCompanyUsers, requirePlatformAdmin,
};
