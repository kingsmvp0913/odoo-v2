/**
 * stations.js — 「回程狀態」欄位的合法值域。
 *
 * 平台有三個欄位記錄「這件事處理完要回去哪一站」，且都是**直接當 tasks.status 寫回**：
 *   - resume_status                  （clarify 閘門答完的回程；runner.js 用當下 status 無條件覆寫）
 *   - respec_return_status           （追加需求檢查點攔截推進前，原本要去的那一關）
 *   - merge_conflict_data.prior_status（merge 衝突裁決完要回去的關）
 *
 * 三者原本都沒有值域檢查。這在 runner.js 是靜默失敗——派工查表是 `if (!handler) return;`，
 * 認不得的 status 不會報錯、不會 log，任務就變成「撈得到卻永遠不被派工」的殭屍：
 * 畫面上顯示一個沒人看得懂的狀態，cron 每分鐘掃過去又跳過，沒有任何訊號。
 *
 * 因此一律經 safeReturnStatus() 收斂：認得的照走，認不得的落回安全預設，不讓非法值進狀態機。
 */

// 可以當「回程目標」的站。含 review_pending（等人的站，但 advance／respec 回程都合法指向它），
// 不含 done／stopped（終點，回程沒有意義）與 clarify_* ／*_triage（回到那裡會形成自我循環）。
const RETURNABLE_STATUSES = new Set([
  'analysis_running',
  'branch_pending',
  'coding_running',
  'qa_running',
  'merge_running',
  'push_ai_running',
  'deploy_testing',
  'playwright_running',
  'wiki_updating',
  'review_pending',
]);

// 收斂一個回程狀態值。fallback 由呼叫端依情境給（多數是 coding_running：退回開發永遠是安全的，
// 頂多多跑一輪；相對地誤放到 review_pending 會讓沒驗過的東西直接送審）。
function safeReturnStatus(value, fallback = 'coding_running') {
  const v = String(value ?? '').trim();
  return RETURNABLE_STATUSES.has(v) ? v : fallback;
}

module.exports = { RETURNABLE_STATUSES, safeReturnStatus };
