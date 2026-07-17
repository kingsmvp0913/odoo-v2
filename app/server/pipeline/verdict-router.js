/**
 * verdict-router.js — 下游 verdict 的路由接縫（規格 §3.4）。
 * 目前提供 enterClarifyGate（QA 判規格歧義時停下批次問人）；日後 E2E／活 session 複用同一接縫。
 */
const { query } = require('../db');
const notify = require('../notify');

// 進「待你裁決」gate：批次寫入所有規格疑點供使用者一次回答；同輪 code 問題暫存 retry_feedback，
// 答完後由 runner.handleClarifyAnswered 帶「裁決＋code 問題」一次退 coding。不加 qa_retry_count（非 code-fix 輪）。
async function enterClarifyGate(taskId, userId, { questions, codeFeedback } = {}) {
  const qList = (questions || []).map(q => String(q).trim()).filter(Boolean);
  await query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
    [taskId, `[需要你裁決]\n${qList.join('\n')}`]
  );
  await query(
    "UPDATE tasks SET status='clarify_pending', resume_status='coding_running', retry_feedback=$2, updated_at=NOW() WHERE id=$1 AND status='qa_running'",
    [taskId, codeFeedback ? `[QA 未通過]\n${codeFeedback}` : null]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: 'clarify_pending' });
}

module.exports = { enterClarifyGate };
