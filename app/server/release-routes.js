/**
 * release-routes.js — 更版頁（管理員 > 平台更版）的後端。
 *
 * 這一頁是整個「平台更版機制」子專案**唯一有人會看到的東西**。三項已拍板的裁決裡有兩項
 * 的落點就在這裡：
 *   裁決二：紅燈只在畫面上通知——這台機器沒有 webhook、沒有 Teams，所以「上一次更版失敗了」
 *           這件事若不在畫面上說得夠大聲，就永遠不會有人知道。連「不會有人通知你」這件事
 *           本身都要寫在畫面上：以為會被通知的人不會自己來看。
 *   裁決三：在飛任務會在時段快結束時被強制中止——管理員要看得到這件事會發生。
 *
 * 為什麼另開一個檔而不是塞進 admin-routes.js：那個檔已經 1100+ 行，而更版是一整塊有自己
 * 生命週期的東西（時段設定、待更版清單、立刻更版）。比照 company-admin-routes.js 的作法。
 *
 * ⚠ 這個檔**不重造 pipeline/release.js 已經有的判斷**：待更版清單、時段設定的讀取與守衛、
 * 重啟本身全部呼叫那邊的函式。這裡只負責 HTTP 與「畫面要看得到什麼」。
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { requirePlatformAdmin } = require('./lib/tenant-access');
const { isInWindow, nextWindow } = require('./lib/release-window');
const { enterMaintenance, leaveMaintenance, isMaintenance } = require('./pipeline/maintenance');
const release = require('./pipeline/release');

const auth = [verifyToken, requirePlatformAdmin];

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

// 公告橫幅要提前多久掛出來。維護時段是週六日 02:00，多數人不會在那一刻開著畫面，
// 提前一個班次（6 小時）掛出來才有人看得到；再早就變成整天掛著的背景噪音。
const NOTICE_LEAD_MS = parseInt(process.env.RELEASE_NOTICE_LEAD_MS || '21600000', 10);

// 更版期間的維護旗標長度。與 release.js 的 RELEASE_MAINTENANCE_MS 同一個用意（撐過
// 「全跑＋重啟＋開機」而不中途過期），那個常數沒有匯出，所以這裡自己有一份 env 旋鈕。
// ⚠ 到期時間不是布林（maintenance.js 檔頭三道保險）：這條路徑掛掉也不會讓派工永久停擺。
const MANUAL_MAINTENANCE_MS = parseInt(process.env.RELEASE_MANUAL_MAINTENANCE_MS || '3600000', 10);

/**
 * 「立刻更版」正在跑。**只在記憶體**，而且這是對的：
 * 重啟會把這個行程整個帶走，旗標跟著消失正好等於「那一次已經結束了」。
 * 與 release.js 的 `_releaseRunning` 是兩個不同的鎖（它守自動時段、這個守人工按鈕），
 * 但兩邊都會先進維護旗標，所以互相撞不到——真正的序列化在 DB 的 maintenance_until。
 */
let _manualRun = null;

function windowLabel(cfg) {
  if (!cfg) return '未設定';
  return `每週${cfg.weekdays.map(d => WEEKDAY_LABELS[d]).join('、')} `
    + `${String(cfg.startHour).padStart(2, '0')}:00 起 ${cfg.durationHours} 小時`;
}

// finding_fixes.members 落地時是 JSONB，但 pg-mem 有時把它回成原始字串（nightly-fix.js 的
// membersFromRefs 與 admin-routes.js 的同名函式都踩過），只認物件陣列會在測試裡靜默變空。
function parseMembers(raw) {
  let list = raw;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
  return Array.isArray(list) ? list : [];
}

/**
 * 待更版清單。列本身來自 release.js 的 pendingReleases()——**那份 SQL 是唯一真相**，
 * 更版頁看到的必須跟時段真的會放上去的是同一批，不然畫面說的是另一件事。
 *
 * 這裡只多補一個 `feedback_ids`：一條修正可能是從使用者意見回饋來的，而回頭稽核時
 * 「這段碼是依據哪段文字改的」正是 R6-B 要答的問題。來源對應存在 finding_fixes.members
 * （nightly-fix.js 寫入、finding-fix.js 的 feedbackIdsOf 讀出），不另外發明一套連結。
 *
 * diff／review_notes／verify_notes 刻意**不在這支回應裡**：它們每一筆都可能好幾千字，
 * 而清單上常態是「看一眼有幾筆」。全文由既有的 GET /api/admin/health-check/findings/:id/fix
 * 提供（那支已經回整段歷史、已經有截斷與筆數上限），前端展開某一列時才去拿。
 */
