---
name: login-attempt-lockout
description: 登入失敗鎖定（5 次鎖 10 分鐘／10 次封鎖）鎖的是「帳號＋來源」這一對，不是帳號——只鎖帳號會被拿來把全部管理員鎖死
metadata: 
  node_type: memory
  type: project
  originSessionId: 9728f041-702c-4382-a801-270d6d744518
  modified: 2026-09-16T02:46:01.467Z
---

2026-09-16 新增。起因：子專案 0 的 M6 實測發現 AI 容器連得到平台 8771，而 `POST /api/auth/login`
**原本完全沒有任何次數限制**（查 DB＋比對密碼就結束）⇒ 可無限猜密碼，猜中 9 個管理員之一就拿回全平台。

**規則（使用者訂）**：同一對 (帳號, 來源) 錯 5 次 → 鎖 10 分鐘；累計 10 次 → 永久封鎖，要管理員手動解。

**為什麼鎖「帳號＋來源」而不是帳號**（使用者裁決，這是重點，不要改回去）：
只鎖帳號的話，被注入的 AI 可以故意對 9 個管理員帳號各打錯 10 次，把所有人永久封鎖且**沒有任何人解得開**——
等於把機密性問題換成整個平台停擺。真人經 nginx 進來、AI 容器直連 8771，`req.socket.remoteAddress` 不同，
所以鎖了容器完全不影響真人。（平台**沒有設 `trust proxy`**，所以經 nginx 的真人看起來都是 nginx 那一個 IP。）

**實作**：`app/server/lib/login-guard.js`＋新表 `login_attempts`（主鍵 `(username, source)`）。
計數落 DB 不放記憶體——放記憶體的話攻擊者等一次平台重啟就歸零。
失敗**不論帳號存不存在都記**，否則「有沒有被鎖」會變成帳號列舉的管道。
管理員端點 `GET/DELETE /api/admin/login-locks`；使用者管理頁（`ui-next/pages/AdminUsers.js`）顯示
`鎖定 N`／`封鎖 N` 標籤與「解除鎖定」按鈕，**封鎖也解得掉**（否則誤鎖的人救不回來）。

**踩雷提醒**：`recordFailure` 刻意用「先查再寫」兩段式，不用 `ON CONFLICT … RETURNING`——
pg-mem 的 upsert RETURNING 回傳值不可信（見 [[pgmem-on-conflict-returning-lies]]）。

**狀態**：commit 在分支 `feat/agent-sandbox`（已 push，**未合併 master、未重啟**）。新表在啟動 `migrate()` 時建立，
所以要重啟才生效。

相關：[[productize-saas-decision]]、[[shared-host-do-no-harm]]
