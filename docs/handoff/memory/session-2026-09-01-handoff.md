---
name: session-2026-09-01-handoff
description: 2026-09-01 UI Next 一整天改動的交班清單：已 commit 未 push、server 未重啟、三件未驗證、兩個待拍板缺陷、DEMO 任務待刪
metadata: 
  node_type: memory
  type: project
  originSessionId: 46056b69-a0d7-4b7d-84a3-d928da532aea
---

2026-09-01 一整天都在 UI Next 介面。commit `661d81a9` → `725b6035`（15 個，全在 master）。

## 狀態

- **已 push 到 `origin/master`**（HEAD `725b6035`），工作區乾淨。
- ~~尚未重啟 server~~ → **2026-09-02 使用者已重啟**，停止鈕的 404 已解（但仍未真的跑過一輪，見下）。
  ⚠ 那之後又有一批 `app/server` 改動（搜尋端點＋對話自動命名，見 [[ui-next-production-cutover]]），**需要再重啟一次**。
- 測試基線 09-01 是 **3471 passed**；09-02 補了兩支新測試後是 **3496 passed**，紅燈仍是同樣 10 支。`cron.test.js` 與 `frontend-ui-next-frozen-copies.test.js` 兩支**在我動手前就是紅的**，別當成自己弄壞的。

## 三件沒驗證的

1. **停止鈕沒真的跑過一輪**（只有單元測試）。
2. **`main_contact`（主要聯絡人）比對沒實測** —— 要一張「只填主要聯絡人、回饋帳號留空」的真工單才驗得到。
3. **執行中的藍色流動色標沒在真的執行中任務上看過**（是注入 class 驗外觀的）。

## 待辦

沒收尾的全部集中在 [[open-loops-2026-09-01]]（必做 1、未驗證 3、等拍板 2、DEMO 任務待刪），
那份有寫每件的驗法與「驗不過代表什麼」。

## 改動的原則都在這兩份

- [[ui-next-async-chat-contract]] —— 對話送出／輪詢／停止的四方契約
- [[ui-next-css-traps]] —— 動版面前必看的四個坑

其餘（側欄改樹狀、專案頁全部收進頁籤、任務卡與任務詳情版面、對話框比照 AskMe）都是純外觀，
commit message 寫得夠清楚，不另記。相關：[[nightshift-ui-next-handoff]]
