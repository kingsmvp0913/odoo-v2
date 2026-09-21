/**
 * company-features.js — 「哪家公司能用哪些功能」的唯一真相。
 *
 * 為什麼需要它：考試系統是給內部一般使用者考的，不能用角色鎖（鎖了他們就不能考）；
 * 但客戶公司也不該看得到內部題庫。所以改用公司層級的功能開關。
 */
const { query } = require('../db');

// 可被開關的功能。加新功能只要在這裡加一筆，不必動 DB schema。
// defaultForCustomer 目前一律 false：新客戶預設什麼加值功能都沒開，要平台管理員明確開。
const FEATURES = {
  exam: { key: 'exam', label: '考試系統', defaultForCustomer: false },
};

// 只留認得的 key、值強制成布林。寫進 DB 之前一定要過這一關——
// JSONB 沒有型別保護，不過濾的話前端傳什麼就存什麼，下次讀出來判斷會歪掉。
function normalizeFeatures(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const key of Object.keys(FEATURES)) {
    if (key in input) out[key] = Boolean(input[key]);
  }
  return out;
}

// 「這家公司能不能用這個功能」。
// 沒有公司 ⇒ true：平台管理員沒有公司，寫反會把管理員鎖在自己的平台外面。
// 查不到公司 ⇒ true：不認識的人不歸這支管，交給上游的授權擋（與 isUserCompanyUsable 同一條原則）。
// 不認得的功能名稱 ⇒ false：打錯字不該變成全開。
async function companyHasFeature(companyId, key) {
  if (!FEATURES[key]) return false;
  if (companyId === null || companyId === undefined || companyId === '') return true;
  const { rows } = await query('SELECT is_internal, features FROM companies WHERE id = $1', [companyId]);
  if (!rows[0]) return true;
  // 內部公司一律全開。這不是「對內部公司開後門」那種被禁止的捷徑——
  // 那條禁令講的是「看得到哪些專案」，那裡內部公司必須跟別家一樣靠綁定拿權限。
  // 功能開關問的是另一件事：「這是不是我們自己」。答案是的時候，全部功能本來就都是我們的。
  // 這樣寫還有一個實際好處：以後加第 N 個功能，不必回頭補內部公司那一列資料，
  // 忘了補就會把自己的同事鎖在外面——而那種錯誤沒有任何徵狀，只會有人說「我的考試不見了」。
  if (rows[0].is_internal === true) return true;
  const f = rows[0].features;
  const parsed = typeof f === 'string' ? JSON.parse(f) : f;
  return normalizeFeatures(parsed)[key] === true;
}

// Express middleware，放在 verifyToken 之後。
// 沒有功能一律回 404 不回 403——403 等於告訴對方「這個功能存在，只是你不能用」。
// 沒有 req.actor 也回 404：能走到這裡代表 verifyToken 沒擋下來，但我們不把「沒有身分」
// 當成「沒有公司」放行，那會讓未登入路徑變成全開。
function requireFeature(key) {
  return async (req, res, next) => {
    try {
      if (!req.actor) return res.status(404).json({ error: '找不到這個功能' });
      if (!(await companyHasFeature(req.actor.companyId, key))) {
        return res.status(404).json({ error: '找不到這個功能' });
      }
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

module.exports = { FEATURES, normalizeFeatures, companyHasFeature, requireFeature };
