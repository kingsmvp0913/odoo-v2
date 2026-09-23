---
name: pipeline-chat-panel-and-today-range
description: 2026-08-10 完成並 push 的兩個平台小功能（進行中 Pipeline 頁加「排障對話」第二區／用量報表「今天」走本機日曆日）；待重啟＋前端人工實測；含報表日期切法其實以台北 08:00 為界這個既有錯位
metadata: 
  node_type: memory
  type: project
  originSessionId: 8f81dc2f-29e8-499b-b862-a16f3ec33747
---

2026-08-10 兩個使用者點名的小功能，3 個 commit 已 push（`76a86c9` → `fdfe7ef` → `82e5cf6`）。
測試 **2565 passed / 174 suites / exit 0**（動工前基線 2561 / 174，新增的就是這 4 例）。

**A. `/admin/pipelines` 分兩區**：新端點 `GET /api/admin/chat/active`（`admin-routes.js`，接在
pause 之後）。chat **不經 runner、沒有 `_inFlight`**，server 端唯一的進行中訊號是
`project_chats.reply_pending`。等待時間錨在最後一則 `role='user'` 訊息——`chatReply` 是
**先 INSERT 該訊息才跑 agent**，所以那就是本輪提問時刻。權限比照 `pipeline/active`：這頁路由
**沒有** `requiresAdmin`，一般使用者進得來，非 admin 必須 `AND c.user_id = $1`。

**B. 用量報表「今天」**：只動 `TokenReport.js` 的 `dateRange`，送**帶時間的完整 ISO**
（本機當日 00:00 到此刻）。後端 `token-report-routes.js:20` 對帶 `T` 的字串直接採用、不補
`23:59:59.999Z`，所以區間才會對。

**這裡有個既有錯位值得記住**：報表其餘選項走 date-only ＋ `toISOString()`，實際上是 **UTC 切**，
等於**以台北 08:00 為界**——台北凌晨 0~8 點的用量會落到前一天。跨多日的區間看不出來，單日則整段
錯位，所以「今天」才必須另走一條。使用者裁決**只修「今天」**，7/30 天與「每日趨勢」的
`recorded_at::date` 分組維持 UTC 不動。另：選「今天」只有一個資料點，`chartData` 需要 ≥2 點，
所以趨勢圖會顯示既有的「資料不足」——不是破圖。

**待辦**：
1. **要 `docker restart odoo-v2` 才生效**（使用者 2026-08-10 選擇「先不重啟」）。重啟方式與
   風險見 [[platform-restart-kills-container]]。
2. ~~**前端未人工實測**~~ → ✅ **2026-08-11 使用者確認測過**（第二區表格與手機卡片化、「今天」
   選項，含深色模式）。**本項已結案**；server 也已於 08-11 12:33 重啟，第 1 點同步解除。

**How to apply**：第三個 commit（`82e5cf6`）是必看的一課——兩區原本共用一個 `try`，但新端點在
**重啟之前必然 404**，共用的話那支失敗會連帶讓上面的在飛任務表停止更新，而畫面上完全看不出來。
凡是「舊 server 尚未載入新端點」的窗口存在時，前端並行取多支 API 一律各自吞自己的錯，並讓
「讀取失敗」與「真的沒資料」在空狀態文案上分得開。
