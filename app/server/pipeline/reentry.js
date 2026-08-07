/**
 * reentry.js — 任務「退回 coding」總循環次數（健檢 U8 / reentry_count 死欄位接線）
 *
 * 每次任務從下游關卡（QA／部署／E2E 失敗）退回 coding_running 前呼叫：
 *   - 累加 reentry_count（供前端顯示真實循環次數；任務 52 實際 6 次卻顯示 0）
 *   - 達上限（MAX_REENTRY）時直接標 stopped，作為 per-stage 重試上限（各 3）之外的總循環兜底
 *
 * bumpReentryOrStop(taskId, userId, diag?) → Promise<boolean>
 *   回傳 true 表示已達上限並已標 stopped（呼叫端不要再設 coding_running）。
 *   diag?（{ blockerType, blockerContent }）：觸頂停下時保留本次真正的診斷（ParseError／log 路徑／
 *   env/code 歸因）。不帶則沿用通用循環訊息（健檢 F10：舊行為把最後一擊的診斷整包覆寫掉）。
 */
const { query } = require('../db');
const notify = require('../notify');
const { addInboxEvent } = require('../lib/inbox');

const MAX_REENTRY = parseInt(process.env.PIPELINE_MAX_REENTRY || '2', 10);

async function bumpReentryOrStop(taskId, userId, diag = {}) {
  const { rows: [t] } = await query(
    'UPDATE tasks SET reentry_count = COALESCE(reentry_count, 0) + 1 WHERE id = $1 RETURNING reentry_count',
    [taskId]
  );
  const n = t?.reentry_count || 0;
  if (n >= MAX_REENTRY) {
    const content = diag.blockerContent
      ? `任務在各關卡間循環 ${n} 次仍未通過，需人工介入。${diag.blockerContent}`
      : `任務在各關卡間循環 ${n} 次仍未通過，需人工介入`;
    // blocker_type：帶了就寫（保住 code/env 歸因），沒帶則不動既有值（COALESCE 保留）
    await query(
      "UPDATE tasks SET status='stopped', blocker_type=COALESCE($3, blocker_type), blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, content, diag.blockerType || null]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }
  // 只有「還會繼續跑」的那幾次退回才寫 bounce。觸頂那次刻意不寫：上面轉 stopped 時 emitToUser
  // 已觸發 _dispatchAction 落一筆 action，同一件事在收件匣出現兩次會讓「被退回幾次」的訊號失真。
  // fire-and-forget：退回本身不該因為收件匣寫不進去而壞掉。
  const why = (diag.blockerContent || '').trim();
  addInboxEvent(userId, taskId, 'bounce', {
    status: 'coding_running',
    summary: why ? `第 ${n} 次退回：${why.slice(0, 120)}` : `第 ${n} 次退回重做`
  }).catch(() => {});
  return false;
}

module.exports = { bumpReentryOrStop, MAX_REENTRY };
