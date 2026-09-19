/**
 * stale-running.js — 卡在 *_running 太久的任務兜底回收（沒有人在看的那道網）
 *
 * 使用者回報（2026-09-17）：兩張任務停在執行中的狀態各 30 天與 42 天，畫面一直顯示「執行中」，
 * 不重試、不報錯、不通知，等同靜默消失。
 *
 * ⚠ 這不是「啟動恢復漏掉 *_running」——原始判斷在這點上不成立，照做會更糟：
 * RUNNABLE_STATUSES 是由 status registry 的 actor 推導的（`public/js/status-labels.js`），
 * 每一個 *_running 的 actor 都是 agent／system，所以它們**本來就在 cron 每分鐘的派工範圍內**。
 * 平台重啟會清空 _inFlight（行程內記憶體），下一個 tick 就把停在 *_running 的任務重派回同一關
 * ——startup-recovery.js 檔頭的「cron 待會就會重派」、claude-runner.js 的「CLI 掛死…只能重啟
 * server」講的都是這件事。若在啟動恢復裡把 *_running 標成失敗，等於每晚夜間批次重啟時，把當時
 * 正常在跑、重啟後本來會自己續跑的任務全部殺掉；而「回推成可派工狀態」則是 no-op（它們已經是）。
 *
 * 真正缺的是「超時沒有人在看」：任務一旦因為任何理由離開派工範圍（卡在進不去的佇列、使用者所屬
 * 的列不再被掃到），或每輪派工都跑不出進展，狀態就永遠停在執行中，而平台沒有任何一處會發現。
 * 這支就是那個看門的：超過門檻仍停在 *_running 的標成 stopped（失敗待確認）並通知，讓它出現在
 * 「輪到你」。**resume_status 不動**，使用者按「解決阻塞」即可從同一關續跑。
 *
 * 界線（第一版被駁回的理由正是踩了第一條）：
 *   - 掃描範圍只取 *_running，不是整份 RUNNABLE_STATUSES（那裡面還有 new／branch_pending／
 *     deploy_testing 等「等著被派」的狀態，混進來就是把排隊當殘留）。
 *   - 門檻預設 72 小時，遠大於 MAX_PER_USER／deploy-E2E 併發上限／merge 尾巴獨佔造成的正常排隊
 *     （派工是 updated_at ASC，等最久的先派，所以排隊是會前進的，不會累積到數天）。不可以設成
 *     「6 小時」那種會把健康任務當殘留的值。
 *   - 維護中與用量閘門 blocked 時整支跳過：那兩種情況下**全平台**都不派工，任務停著是正常的，
 *     這時掃描等於把所有在途任務一次標成失敗。
 *   - 真的在飛（_inFlight）的不動：那是活著的 agent，改它的狀態是跟它自己搶寫。掛死的 agent 由
 *     claude-runner 的逾時砍（健檢 U9），不在本支的職責內。
 */
const { query } = require('../db');
const notify = require('../notify');
const { RUNNABLE_STATUSES, STATUS_LABELS } = require('../../public/js/status-labels.js');

// 名字以 _running 結尾的可派工狀態。從 registry 推導而非手寫一份清單：新增一關時不必回頭補這裡，
// 也不會出現「清單抄本沒跟上」的失效防線。
const STALE_STATUSES = RUNNABLE_STATUSES.filter(s => s.endsWith('_running'));

// 0＝停用（本支只是兜底，關掉不影響任何正常流程）
const STALE_RUNNING_HOURS = parseInt(process.env.STALE_RUNNING_HOURS || '72', 10);

/**
 * 把停在 *_running 超過門檻的任務標成 stopped 並通知。
 * 回傳 { reclaimed, skipped? }；skipped 是整支跳過的理由（停用／維護中／用量閘門）。
 * deps.hours 供測試注入門檻。
 */
async function reclaimStaleRunningTasks(deps = {}) {
  const hours = deps.hours ?? STALE_RUNNING_HOURS;
  if (!(hours > 0)) return { reclaimed: 0, skipped: 'disabled' };
  if (await require('./maintenance').isMaintenance()) return { reclaimed: 0, skipped: 'maintenance' };
  // 讀不到閘門狀態時當成沒擋（比照 usage-gate 自己的 fail-open）：寧可多回收一輪，
  // 也不要因為查不到就永久停用這道網。
  const gate = await require('./usage-gate').getGateState().catch(() => ({ blocked: false }));
  if (gate.blocked) return { reclaimed: 0, skipped: 'usage-gate' };

  const inflight = new Set(require('./runner').getInflightTaskIds());
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const { rows } = await query(
    `SELECT id, user_id, status, updated_at FROM tasks
      WHERE status = ANY($1::text[]) AND is_paused = false AND is_hidden = false AND updated_at < $2`,
    [STALE_STATUSES, cutoff]
  );
  let reclaimed = 0;
  for (const t of rows) {
    if (inflight.has(t.id)) continue;
    const days = Math.floor((Date.now() - new Date(t.updated_at).getTime()) / 86400000);
    const stage = STATUS_LABELS[t.status] || t.status;
    const reason = `任務停在「${stage}」已 ${days} 天沒有任何進展，平台已停止等待並交回給你處理`
      + '（按「解決阻塞」會從同一關重跑）。';
    // 條件更新：這一瞬間被派工／被暫停／被封存就不動它，留待下一輪重新判斷。
    const { rowCount } = await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW()
        WHERE id=$1 AND status=$3 AND is_paused=false AND is_hidden=false`,
      [t.id, reason, t.status]
    );
    if (!rowCount) continue;
    // 比照 runner.js 轉 stopped 時的那一行，讓原因留在「執行歷程」裡（寫失敗不影響回收本身）
    await query('INSERT INTO task_events (task_id, content) VALUES ($1, $2)',
      [t.id, `\n\x1b[91m❌ 失敗：${reason}\x1b[0m\n`]).catch(() => {});
    // stopped 是 actor:'human' → notify 會一併寫收件匣、發 action 通知與離線 webhook
    notify.emitToUser(t.user_id, 'task:updated', { taskId: t.id, status: 'stopped' });
    console.warn(`[STALE] 任務 ${t.id} 停在 ${t.status} 已 ${days} 天，標記 stopped 交人工`);
    reclaimed++;
  }
  return { reclaimed };
}

module.exports = { reclaimStaleRunningTasks, STALE_RUNNING_HOURS, STALE_STATUSES };
