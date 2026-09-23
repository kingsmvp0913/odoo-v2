# 階段 5：平台更版機制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 平台的改動不再「合併就立刻重啟」——合併照舊自動，**重啟改成等平台管理員選定的維護時段**，重啟前對 master 跑一次全套測試，紅了就不重啟並通知人。

**Architecture:** `applyFix` 目前一個函式做完「合併 → 重啟」兩件事。把重啟那半段抽成獨立的 `restartForRelease()`，由一支新的 cron（維護時段）觸發；合併完的修正停在既有的 `status='merged'`，那就是天然的待更版清單。維護旗標沿用 `pipeline/maintenance.js` 的到期時間機制，不新增布林旗標。

**Tech Stack:** Node + Express（`app/server`）、PostgreSQL（`aidev`，埠 8772）、jest + pg-mem + supertest、Vue 3（`app/public/js/ui-next`）、docker CLI（重啟自己的容器）。

**Spec:** `docs/superpowers/specs/2026-09-11-saas-operations-design.md` §4.3（含 09-15 R6 對該節兩列的覆寫）。

---

## Global Constraints

逐字抄自規格與既有規則，每一關都適用：

- **合併維持自動**（R6 覆寫）。更版頁**不是**合併的閘門，只管重啟。不要把自動合併改掉。
- **健檢提案要平台管理員核准才進夜間批次**（R6 覆寫）——**這一列已經實作完成**，見 `app/server/pipeline/health-check-runner.js:76-79`（建立時 status 寫 `'pending'`，註解已引規格）與 `app/server/feedback-routes.js:123`（核准端點）。**不要重做，也不要「補強」它。**
- 重啟時段：**每週六、日**（規格 O6）。實際幾點由平台管理員在畫面上設定。
- 重啟前對 master 跑 `npm run test:quiet` 全套；**紅了不重啟**，通知平台管理員。
- 重啟後**自動重開所有執行中的測試區 Odoo**——重啟會讓 Odoo 的 cron 執行緒永久死掉（規格 §3.2，記憶 `testenv-disconnect-from-platform-restart`）。
- 維護前在畫面上方掛公告。
- **維護旗標一律用「到期時間」不用布林**（`app/server/pipeline/maintenance.js` 檔頭三道保險）。布林會卡在 true 而派工安靜停擺——此 repo 踩過（夜班空轉 98 輪無人察覺）。
- **取 exit code 不經管線**：`cmd > out 2>&1; echo "EXITCODE=$?" >> out`，再讀檔。此 repo 已誤判三次。
- 全跑一律 `cd app && npm run test:quiet`，判紅綠只看 `Tests:` 那行。**動手前先量自己的基線。**
- 改 `app/server/**.js` 後必須重啟 server 才生效。
- commit 前 `git status --porcelain -uno` 逐檔挑選，**禁用 `git add -A`**。
- 繁體中文註解寫 WHY。禁止寫死絕對路徑。零順手重構。

---

## 現況事實（2026-09-21 實查，實作前請自行複驗）

