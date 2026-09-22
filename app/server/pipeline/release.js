const { execFile } = require('child_process');
const { query } = require('../db');
const { selfContainerName } = require('./finding-fix');

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
 * ⚠ `testsPassed`／`tests` 目前恆為 null：重啟前對 master 跑全套測試的閘門（規格 §4.3「紅了不
 * 重啟」）還沒接上。**null 不是通過**——呼叫端要判就判 `=== false`，不要判 falsy。
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
  return { restarted: true, testsPassed: null, tests: null, reason: null, container, released: releases.length };
}

module.exports = { pendingReleases, restartNow };
