const path = require('path');
const { execFile } = require('child_process');
const { query } = require('../db');
const { selfContainerName, measureTests } = require('./finding-fix');
const { isInWindow, nextWindow } = require('../lib/release-window');
const { enterMaintenance, leaveMaintenance, isMaintenance } = require('./maintenance');

/**
 * release.js — 「把已經合併的碼真的放上去」。
 *
 * 為什麼合併與重啟要分開（規格 §4.3 ＋ 09-15 R6）：合併只動 git，客戶無感；重啟會當場砍掉在飛的
 * AI agent、讓測試區 Odoo 的 cron 執行緒永久死掉（§3.2），客戶正在用的東西會斷。
 * 所以合併自動、重啟等平台管理員選的時段。
 *
 * ⚠ 重啟走 `docker restart`（交給 host 的 daemon）而不是自殺讓 policy 撿回來：容器內 kill node 會
 * 連 entrypoint 帶 postgres 一起收掉，能不能回來得看容器外的 restart policy——那是這裡看不見的設定。
 */

// 下指令前的緩衝：這道指令會把自己這個行程一起帶走，HTTP 回應與 log 得先送出去。
// 沿用 applyFix 舊有的旋鈕名（重啟本來就是同一件事搬過來的），免得既有部署的設定一夕失效。
const RESTART_DELAY_MS = parseInt(process.env.PLATFORM_RESTART_DELAY_MS || '1500', 10);

// 平台自己的主 clone。測試閘門要跑的就是這一份——不是任何工作區副本。
const REPO_ROOT = path.join(__dirname, '..', '..', '..');

/**
 * 重啟前對「合併之後的 master 本身」跑一次全套測試。
 *
 * 為什麼非跑不可：每條修正都是在自己的 worktree 上各自跑綠才合併的，**沒有人跑過「全部
 * 合起來」**。兩條各自綠的修正合起來紅是真實存在的形狀，而合併是自動的、一條接一條進來，
 * 這個組合在維護時段之前不存在於任何地方。不在這裡跑，它就直接上線且沒有人在看。
 *
 * 跑的是 REPO_ROOT 而不是 worktree：那份「全部合起來」的組合只存在於主 clone 的 master 上。
 *
 * 用 finding-fix 既有的 `measureTests`，不另外寫一套跑 jest 的碼——它用 execFile（無 shell、
 * 無管線）取 exit code，全綠才走 resolve 那條路回 `ok: true`；紅燈與跑不起來都走 reject。
 * 此 repo 已因為「exit code 經過管線」誤判三次（rules/always.md 第 12 條），不要重造。
 *
 * 回傳 `{ passed, tests, reason }`。判綠的條件是三個一起成立，任何一個判讀不出來都不算綠：
 *   - `ok === true`：jest 的 exit code 是 0；
 *   - `failed === 0`：`Tests:` 那行沒有紅的；
 *   - `suiteFailed === 0`：`Test Suites:` 那行沒有紅的。整支測試檔載不起來（改壞的 require、
 *     語法錯）時，裡面沒跑到的測試**不會**被算進 `Tests:` 的 failed，那一行只是少掉一批
 *     passed、完全沒有 "failed" 字樣——那是騙人的 pass，只在 `Test Suites:` 留痕。
 */
async function runReleaseTests() {
  const tests = await measureTests(REPO_ROOT);
  if (tests.ok === true && tests.failed === 0 && tests.suiteFailed === 0) {
    return { passed: true, tests, reason: null };
  }
  // 理由要讓半夜兩點被叫起來的人直接知道下一步查哪裡：光回一個 false 等於什麼都沒說。
  const what = [];
  if (tests.failed) what.push(`${tests.failed} 支測試紅`);
  if (tests.suiteFailed) what.push(`${tests.suiteFailed} 個測試檔整支載不起來`);
  if (tests.error) what.push(`測試沒跑完：${tests.error}`);
  if (!what.length) what.push('全跑結果判讀不出綠燈（總結行解析不到數字）');
  const reason = `重啟前全跑未通過：${what.join('、')}`
    + `${tests.summary ? `｜${tests.summary}` : ''}`
    + '。碼已在 master 但不重啟，平台仍跑舊碼；請在主 clone 的 app/ 下跑 npm run test:quiet 看是哪幾支。';
  return { passed: false, tests, reason };
}

/**
 * 待更版清單＝已經合併進 master、但新碼還沒真的跑起來的那些修正。
 *
 * 這份清單不是新發明的資料：`status='merged'` 本來就是「碼在 master、只差重啟」的意思
 * （舊版被在飛任務擋掉時就會停在這個狀態），拆開合併與重啟之後它變成常態而不是例外。
 */