| 事實 | 位置 |
|---|---|
| `applyFix(fixId, userId, inflight)` 合併＋重啟一手包辦 | `app/server/pipeline/finding-fix.js:546-653` |
| 它已經是兩段式的雛形：`status !== 'merged'` 才合併，合併完 `setStatus(fixId,'merged')` | 同上 `:555`、`:633` |
| 在飛任務擋重啟：`if (inflight.length) return { merged:true, restarted:false, inflight }` | 同上 `:636-638` |
| 重啟本體：`setTimeout` 後 `execFile('docker',['restart',container])` | 同上 `:647-651` |
| 唯一呼叫端 | `app/server/admin-routes.js:871-873` |
| 維護旗標：`enterMaintenance(ms)` / `leaveMaintenance()` / `isMaintenance()`，落 `teams_settings.maintenance_until` | `app/server/pipeline/maintenance.js` |
| cron 註冊表（排程頁靠它顯示） | `app/server/cron.js:277` 附近 |
| 夜間批次撈的是 `status='approved'` 的提案與意見 | `app/server/pipeline/nightly-fix.js:132`、`:178` |
| 單筆修正查詢只回最新一筆 | `app/server/admin-routes.js:734-744` |

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `app/server/lib/release-window.js`（新） | 純函式：給定「設定的時段」與「現在」，回答現在是不是維護時段、下一次是什麼時候。不查 DB、不碰時間以外的東西。 |
| `app/server/pipeline/release.js`（新） | 更版流程本體：待更版清單、跑測試、重啟、重開測試區。 |
| `app/server/pipeline/finding-fix.js`（改） | 把重啟那半段搬走，`applyFix` 只留合併。 |
| `app/server/release-routes.js`（新） | 更版頁的端點（清單、設定時段、立刻更版、取消）。 |
| `app/server/cron.js`（改） | 註冊維護時段的 tick。 |
| `app/server/admin-routes.js`（改） | `findings/:id/fix` 改回歷史全部；補意見回饋來源的修正。 |
| `app/public/js/ui-next/pages/Release.js`（新） | 更版頁。 |
| `app/public/js/ui-next/UiNextApp.js`（改） | 維護公告橫幅、更多工具入口。 |
| `app/public/js/app.js`（改） | 路由 `+ requiresAdmin`。 |

---

### Task 1：維護時段的純函式

**Files:**
- Create: `app/server/lib/release-window.js`
- Test: `app/server/tests/release-window.test.js`

**Interfaces:**
- Produces: `isInWindow(cfg, now) -> boolean`、`nextWindow(cfg, now) -> Date`，`cfg = { weekdays:[6,0], startHour:2, durationHours:2 }`（`weekdays` 用 JS 的 `getDay()`：0=日、6=六）

**為什麼先做這個**：時段判斷是整個機制唯一會算錯又不容易發現的地方（跨午夜、跨週、時區）。把它做成不碰 DB 的純函式，就能用表格把邊界一次釘死。

- [ ] **Step 1：先寫會紅的測試**

```javascript
const { isInWindow, nextWindow } = require('../lib/release-window');
const CFG = { weekdays: [6, 0], startHour: 2, durationHours: 2 }; // 週六日 02:00-04:00

// 意圖：時段判斷算錯的後果不是報錯，是「該重啟的週末沒重啟」或「上班時間把人踢下線」，
// 兩種都不會有任何 log。所以邊界要逐一釘死，不能只測中間值。
test.each([
  ['2026-09-26T02:00:00+08:00', true,  '週六 02:00 整＝進場邊界，含'],
  ['2026-09-26T03:59:59+08:00', true,  '週六 03:59:59＝還在裡面'],
  ['2026-09-26T04:00:00+08:00', false, '週六 04:00 整＝出場邊界，不含'],
  ['2026-09-26T01:59:59+08:00', false, '週六 01:59:59＝還沒到'],
  ['2026-09-27T02:30:00+08:00', true,  '週日也是時段'],
  ['2026-09-25T02:30:00+08:00', false, '週五同一時刻不是時段'],
])('%s → %s（%s）', (iso, expected) => {
  expect(`${iso}: ${isInWindow(CFG, new Date(iso))}`).toBe(`${iso}: ${expected}`);
});

test('下一次時段：週五算出的是隔天週六', () => {
  const next = nextWindow(CFG, new Date('2026-09-25T10:00:00+08:00'));
  expect(next.toISOString()).toBe(new Date('2026-09-26T02:00:00+08:00').toISOString());
});

test('下一次時段：時段進行中算出的是「現在這一場」的開始，不是下週', () => {
  const next = nextWindow(CFG, new Date('2026-09-26T03:00:00+08:00'));
  expect(next.toISOString()).toBe(new Date('2026-09-26T02:00:00+08:00').toISOString());
});
```

- [ ] **Step 2：跑它，確認紅在「找不到模組」**

`cd app && npx jest server/tests/release-window.test.js --runInBand > /tmp/t.log 2>&1; echo "EXITCODE=$?" >> /tmp/t.log`，讀檔。

- [ ] **Step 3：最小實作**

