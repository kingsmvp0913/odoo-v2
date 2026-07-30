/**
 * dispatch-lease.js — 「單一派工者」值班牌（跨行程互斥）
 *
 * 為什麼需要：`runner.js` 的 `_inFlight`／`_pipelineRunning` 是**行程內記憶體**，只能保證
 * 「同一個行程不會把同一任務派兩次」。一旦同時有兩個行程對同一個 DB 跑 cron（實際事故：
 * 重複啟動時綁不到埠的行程沒死，留下一個看不見卻照樣派工的 cron），兩邊各記各的，
 * 同一任務同一關就會被派兩次——兩支 claude 並行寫同一個 worktree、`reentry_count` 被記兩次
 * （MAX_REENTRY=2 在第一次真實彈跳就打滿）、`wiki_drift` 分類／自動封存／夜間關機／閒置回收
 * 這些 cron 副作用也全部重複。
 *
 * 成因本身已由 `index.js` 的綁埠守衛修掉；本檔是**第二道防線**：把「現在誰值班」放進 DB，
 * 讓「多開一個行程」在結構上不再等於「重複派工」（換機器、開機自動啟動、別人手動跑一次都涵蓋）。
 *
 * 刻意的設計取捨：
 *   - 只擋「自動推進」（cron tick／`continuePipelineIfAdvanced`）。**使用者手動按「繼續」不受限**
 *     （`runPipeline` 的 auto:false 路徑），所以就算值班牌因故卡住，人工仍推得動任務，
 *     不會整個平台凍住。
 *   - TTL 遠大於 cron 間隔（1 分鐘），漏跑一兩個 tick 不會把牌讓出去；持有者猝死後
 *     最多等一個 TTL 就有別人接手。
 *   - 時間戳由 JS 端算好當參數傳入，不在 SQL 內做 interval 運算（pg-mem 對 interval 支援不穩）。
 */
const os = require('os');
const crypto = require('crypto');
const { query } = require('./db');

// 本行程的身分：pid 會被回收，補一段隨機碼確保重啟後不會被誤認成同一個持有者
const HOLDER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
const LEASE_TTL_MS = parseInt(process.env.DISPATCH_LEASE_TTL_MS ?? '150000', 10);

// null＝本行程還沒問過（例如單元測試不跑 cron）→ 視為不限制，維持既有測試的 hermetic 性；
// true/false＝最近一次 tick 的結果。
let _isDispatcher = null;

// 取得或續約值班牌。回傳 true 表示本行程是目前的派工者。
async function acquireDispatchLease() {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
  // 條件更新即原子搶牌：自己續約，或別人的牌已過期才搶得到
  const { rowCount } = await query(
    'UPDATE dispatcher_lease SET holder=$1, expires_at=$2, updated_at=$3 WHERE id=1 AND (holder=$1 OR expires_at < $3)',
    [HOLDER, expiresAt, now]
  );
  if (rowCount) { _isDispatcher = true; return true; }
  // rowCount 0 有兩種可能：①牌在別人手上且沒過期（正常，本輪不派）②整張表沒有列
  // （migrate 的 seed 被刪掉）。後者若不補，就沒有人搶得到牌、平台從此不再自動推進，
  // 而且完全無聲——所以補一列「已過期的空牌」再重試一次。
  const { rows } = await query('SELECT 1 FROM dispatcher_lease WHERE id = 1');
  if (rows.length) { _isDispatcher = false; return false; }
  // ⚠ 裁決一律看 UPDATE 的 rowCount，不看 INSERT 的：pg-mem 對 `ON CONFLICT DO NOTHING`
  // 即使實際沒插入也回 rowCount 1（真 Postgres 回 0），拿它判斷會讓兩個行程都自認拿到牌。
  // 補的是「已過期的空牌」：expires_at 必須嚴格早於 now，否則下面重試的 `expires_at < now`
  // 不成立，補完仍然沒人搶得到。
  await query(
    "INSERT INTO dispatcher_lease (id, holder, expires_at, updated_at) VALUES (1, '', $1, $2) ON CONFLICT (id) DO NOTHING",
    [new Date(now.getTime() - 1000), now]
  );
  const retry = await query(
    'UPDATE dispatcher_lease SET holder=$1, expires_at=$2, updated_at=$3 WHERE id=1 AND (holder=$1 OR expires_at < $3)',
    [HOLDER, expiresAt, now]
  );
  _isDispatcher = retry.rowCount > 0;
  return _isDispatcher;
}

// 供 runPipeline 的自動推進路徑同步查詢（不另外打 DB；值由 cron tick 更新）
function isDispatcher() { return _isDispatcher; }

// 測試用：直接設定／清掉本行程的值班狀態
function __setDispatcherForTesting(v) { _isDispatcher = v; }

module.exports = { acquireDispatchLease, isDispatcher, HOLDER, LEASE_TTL_MS, __setDispatcherForTesting };
