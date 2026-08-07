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
 * ⚠ 本函式會如實拋錯，**呼叫端一律要 .catch(() => {})**。收件匣寫入掛住或拋出會連累主流程：
 * `_dispatchAction` 走在 cron tick 的通知路徑上（規則 65：tick 內通知類副作用一律 fire-and-forget），
 * `bumpReentryOrStop` 則是任務退回的必經之路，失敗不該讓退回本身壞掉。
 * 不在這裡吞掉是為了讓測試驗得到失敗，也讓呼叫端的 fire-and-forget 是「看得見的刻意決定」。
 */
const { query } = require('../db');

async function addInboxEvent(userId, taskId, kind, { status = null, summary = null } = {}) {
  if (!userId || !taskId || !kind) return;
  await query(
    'INSERT INTO user_inbox (user_id, task_id, kind, status, summary) VALUES ($1, $2, $3, $4, $5)',
    [userId, taskId, kind, status, summary]
  );
}

module.exports = { addInboxEvent };
