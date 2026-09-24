/**
 * scope.js — 考試場次「這一場是誰的、誰看得到」的唯一真相
 * （規格 `docs/superpowers/specs/2026-09-24-exam-tenant-scope-design.md` §3.2）
 *
 * 為什麼另立一支而不是塞進 lib/tenant-access.js：那支管的是專案與任務，靠
 * project_companies 綁定表；考試場次沒有綁定表，歸屬是建立當下寫死在
 * exam_banks.company_id 的。兩套判準混在同一個檔裡，遲早有人把綁定那套的
 * 「內部也要靠綁定拿權限」搬過來——而這裡的內部**刻意**是看得到全部。
 *
 * 題目池（exam_items）不在本檔範圍：它是跨公司共用的，那是 2026-09-24 的裁決
 * 而不是遺漏（分家等於每家客戶從零開始，「越考越準」整個機制歸零）。
 */
const { query } = require('../../db');

// 看得到全部場次的人：平台管理員、內部公司成員，以及**沒有公司的帳號**。
//
// 「沒有公司 ⇒ 算內部」不是漏洞，是全平台既有的同一條慣例：lib/tenant-access.js 的
// isUserCompanyInternal（查不到 ⇒ 內部人員）、lib/company-features.js 的
// companyHasFeature（沒有公司 ⇒ true，否則會把管理員鎖在自己的平台外面）、
// lib/agent-home.js 的 resolveHomeBucket 都是這樣判。**客戶一定有公司**
// （tenant-access 的 validateRoleCompany 對 user／company_admin 強制要求），
// 所以這條慣例不會把客戶放進來；會落在這裡的是平台管理員與遷移前的舊帳號。
// 在這裡自創另一套判法，症狀是內部同事的考試突然不見了。
//
// 另一半的內部特判（內部看得到全部場次）與 tenant-access 的「內部公司不特判、
// 一樣靠綁定」相反，那是刻意的：那裡問「看得到哪些客戶專案」，答案必須靠綁定才
// 不會變成後門；這裡問「看得到哪些考試場次」，而考試本來就是我們自己的東西。
function seesAllBanks(actor) {
  if (!actor) return false;
  if (actor.isPlatformAdmin === true || actor.isInternal === true) return true;
  return actor.companyId === null || actor.companyId === undefined;
}

// 這個人開的場次該掛在誰底下。null＝內部。
// 形狀比照 lib/agent-home.js 的 resolveHomeBucket：查不到人、沒有公司、內部公司
// 一律回 null，只有「真的是客戶公司」才回公司 id。
function bankOwnerForActor(actor) {
  if (!actor || seesAllBanks(actor)) return null;
  return actor.companyId ?? null;
}

// 同一件事，但只有 userId（上傳那條路沒有 req.actor——通行碼與本機上傳都不經
// verifyToken，見 exam-upload-routes.js 的 checkExamToken）。
async function bankOwnerForUser(userId, deps = {}) {
  if (userId === null || userId === undefined) return null;
  const q = deps.query || query;
  const { rows } = await q(
    'SELECT c.id, c.is_internal FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = $1',
    [userId]
  );
  if (!rows[0] || rows[0].is_internal === true) return null;
  return rows[0].id;
}

/**
 * 給 SELECT 用的範圍條件。回 { sql, params }，sql 是可直接接在 WHERE 後面的片段
 * （看得到全部時回 'TRUE'，呼叫端不必分支）。
 *
 * `column` 讓呼叫端指定欄位前綴（'b.company_id'），因為這些查詢多半有 JOIN。
 * 刻意不用 `IS NOT DISTINCT FROM`：pg-mem 不支援，而測試跑在 pg-mem 上。
 */
function bankScopeClause(actor, column = 'company_id', firstParamIndex = 1) {
  if (seesAllBanks(actor)) return { sql: 'TRUE', params: [] };
  const companyId = actor?.companyId ?? null;
  // 走到這裡代表有公司且不是內部（沒有公司的在 seesAllBanks 就回 true 了）。
  // 唯一的例外是完全沒有 actor——那道閘門的失敗方向只能是「看不到」。
  if (companyId === null) return { sql: 'FALSE', params: [] };
  return { sql: `${column} = $${firstParamIndex}`, params: [companyId] };
}

/**
 * 「這次上傳該落在誰的場次裡」的條件。**與 bankScopeClause 是不同的問題**，不要合併：
 * 那支問「看得到哪些場」（內部＝全部看得到），這支問「這次上傳屬於哪一場」
 * （內部＝只落在內部的場次，不可以落進某家客戶的場次）。
 *
 * owner 為 null（內部）時必須是 `IS NULL` 而不是 `= NULL`——後者在 SQL 裡永遠不成立，
 * 症狀是內部上傳每次都開一場新的考試，而畫面上只看得出「場次列表一直變長」。
 */
function bankOwnerClause(owner, column = 'company_id', firstParamIndex = 1) {
  if (owner === null || owner === undefined) return { sql: `${column} IS NULL`, params: [] };
  return { sql: `${column} = $${firstParamIndex}`, params: [owner] };
}

// 看得到這一場嗎。看不到時呼叫端一律回 **404 不是 403**——403 等於告訴對方
// 「這個 id 存在，只是你不能看」，那本身就是外洩（專案既有原則，見 tenant-access.js）。
async function canSeeBank(actor, bankId, deps = {}) {
  if (!actor) return false;
  const q = deps.query || query;
  const id = parseInt(bankId, 10);
  if (!Number.isInteger(id)) return false;
  const { rows } = await q('SELECT company_id FROM exam_banks WHERE id = $1', [id]);
  if (!rows[0]) return false;
  if (seesAllBanks(actor)) return true;
  const owner = rows[0].company_id ?? null;
  return owner !== null && Number(owner) === Number(actor.companyId);
}

/**
 * 題庫管理（瀏覽累積的題目、標歷史錯題、版本切換）限內部。
 *
 * 與 requireFeature 同樣回 404 而不是 403：客戶不需要知道有這個東西存在。
 * 放在 verifyToken 與 requireFeature 之後，所以 req.actor 一定在。
 */
function requireInternal(req, res, next) {
  if (!seesAllBanks(req.actor)) return res.status(404).json({ error: '找不到這個功能' });
  next();
}

module.exports = {
  seesAllBanks, bankOwnerForActor, bankOwnerForUser, bankScopeClause, bankOwnerClause,
  canSeeBank, requireInternal,
};
