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
    `SELECT f.id, f.finding_id, f.branch, f.commit_sha, f.status, f.created_at,
            h.diagnosis, h.severity
       FROM finding_fixes f
       LEFT JOIN health_check_findings h ON h.id = f.finding_id
      WHERE f.status = 'merged'
      ORDER BY f.created_at ASC`);
  return rows;
}

/**
 * 真的重啟平台，讓已經合併的碼生效。
 *
 * 回傳 `{ restarted, testsPassed, tests, reason }`；不重啟時 `reason` 一定說得出是為什麼——
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
  // 排在查容器之後：查不到容器名根本重啟不了，不值得先燒掉十幾分鐘跑全跑。
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

  console.log('[RELEASE] 重啟平台容器 %s 讓 %d 筆已合併的修正生效', container, releases.length);
  setTimeout(() => {
    execFile('docker', ['restart', container], err => {
      if (err) console.error('[RELEASE] restart:', err.message);
    });
  }, RESTART_DELAY_MS);
  return { restarted: true, testsPassed: opts.skipTests ? null : true, tests,
    reason: null, container, released: releases.length };
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
// 為什麼是 30 分鐘（時段全長 120 分鐘）：
//   - restartNow 會**先**跑一次全套測試才重啟，實測約 15 分鐘（Task 3 實量）。那 15 分鐘是
//     這台機器平常的值、不是上限——維護時段剛好接在夜間批次（22:00 起、02:00 收）的尾巴，
//     機器可能還在忙，所以要抓兩倍：30 分鐘 = 15 分鐘全跑 ＋ 15 分鐘給中止收尾與重啟指令。
//   - 不能更大：設 45～60 分鐘等於在時段前半就開始殺任務，而那時還有兩三個 tick 的機會讓
//     它們自己跑完——**任務自己跑完永遠是最好的結果**，中止只是為了不讓一條任務綁架整個時段。
//     30 分鐘的門檻給了在飛任務 90 分鐘（02:00–03:30）自己收尾。
//   - 不能更小：設 15 分鐘的話全跑就把剩下的時間吃光，稍有變異就變成「任務殺了、時段也錯過」
//     ——兩頭皆空，比不中止還糟。
const RELEASE_ABORT_BEFORE_END_MS = parseInt(process.env.RELEASE_ABORT_BEFORE_END_MS || '1800000', 10);

// 更版期間的維護旗標長度。要能撐過「全跑＋重啟＋開機」而不中途過期——中途過期會讓派工在
// 我們正要下重啟指令的那一刻恢復，剛派出去的 agent 立刻被砍。取全跑實測值的四倍。
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
  try {
    // ⚠ 旗標一定要先落。下面每一件事都可能把這個行程帶走（重啟指令、容器被收），
    // 而「跑過了」若只記在記憶體，回來就歸零，同一場時段會被無限重啟。
    // 代價是「這一場只嘗試一次」：全跑紅了不會在同一場重試。那是刻意的——一次全跑十幾分鐘，
    // 每分鐘重試一次只會把機器跑垮，而紅燈不會在兩小時內自己變綠。
    await markWindow(windowKey);
    // 先停派工、再中止在飛任務。反過來的話被中止的任務會在 60 秒後的下一個 tick 立刻被重派，
    // 跑到一半又被重啟砍掉——白燒一輪，而且中止訊息會被後來那一輪的內容蓋過去。
    await enterMaintenance(RELEASE_MAINTENANCE_MS);
    const aborted = inflight.length ? await abortInflightForRelease(inflight, msLeft) : [];

    // restartNow 的 inflight 是**守衛不是決策者**（Task 2 刻意把裁決留給呼叫端）。
    // 走到這裡裁決已經下了：中止並照常重啟，所以傳空陣列。不傳空的話這一場會被剛中止、
    // 還沒從 _inFlight 移除的那幾條擋掉，等於裁決三沒有實作。
    const result = await restartNow({ userId: deps.userId ?? null, inflight: [] });

    const record = {
      windowStart: windowKey,
      at: new Date().toISOString(),
      restarted: result.restarted,
      testsPassed: result.testsPassed,
      reason: result.reason,
      released: result.released ?? 0,
      pending: pending.length,
      aborted,
      summary: (result.tests && result.tests.summary) || null,
    };
    await recordReleaseResult(record)
      .catch(err => console.error('[RELEASE] 記錄更版結果失敗：', err.message));

    if (!result.restarted) {
      // 沒重啟就要把維護旗標收回來，否則派工會一路停到到期時間才自己恢復。
      await leaveMaintenance().catch(err => console.error('[RELEASE] 清維護旗標失敗：', err.message));
    }
    return { ran: true, windowKey, aborted, pending: pending.length, ...result };
  } finally {
    _releaseRunning = false;
  }
}

module.exports = {
  pendingReleases, restartNow,
  releaseTick, releaseWindowConfig, lastReleaseResult, readLastWindow,
  DEFAULT_RELEASE_WINDOW, RELEASE_ABORT_BEFORE_END_MS,
};
