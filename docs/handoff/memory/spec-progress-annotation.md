---
name: spec-progress-annotation
description: 產品化規格做完一塊就要在規格上標註完成並重產網頁——使用者只能從那個頁面看進度，terminal 裡的回報他看不到
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9728f041-702c-4382-a801-270d6d744518
  modified: 2026-09-16T01:22:56.480Z
---

2026-09-16 使用者原話：「產品化規格到時候做好的部分記得更新標註 我現在沒辦法看到進度」。

**Why**：使用者不看 terminal，他看平台網頁（更多工具→「產品化規格」，限管理員）。在對話裡回報「做完了」對他等於沒發生。規格本身是 gitignored、只在這台，所以規格頁是唯一的進度介面。

**How to apply**：每完成一個階段／Task 就做這三步，不要累積到收工才補。

1. 改 `docs/superpowers/specs/2026-09-11-productize-rollout-plan.md` 的 **`## 0. 目前進度`** 表（2026-09-16 新增，這是唯一的進度來源），並在該階段的細部小節補「✅ 已完成」與驗證結果；重大決定另補進總覽 `2026-09-11-productize-overview.md` §2 的表。
2. 重產頁面：`cd docs/superpowers/specs/_page && node build-specs-page.js`，**再手動複製**到 `docs/odoo-v2-saas-specs.html`（產生器只寫在 `_page/`，不會自己複製）。
3. 不必重啟——`docs-routes.js:29` 是每次請求才讀檔。

標註要寫「驗證到什麼程度」，不要只寫完成：未重啟、未實測、未由真人點過，都要寫出來（Rule 12）。

## 產品化結束後要把整個規格頁拿掉

2026-09-24 使用者原話：「是說產品化做完就把規格頁拿掉吧」。

**Why**：這個頁面唯一的用途是給他看產品化進度。產品化收尾之後它就是一塊沒人維護的死內容，
而它掛在「更多工具」選單裡、限管理員——留著只會讓下一個人以為那是現行文件。

**時機**：**不是現在**。拿掉＝他就沒有進度介面了，所以要等驗收全部過、確定不會再回頭改規格才動。

**範圍（8 個檔，2026-09-24 盤過）**：
- 後端：`app/server/docs-routes.js`（整個檔只有這一支端點）＋ `index.js` 的註冊
- 前端：`app/public/js/ui-next/pages/SaasSpecs.js`（整個檔）、`app/public/js/app.js` 的路由、
  `app/public/js/ui-next/UiNextApp.js` 選單裡的「產品化規格」按鈕、`app/rwd/routes.js` 的 `saas-specs`
- 測試：`docs-routes.test.js`、`frontend-saas-specs.test.js`（兩個整檔刪）、
  `frontend-tenant-guard.test.js` 有提到要確認是不是釘死了數量
- 檔案：`docs/odoo-v2-saas-specs.html`（追蹤中，commit `11f7b982` 起）

規格書本體（`docs/superpowers/specs/`）與產生器是否一起刪，**沒問過，不要自己決定**。

相關：[[productize-saas-decision]]、[[ask-decisions-one-at-a-time]]、[[docs-handoff-tracked]]
