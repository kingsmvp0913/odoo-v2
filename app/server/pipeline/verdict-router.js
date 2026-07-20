/**
 * verdict-router.js — 下游 verdict 的路由接縫（規格 §3.4）。
 * enterClarifyGate（停下批次問人）：QA 判規格歧義、分診員判退回原因含糊都複用同一接縫；日後 E2E／活 session 亦同。
 */
const { query } = require('../db');
const notify = require('../notify');

// 進「待你裁決」gate：批次寫入所有疑點供使用者一次回答；答完後由 runner.handleClarifyAnswered
// 依 resumeStatus 帶回饋導回原關（QA→coding、分診→reject_triage/resolve_triage）。不加該關計數（非自動失敗輪）。
// resumeStatus/fromStatus 泛化呼叫端（預設＝QA 原值，QA 端零變更）；
// carryFeedback 讓分診端傳原始退回原因保留在 retry_feedback（否則空 codeFeedback 會清成 null、洗掉原因）。
async function enterClarifyGate(taskId, userId,
  { questions, codeFeedback = null, carryFeedback = null, resumeStatus = 'coding_running', fromStatus = 'qa_running' } = {}) {
  const qList = (questions || []).map(q => String(q).trim()).filter(Boolean);
  await query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
    [taskId, `[需要你裁決]\n${qList.join('\n')}`]
  );
  const feedback = carryFeedback != null ? carryFeedback : (codeFeedback ? `[QA 未通過]\n${codeFeedback}` : null);
  await query(
    "UPDATE tasks SET status='clarify_pending', resume_status=$3, retry_feedback=$2, updated_at=NOW() WHERE id=$1 AND status=$4",
    [taskId, feedback, resumeStatus, fromStatus]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'clarify_pending' });
}

module.exports = { enterClarifyGate };