async function pendingWithSources() {
  const rows = await release.pendingReleases();
  if (!rows.length) return rows;
  const { feedbackIdsOf } = require('./pipeline/finding-fix');
  const { rows: memberRows } = await query(
    "SELECT id, members FROM finding_fixes WHERE status = 'merged'");
  const byId = new Map(memberRows.map(r => [r.id, feedbackIdsOf(parseMembers(r.members))]));
  return rows.map(r => ({ ...r, feedback_ids: byId.get(r.id) || [] }));
}

/**
 * 時段設定的輸入守衛。**與 release.js 的 releaseWindowConfig() 是同一組規則**，
 * 差別在這裡會把理由講給人聽，那裡是 fail-closed 地當成「沒設定」。
 * 兩邊不一致的後果很難查：畫面顯示存好了，而引擎讀出來是 null＝整條機制是關的。
 */
function validateWindow(body) {
  const weekdays = body && body.weekdays;
  if (!Array.isArray(weekdays) || !weekdays.length) return '至少要選一天';
  if (!weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return '星期只能是 0（日）到 6（六）';
  const startHour = body.startHour;
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) return '開始時間只能是 0 到 23 點';
  const durationHours = body.durationHours;
  if (!(durationHours > 0)) return '時段長度要大於 0 小時';
  // 跨午夜的時段 isInWindow 會**靜默漏掉**（Task 1 審查記錄），所以在入口就擋，
  // 而不是讓它在半夜安靜地不觸發。
  if (startHour + durationHours > 24) return '時段不能跨過午夜（開始時間＋長度要在 24 小時內）';
  return null;
}

/**
 * 把一次更版嘗試的結果落 DB。裁決二唯一的落點——人工按的那一次若不記，
 * 「全跑紅了所以沒重啟」就只剩一行會被輪替掉的 stdout。
 * release.js 的 recordReleaseResult 沒有匯出，所以這裡寫同一個欄位（同樣的 JSON 形狀，
 * 多一個 `source` 分辨是誰按的）。前端讀的是同一筆，兩條路的顯示因此一致。
 */
async function recordResult(record) {
  await query(
    `INSERT INTO teams_settings (id, release_last_result) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET release_last_result = $1`, [JSON.stringify(record)]);
}

/**
 * 「立刻更版」的實際工作。**背景跑、不佔著 HTTP 連線**：restartNow 會先跑一次全套測試，
 * 實測 115 秒（2026-09-22 實量，見 pipeline/release.js 的 RELEASE_ABORT_BEFORE_END_MS），
 * 掛在請求上仍可能逾時，而逾時的那一端看到的是「失敗」——
 * 但那時測試其實還在跑，重按就變成兩份全跑同時在燒同一台機器。
 * 結果寫進 release_last_result，前端輪詢同一支 GET 就看得到（成功的話平台會重啟，
 * 畫面本來就會斷線重連）。
 */
