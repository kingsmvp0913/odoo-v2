// 全站唯一的任務狀態 registry：狀態是什麼（中文標籤、由誰推進、哪支 agent 在跑）。
// 三支 view（TaskList／TaskDetail／AdminPipelines）原本各存一份標籤，已實際漂移：同一狀態在列表顯示
// 「等待回覆確認」、在詳情顯示「等待確認回覆」，且 respec_running 只有詳情頁有——列表遇到它直接顯示
// 英文 status。症狀是新增一關後某些畫面漏標，人工比對三份才看得出來。
//
// actor＝誰負責推進這個狀態，是「把狀態分類」的唯一依據：
//   human    等人動作（閘門／失敗待確認）      → HUMAN_STATUSES
//   agent    AI 在跑，附 agent 欄記哪一支      → RUNNABLE_STATUSES
//   system   系統自動推進，無 AI               → RUNNABLE_STATUSES
//   terminal 終態，不屬於任何名單
// 原本 TaskList 的 NEEDS_ACTION、notify 的 ACTION_STATUSES、runner 的 RUNNABLE_STATUSES 三份手寫名單
// 都可由 actor 完整推導（8＋16＋1＝25，零例外），改為推導後「新增一關漏補某一份」在結構上不可能發生。
//
// ⚠ 狀態屬性不得下放到 pipeline-spec.js：pipelineNodes(flags) 是函式，專案關掉 E2E 時 e2e 節點整個不
// push，屬性寫在節點裡會讓 playwright_running 的定義隨設定消失——但 DB 裡跑到一半的舊任務仍停在該狀態，
// 列表查不到標籤就掉回英文代號。狀態屬性是靜態的（qa_running 永遠是 AI 在跑），流程拓樸才是動態的。
//
// 後端 runner.js 的 STAGE_LABELS 不併進來：那是「執行歷程」的階段標記，文案刻意不同（客服處理中／
// 已回覆澄清），併了會改動歷程文字。兩者的 key 涵蓋關係由 frontend-status-labels.test.js 守住。
const TASK_STATUSES = {
  new:                  { label: '待分類',              actor: 'system' },
  analysis_running:     { label: '分析中',              actor: 'agent',  agent: 'analysis-project' },
  branch_pending:       { label: '建立分支',            actor: 'system' },
  confirm_pending:      { label: '等待確認',            actor: 'human' },
  confirm_answered:     { label: '已回覆',              actor: 'system' },
  coding_running:       { label: '開發中',              actor: 'agent',  agent: 'coding-project' },
  qa_running:           { label: 'QA 審查中',           actor: 'agent',  agent: 'qa' },
  respec_running:       { label: '追加需求更新規格中',  actor: 'agent',  agent: 'respec-patch' },
  merge_running:        { label: '併入測試中',          actor: 'system' },
  merge_conflict:       { label: '合併衝突',            actor: 'human' },
  deploy_testing:       { label: '部署測試區',          actor: 'system' },
  // 純程式關：E2E 不再有 agent。tour 一律在分析後由 spec_tour 依 acceptance 產出，本關只負責
  // 「併分支 → odoo-bin --test-enable → 判題數與 exit code」，行為確定、無模型參與。
  // actor 由 agent 改 system 後仍在 RUNNABLE_STATUSES 內（byActor('system','agent') 兩者都收），
  // 派工不受影響——這是改這欄之前必須先確認的事，弄錯會讓任務永久凍在此狀態。
  // status 代號刻意不改名：它散在 DB、resume_status 與歷史任務裡，改名風險遠大於名字不精確。
  playwright_running:   { label: 'E2E 測試中',          actor: 'system' },
  spec_review:          { label: '等待規格確認',        actor: 'human' },
  review_pending:       { label: '等待審核',            actor: 'human' },
  reject_triage:        { label: '分診中',              actor: 'agent',  agent: 'analysis-reject' },
  resolve_triage:       { label: '分診中',              actor: 'agent',  agent: 'analysis-reject' },
  clarify_pending:      { label: '待你裁決',            actor: 'human' },
  clarify_answered:     { label: '已裁決',              actor: 'system' },
  clarify_chat_running: { label: 'AI 回覆中',           actor: 'agent',  agent: 'clarify-chat' },
  wiki_updating:        { label: '更新 Wiki',           actor: 'agent',  agent: 'library' },
  cs_running:           { label: '客服處理',            actor: 'agent',  agent: 'cs' },
  cs_reply_pending:     { label: '等待確認回覆',        actor: 'human' },
  cs_data_needed:       { label: '需補資料',            actor: 'human' },
  done:                 { label: '完成',                actor: 'terminal' },
  stopped:              { label: '失敗待確認',          actor: 'human' }
};

// 相容層：既有取用點（三支 view、socket.js、測試）全部沿用 STATUS_LABELS，不必跟著改。
const STATUS_LABELS = Object.fromEntries(
  Object.entries(TASK_STATUSES).map(([k, v]) => [k, v.label])
);

const byActor = (...a) => Object.keys(TASK_STATUSES).filter(s => a.includes(TASK_STATUSES[s].actor));
const HUMAN_STATUSES = byActor('human');              // 等人動作：通知與「輪到你」篩選
const RUNNABLE_STATUSES = byActor('system', 'agent'); // 派工可推進：cron tick 撈這些

if (typeof window !== 'undefined') {
  window.TASK_STATUSES = TASK_STATUSES;
  window.STATUS_LABELS = STATUS_LABELS;
  window.HUMAN_STATUSES = HUMAN_STATUSES;
  window.RUNNABLE_STATUSES = RUNNABLE_STATUSES;
}
if (typeof module !== 'undefined') module.exports = { TASK_STATUSES, STATUS_LABELS, HUMAN_STATUSES, RUNNABLE_STATUSES };
