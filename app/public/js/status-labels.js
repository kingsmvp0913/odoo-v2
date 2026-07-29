// 全站唯一的任務狀態中文標籤來源。三支 view（TaskList／TaskDetail／AdminPipelines）原本各存一份，
// 已實際漂移：同一狀態在列表顯示「等待回覆確認」、在詳情顯示「等待確認回覆」，且 respec_running
// 只有詳情頁有——列表遇到它直接顯示英文 status。症狀是新增一關後某些畫面漏標，人工比對三份才看得出來。
// 後端 runner.js 的 STAGE_LABELS 不併進來：那是「執行歷程」的階段標記，文案刻意不同（客服處理中／
// 已回覆澄清），併了會改動歷程文字。兩者的 key 涵蓋關係由 frontend-status-labels.test.js 守住。
const STATUS_LABELS = {
  new:                '待分類',
  analysis_running:   '分析中',
  branch_pending:     '建立分支',
  confirm_pending:    '等待確認',
  confirm_answered:   '已回覆',
  coding_running:     '開發中',
  qa_running:         'QA 審查中',
  respec_running:     '追加需求更新規格中',
  merge_running:      '併入測試中',
  merge_conflict:     '合併衝突',
  deploy_testing:     '部署測試區',
  playwright_running: 'E2E 測試中',
  spec_review:        '等待規格確認',
  review_pending:     '等待審核',
  reject_triage:      '分診中',
  resolve_triage:     '分診中',
  clarify_pending:    '待你裁決',
  clarify_answered:   '已裁決',
  clarify_chat_running: 'AI 回覆中',
  wiki_updating:      '更新 Wiki',
  cs_running:         '客服處理',
  cs_reply_pending:   '等待確認回覆',
  cs_data_needed:     '需補資料',
  done:               '完成',
  stopped:            '失敗待確認'
};

if (typeof window !== 'undefined') window.STATUS_LABELS = STATUS_LABELS;
if (typeof module !== 'undefined') module.exports = { STATUS_LABELS };