async function runManualRelease({ userId, skipTests, abortInflight }) {
  const started = new Date().toISOString();
  const pending = await release.pendingReleases();
  let aborted = [];
  await enterMaintenance(MANUAL_MAINTENANCE_MS);
  try {
    if (abortInflight) {
      // 先停派工（上面的 enterMaintenance）再中止，順序與 releaseTick 一致：反過來的話
      // 被中止的任務會在下一個 cron tick 立刻被重派，跑到一半又被重啟砍掉。
      const { getInflightInfo, abortTask } = require('./pipeline/runner');
      for (const e of getInflightInfo()) {
        abortTask(e.taskId);
        // 這行字是任務的主人唯一看得到的東西（比照 release.js 的 abortInflightForRelease）。
        await query(
          "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
          [e.taskId, '平台管理員手動觸發更版，本輪執行已中止以便更新平台程式。'
            + '改到一半的程式碼留在任務分支，沒有合併；平台重啟後會自動從同一關重跑，不需要人工處理。']
        ).catch(err => console.error('[RELEASE] 寫中止說明失敗：', err.message));
        aborted.push(e.taskId);
      }
    }
    // inflight 傳空＝裁決已經下了（上面中止過，或使用者在畫面上確認過沒有在飛任務）。
    // 沒中止而確實有任務在飛時，restartNow 自己那道守衛擋不到——所以路由層在按下之前就擋。
    const result = await release.restartNow({ userId, inflight: [], skipTests });
    await recordResult({
      source: 'manual',
      by: userId,
      startedAt: started,
      at: new Date().toISOString(),
      restarted: result.restarted,
      testsPassed: result.testsPassed,
      reason: result.reason,
      released: result.released ?? 0,
      pending: pending.length,
      aborted,
      summary: (result.tests && result.tests.summary) || null,
    });
    if (!result.restarted) {
      // 沒重啟就要把維護旗標收回來，否則派工會一路停到到期時間才自己恢復。
      await leaveMaintenance().catch(err => console.error('[RELEASE] 清維護旗標失敗：', err.message));
    }
    return result;
  } catch (err) {
    console.error('[RELEASE] 立刻更版失敗：', err.message);
    await recordResult({
      source: 'manual', by: userId, startedAt: started, at: new Date().toISOString(),
      restarted: false, testsPassed: null, reason: `立刻更版過程出錯：${err.message}`,
      released: 0, pending: pending.length, aborted, summary: null,
    }).catch(() => {});
    await leaveMaintenance().catch(() => {});
    throw err;
  }
}

