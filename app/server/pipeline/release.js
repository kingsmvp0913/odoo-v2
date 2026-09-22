const path = require('path');
const { execFile } = require('child_process');
const { query } = require('../db');
const { selfContainerName, measureTests } = require('./finding-fix');

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

module.exports = { pendingReleases, restartNow };