```javascript
/**
 * release-window.js — 「現在是不是維護時段」的唯一真相。
 *
 * 刻意不碰 DB、不碰 process.env：時段算錯的後果（該重啟的週末沒重啟／上班時間把人踢下線）
 * 完全不會留下 log，所以它必須是能用表格窮舉測試的純函式。
 * 時區用平台所在機器的本地時間（台北），與排程頁顯示的一致——不要在這裡做時區轉換。
 */
function isInWindow(cfg, now) {
  if (!cfg || !Array.isArray(cfg.weekdays) || !cfg.weekdays.length) return false;
  if (!cfg.weekdays.includes(now.getDay())) return false;
  const start = new Date(now);
  start.setHours(cfg.startHour, 0, 0, 0);
  const end = new Date(start.getTime() + cfg.durationHours * 3600000);
  // 進場含、出場不含：兩邊都含的話，設成連續兩天會在交界那一秒重複觸發。
  return now >= start && now < end;
}

function nextWindow(cfg, now) {
  if (!cfg || !Array.isArray(cfg.weekdays) || !cfg.weekdays.length) return null;
  if (isInWindow(cfg, now)) {
    const s = new Date(now); s.setHours(cfg.startHour, 0, 0, 0); return s;
  }
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    d.setHours(cfg.startHour, 0, 0, 0);
    if (cfg.weekdays.includes(d.getDay()) && d > now) return d;
  }
  return null;
}

module.exports = { isInWindow, nextWindow };
```

- [ ] **Step 4：跑到綠**
- [ ] **Step 5：commit** — `git add app/server/lib/release-window.js app/server/tests/release-window.test.js`

---

### Task 2：把重啟從 `applyFix` 拆出來

**Files:**
- Modify: `app/server/pipeline/finding-fix.js:546-653`
- Create: `app/server/pipeline/release.js`
- Test: `app/server/tests/release-restart.test.js`；既有 `app/server/tests/finding-fix-apply.test.js` 會受影響

**Interfaces:**
- Produces: `restartNow({ userId, skipTests })` → `{ restarted, testsPassed, tests, reason }`；`pendingReleases()` → `finding_fixes` 裡 `status='merged'` 的列

**⚠ 既有測試會紅，而這一關就是要它紅**：`finding-fix-apply.test.js` 現在斷言 `applyFix` 會重啟。**那是行為斷言，不是文字斷言**——這一關刻意改掉那個行為，所以那幾支要跟著改，但**只改「重啟」那部分的期待，不准放寬任何關於合併的斷言**。分不出來就停下回報。

- [ ] **Step 1：先讀完整個 `applyFix`**（`:546-653`），特別是這三段，它們都是踩過坑才長成這樣的，**一行都不要動**：
  - `:560-577` 已暫存 vs 未暫存的分辨（2026-09-08 因此整晚五組修正一組都沒併進去）
  - `:586-597` 「忘記 push」與「真的分岔」的分辨
  - `:625-632` push 失敗要把合併節點 reset 回去

- [ ] **Step 2：`applyFix` 只留到合併**

把 `:636` 之後整段（在飛檢查、標 finding done、`setTimeout` + `docker restart`）搬進 `release.js`。`applyFix` 改成合併完就 return：

```javascript
    await setStatus(fixId, 'merged');
  }
  // 更版機制（規格 §4.3 ＋ 09-15 R6）：合併維持自動，重啟改成等維護時段。
  // 這裡刻意不再碰 health_check_findings 的 status——「碼進了 master」與「新碼真的在跑」
  // 是兩件事，提早標 done 會讓更版頁再也看不到這一筆。標記改由 release.js 在真的重啟後做。
  return { branch: fix.branch, merged: true, restarted: false, awaitingRelease: true };
}
```

- [ ] **Step 3：`release.js` 的重啟段**

```javascript
/**
 * release.js — 「把已經合併的碼真的放上去」。
 *
 * 為什麼合併與重啟要分開（規格 §4.3）：合併只動 git，客戶無感；重啟會當場砍掉在飛的 AI
 * agent、讓測試區 Odoo 的 cron 執行緒永久死掉（§3.2），客戶正在用的東西會斷。
 * 所以合併自動、重啟等平台管理員選的時段。
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
```