async function pendingReleases() {
  const { rows } = await query(
    // finding_status／finding_applied_at 是**回滾要用的原值**（見 handleRestartFailure）：
    // 重啟指令失敗時要把這一批放回待更版，寫死 'approved'／NULL 會把別的路徑（人工裁決、
    // 上一次更版）留下的狀態一起覆蓋掉，所以在動手之前就先把原值抓在手上。
    `SELECT f.id, f.finding_id, f.branch, f.commit_sha, f.status, f.created_at,
            h.diagnosis, h.severity,
            h.status AS finding_status, h.applied_at AS finding_applied_at
       FROM finding_fixes f
       LEFT JOIN health_check_findings h ON h.id = f.finding_id
      WHERE f.status = 'merged'
      ORDER BY f.created_at ASC`);
  return rows;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 重啟後把「原本在跑的測試區」救回來（規格 §3.2）
 *
 * 測試區容器的 Odoo 連的是**平台容器裡那顆 postgres**，所以平台一重啟，所有測試區的 DB 連線
 * 同時瞬斷。HTTP 與 bus 會自癒（bus 睡 50 秒後接回來），**cron 執行緒不會**：例外從
 * `_bootstrap_inner` 逃出去，執行緒就沒了，要整個 Odoo 重開才回得來（2026-09-10 萊峰19 實測，
 * 06:18 死後 30 分鐘零排程）。客戶看到的是「測試區還開著但什麼都不動」——比整個關掉更難查。
 *
 * 以前重啟是稀有事件、有人在旁邊看；從現在起每週末 02:00 自動跑一次，沒有人在。
 *
 * ⚠ 清單為什麼一定要在重啟**之前**落 DB，不能重啟完再掃：
 *   - 行程活不過重啟，記憶體不是選項；
 *   - 重啟完才掃的話，「當時在跑、但已經被連帶收掉」與「本來就沒在跑」長得一模一樣，
 *     那一台就這樣靜靜地漏掉——而漏掉的症狀正好就是「什麼都不動」，沒有人會發現。
 * ──────────────────────────────────────────────────────────────────────────── */

// 逐台重開的整體預算。restartEnv 內含 waitForPort（ENV_HEALTH_TIMEOUT_MS 預設 90 秒）且序列做，
// 而這段跑在平台還沒 listen 之前——十台全部卡滿就是十五分鐘對所有人停擺。
// 超出預算就停手並把還沒救到的那幾台大聲記下來：那幾台只是維持現況（cron 仍是死的），
// 不會比不做這件事更糟，但啟動不能被它拖垮。比照 startup-recovery.js 的同一道取捨。
const ENV_REVIVE_BUDGET_MS = parseInt(process.env.ENV_REVIVE_BUDGET_MS || '180000', 10);

/**
 * 把「此刻正在跑的測試區」記進 DB，供重啟回來之後兌現。
 *
 * 存 teams_settings 的單列設定而不是新開一張表：這是更版機制自己的狀態，和
 * release_last_window／release_last_result 同一個層級、同一個生命週期（寫一次、用一次、清掉）。
 */
async function captureRunningEnvs() {
  // 排序只是為了讓「預算用盡時被跳過的是哪幾台」可預期（也讓測試盯得住），不影響語意。
  const { rows } = await query(
    "SELECT project_id FROM odoo_envs WHERE status='running' ORDER BY project_id");
  const ids = rows.map(r => r.project_id).filter(id => id !== null && id !== undefined);
  await query(
    `INSERT INTO teams_settings (id, release_envs_to_revive) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET release_envs_to_revive = $1`, [JSON.stringify(ids)]);
  return ids;
}

async function readEnvsToRevive() {
  try {
    const { rows } = await query('SELECT release_envs_to_revive FROM teams_settings WHERE id = 1');
    const raw = rows[0] && rows[0].release_envs_to_revive;
    if (!raw) return [];
    const ids = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(ids) ? ids.filter(id => Number.isInteger(id)) : [];
  } catch (err) {
    // 欄位還沒建、或內容壞掉：當成沒有清單。這裡 throw 會擋住整個平台啟動，代價遠大於少救幾台。
    console.error('[RELEASE] 讀不到待重開的測試區清單，本次不重開：', err.message);
    return [];
  }
}

async function clearEnvsToRevive() {
  await query(
    `INSERT INTO teams_settings (id, release_envs_to_revive) VALUES (1, NULL)
       ON CONFLICT (id) DO UPDATE SET release_envs_to_revive = NULL`);
}

/**
 * 把失敗留在人看得到的地方。這台沒有 webhook 也沒有 Teams（裁決二），畫面是唯一的通道，
 * 而 release_last_result 就是更版頁讀的那一筆——附掛上去，不另開一個沒有人會去看的欄位。
 * 寫失敗只記 log：這是通知，不是救援本身，不得反過來擋住啟動。
 */
async function recordEnvReviveResult(envRevive) {
  const prev = await lastReleaseResult();
  // 沒有上一筆（例如人工直接按重啟、沒走維護時段）也要留下時間，否則畫面上看不出這是哪一次的事。
  const record = { ...(prev || { at: new Date().toISOString() }), envRevive };
  await query(
    `INSERT INTO teams_settings (id, release_last_result) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET release_last_result = $1`, [JSON.stringify(record)]);
}

/**
 * 啟動時兌現那份清單：逐一重開，把測試區 Odoo 的 cron 執行緒救回來。
 *
 * 由 index.js 在 startCron() 之前呼叫（與其他開機收尾同一段，不另開啟動鉤子）。
 *
 * ⚠ 一台失敗不得影響其他台：這裡每一台各自 try/catch。整個迴圈一起 throw 的話，
 * 「一台有毛病」會變成「全部都沒救回來」，而且症狀一樣是安靜的。
 *
 * 清單在**全部處理完之後**才清：中途被再一次重啟打斷時，下次開機還救得到剩下的。
 * 期間被人工停掉的測試區不會被誤開——restartEnv 只重啟「容器還在跑」的環境（容器沒在跑時
 * 回 `{ ok:false, skipped:'not_running' }`），它不會把停掉的環境重新拉起來。
 *
 * deps 供測試注入（restartEnv／now）。
 */
async function reviveRunningEnvs(deps = {}) {
  const restartEnv = deps.restartEnv || require('./env-agent').restartEnv;
  const now = deps.now || (() => Date.now());
  const budgetMs = deps.budgetMs ?? ENV_REVIVE_BUDGET_MS;

  const ids = await readEnvsToRevive();
  const stats = { total: ids.length, revived: 0, skipped: 0, failed: 0, overBudget: 0, failures: [] };
  if (!ids.length) return stats;

  const startedAt = now();
  for (const projectId of ids) {
    if (now() - startedAt >= budgetMs) {
      stats.overBudget++;
      stats.failures.push({ projectId, error: `啟動預算 ${budgetMs}ms 用盡，未重開` });
      console.error(`[STARTUP] 專案 ${projectId} 的測試區未重開（啟動預算用盡）：排程（cron）仍是停的，請人工重啟該測試區`);
      continue;
    }
    try {
      const r = await restartEnv(projectId);
      if (r && r.ok) {
        stats.revived++;
        console.log(`[STARTUP] 專案 ${projectId} 的測試區已重開，排程（cron）執行緒恢復`);
      } else {
        // 容器已經不在跑＝這台本來就沒東西要救（多半是這段期間被人工停掉或被閒置回收）。
        stats.skipped++;
      }
    } catch (e) {
      stats.failed++;
      stats.failures.push({ projectId, error: e.message });
      // 這一行與下面寫進 release_last_result 的那一筆，是這件事唯一會留下來的痕跡。
      console.error(`[STARTUP] 專案 ${projectId} 的測試區重開失敗，排程（cron）仍是停的：${e.message}`);
    }
  }
  // 清單一定要清掉：不清的話下一次重啟會再照著這份舊清單重開一輪，把這段期間被刻意停掉的
  // 測試區也一起翻出來（就算 restartEnv 擋得住，也等於每次開機都白跑一輪）。
  await clearEnvsToRevive()
    .catch(err => console.error('[STARTUP] 清待重開測試區清單失敗：', err.message));
  if (stats.failed || stats.overBudget) {
    await recordEnvReviveResult(stats)
      .catch(err => console.error('[STARTUP] 記錄測試區重開結果失敗：', err.message));
  }
  console.log('[STARTUP] 更版後重開測試區：成功 %d／略過 %d／失敗 %d／超預算 %d（共 %d 台）',
    stats.revived, stats.skipped, stats.failed, stats.overBudget, stats.total);
  return stats;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 重啟指令失敗時的補救
 *
 * 「先標記已更版、再下重啟指令」的順序**不能倒過來**：那道指令會把這個行程一起帶走，
 * 排在後面的寫入不保證跑得到。所以能修的不是順序，是**失敗之後還剩下什麼**。
 *
 * docker restart 失敗（socket 被收回、daemon 忙、容器名對不上）時這個行程其實還活著，
 * callback 有幾秒鐘可用，剛好夠做四件事——每一件各自對應一種原本會永遠靜默的後果：
 *   1. 把這一批標記回滾成待更版。不回滾的話待更版清單**永遠是空的**：更版頁顯示全綠、
 *      下一個時段的第 4 步判「nothing-pending」直接結束，平台就這樣無限期跑著舊碼。
 *   2. 清掉 release_envs_to_revive。那份清單是為「這一次重啟」記的；沒重啟卻留著，
 *      將來某次不相干的開機會照著它把一批測試區重開一輪（重開的是別人正在用的環境）。
 *   3. 收掉維護旗標。restartNow 回 restarted 時呼叫端刻意不清旗標（正常情況下行程已經死了、
 *      由 index.js 開機時清）；沒死就必須自己清，否則派工一路停到到期時間。
 *   4. 把失敗寫進 release_last_result。這台沒有 webhook 也沒有 Teams（裁決二），
 *      畫面是唯一通道，不寫下來就只剩一行會被輪替掉的 stderr。
 *
 * ⚠ 救不回來的：callback 根本沒被呼叫的那種——指令送出去、容器真的被收掉（那就是成功），
 * 或行程在 callback 之前先死了。那時什麼都不會回滾，而它與成功長得一模一樣；分辨得出來的
 * 只有人：平台起不來，或起來了卻還是舊碼。同理，回滾跑到一半行程才死掉的話，DB 會停在
 * 「一半 released 一半 merged」——下一個時段只會上剩下那半批，不會更糟，但也不會自己補齊。
 * ──────────────────────────────────────────────────────────────────────────── */

// 供測試等待這段補救跑完：callback 是 execFile 丟回來的，測試沒有別的把手接得到它。
let _restartFailurePromise = null;

async function handleRestartFailure(err, { container, releases }) {
  const reason = `已標記 ${releases.length} 筆為已更版，但 docker restart ${container} 失敗：${err.message}`
    + '。平台仍跑著舊碼；那一批已經放回待更版，下一個維護時段或人工按「立刻更版」會再試一次。'
    + '請先確認容器還在、docker socket 還連得上，必要時在 host 上人工 docker restart。';
  console.error('[RELEASE] %s', reason);

  for (const r of releases) {
    await query("UPDATE finding_fixes SET status='merged' WHERE id=$1 AND status='released'", [r.id])
      .catch(e => console.error('[RELEASE] 回滾待更版狀態失敗（fix %s）：%s', r.id, e.message));
    // 用進來時抓到的原值還原，不寫死常數（見 pendingReleases 的註解）。
    await query(
      'UPDATE health_check_findings SET status=$2, applied_at=$3 WHERE id=$1 AND status=\'done\'',
      [r.finding_id, r.finding_status || 'approved', r.finding_applied_at || null])
      .catch(e => console.error('[RELEASE] 回滾提案處置狀態失敗（finding %s）：%s', r.finding_id, e.message));
  }
  await clearEnvsToRevive()
    .catch(e => console.error('[RELEASE] 清待重開測試區清單失敗：', e.message));
  await leaveMaintenance()
    .catch(e => console.error('[RELEASE] 清維護旗標失敗：', e.message));

  // 合併進上一筆而不是另寫一筆：呼叫端（releaseTick／立刻更版）在這之前已經寫過一筆
  // restarted:true 的樂觀紀錄，畫面讀的就是那一筆，要把它改口才看得到失敗。
  const prev = await lastReleaseResult().catch(() => null);
  const record = {
    ...(prev || { at: new Date().toISOString() }),
    restarted: false,
    released: 0,
    reason,
    restartFailed: { container, at: new Date().toISOString(), error: err.message, rolledBack: releases.length },
  };
  await query(
    `INSERT INTO teams_settings (id, release_last_result) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET release_last_result = $1`, [JSON.stringify(record)])
    .catch(e => console.error('[RELEASE] 記錄重啟失敗結果失敗：', e.message));
  return record;
}

/**
 * 真的重啟平台，讓已經合併的碼生效。
 *
 * 回傳 `{ restarted, testsPassed, tests, reason }`；`restarted: true` ＝**重啟指令已送出**
 * （見函式尾端），不等於重啟成功；不重啟時 `reason` 一定說得出是為什麼——
 * 這條路的每一種「沒做」都是靜默的（人只會看到平台還跑著舊碼），沒有理由就等於查不出來。
 *
 * ⚠ `testsPassed` 是三態，**null 不是通過**——呼叫端要判就判 `=== false`，不要判 falsy：
 *   - `true`：這一次真的跑了全跑而且全綠；
 *   - `false`：跑了但沒回綠（紅燈、測試檔載不起來、或跑不完），`reason` 會說是哪一種；
 *   - `null`：**根本沒跑**——有任務在飛、查不到容器、或呼叫端指定 `skipTests`。
 * 「跑了測試」與「測試通過」是兩件事；只看有沒有跑，紅燈照樣會被放上線。
 *
 * 在飛任務由呼叫端決定怎麼辦（維護時段的 cron 會在時段快結束時先中止再進來），這裡只認結果：
 * 傳進來還有在飛的就不重啟。重啟會當場砍掉那些 agent，任務會留在 `*_running` 的孤兒狀態。
 */
async function restartNow(opts = {}) {
  const userId = opts.userId || null;
  const inflight = opts.inflight || [];
  if (inflight.length) {
    return { restarted: false, testsPassed: null, tests: null, inflight,
      reason: `有 ${inflight.length} 條任務在飛，不重啟` };
  }
  // 先查得到容器名才動手：查不到就重啟不了，此時若已經把提案標成 done，畫面會顯示「處置完成」
  // 而平台其實還跑著舊碼——寧可什麼都不動，留下這行字讓人工重啟。
  let container;
  try {
    container = await selfContainerName();
  } catch (err) {
    console.error('[RELEASE] 查不到平台容器，碼已合併但未重啟，請人工重啟：', err.message);
    return { restarted: false, testsPassed: null, tests: null, reason: `查不到平台容器：${err.message}` };
  }

  // 閘門夾在「查完容器名」與「開始標記」之間。
  // 排在標記之前：標記一旦寫下去，更版頁就再也看不到這一批，而紅燈的正解是原封不動留到下個時段。
  // 排在查容器之後：查不到容器名根本重啟不了，不值得先燒掉兩分鐘跑全跑。
  let tests = null;
  if (opts.skipTests) {
    // 只有人工在畫面上明確指定跳過才會到這裡（例如已經自己跑過、或急著讓某條修正生效）。
    // testsPassed 維持 null 而不是 true：事後要回頭查「這次更版驗過沒有」，靠的就是這個值，
    // 把「沒跑」記成「通過」等於把證據偽造掉。
    console.warn('[RELEASE] 依呼叫端指定跳過重啟前全跑——本次更版沒有測試證據');
  } else {
    const gate = await runReleaseTests();
    tests = gate.tests;
    if (!gate.passed) {
      // 已拍板：紅燈只在畫面上通知（這台沒有 webhook／Teams），所以這個回傳值與這行 log
      // 就是唯一會留下來的記錄，理由必須自己說得完整。
      console.error('[RELEASE] %s', gate.reason);
      return { restarted: false, testsPassed: false, tests, reason: gate.reason };
    }
  }

  const releases = await pendingReleases();
  // ⚠ 標記一定要全部做完才下重啟指令：那道指令會把這個行程一起帶走，排在後面的寫入不保證跑得到。
  for (const r of releases) {
    // 提案標 done 只在真的重啟這條路上做——這是從 applyFix 原封搬過來的判準，拆開之後更成立：
    // 現在每一次合併都會停在「還差重啟」，提早標 done 會把更版頁那顆按鈕永遠藏掉。
    // 下一輪健檢的 previousProposals() 讀的也是這裡；applied_at 是回頭驗成效的起算點，指標只會在
    // 新碼真的跑起來之後才變，停在合併那一刻等於把舊碼期間的數據算進這條修正的成效裡。
    // COALESCE 保留第一次的時間：重按不該把起算點往後推。
    await query(
      `UPDATE health_check_findings
          SET status='done', decided_by=$2, decided_at=NOW(), applied_at=COALESCE(applied_at, NOW())
        WHERE id=$1 AND status<>'done'`, [r.finding_id, userId]);
    // 這一列不能留在 merged：待更版清單只認 merged，不收掉的話每個維護時段都會看到同一批，
    // 於是沒有新碼也照樣把客戶重啟一次。
    await query(`UPDATE finding_fixes SET status='released' WHERE id=$1`, [r.id]);
  }

  // ⚠ 與上面的標記同一個理由，而且這一份更嚴格：清單**只有現在**問得到。重啟之後再掃，
  // 「當時在跑、被連帶收掉」與「本來就沒在跑」就再也分不出來了（見 captureRunningEnvs 檔頭）。
  // 記不下來也照樣重啟：更版本身不該被這件事擋住，但要留下這行字說明哪幾台不會被救回來。
  let envsToRevive = [];
  try {
    envsToRevive = await captureRunningEnvs();
  } catch (err) {
    console.error('[RELEASE] 記不下執行中的測試區清單，重啟後不會自動重開它們（排程會停）：', err.message);
  }

  console.log('[RELEASE] 重啟平台容器 %s 讓 %d 筆已合併的修正生效（重啟後要重開 %d 個測試區）',
    container, releases.length, envsToRevive.length);
  setTimeout(() => {
    _restartFailurePromise = new Promise(resolve => {
      execFile('docker', ['restart', container], err => {
        // 沒錯就什麼都不做：這個行程正要被指令帶走，做什麼都不保證跑得完。
        if (!err) return resolve(null);
        // 有錯代表行程還活著、而 DB 裡已經寫著「這一批上線了」——那是最危險的一種狀態
        // （待更版清單空掉＝這批碼再也不會被上線）。補救見 handleRestartFailure。
        handleRestartFailure(err, { container, releases })
          .catch(e => console.error('[RELEASE] 重啟失敗的補救本身也失敗了：', e.message))
          .then(resolve);
      });
    });
  }, RESTART_DELAY_MS);
  // ⚠ `restarted: true` 的意思是「**重啟指令已經送出去**」，不是「重啟成功了」——成功的長相
  // 是這個行程當場消失，沒有任何人回得來把 true 改成別的值。指令真的失敗時由上面的 callback
  // 把 release_last_result 改口成 restarted:false 並回滾標記，畫面讀的是那一筆。
  return { restarted: true, testsPassed: opts.skipTests ? null : true, tests,
    reason: null, container, released: releases.length, envsToRevive: envsToRevive.length };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 維護時段的自動更版（規格 §4.3 ＋ 2026-09-22 三項裁決）
 *
 * cron 每分鐘打一次 releaseTick()，由它決定這一分鐘要不要把已合併的碼真的放上去。
 * **判斷順序本身就是規格**，每一步各自擋掉一種真實事故：
 *   1. 沒設定時段 → 什麼都不做。沒有「預設每週六日自動重啟」這種行為。
 *   2. 不在時段內 → 結束。上班時間不准把客戶踢下線。
 *   3. 這一場時段已經跑過 → 結束。旗標落 DB（見 readLastWindow）。
 *   4. 沒有待更版的碼 → 結束。**沒東西要上就不要打擾客戶**——這正是本子專案存在的理由。
 *   5. 有在飛任務 → 還早就等它自己跑完，快結束才中止（裁決三）。
 *   6. 落旗標 → 進維護 → 中止（若已裁定）→ 跑全套 → 綠才重啟。
 * ──────────────────────────────────────────────────────────────────────────── */

// 已拍板的時段（週六日 02:00 起兩小時）。**這是給設定頁預填用的，不是預設值**：
// releaseWindowConfig() 讀不到設定時回 null，整條機制就是關的。
// 「沒有人按下同意，平台卻自己在週末重啟客戶」是這裡唯一不能犯的錯。
const DEFAULT_RELEASE_WINDOW = { weekdays: [6, 0], startHour: 2, durationHours: 2 };

// 「快結束了」的門檻：離時段結束剩這麼多就不再等在飛任務，直接中止並照常重啟。
//
// 為什麼是 5 分鐘（時段全長 120 分鐘）——**從實測值推導，不是估的**：
//   - 全跑實測 115 秒（2026-09-22 在這台機器上量：主 clone 的 `cd app && npm run test:quiet`，
//     6,069 支測試／396 個測試檔，exit code 0，jest 自報 114.7 秒、wall 115 秒）。
//     ⚠ 這個數字會腐爛（測試只會越加越多），下次有人覺得門檻不夠用時請重量一次再改，
//     不要憑印象加碼——本行原本寫的「約 15 分鐘」就是沒量過的估計，差了快 8 倍。
//   - 推導：2 分鐘 × 2（維護時段接在夜間批次 22:00–02:00 的尾巴，機器可能還在忙）＝ 4 分鐘，
//     再加 1 分鐘給中止收尾與 docker restart 的緩衝 → 5 分鐘。
//   - 不能更大：門檻每多一分鐘，就是每個週末多殺掉一分鐘份量的、本來自己會跑完的任務。
//     **任務自己跑完永遠是最好的結果**，中止只是為了不讓一條任務綁架整個時段；原本的 30 分鐘
//     等於在 03:30 就開始殺，而那時全跑只需要兩分鐘。
//   - 壓這麼緊的代價很小：沒有任何地方在時段邊界上硬停進行中的更版（判斷只發生在進場那一刻），
//     所以真的超時也只是重啟發生在 04:0x，不是「任務殺了、時段也錯過」。
const RELEASE_ABORT_BEFORE_END_MS = parseInt(process.env.RELEASE_ABORT_BEFORE_END_MS || '300000', 10);

// 崩潰重試上限：同一場時段裡，工作區塊自己炸掉最多讓它再試這麼多次（見 handleTickCrash）。
const RELEASE_MAX_CRASH_RETRIES = parseInt(process.env.RELEASE_MAX_CRASH_RETRIES || '2', 10);

// 更版期間的維護旗標長度。要能撐過「全跑＋重啟＋開機」而不中途過期——中途過期會讓派工在
// 我們正要下重啟指令的那一刻恢復，剛派出去的 agent 立刻被砍。實際需要的是
// 全跑 2 分 ＋ 重啟 ＋ 開機（含測試區重開預算 ENV_REVIVE_BUDGET_MS 3 分）≈ 10 分鐘以內；
// 這裡仍留 1 小時不跟著調小，因為它是**上限型的保險**：長一點只是延後「無人收拾時自動恢復」，
// 而正常路徑（重啟成功→開機清、沒重啟→leaveMaintenance、崩潰→handleTickCrash）都會明確清掉它。
// ⚠ 這是到期時間不是布林（maintenance.js 檔頭三道保險）：這條路徑掛掉也不會讓派工永久停擺。
const RELEASE_MAINTENANCE_MS = parseInt(process.env.RELEASE_MAINTENANCE_MS || '3600000', 10);

// 同一行程內的重入鎖。**它不是「這一場跑過了」的旗標**——那一個一定要落 DB（見 markWindow）。
let _releaseRunning = false;

/**
 * 維護時段設定；沒設定（或設定壞掉）一律回 null＝機制關閉。
 *
 * 這裡的守衛是 release-window.js 那兩支純函式刻意不做的部分（它們只回答「現在是不是」）。
 * 擋在這裡的理由：`startHour` 溢位時 `Date#setHours` 是**靜默滾進隔天**而不是報錯，
 * nextWindow 會算出一個看起來合理但錯的日期（Task 1 審查記錄的 IMPORTANT），
 * 而排程頁顯示錯日期還只是難看，真的在錯的時間重啟才是事故。壞設定一律 fail-closed。
 */
async function releaseWindowConfig() {
  let raw;
  try {
    const { rows } = await query('SELECT release_window FROM teams_settings WHERE id = 1');
    raw = rows[0] && rows[0].release_window;
  } catch { return null; }   // 欄位還沒建／DB 暫時性錯誤：當成沒設定，寧可不重啟
  if (!raw) return null;
  let cfg;
  try { cfg = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (err) { console.error('[RELEASE] 維護時段設定不是合法 JSON，當成未設定：', err.message); return null; }
  if (!cfg || !Array.isArray(cfg.weekdays) || !cfg.weekdays.length) return null;
  if (!cfg.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  if (!Number.isInteger(cfg.startHour) || cfg.startHour < 0 || cfg.startHour > 23) return null;
  if (!(cfg.durationHours > 0)) return null;
  // 跨午夜的時段 isInWindow 會**靜默漏掉**（週六 23:00＋4 小時，在週日 01:00 會回 false，
  // 因為它先用 getDay() 過濾、不考慮「現在屬於昨天開始還沒結束的那一場」——Task 1 審查已記錄）。
  // 與其讓它在半夜安靜地不觸發，不如在設定入口就擋下來。
  if (cfg.startHour + cfg.durationHours > 24) {
    console.error('[RELEASE] 維護時段跨過午夜（%d:00 起 %d 小時），目前的時段判斷不支援，當成未設定',
      cfg.startHour, cfg.durationHours);
    return null;
  }
  return { weekdays: cfg.weekdays, startHour: cfg.startHour, durationHours: cfg.durationHours };
}

/**
 * 「這一場時段已經跑過了」的旗標。**只能落 DB，不能放記憶體。**
 * 重啟會把這個行程整個帶走，記憶體旗標回來就是 null，同一場時段的下一個 tick 會再重啟一次，
 * 然後再一次——無限重啟（cron.js 的 readNightlyFixDay 檔頭記著一模一樣的坑）。
 * 值存「這一場時段的開始時間」而不是日期：同一天可能有兩場（未來若設成早晚各一場）。
 */
async function readLastWindow() {
  const { rows } = await query('SELECT release_last_window FROM teams_settings WHERE id = 1');
  return (rows[0] && rows[0].release_last_window) || null;
}

async function markWindow(windowKey) {
  await query(
    `INSERT INTO teams_settings (id, release_last_window) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET release_last_window = $1`, [windowKey]);
}

/**
 * 把「這一場跑過了」的旗標收回來，讓同一場時段還能再試一次。
 * **只有在整條路徑確定沒有下過重啟指令時才准呼叫**（見 handleTickCrash）：指令一旦送出去，
 * 旗標就是防止「重啟回來又重啟一次」的唯一一道保險，收掉它等於回到無限重啟。
 */
async function clearWindowMark() {
  await query(
    `INSERT INTO teams_settings (id, release_last_window) VALUES (1, NULL)
       ON CONFLICT (id) DO UPDATE SET release_last_window = NULL`);
}

/**
 * 上一次更版嘗試的結果。**這是裁決二唯一的落點**：紅燈只在畫面上通知，這台沒有 webhook
 * 也沒有 Teams，所以「半夜兩點全跑紅了」這件事若不寫進 DB，就只剩一行會被輪替掉的 stdout。
 * 排程頁與更版頁都讀這一筆，讓它在事後找得到，而不是只發生過。
 */
async function recordReleaseResult(result) {
  await query(
    `INSERT INTO teams_settings (id, release_last_result) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET release_last_result = $1`, [JSON.stringify(result)]);
}

async function lastReleaseResult() {
  try {
    const { rows } = await query('SELECT release_last_result FROM teams_settings WHERE id = 1');
    const raw = rows[0] && rows[0].release_last_result;
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { return null; }
}

/**
 * 中止在飛任務（裁決三）。
 *
 * **狀態刻意不動**——這是全平台既有的中止語意（比照 runner.js 的 abortCompanyTasks：
 * 原地不動、不寫失敗、不列 blocker，只補一行讓人看得懂為什麼停了），而且這裡不動狀態
 * 正是任務能自己接回去的原因：任務留在 `*_running`，而所有 `*_running` 的 actor 都是
 * agent／system，**它們本來就在 cron 每分鐘的派工範圍內**（stale-running.js 檔頭實查記錄）。
 * 平台重啟後 `_inFlight`（行程內記憶體）歸零，下一個 tick 就把它從同一關重派，沒有人要按任何東西。
 * 另外兩層既有機制接住剩下的髒東西，都不必在這裡重造：
 *   - index.js 啟動時的 clearInterruptedUpgrades()：把停在 deploy_testing／playwright_running
 *     的專案容器重啟一次，清掉「父死子活」留在容器裡的 odoo exec 進程，重派才不會撞併行升級。
 *   - lib/agent-orphans：清掉被重啟打斷、不會跟著死的 AI 容器。
 * 萬一真的沒被重派（離開派工範圍），stale-running 的 72 小時兜底會把它標成 stopped 並通知，
 * 出現在「輪到你」——不會靜默消失。
 */
async function abortInflightForRelease(inflight, msLeft) {
  const { abortTask } = require('./runner');
  const mins = Math.max(0, Math.round(msLeft / 60000));
  const aborted = [];
  for (const e of inflight) {
    abortTask(e.taskId);
    // 這行字是任務的主人週一早上唯一看得到的東西，所以要把「發生什麼、我要不要做什麼」講完。
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [e.taskId, `平台維護時段剩下 ${mins} 分鐘，本輪執行已中止以便更新平台程式。`
        + '改到一半的程式碼留在任務分支，沒有合併；平台重啟後會自動從同一關重跑，不需要人工處理。']
    ).catch(err => console.error('[RELEASE] 寫中止說明失敗：', err.message));
    aborted.push(e.taskId);
  }
  console.warn('[RELEASE] 維護時段剩 %d 分鐘，中止 %d 條在飛任務後照常重啟', mins, aborted.length);
  return aborted;
}

/**
 * 更版工作區塊自己炸掉時的收尾。
 *
 * 這一段原本沒有 catch，而它涵蓋的每一句都可能拋：pendingReleases 的 SQL、標記迴圈的兩道
 * UPDATE、中止路徑、restartNow 裡的每一次查詢。拋出去只會被 cron.js 的 fire-and-forget
 * `.catch(console.error)` 接住，留下的是三件同時成立的壞事：
 *   - 維護旗標還掛著 → 全平台派工停一小時；
 *   - 沒有任何 release_last_result → 更版頁顯示的是上一次（多半是綠的）；
 *   - 這一場的旗標已經落了 → 不會再試，而且沒有人知道它試過。
 * 三件加起來就是「安靜地什麼都沒發生」，正是這個子專案存在的理由。
 *
 * 【這一場還能不能再試】可以，但有上限，而且**只在沒下過重啟指令時**：
 *   - 該給重試：崩潰與「全跑紅燈」在性質上完全不同。紅燈是對碼的判決，兩小時內不會自己變綠，
 *     所以刻意不重試；而崩潰多半是暫時性的（DB 連線斷一下、docker 查詢逾時），下一分鐘再試
 *     很可能就成功，不試就白白丟掉一整個週末的時段。
 *   - 該有上限：崩潰若是程式碼的 bug，每分鐘重試一次＝每分鐘再跑一次全跑，把機器燒到天亮，
 *     而結果不會變。上限 RELEASE_MAX_CRASH_RETRIES 次之後就把旗標留著，讓這一場結束，
 *     人在畫面上看得到它為什麼放棄。
 *   - 下過重啟指令就絕不重試：那時行程隨時會消失，旗標是防止「重啟回來又重啟一次」的
 *     唯一保險（readLastWindow 檔頭記著那個無限重啟的坑）。
 */
async function handleTickCrash(err, { windowKey, pending, restartFired }) {
  console.error('[RELEASE] 維護時段的更版流程中途出錯（%s）：%s', windowKey, err.stack || err.message);
  // 先收維護旗標：三件壞事裡就它會把整個平台的派工停掉，而且與能不能重試無關。
  if (!restartFired) {
    await leaveMaintenance().catch(e => console.error('[RELEASE] 清維護旗標失敗：', e.message));
  }

  const prev = await lastReleaseResult().catch(() => null);
  const crashCount = (prev && prev.crash && prev.crash.windowStart === windowKey)
    ? (prev.crash.count || 1) + 1 : 1;
  const retryable = !restartFired && crashCount <= RELEASE_MAX_CRASH_RETRIES;
  const reason = `更版流程中途出錯：${err.message}`
    + `｜${restartFired ? '重啟指令已經送出，不重試（避免重啟回來又重啟一次）'
      : retryable ? `這一場還會再試（第 ${crashCount} 次，上限 ${RELEASE_MAX_CRASH_RETRIES} 次）`
      : `這一場已經試過 ${crashCount} 次，不再重試——碼留在待更版等下一個時段`}`
    + '。碼已在 master 但沒有生效，平台仍跑舊碼；請看平台 log 的 [RELEASE] 那幾行找真因。';
  await recordReleaseResult({
    windowStart: windowKey,
    at: new Date().toISOString(),
    restarted: false,
    testsPassed: null,
    reason,
    released: 0,
    pending,
    aborted: [],
    envsToRevive: 0,
    summary: null,
    crash: { windowStart: windowKey, count: crashCount, error: err.message, retryable },
  }).catch(e => console.error('[RELEASE] 記錄更版崩潰結果失敗：', e.message));

  // 旗標最後才收：前面兩件事失敗時寧可這一場不再試，也不要在沒有任何紀錄的情況下重跑。
  if (retryable) {
    await clearWindowMark().catch(e => console.error('[RELEASE] 收回時段旗標失敗，這一場不會再試：', e.message));
  }
  return { ran: false, reason: 'crashed', windowKey, error: err.message, retryable, crashCount };
}

/**
 * 維護時段的一拍。cron 每分鐘打一次，回傳 `{ ran, reason, ... }`——**每一種「沒做」都說得出理由**，
 * 因為這條路徑的所有失敗都是靜默的（人只會看到平台還跑著舊碼）。
 *
 * deps.now 供測試注入時鐘；deps.userId 是記在 `decided_by` 的人，自動排程是 null。
 */
async function releaseTick(deps = {}) {
  const now = deps.now || new Date();

  const cfg = await releaseWindowConfig();
  if (!cfg) return { ran: false, reason: 'no-window-config' };
  if (!isInWindow(cfg, now)) return { ran: false, reason: 'outside-window' };

  // 時段內時 nextWindow 回的是「現在這一場」的開始（Task 1 刻意如此），正好可以當這一場的識別碼。
  const windowStart = nextWindow(cfg, now);
  const windowKey = windowStart.toISOString();
  const windowEndMs = windowStart.getTime() + cfg.durationHours * 3600000;
  if (await readLastWindow() === windowKey) return { ran: false, reason: 'already-ran', windowKey };
  if (_releaseRunning) return { ran: false, reason: 'already-running', windowKey };

  const pending = await pendingReleases();
  // **沒有新碼就不要打擾客戶**：重啟會砍掉在飛的 agent、讓測試區 Odoo 的 cron 執行緒永久死掉。
  // 為了零筆待更版而付這個代價，正是本子專案要防的那起事故。
  if (!pending.length) return { ran: false, reason: 'nothing-pending', windowKey };

  // 延到函式內才 require：載入期就拉 runner 會循環依賴（比照 nightly-fix.js 的 inflightCount）。
  const { getInflightInfo } = require('./runner');
  const inflight = getInflightInfo();
  const msLeft = windowEndMs - now.getTime();
  if (inflight.length && msLeft > RELEASE_ABORT_BEFORE_END_MS) {
    console.log('[RELEASE] 時段內有 %d 條任務在飛，離時段結束還有 %d 分鐘，這一輪先等它們自己跑完',
      inflight.length, Math.round(msLeft / 60000));
    return { ran: false, reason: 'inflight-waiting', inflight: inflight.length, msLeft, windowKey };
  }

  // 夜間批次跑過 02:00 時，getInflightInfo() 看不到它——那支不是 pipeline 任務，不進在飛表。
  // 它正在做的事包含 git merge 與 git push，中途被 docker restart 砍掉的話，push 失敗時
  // 那段「把合併節點 reset 回去」的補償碼不會執行，master 會留下一顆只有本機看得到的 commit，
  // 之後每次重試都回 Already up to date 而 push continues to fail——要進 shell 才解得開。
  // 但它其實留了訊號：批次一開始就 enterMaintenance()，而且跑的期間會定期續期
  // （nightly-fix.js 的批次起點與續期處）。所以進場前先問一次「現在是不是已經有人在維護中」，
  // 有的話就是批次還在跑，這一輪讓它。**不標記這一場跑過**，下一分鐘再來問。
  // 旗標是到期時間不是布林，所以批次若整個死掉，旗標會自己過期，不會把更版永遠卡住。
  if (await isMaintenance()) {
    console.log('[RELEASE] 已經有人在維護中（多半是夜間批次還沒收工），這一輪讓它，不重啟');
    return { ran: false, reason: 'maintenance-busy', windowKey };
  }

  _releaseRunning = true;
  // 有沒有下過重啟指令，決定崩潰時能不能把這一場的旗標收回來重試（見 handleTickCrash）。
  let restartFired = false;
  try {
    // ⚠ 旗標一定要先落。下面每一件事都可能把這個行程帶走（重啟指令、容器被收），
    // 而「跑過了」若只記在記憶體，回來就歸零，同一場時段會被無限重啟。
    // 代價是「這一場只嘗試一次」：全跑紅了不會在同一場重試。那是刻意的——紅燈不會在兩小時內
    // 自己變綠，每分鐘重跑一次全跑（實測 115 秒，見 RELEASE_ABORT_BEFORE_END_MS）只是白燒機器。
    // 崩潰是另一回事，那條路有次數上限的重試（見 handleTickCrash）。
    await markWindow(windowKey);
    // 先停派工、再中止在飛任務。反過來的話被中止的任務會在 60 秒後的下一個 tick 立刻被重派，
    // 跑到一半又被重啟砍掉——白燒一輪，而且中止訊息會被後來那一輪的內容蓋過去。
    await enterMaintenance(RELEASE_MAINTENANCE_MS);
    const aborted = inflight.length ? await abortInflightForRelease(inflight, msLeft) : [];

    // restartNow 的 inflight 是**守衛不是決策者**（Task 2 刻意把裁決留給呼叫端）。
    // 走到這裡裁決已經下了：中止並照常重啟，所以傳空陣列。不傳空的話這一場會被剛中止、
    // 還沒從 _inFlight 移除的那幾條擋掉，等於裁決三沒有實作。
    const result = await restartNow({ userId: deps.userId ?? null, inflight: [] });
    restartFired = result.restarted === true;

    const record = {
      windowStart: windowKey,
      at: new Date().toISOString(),
      restarted: result.restarted,
      testsPassed: result.testsPassed,
      reason: result.reason,
      released: result.released ?? 0,
      pending: pending.length,
      aborted,
      // 重啟後要重開幾台測試區。更版頁靠它與後面補上的 envRevive 對照：記了 3 台、回來只救回 2 台，
      // 差額就是那台還在「開著但什麼都不動」的環境。
      envsToRevive: result.envsToRevive ?? 0,
      summary: (result.tests && result.tests.summary) || null,
    };
    await recordReleaseResult(record)
      .catch(err => console.error('[RELEASE] 記錄更版結果失敗：', err.message));

    if (!result.restarted) {
      // 沒重啟就要把維護旗標收回來，否則派工會一路停到到期時間才自己恢復。
      await leaveMaintenance().catch(err => console.error('[RELEASE] 清維護旗標失敗：', err.message));
    }
    return { ran: true, windowKey, aborted, pending: pending.length, ...result };
  } catch (err) {
    // ⚠ 這個 catch 是整段的救命索：沒有它，任何一句拋出去都會留下「維護旗標掛著、
    // 沒有任何紀錄、而且這一場已經標記跑過」——畫面上看起來什麼都沒發生。
    return await handleTickCrash(err, { windowKey, pending: pending.length, restartFired });
  } finally {
    _releaseRunning = false;
  }
}

module.exports = {
  pendingReleases, restartNow,
  captureRunningEnvs, readEnvsToRevive, reviveRunningEnvs,
  releaseTick, releaseWindowConfig, lastReleaseResult, readLastWindow,
  DEFAULT_RELEASE_WINDOW, RELEASE_ABORT_BEFORE_END_MS, RELEASE_MAX_CRASH_RETRIES,
  // 重啟指令是 setTimeout ＋ execFile callback，測試沒有別的把手等得到那段補救跑完。
  _pendingRestartFailureForTesting: () => _restartFailurePromise,
};
