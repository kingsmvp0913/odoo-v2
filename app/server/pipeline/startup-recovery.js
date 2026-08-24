/**
 * startup-recovery.js — 平台重啟後、開始派工前的測試環境清理
 *
 * 為什麼需要（2026-08-21 實測，非推論）：
 * deploy 的模組升級與 E2E 的 tour 都走 `docker exec` 起一次性 odoo 進程。平台被重啟時那支
 * docker CLI 會跟著死，但**容器內的 odoo 進程不會**——exec 不帶 TTY，CLI 只是 attach stdio，
 * 進程由 dockerd 管，父死子活（實測：砍掉父進程後 docker CLI 也沒了，容器內的 exec 進程照常存活）。
 * 而 _inFlight 是行程內記憶體，重啟後清空、DB 裡任務仍停在 deploy_testing → 下一個 cron tick
 * 重派 → 兩個 `odoo -u` 併行寫同一個 DB（實測確認會並行，不是理論可能）。
 *
 * 併行的後果不是「其中一個排隊等待」而是**兩個都死**（實測 exit=255）：
 *   psycopg2.errors.SerializationFailure: could not serialize access due to concurrent update
 * 一個死在 loading.py 的 `update ir_module_module set state='to upgrade'`，另一個死在
 * ir_module_module 的 latest_version UPDATE。DB 本身有回滾、狀態不會壞（實測升級後模組 state
 * 乾淨、沒卡在 to upgrade），壞的是**歸因**：這段錯誤文字餵進 classifyFailure 回 'unknown'，
 * 接著交 haiku 猜——判 env 是叫人來看一個不存在的環境問題，判 code 是退開發空轉一輪，
 * 而模組程式碼根本沒問題。兩條都是白燒一輪。
 *
 * 清理方式是重啟該專案的容器：docker restart 會殺光容器內所有 exec 進程（實測兩支殘留全清）。
 *
 * ⚠ 界線：一律走 restartEnv(projectId) → dockerCtxFor 解出的**單一具名容器**
 * （odoo-test-<專案目錄名>，見 docker-env.js 的 containerNameFor）。本模組不掃描、不列舉、
 * 不依名稱樣式批次操作容器——正式機是 Linux 且同機跑著其他服務，這條界線不能越。
 */
const { query } = require('../db');

// 只有這兩關會在容器內留下一次性 odoo 進程（deploy 的 upgradeModules、E2E 的 runTourTests）。
// 其餘關卡跑的是 claude 子進程，死在宿主上，容器裡沒有殘留可清。
const INTERRUPTED_STATUSES = ['deploy_testing', 'playwright_running'];

// 整體預算：restartEnv 內含 waitForPort（ENV_HEALTH_TIMEOUT_MS 預設 90s），逐專案序列做。
// 同時卡住的專案上限是 DEPLOY_MAX_CONCURRENT(3) + E2E_MAX_CONCURRENT(2)，最壞會把啟動拖住
// 7 分半——而這段期間平台還沒 listen，等於對所有人停擺。超出預算就停手：**跳過的專案只是
// 維持現況（殘留照舊），不會比不做這件事更糟**，但啟動不能被它拖垮。
const BUDGET_MS = parseInt(process.env.ENV_RECOVERY_BUDGET_MS || '180000', 10);

/**
 * 重啟「有任務被中斷在重 odoo-bin 關卡」的專案容器，清掉殘留的 exec 進程。
 *
 * 必須在 cron 開始派工之前呼叫（見 index.js 的接線位置）——晚一步就是已經重派了，清理沒有意義。
 * 回傳 { restarted, skipped, failed, overBudget } 供啟動 log；任何失敗都不得擋住啟動。
 *
 * deps 供測試注入（restartEnv／now）。
 */
async function clearInterruptedUpgrades(deps = {}) {
  const restartEnv = deps.restartEnv || require('./env-agent').restartEnv;
  const now = deps.now || (() => Date.now());
  const budgetMs = deps.budgetMs ?? BUDGET_MS;

  // is_paused／is_hidden 的任務 cron 不會重撿（見 runner.js 的派工查詢帶同樣條件），
  // 沒有併行競態，不必為它們重啟環境——那會白白打斷可能正在被人使用的測試區。
  const { rows } = await query(
    `SELECT project_id FROM tasks
      WHERE status IN ('deploy_testing','playwright_running')
        AND is_paused = false AND is_hidden = false AND project_id IS NOT NULL`
  );
  // 同專案多張任務只需重啟一次。去重在 JS 做而非 SELECT DISTINCT：pg-mem 對 DISTINCT 的
  // 支援不值得賭，而這裡的資料量是個位數。
  const projectIds = [...new Set(rows.map(r => r.project_id))];
  const stats = { restarted: 0, skipped: 0, failed: 0, overBudget: 0 };
  if (!projectIds.length) return stats;

  const startedAt = now();
  for (const projectId of projectIds) {
    if (now() - startedAt >= budgetMs) {
      stats.overBudget++;
      // 不得靜默截斷：跳過等於這個專案的殘留還在，下一輪 deploy 仍可能雙輸並被誤歸因。
      console.error(`[STARTUP] 專案 ${projectId} 的測試區未清理（啟動預算 ${budgetMs}ms 已用盡），殘留的升級進程可能造成本輪 deploy 失敗`);
      continue;
    }
    try {
      const r = await restartEnv(projectId);
      if (r && r.ok) {
        stats.restarted++;
        console.log(`[STARTUP] 專案 ${projectId} 的測試區已重啟，清掉中斷殘留的升級進程`);
      } else {
        // 容器沒在跑＝進程隨容器一起沒了，本來就無殘留可清，不是失敗。
        stats.skipped++;
      }
    } catch (e) {
      // 清理失敗不擋啟動：最壞退回現況（殘留照舊），而擋住啟動是全平台停擺。
      stats.failed++;
      console.error(`[STARTUP] 專案 ${projectId} 的測試區重啟失敗（殘留未清）：${e.message}`);
    }
  }
  return stats;
}

