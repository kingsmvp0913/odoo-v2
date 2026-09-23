---
name: ui-next-production-cutover
description: UI Next 轉正式的四項拍板與翻正式的那一個字；2026-09-16 起 legacy 不再維護，改前端只動 ui-next
metadata: 
  node_type: memory
  type: project
  originSessionId: 690e6cd9-a432-4001-b34a-408893902f2e
---

2026-09-01 使用者當面拍板的轉正式方案。**這些取代任何更早的推測**。

## 拍板內容

- **舊版要保留，方式＝反轉旗標**：預設載 UI Next，`?ui=legacy` 退回舊版。舊版碼一行不刪。
- **9 個管理員頁的漂移要逐頁比對補齊**（不是解除凍結契約放它過去）。方向**不是單向**：舊版側 08-17～08-26 也各自修過實質 bug（健檢分級 `a2e641a6`、企業版版本檢查 `6924cd08`），新版側 09-01 仍在改，兩邊都要看。
- **JS 與 CSS 一起拆檔**，錨點＝舊版 `js/views/*.js` 一檔一 View 的既有結構。
- **順序**：側欄搜尋 → 對話標題 → 退路旗標 → 拆檔 → 9 頁處理。**五項全部完成並已 push**
  （`294693d6`／`412f6a16`／`b8d75541`／`5039aefe`／`caa5dfe5`／`d5a30e7b`／`383ebb00`，HEAD = `383ebb00`）。

## 拆檔後的結構（2026-09-02 完成）

- `UiNextPages.js`（7359 行）**已不存在**。26 個 View 各自一檔在 `js/ui-next/pages/`，檔名＝元件名去掉 `UiNext` 前綴與 `View` 後綴，對齊 Legacy 的 `js/views/*.js`。
- 共用部分抽到 `js/ui-next/UiNextShared.js`（8 個格式化 helper、2 個小元件 StatusBar／WikiNode、常數 SOP_FILLABLE_PLACEHOLDERS），掛 `window.UiNextShared`，只有 5 個檔需要它。
  **刻意不放全域**：Legacy 同為 classic script，同名頂層 `const` 是 SyntaxError ⇒ 整支檔不執行、白畫面。
- `ui-next-pages.css`（3250 行）→ `css/ui-next-pages/01-…09-*.css`。**檔名數字＝層疊順序，絕對不可重排或按字母排序**：尾端 `09-later-patches` 整份是靠排最後才生效的補丁。
- **載入順序是硬約束**：`UiNextShared.js` 必須在 `pages/` 之前（有檔在載入當下就解構取 helper）。已有測試守住這兩件事。

## 9 個 Admin 子頁：不是漏採修正，是刻意分家

逐頁比對後確認**沒有任何一頁**是「Legacy 修了 bug、Next 沒跟上」。差異全是 Next 往前走：返回鈕改掛 head 區、`ui-next-admin-head` class、引號風格；另有 Agent 管理預設選 CLAUDE.md、新增使用者改彈窗（這兩項本來就各有測試正面斷言）。
⇒ 凍結契約與那些斷言直接矛盾，依該測試自己的第三條路從 `FROZEN_COPIES` 移除並註明理由。
**代價**：這九頁從此沒有自動訊號，動 `js/views/Admin*.js` 要自行確認 `js/ui-next/pages/` 的同名檔。

⚠ 判讀陷阱：AdminHealthCheck 看起來少 49 行，那是 Legacy 檔在元件**外**的頂層常數（`HC_SEV` 等），Next 刻意不複製、直接吃全域 —— 不是漏掉。用整檔 diff 會誤判，要比的是 `window.X = Vue.defineComponent({…})` 那個賦值本身。

## 測試狀態

**紅燈 10 → 1**：只剩 `cron.test.js`（動手前就是紅的，與 UI Next 無關）。通過數 3471 → 3630。

## 仍未做的

- **對話自動命名沒真的跑過一次 AI**：單元測試全是 mock。搜尋端點則已用真資料實測過（任務／對話／專案三類都回得出來，且對話是靠訊息內容命中的）。
- `agentType: 'chat-title'` 未登記在 `claude-runner.js` 的 `NO_MCP_STAGES`，會照預設載 MCP。不影響正確性，只是多花啟動時間。

## 翻正式就是改一個字

`app/public/index.html` 的 `window.UiVersion` 區塊內：`var DEFAULT_UI = 'legacy'` → `'next'`。

原本三處各自讀網址（head 的 CSS 段、body 的 script 段、`UiNextApp.js` 開頭），
漏改一處的症狀是**載了新版資產卻走舊版 View**，畫面錯位但完全不報錯。已收斂成這一個來源。

## 為什麼 2026-09-01 沒有直接翻

`app/public` 是靜態直接服務的：**改檔即對所有人生效，不需要重啟、也不需要 push**。
所以「反轉旗標」不是一個可以先 commit 等人審的動作，它就是上線本身。
當時 9 頁仍在漂移、新版零瀏覽器實測、使用者已離線 ⇒ 留給他自己按。

**Why**：這條在動 `app/public` 的任何開關類改動時都成立，很容易誤以為「commit 了但沒 push 所以還沒生效」。
**How to apply**：要改 `app/public` 下影響全體使用者的預設值前，先確認使用者在線且已同意當下生效。

## 2026-09-16 使用者裁決：legacy 不用維護了

**已翻正式**：`app/public/index.html` 的 `DEFAULT_UI` 現在是 `'next'`。

使用者當面說「legacy 不用維護了」。上面 09-01 那條「舊版碼一行不刪、9 頁漂移要逐頁比對補齊」**到此為止**：

- 改前端只動 `app/public/js/ui-next/`。`app/public/js/views/*.js` 不必同步、不必比對、不必補。
- 兩邊行為不一致**不算缺陷**，不要開提案、不要當紅燈查。
- 舊檔仍在樹上（`?ui=legacy` 還進得去），但那是沒人顧的退路，不是需要維持等價的第二套。

**Why**：維持兩套等價的成本一直在付，而 09-02 逐頁比對已證實 legacy 沒有 next 缺的東西——繼續同步只是替一個沒人用的退路做工。

**How to apply**：以後看到「legacy 版沒跟上」不要主動修；只有使用者指名要動 legacy 才動。實例：2026-09-16 加健檢頁「觀察中」狀態（[[health-signal-vs-proposal]]）時 legacy 刻意沒改。

相關 [[session-2026-09-01-handoff]]、[[ui-next-css-traps]]、[[nightshift-ui-next-handoff]]。
