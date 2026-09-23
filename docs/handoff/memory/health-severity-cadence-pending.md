---
name: health-severity-cadence-pending
description: 健檢四階顏色／per-提案 severity／歷史列表兩欄／7-30 天大健檢已 push a2e641a，但未重啟、前端未實測、排程未實跑
metadata: 
  node_type: memory
  type: project
  originSessionId: fa81652c-e8b8-4591-a63e-c38cb4312356
---

2026-08-26 完成並 push（`a2e641a`，master）：健檢分級拆成 綠→黃→橘→紅 四階、提案各自帶
severity、歷史列表加「嚴重度／處理狀態」、cron 依臺灣日期跑 7 天（週日）與 30 天（1 號）大健檢、
只有月健檢做趨勢比對。測試 3196→3212、零紅燈。

**還沒驗的四件事**（別把這些當成已完成）：

1. **server 未重啟** — 改了 `app/server/**` 六個檔，`health_check_runs.cadence` 的 migration 也要
   重啟才會跑。重啟一律請使用者在主機 `docker restart`（見 [[platform-restart-kills-container]]）。
2. **前端零自動測試、我沒開過瀏覽器** — 四階顏色、兩個新欄位、節奏下拉都要人工點過含深色模式。
3. **排程未實跑** — 週日／1 號的行為只有單元測試撐著，真正觸發要等 2026-08-30 與 2026-09-01。
   想提早驗就在健檢頁選「7 天大健檢」，走的是同一條 `runAudit`。
4. **趨勢比對的產出品質未知** — 只驗到「monthly 會多算一期、資料有進 prompt」，agent 拿到之後寫不
   寫得出有用的比對沒有證據。

**設計上刻意的取捨**：待辦計數只算 medium 以上的 pending 提案，low 在明細裡照樣列出可裁決，只是不
讓整輪顯示成待處理——使用者裁決「輕微的話可不處理」。另外手動填 `sinceDays=30` 與選「30 天大健檢」
是兩件不同的事：只有後者帶 cadence、才會做趨勢比對。