/**
 * 建立到一半被平台重啟打斷的測試環境：收乾淨並讓狀態回到可再建立的 idle。
 *
 * 舊版是一句 `UPDATE ... SET status='error'`，有兩個問題：
 *
 * 1. error 在 /env/sso 是**死路**——那裡刻意不對 error 自動重試（怕「本來就建不起來」的環境
 *    每次輪詢都重跑一整輪 build/pip/init），直接回 409 要使用者自己回專案頁重按。但「環境有
 *    毛病建不起來」與「平台自己把它打斷了」是兩回事，後者重跑多半就成功，不該判同一種死刑。
 * 2. 它**只改 status**，不像 _failEnv 會一併 removeContainer + port=NULL。於是容器還綁著宿主
 *    的埠，而閒置掃描看到「error 又佔著埠」會把租約收回池子（env-agent 的 sweepIdleEnvs 尾段）
 *    → 下一個借到同一個埠的專案 docker run 當場撞埠，而且是**別的專案**莫名其妙建不起來。
 *    _failEnv 的註解正是在講這個坑，這條路徑卻沒套用。
 *
 * 改走既有的 stopEnv（單一真相來源）：停並移除容器、狀態回 idle、port/external_slot 一併歸還、
 * 同步 nginx map。不另外拼一套欄位清理，避免與 stopEnv 漂移。
 *
 * 為什麼不需要額外的重試護欄（原設計者的顧慮仍成立，但已由既有機制接住）：
 *   - idle 不會造成「啟動時批次重建」，而是等真人點測試區或 pipeline 需要時才按需建立；
 *   - 前端輪詢也不會反覆觸發：一旦開始建，狀態即為 setting_up，/env/sso 那條分支就不再觸發；
 *   - 真的建不起來的環境會在那一輪由 _failEnv 標回 error，之後照舊被 409 擋住。
 *     也就是最多多跑一輪，不是無限重試。
 *
 * stopEnv 失敗（多半是 docker 不通）時**退回舊行為標 error**：此時容器去留未知，若照樣標 idle
 * 並歸還埠，就是親手製造上面第 2 點那個撞埠情境。docker 不通時本來也建不了環境，交人工是對的。
 */
async function releaseInterruptedSetups(deps = {}) {
  const stopEnv = deps.stopEnv || require('./env-agent').stopEnv;
  const { rows } = await query("SELECT project_id FROM odoo_envs WHERE status='setting_up'");
  const stats = { released: 0, failed: 0 };
  for (const { project_id: projectId } of rows) {
    try {
      await stopEnv(projectId);
      stats.released++;
      console.log(`[STARTUP] 專案 ${projectId} 的測試區建立被重啟打斷，已收回資源並回到可重建狀態`);
    } catch (e) {
      // 絕不能讓它留在 setting_up：那是「建立中」的畫面，沒有任何路徑會再推進它，使用者永遠轉圈。
      stats.failed++;
      console.error(`[STARTUP] 專案 ${projectId} 的中斷環境收拾失敗，退回標記 error 交人工：${e.message}`);
      await query(
        "UPDATE odoo_envs SET status='error', error_msg=$2, updated_at=NOW() WHERE project_id=$1",
        [projectId, `伺服器重啟中斷建立程序，且清理失敗（${e.message}）——請在專案環境頁重新建立`]
      ).catch(() => { /* 連這都寫不進去只能靠上面的 log，不得讓啟動流程掛掉 */ });
    }
  }
  return stats;
}

/**
 * 被重啟打斷的 repo clone／更新。
 *
 * reclone 與新增 repo 都是「先把 clone_status 標成 cloning，再背景 triggerClone」。背景那段是
 * execFile／git 操作，隨進程一起死——平台重啟時沒有任何 catch 會執行，狀態就永久卡在 cloning。
 *
 * 而 cloning 不是無害的中間態：全平台撈 repo 一律 `WHERE clone_status='done'`（規則 81），所以
 * 卡住的 repo 等同從平台上消失——該專案的測試環境會被建成「沒有任何客製模組」的空殼（容器照起、
 * 健康檢查照過、狀態照標 running），pipeline 也撈不到 repo。2026-08-24 萊峰19 的第一次事故就是
 * 這個形狀：客戶開銷售訂單直接 JS 崩潰，而平台顯示一切正常，事後也查不出它是何時壞的。
 *
 * 標成 error 而不是自動重跑 clone：clone 可能很久、也可能需要 PAT（reclone 端點會擋沒 PAT 的人），
 * 啟動時批次拉是拿不到發起人憑證的。error 至少會在專案頁紅字現形，一鍵重新 clone 即可。
 */
async function failInterruptedClones() {
  const { rows } = await query(
    `UPDATE project_repos SET clone_status='error',
       clone_error='clone／更新被平台重啟中斷，請重新 clone（此期間該專案無法建立測試環境）',
       clone_status_at=NOW()
     WHERE clone_status='cloning' RETURNING id, label, project_id`
  );
  for (const r of rows) {
    console.warn(`[STARTUP] repo ${r.id}（${r.label}，專案 ${r.project_id}）的 clone 被重啟打斷，已標記 error 待人工重新 clone`);
  }
  return { failed: rows.length };
}

module.exports = { clearInterruptedUpgrades, releaseInterruptedSetups, failInterruptedClones, INTERRUPTED_STATUSES };
