/**
 * reentry.js — 任務「退回 coding」總循環次數（健檢 U8 / reentry_count 死欄位接線）
 *
 * 每次任務從下游關卡（QA／部署／E2E 失敗）退回 coding_running 前呼叫：
 *   - 累加 reentry_count（供前端顯示真實循環次數；任務 52 實際 6 次卻顯示 0）
 *   - 達上限（MAX_REENTRY）時直接標 stopped，作為 per-stage 重試上限（各 3）之外的總循環兜底
 *
 * bumpReentryOrStop(taskId, userId) → Promise<boolean>
 *   回傳 true 表示已達上限並已標 stopped（呼叫端不要再設 coding_running）。
 */
const { query } = require('../db');
const notify = require('../notify');

const MAX_REENTRY = parseInt(process.env.PIPELINE_MAX_REENTRY || '10', 10);

async function bumpReentryOrStop(taskId, userId) {
  const { rows: [t] } = await query(
    'UPDATE tasks SET reentry_count = COALESCE(reentry_count, 0) + 1 WHERE id = $1 RETURNING reentry_count',
    [taskId]
  );
  const n = t?.reentry_count || 0;
  if (n >= MAX_REENTRY) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, `任務在各關卡間循環 ${n} 次仍未通過，需人工介入`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }
  return false;
}

module.exports = { bumpReentryOrStop, MAX_REENTRY };
