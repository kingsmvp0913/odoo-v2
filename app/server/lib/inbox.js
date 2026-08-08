/**
 * inbox.js — 收件匣事件寫入的單一來源
 *
 * 為什麼在 lib 而不是 inbox-routes.js：`reentry.js`（pipeline）也要寫收件匣，而 pipeline 程式碼
 * 不得 require route 檔——route 會拖進 `auth`，連帶要求 `JWT_SECRET` 才能載入。
 *
 * addInboxEvent(userId, taskId, kind, opts?) → Promise<void>
 *   kind：'action'＝任務停在需人處理的閘門／'bounce'＝被退回重做
 *   opts：{ status, summary }
 *
 * resolveInboxActions(userId) → Promise<void>
 *   把已經過期的 'action' 事件標成已讀（見下方註解）。
 *
 * ⚠ addInboxEvent 會如實拋錯，**呼叫端一律要 .catch(() => {})**。收件匣寫入掛住或拋出會連累主流程：
 * `_dispatchAction` 走在 cron tick 的通知路徑上（規則 65：tick 內通知類副作用一律 fire-and-forget），
 * `bumpReentryOrStop` 則是任務退回的必經之路，失敗不該讓退回本身壞掉。
 * 不在這裡吞掉是為了讓測試驗得到失敗，也讓呼叫端的 fire-and-forget 是「看得見的刻意決定」。
 */
const { query } = require('../db');
const { HUMAN_STATUSES } = require('../../public/js/status-labels.js');

async function addInboxEvent(userId, taskId, kind, { status = null, summary = null } = {}) {
  if (!userId || !taskId || !kind) return;
  await query(
    'INSERT INTO user_inbox (user_id, task_id, kind, status, summary) VALUES ($1, $2, $3, $4, $5)',
    [userId, taskId, kind, status, summary]
  );
}

// 'action' 是「現在輪到你動手」的召喚，任務一離開等人的狀態就過期了。但使用者常常直接在任務列表
// 把 review_pending 審掉（正常工作流，不經收件匣），沒有任何東西會回頭清那筆事件 → 它永遠未讀，
// 未讀數只增不減。'bounce' 不在此列：那是「發生過什麼」的資訊性事件，不因狀態改變而失效。
//
// 依 user 整批掃、而不是在每個狀態轉移點逐筆呼叫：轉移點散在 pipeline 各關與多支 route，逐點補
// 呼叫就是再開一份手寫名單，漏補哪一處都不會報錯（規則 3b78a7f 的教訓）。呼叫端只要在「要用到
// 未讀數之前」掃一次即可，代價是一句 UPDATE。
async function resolveInboxActions(userId) {
  if (!userId) return;
  const ph = HUMAN_STATUSES.map((_, i) => `$${i + 2}`).join(',');
  await query(
    `UPDATE user_inbox SET read_at = NOW()
      WHERE user_id = $1 AND kind = 'action' AND read_at IS NULL
        AND task_id IN (SELECT id FROM tasks WHERE status NOT IN (${ph}))`,
    [userId, ...HUMAN_STATUSES]
  );
}

module.exports = { addInboxEvent, resolveInboxActions };
