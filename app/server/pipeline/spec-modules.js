const yaml = require('js-yaml');

// 規格的 module 欄位允許逗號分隔多個模組。拆模組、把檔案從 A 模組搬到 B 模組這類任務天生跨兩個
// 以上模組，而部署只會升級這裡列出的模組——漏掉任何一個，那個模組的 view 改動與 migration 都不會
// 執行，且升級本身照樣 exit 0（實測 task 195：規格只寫 idx_purchase，idx_project 的 pre-migrate
// 一次都沒被執行，砍掉的 217 行 view 也沒生效，錯誤訊息卻指向新模組的 xpath，完全看不出真因）。
function specModules(analysisYaml) {
  let raw = '';
  try { raw = (yaml.load(analysisYaml, { schema: yaml.CORE_SCHEMA }) || {}).module || ''; }
  catch { return []; }
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

// 主模組＝清單第一個。只有部署需要「全部升級」；其餘關卡問的都是「這張任務算哪個模組的」——
// tour 要跑哪個模組的測試、wiki 頁掛在哪個模組底下，答案都只能有一個。
// 這些地方直接吃整串會壞：tourTestClasses 用它組 regex 比對檔案路徑、library 的
// _collectModuleSource 用 /^[A-Za-z0-9_]+$/ 擋 path traversal，帶逗號一律比對不到。
function primaryModule(analysisYaml) {
  return specModules(analysisYaml)[0] || '';
}

module.exports = { specModules, primaryModule };
