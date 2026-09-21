const yaml = require('js-yaml');

// 規格宣告「這張任務不動任何 Odoo 模組」的保留字。必須是明確的字，不能用空字串：
// analysis.yaml 的骨架本來就長 `module: ""`，留空與「忘了填」在資料上完全一樣，而忘了填會讓部署
// 升級到錯的模組（漏升的 view 改動與 migration 都不執行、還 exit 0）。REQUIRED_FIELDS 因此仍擋空值，
// 只有寫出這個字才算數（2026-09-21 task 282：改的是 repo 根目錄的主機端備份腳本與 markdown，
// 全庫第一張不含任何 addon 的任務，分析關留空 → 卡在「分析結果缺少必要欄位：module」）。
const NO_MODULE = 'none';

function rawModule(analysisYaml) {
  try { return String((yaml.load(analysisYaml, { schema: yaml.CORE_SCHEMA }) || {}).module || ''); }
  catch { return ''; }
}

/** 規格是否明確宣告「不動任何模組」。解析失敗與留空都不算——那兩種是「不知道」，不是「沒有」。 */
function isNoModule(analysisYaml) {
  return rawModule(analysisYaml).trim().toLowerCase() === NO_MODULE;
}

// 規格的 module 欄位允許逗號分隔多個模組。拆模組、把檔案從 A 模組搬到 B 模組這類任務天生跨兩個
// 以上模組，而部署只會升級這裡列出的模組——漏掉任何一個，那個模組的 view 改動與 migration 都不會
// 執行，且升級本身照樣 exit 0（實測 task 195：規格只寫 idx_purchase，idx_project 的 pre-migrate
// 一次都沒被執行，砍掉的 217 行 view 也沒生效，錯誤訊息卻指向新模組的 xpath，完全看不出真因）。
//
// ⚠ 回空陣列有兩種來源，呼叫端要分得開：解析失敗／欄位留空（＝不知道，部署的既有降級行為是 -u all），
// 與明確宣告 NO_MODULE（＝真的沒有，部署要整個跳過）。要判後者請用 isNoModule，不要拿長度為 0 推斷。
function specModules(analysisYaml) {
  const raw = rawModule(analysisYaml);
  if (raw.trim().toLowerCase() === NO_MODULE) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// 主模組＝清單第一個。只有部署需要「全部升級」；其餘關卡問的都是「這張任務算哪個模組的」——
// tour 要跑哪個模組的測試、wiki 頁掛在哪個模組底下，答案都只能有一個。
// 這些地方直接吃整串會壞：tourTestClasses 用它組 regex 比對檔案路徑、library 的
// _collectModuleSource 用 /^[A-Za-z0-9_]+$/ 擋 path traversal，帶逗號一律比對不到。
function primaryModule(analysisYaml) {
  return specModules(analysisYaml)[0] || '';
}

module.exports = { specModules, primaryModule, isNoModule, NO_MODULE };
