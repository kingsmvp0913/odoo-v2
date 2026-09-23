---
name: pgmem-like-bracket-charclass
description: "pg-mem 把 LIKE 裡的 [...] 當 regex 字元類別，真 Postgres 不會——這種查詢正式環境會動、測試永遠 0 筆"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8677bf54-ed95-4ccb-afcb-03e9d820da63
---

`content LIKE '[人工退回]%'` 在真 Postgres 命中（方括號在 LIKE 裡是普通字元），在 pg-mem **恆回 0 筆**——它把 LIKE 轉 regex 時不逃脫 `[`，於是那段變成「一個字元類別」。實測：`LIKE '%人工退回%'` 命中，`LIKE '[人工退回]%'` 不命中。

平台的機器 log 前綴全都長這樣（`[人工退回]`／`[QA 未通過]`／`[等待你審核規格]`），所以只要拿前綴做 LIKE 就會踩到。

**Why:** 這個方向的落差最惡劣——正式環境行為正確，測試卻永遠證明不了它，或者反過來讓你以為修法沒生效而去改對的碼。我第一次寫成 LIKE 時測試紅了，差點以為是自己的 SQL 錯。

**How to apply:**
- 前綴比對一律用 `substring(content, 1, N) = $2`，長度內插進 SQL（來源是自家常數，不是使用者輸入）。`left()` pg-mem 沒有；`substring(c,1,$2)` 把長度當參數也會炸（`Cannot read properties of null`），長度必須是字面值。
- `app/server/tests/workflow-scenarios.test.js` 已有一段 shim 把 `LIKE '[…%'` 改寫成 substring——看到那段就知道別人也踩過，別以為那是多餘的。
- 同一家族的既有紀錄見 `.claude/rules/testing.md` 第 12~17 條（LIKE 的 `%` 跨不了換行也在那）。

相關：[[stale-memory-blocks-work]]