function registerRoutes(app) {
  /**
   * 更版頁的一次載入。管理員來這頁是要回答三個問題，回應就照那三個問題長：
   *   什麼在等著上去 → pending
   *   什麼時候會上去 → window（含 nextWindowAt、inWindow）
   *   上一次成功了嗎 → last
   * 其餘欄位（inflight／maintenance／abortMinutes／notify）都是「這件事會不會被別的東西擋住」。
   */
  app.get('/api/admin/release', auth, async (req, res) => {
    try {
      const now = new Date();
      const cfg = await release.releaseWindowConfig();
      const next = cfg ? nextWindow(cfg, now) : null;
      const { getInflightInfo } = require('./pipeline/runner');
      res.json({
        window: {
          configured: !!cfg,
          weekdays: cfg ? cfg.weekdays : release.DEFAULT_RELEASE_WINDOW.weekdays,
          startHour: cfg ? cfg.startHour : release.DEFAULT_RELEASE_WINDOW.startHour,
          durationHours: cfg ? cfg.durationHours : release.DEFAULT_RELEASE_WINDOW.durationHours,
          label: windowLabel(cfg),
          nextWindowAt: next ? next.toISOString() : null,
          inWindow: cfg ? isInWindow(cfg, now) : false,
          // 預設值是給設定頁預填用的，**不是**沒設定時的行為（release.js 檔頭：
          // 「沒有人按下同意，平台卻自己在週末重啟客戶」是這裡唯一不能犯的錯）。
          defaults: release.DEFAULT_RELEASE_WINDOW,
        },
        pending: await pendingWithSources(),
        last: await release.lastReleaseResult(),
        inflight: getInflightInfo(),
        maintenance: await isMaintenance(),
        running: !!_manualRun,
        abortMinutes: Math.round(release.RELEASE_ABORT_BEFORE_END_MS / 60000),
        // 裁決二寫成資料而不是只寫在畫面上的字：前端要能理直氣壯地說「沒有任何東西會通知你」，
        // 而哪天真的接了 webhook，改的是這裡、不是散在畫面各處的文案。
        notify: { channels: [], note: '本機沒有 webhook／Teams，更版結果只會出現在這一頁與排程頁。' },
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 寫時段設定。回應一律附上「引擎實際讀到的設定」：驗證過了不代表 releaseWindowConfig()
  // 認得（兩邊規則若哪天漂移，症狀是畫面顯示存好了而機制其實是關的）。
  app.put('/api/admin/release/window', auth, async (req, res) => {
    try {
      const bad = validateWindow(req.body || {});
      if (bad) return res.status(400).json({ error: bad });
      const cfg = {
        weekdays: req.body.weekdays,
        startHour: req.body.startHour,
        durationHours: req.body.durationHours,
      };
      await query(
        `INSERT INTO teams_settings (id, release_window) VALUES (1, $1)
           ON CONFLICT (id) DO UPDATE SET release_window = $1`, [JSON.stringify(cfg)]);
      const effective = await release.releaseWindowConfig();
      res.json({ window: effective, label: windowLabel(effective) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 取消（停用自動更版）。清成 NULL＝release.js 讀到 null＝整條機制關閉，
  // 已合併的碼會一直停在待更版直到有人按「立刻更版」。前端必須把這句話講出來。
  app.delete('/api/admin/release/window', auth, async (req, res) => {
    try {
      await query(
        `INSERT INTO teams_settings (id, release_window) VALUES (1, NULL)
           ON CONFLICT (id) DO UPDATE SET release_window = NULL`);
      res.json({ window: null, label: windowLabel(null) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /**
   * 立刻更版。管理員有時等不到週六。
   *
   * 擋在前面的四件事各自擋掉一種真實事故，而且每一種都回得出人看得懂的理由：
   *   1. 已經有一次在跑 → 兩份全跑同時燒同一台機器。
   *   2. 沒有待更版的碼 → 白白把客戶踢下線（這正是本子專案要防的那起事故）。
   *   3. 夜間批次還在維護中 → 它正在 git merge／push，中途被砍會留下只有本機看得到的 commit。
   *   4. 有任務在飛而使用者沒有明確說要中止 → 回 409 並附上清單，讓人自己決定。
   */
  app.post('/api/admin/release/now', auth, async (req, res) => {
    try {
      if (_manualRun) {
        return res.status(409).json({ error: '已經有一次更版在跑（開始於 ' + _manualRun.startedAt + '）' });
      }
      const pending = await release.pendingReleases();
      if (!pending.length) {
        return res.status(400).json({ error: '沒有待更版的碼，不必重啟——重啟會砍掉在飛的 AI 與測試區 Odoo 的 cron 執行緒' });
      }
      if (await isMaintenance()) {
        return res.status(409).json({ error: '現在正在維護中（多半是夜間改善批次還沒收工），等它結束再按——中途重啟會讓它的 git push 停在半途' });
      }
      const { getInflightInfo } = require('./pipeline/runner');
      const inflight = getInflightInfo();
      const abortInflight = req.body && req.body.abortInflight === true;
      if (inflight.length && !abortInflight) {
        return res.status(409).json({
          error: `有 ${inflight.length} 條任務在飛，更版會當場砍掉它們`,
          inflight,
        });
      }
      const skipTests = !!(req.body && req.body.skipTests);
      _manualRun = { startedAt: new Date().toISOString(), by: req.userId, skipTests };
      // fire-and-forget：全跑兩分鐘上下、機器忙時更久，掛在請求上會逾時（比照 admin-routes 的健檢與索引重建）。
      runManualRelease({ userId: req.userId, skipTests, abortInflight })
        .catch(err => console.error('[RELEASE] 立刻更版：', err.message))
        .finally(() => { _manualRun = null; });
      res.json({ started: true, pending: pending.length, skipTests, abortInflight });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /**
   * 公告橫幅用的輕量旗標。**一般登入者也讀得到**（不掛 requirePlatformAdmin）：
   * 會被重啟踢下線的是所有人，不是管理員。所以這支只回「什麼時候會停、要不要在意」，
   * 不回待更版的內容、筆數或任何診斷文字——那些是管理員的東西。
   *
   * `show` 為 false 的情境包含「沒有待更版的碼」：那種時候時段到了也不會重啟
   * （releaseTick 的第 4 步），掛一條說要重啟的橫幅就是騙人。
   */
  app.get('/api/release/notice', verifyToken, async (req, res) => {
    try {
      const now = new Date();
      const cfg = await release.releaseWindowConfig();
      if (!cfg) return res.json({ show: false });
      const pending = await release.pendingReleases();
      if (!pending.length) return res.json({ show: false });
      const inWindow = isInWindow(cfg, now);
      const next = nextWindow(cfg, now);
      const startsIn = next ? next.getTime() - now.getTime() : null;
      res.json({
        show: inWindow || (startsIn !== null && startsIn <= NOTICE_LEAD_MS),
        inWindow,
        startsAt: next ? next.toISOString() : null,
        label: windowLabel(cfg),
      });
    } catch { res.json({ show: false }); }   // 查不到就不掛橫幅：假警報比沒警報更快被無視
  });
}

module.exports = { registerRoutes, validateWindow, windowLabel, _manualRunForTesting: () => _manualRun };
