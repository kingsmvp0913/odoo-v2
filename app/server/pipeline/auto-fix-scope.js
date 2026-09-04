/**
 * auto-fix-scope.js — 葉節點模組，只 export 兩個判準常數，不 require 任何東西。
 *
 * 「一條健檢提案算不算在自動修正範圍內」這個判準被兩處各自需要：
 *   - nightly-fix.js 的 fetchHealthCandidates（撈候選時再篩一次，layer 要等 triage 跑完才知道
 *     意見回饋的值，健檢提案在撈的當下就已知，可以先篩）
 *   - health-check-runner.js 的 insertFinding（提案剛落地時就要決定 status 是 approved 還是
 *     pending——不符自動修範圍的不該預設 approved，否則畫面顯示「已核准（將自動執行）」但
 *     夜間批次永遠不會碰它，狀態說謊）
 *
 * 抽成獨立葉節點而不是任一邊 require 另一邊：nightly-fix.js 與 health-check-runner.js 之間
 * 已經因為 MACHINE_RETIRE_PREFIX 撞過一次循環依賴（見 retire-prefix.js 的檔頭說明），
 * 兩邊都不准再互相 require。
 */

// 可自動修的 layer。
const AUTO_LAYERS = new Set(['code', 'prompt', 'observability']);
// 健檢候選嚴重度門檻（low／ok 不自動跑，留給人決定）。
const HEALTH_SEVERITIES = new Set(['medium', 'high', 'error']);

// ⚠ health-auditor.md 的 layer 詞彙表是 prompt／platform／env／observability（見該檔 §layer），
// 與這裡的 AUTO_LAYERS（code／prompt／observability）不是同一套命名——'platform' 與 'code'
// 指的是同一件事（平台程式碼本身的問題），只是兩處各自取了不同的字。發現方式：runAudit 產出
// layer='platform' 的 proposal，若不做這層映射，會落 status='approved' 卻被 fetchHealthCandidates
// 的 AUTO_LAYERS.has('platform') 篩掉——「已核准（將自動執行）」但永遠不會被夜間批次撈到，
// 是 2-I2 描述的同一類「狀態說謊」，只是換一個詞彙不對齊的管道發生。這裡做別名映射而不是把
// 'platform' 直接塞進 AUTO_LAYERS：AUTO_LAYERS 的字面值同時被 nightly-fix.js 的候選撈取與
// merge 結果重新套用兩處使用，保留原詞彙表、只在判斷函式內部做映射，改動面最小。
const LAYER_ALIASES = { platform: 'code' };

// 把 health-auditor 詞彙的 layer 正規化成 AUTO_LAYERS 認得的字面值（無對應別名就原樣傳回，
// 讓呼叫端自己判斷在不在範圍內）。
function normalizeLayer(layer) {
  return LAYER_ALIASES[layer] || layer;
}

function inAutoFixScope(layer, severity) {
  return AUTO_LAYERS.has(normalizeLayer(layer)) && HEALTH_SEVERITIES.has(severity);
}

module.exports = { AUTO_LAYERS, HEALTH_SEVERITIES, inAutoFixScope, normalizeLayer };
