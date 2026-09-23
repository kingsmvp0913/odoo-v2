---
name: full-run-test-count-model
description: 全跑的通過數可以事先算準（新測試數＋每個新原始碼檔 +1）；全跑進行中改測試檔會污染結果
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9728f041-702c-4382-a801-270d6d744518
  modified: 2026-09-16T02:10:20.612Z
---

2026-09-16 做子專案 0 第 1 部時，每個 Task 都「先預測全跑通過數、再驗證」，**連續九次完全命中**。

**計數模型**：新的通過數 ＝ 舊通過數 ＋ 本次新增測試數 ＋（本次新增的 `.js` **原始碼**檔數 × 1）。

那個 +1 來自 `frontend-machine-logs.test.js`：它走訪 `app/public` 與 `app/server` 全樹（**跳過 `tests/`**），對每個 `.js` 檔各產生一支 `test.each`。所以新增 `lib/foo.js` 會 +1，新增 `tests/foo.test.js` **不會**；只改既有檔則兩者皆 0。

**Why 值得做**：對不上就代表有看不見的連帶影響。09-16 第一次對不上（+15 而非 +14），追下去才發現是這條規則——而不是 flaky。**數字對不上不要當浮動放過去，先逐支比對**：用 `jest --json --outputFile=` 取兩次的 `assertionResults.length` 再 `join` 比對，一次就指得出是哪一支。

**⚠ 全跑進行中不要動任何測試檔**（09-16 實際踩到）：背景 jest 會讀到你剛追加、還沒實作的測試，結果變成 `6 failed`，看起來像剛完成的那個 Task 把東西弄壞了。判別法：失敗的支數與訊息是否**正好等於**你剛加的那幾支；`passed` 數是否仍等於預測值。要並行就只做「讀檔／寫非測試檔／git commit」——commit 不改工作目錄檔案，不會干擾 jest。

**也別同時開兩個 jest**：互搶 CPU 會製造假紅燈（rules/always 1）。單支測試 <1 秒、全跑約 85 秒，兩段式（改的時候跑單支、要宣稱完成前才全跑）就夠，不需要中間層。

相關：[[productize-saas-decision]]