- [ ] **Step 4：改既有測試的「重啟」期待，不動「合併」的**，跑 `finding-fix-apply.test.js` 到綠
- [ ] **Step 5：全跑 ＋ commit**

---

### Task 3：重啟前先跑全套測試

**Files:**
- Modify: `app/server/pipeline/release.js`
- Test: `app/server/tests/release-restart.test.js`

**為什麼**：合併是一條一條自動進來的，每條各自跑過測試——但**沒有人跑過「全部合起來」**。兩條各自綠的修正合起來紅，是這個機制存在的主要理由之一。

- [ ] **Step 1：先寫會紅的測試**

```javascript
// 意圖：紅了不重啟，而且要講得出是哪一支紅。
// 「跑了測試」與「測試通過」是兩件事——只檢查有沒有跑，紅燈照樣會被放上線。
test('全跑紅燈時不重啟，並帶回紅的支數', async () => {
  mockMeasure.mockResolvedValue({ passed: 5800, failed: 3, exitCode: 1 });
  const r = await restartNow({ userId: 1 });
  expect(`restarted: ${r.restarted}`).toBe('restarted: false');
  expect(`testsPassed: ${r.testsPassed}`).toBe('testsPassed: false');
  expect(mockRestart).not.toHaveBeenCalled();
});

test('全跑綠燈才重啟', async () => {
  mockMeasure.mockResolvedValue({ passed: 5860, failed: 0, exitCode: 0 });
  const r = await restartNow({ userId: 1 });
  expect(`restarted: ${r.restarted}`).toBe('restarted: true');
  expect(mockRestart).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2：實作**。`finding-fix.js` 已經匯出 `measureTests` 與 `parseJestCounts`（見該檔 `module.exports`）——**用既有的，不要自己再寫一套跑 jest 的程式碼**。

- [ ] **Step 3：exit code 不經管線**。`measureTests` 怎麼取的，照它；若它有用管線，**停下回報**，那是既有缺陷不是這一關該順手改的。

- [ ] **Step 4：全跑 ＋ commit**

---

### Task 4：維護時段的 cron

**Files:**
- Modify: `app/server/cron.js`
- Modify: `app/server/pipeline/release.js`
- Test: `app/server/tests/release-cron.test.js`

- [ ] **Step 1：tick 的判斷順序**（順序本身就是規格）

1. 讀設定；沒設定 → 什麼都不做（**不要有「預設每週六日自動重啟」的行為**，沒設定就是沒開）
2. `isInWindow(cfg, new Date())` 為 false → 結束
3. 這個時段已經跑過 → 結束。**旗標一律落 DB 不落記憶體**——重啟會把行程帶走，記憶體旗標歸零，同一個時段會無限重啟（`cron.js:107` 的註解記著同一個坑）
4. `pendingReleases()` 是空的 → 結束（沒東西要上就不要打擾客戶）
5. 有在飛任務 → **看離時段結束還有多久**（裁決三）：
   - 還早 → 結束並記錄，等下一個 tick（讓任務自己跑完是最好的結果）
   - **快結束了** → 中止在飛任務，繼續往下走
   ⚠ 「快結束」的門檻自己定並寫進註解，理由要能說出口：中止得太早等於白白殺掉本來跑得完的任務，
   太晚則來不及在時段內重啟完。
   ⚠ **中止之後那張任務怎麼辦，必須有答案**——寫進報告。先讀 `db.js` 的 stale-running 清理與
   `index.js` 的 `clearInterruptedUpgrades`，沿用既有機制，不要另造一套。
6. `enterMaintenance()` → 跑全套 → 綠才重啟

- [ ] **Step 2：註冊進 `cron.js:277` 的排程表**，讓排程頁看得到「下一次維護時段」

- [ ] **Step 3：寫測試**，至少涵蓋：不在時段不動、在時段但沒待更版不動、在時段有待更版且全綠會重啟、同一時段不重複觸發

- [ ] **Step 4：全跑 ＋ commit**

---

### Task 4b：第二條重啟路徑——夜間批次自己也會重啟

**Files:**
- Modify: `app/server/pipeline/nightly-fix.js`（`:993` 的 `if (mergedAny) await restartSelf();` 與 `:997` 的 `restartSelf()`）
- Modify: `app/server/pipeline/nightly-fix.js` 的 `markGroupDone`（合併當下就標 `done` + `applied_at`）
- Test: `app/server/tests/` 內既有的 nightly-fix 測試

⚠ **這一關是計畫寫漏的，2026-09-22 由 Task 2 的實作者發現、控制者複驗屬實。**
原本的〈現況事實〉表只盤點了 `applyFix` 這一條重啟路徑，漏了夜間批次自己那一條。
**沒有這一關，整個子專案的目的不成立**——`applyFix` 拆好了，夜間批次照樣在半夜把客戶踢下線。

**要做的**：

1. **`if (mergedAny) await restartSelf();` 不再當場重啟**。碼留在 master，等維護時段。
   `restartSelf()` 本體可以刪，也可以留給 Task 4 的時段流程呼叫——**自己決定並說明**，
   但不可以有任何「合併完就重啟」的路徑殘留。
2. **`markGroupDone` 的 `done` / `applied_at` 要與 Task 2 的裁決一致**。Task 2 把這兩者
   都移到重啟之後，理由是「碼進 master」與「新碼真的在跑」是兩件事，而 `applied_at`
   是回頭驗成效的起算點。**兩條路的語意不一致就等於報表看誰寫的而定**，必須統一。
3. **`admin-routes.js:889-892` 的註解與 `getInflightInfo()` 引數在 Task 2 之後已經過時**
   （Task 2 刻意沒動別關的檔）。一併更正。

⚠ **這個檔在自動改善通道的 DENY 清單內**（守衛碼在 DENY 造成的死結：自動通道永遠修不掉
自己的守門 bug）。**只能人工改，不要期待夜間批次會自己修它。**

- [ ] **Step 1：先確認還有沒有第三條重啟路徑**。`grep -rn "docker', \['restart'" app/server`
      與 `grep -rn restartSelf app/server`，把結果貼進報告。**這一關存在的理由就是上一輪漏盤**，
      不要只修被點名的那一條。
- [ ] **Step 2：改掉合併即重啟**
- [ ] **Step 3：統一 `done` / `applied_at`**
- [ ] **Step 4：全跑 ＋ commit**

---

### Task 5：重啟後自動重開執行中的測試區

**Files:**
- Modify: `app/server/pipeline/release.js`
- Modify: `app/server/index.js`（啟動時的收尾，比照既有的 `leaveMaintenance()` 呼叫，見 `index.js:406`）
- Test: `app/server/tests/release-restore-envs.test.js`

**為什麼**：平台重啟會讓測試區 Odoo 的 cron 執行緒**永久死掉**（規格 §3.2）。客戶看到的是「測試區還開著但什麼都不動」——比整個關掉更難查。

- [ ] **Step 1：重啟前把「當時是執行中」的測試區清單落 DB**。不能只靠重啟後掃描：重啟那一刻容器可能已經被連帶停掉，掃不到就等於這份清單消失。
- [ ] **Step 2：啟動時讀那份清單、逐一重開、清掉清單**
- [ ] **Step 3：一台失敗不影響其他台**，失敗的要留下看得見的紀錄
- [ ] **Step 4：全跑 ＋ commit**

---

### Task 6：更版頁與維護公告

**Files:**
- Create: `app/server/release-routes.js`
- Create: `app/public/js/ui-next/pages/Release.js`
- Modify: `app/public/js/app.js`（路由 + `requiresAdmin: true`）
- Modify: `app/public/js/ui-next/UiNextApp.js`（更多工具入口 + 公告橫幅）
- Modify: `app/public/index.html`
- Test: `app/server/tests/release-routes.test.js`、`app/server/tests/frontend-tenant-guard.test.js`（補斷言）

**⚠ 三層規則**（`.claude/rules/frontend.md` 38）：新入口要 nav 的 `v-if`、router meta guard、後端 403 **三層都有**，少一層就是洞。

- [ ] **Step 1：端點**——清單、讀/寫時段設定、立刻更版、取消。全部 `requirePlatformAdmin`。
- [ ] **Step 2：頁面**。待更版清單要顯示**每一筆的 diff 與審核意見**（規格 R6-B 的可回查）。
- [ ] **Step 3：公告橫幅**——維護時段前掛在畫面上方。沿用既有的 `maintenance` 橫幅機制（`UiNextApp.js` 的 `pollMaintenance`），**不要另造一套**。
- [ ] **Step 4：靜態守衛**。加到 `frontend-tenant-guard.test.js`。**每個掃描要先斷言自己的母體筆數**——掃到零筆也會綠的守衛比沒有守衛更糟，這個 repo 已經踩過。
- [ ] **Step 5：全跑 ＋ commit**

---

### Task 7：修正紀錄要看得到歷史與意見回饋來源

**Files:**
- Modify: `app/server/admin-routes.js:734-744`
- Test: `app/server/tests/admin-health-check-routes.test.js`

**為什麼**（規格 R6-B）：合併後要能回查「這段碼是依據哪段文字改的」。現在只回最新一筆，而且只看得到健檢提案來源的。提示詞注入的防線是「人擋在入口」，出口不擋——**出口不擋就更需要事後查得到**。

- [ ] **Step 1：改成回歷史全部**（時間新到舊）
- [ ] **Step 2：意見回饋來源的修正也要查得到**。`nightly-fix.js` 的 `feedbackIdsOf` 已經有來源對應關係，先讀它再決定怎麼接。
- [ ] **Step 3：既有測試若斷言「只回一筆」，那是行為斷言**——這一關刻意改掉它，跟著改；但**不准放寬任何關於「誰能看」的斷言**。
- [ ] **Step 4：全跑 ＋ commit**

---

### Task 8：整枝審查與規格標註

- [ ] **Step 1：整枝審查**。這個計畫改到派工、重啟、客戶可見的公告——**找「不屬於任何一關的需求」**，走規格 §4.3 每一列對照分支現況。
- [ ] **Step 2：人工驗收清單**。至少要有：維護時段到了而沒有待更版項目時不打擾、全跑紅燈時不重啟且通知得到人、重啟後測試區真的活著（**只有人能證**）。
- [ ] **Step 3：標註規格進度**，跑 `node scripts/build-specs-page.js` 並複製到 `docs/`（記憶 `spec-progress-annotation`：使用者只從平台網頁看進度）。

---

## 已拍板（2026-09-22，使用者裁決）

| 題目 | 裁決 | 影響 |
|---|---|---|
| 維護時段 | **每週六、日凌晨 02:00 起，兩小時**（02:00–04:00） | Task 1 的測試資料正好就是這組，不必改 |
| 全跑紅燈怎麼通知 | **只在畫面上** —— 更版頁標紅「上週未成功」＋管理員首頁掛一條。**不接 webhook／Teams** | 這台兩者都沒設定；代價是不登入就不會知道，**這一點要寫進更版頁的說明文字**，不要讓人以為會收到通知 |
| 在飛任務 vs 維護時段 | **時段快結束時強制中止在飛任務，照常重啟** | 推翻了原本 Task 4 第 5 步的「有在飛就結束」。詳見下方 Task 4 的修訂 |

⚠ **第三項裁決帶進一個必須處理的後果**：被強制中止的任務會停在 `*_running` 的孤兒狀態。
Task 4 必須回答「中止之後那張任務怎麼辦」——能不能自己接回去、還是要人重按。
`db.js` 既有的 stale-running 清理與 `index.js` 啟動時的 `clearInterruptedUpgrades` 是現成的錨點，
**先讀它們再決定**，不要另造一套。這是本計畫唯一一個「裁決本身帶出新工作」的地方。

## 刻意不做

- **不動自動合併**（R6 明文）。
- **不重做健檢提案的核准閘**（已完成）。
- 不做藍綠部署、不做零停機——規格沒要求，這台機器也不是那個規模。
- 不動 `applyFix` 裡那三段踩過坑的 git 判斷。
