---
name: fix-retry-blind-to-reject-reason
description: "改善通道 09-14 又卡住（意見 #34 同晚兩次同理由被駁回）的真因＝重改輪看不到上一輪駁回理由；09-15 人工修 b0d96a54，未 push 未重啟"
metadata: 
  node_type: memory
  type: project
  originSessionId: c5cc164a-1ce6-4f07-9bd0-fbe89854a1d1
  modified: 2026-09-15T03:45:30.159Z
---

2026-09-15 使用者問「改善提案為什麼又卡住」。意見 #34（resumed 記帳）09-14 晚 fix 43、44 都被 fix-review 以「analysis 降級沒有測試」駁回。

**真因**：`runFix` 組 platform-fix 提示詞時完全沒帶之前的 `reject_reason`，重改輪與首輪逐字相同⇒同錯必再犯。隔晚意見會開成**新的 finding 列**，連 finding_id 都對不上。健檢提案 147（09-11）、169（09-14）早就點名，但修法在 DENY 檔、標「只能人工修」後停在 pending 沒人接——這是 [[auto-fix-deny-deadlock]] 同一類。

**修法**（`b0d96a54`，09-15 已 push origin/master，**未重啟**）：`finding-fix.js` 的 `previousRejections` 撈同 finding_id 或 members 重疊（source+id）的最近 3 筆駁回理由 → `{{previous_rejections}}` 進 `platform-fix.md`，並教它逐條處理（「diff 看不出來」就補還原會紅的測試）。測試 `finding-fix-previous-rejections.test.js`；全跑 4843→4851 零紅。正式資料驗過：#34 今晚會拿到 fix 44/43/40 的理由。

**卡住的歷史分類**（44 筆 finding_fixes，16 merged）：守門 DENY 5、複檢基線 bug 3、NUL byte 2（皆已修）；剩下的實質駁回裡重犯同理由的就是本條。

**#34 本身也人工修掉**（`19a59a7c`，已 push，未重啟）：withResume 回傳 `resumed`；續接失敗列 `logFailedUsage(...,true)`；chat／cs／spec-review／clarify-chat／analysis 記 true/false。**coding 與 respec-patch 刻意留 NULL**（沒有續接概念，照 db.js 欄位定義）——fix 44 寫 false 被駁回的就是這點。analysis 降級列本來就是 false（`resumed=true` 在續接成功之後才設），審核的疑點是 diff 看不到，已補測試。6 支新測試、19 條，還原實作全紅；全跑 4870 零紅。DB 已結案：feedback 34／提案 164／147／169 → done（口徑同 markGroupDone）。

**未處理、已知的**：fix-review 只看 diff，「從 diff 看不出來」一律 reject 仍會製造駁回；本次靠提示詞引導補測試繞過，沒改審核關。提案 147／169 仍是 pending，要人工結案。

相關：[[improve-channel-stalled-silently]]、[[shared-index-race-on-commit]]
