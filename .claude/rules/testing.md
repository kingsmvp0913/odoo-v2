---
paths:
  - "app/server/tests/**"
---

# 平台開發：測試

> 抽自 2026-07-29 的記憶整併。完整清單與來源見 `docs/rules-extraction-2026-07-29.md`。

### pg-mem 已知限制（測試環境限制，**不要改寫正式 SQL**）
12. `WHERE <serial_pk> = ANY($1::int[])` 永遠查不到既有列 — int 陣列型別調解與 SERIAL 底層型別對不上，連字面量都查不到。跳過該測試並註解。
13. `LIKE` 轉 regex 沒有 dotAll，`%` 跨不了換行 — fixture 用空白而非 `\n` 當分隔。
14. 不支援相關子查詢（子查詢內參照外層 alias），要改寫成 `NOT IN`；**改 `NOT IN` 時務必在子查詢加 `IS NOT NULL`** — 真 PG 裡 `NOT IN` 清單含一個 NULL，整個條件恆為 UNKNOWN，查詢靜默全失效。
15. 一旦建了 partial unique index，`<欄位> IS NOT NULL AND <比較>` 會查不到列 — 拿掉冗餘的 `IS NOT NULL`（語意等價）。
16. 不支援 `btrim`。
17. **表在測試間不清空** — 寫新測試要假設有殘留資料；`beforeEach` 補「未排到的查詢一律回空」預設 mock，並改用 body-aware 的 mock 路由。

### 測試設計
18. **測試挑的輸入值必須有鑑別力** — 避開「正確與錯誤行為結果剛好相同」的值（例：用 `ask` 驗「mode 從 DB 讀」等於沒測，因為未知 mode 的降級目標剛好也是 `ask`）。
19. **測「順序／覆蓋權」類邏輯，fixture 必須放兩筆以上** — 只有一筆時 `push` 與 `unshift` 行為相同，全綠證明不了什麼。TDD 的「先跑到失敗」正是攔截這種缺口的機制。
20. **測試改寫要保住原測試的 intent，不是只讓它變綠** — 否則覆蓋率靜默塌陷。
21. **有模組層節流變數（如 `_lastIdleSweepAt`）的測試，其檔內先後順序具有語意** — 節流變數跨 test 累積，不可任意搬動或新增前置案例。
22. **route 層測試的授權走 `createApp` + auth/setup 取得 token，不要用私有 signer 造** — 私有 signer 繞過真實授權路徑，測不到 guard。
23. **新增會被 runner 讀取的全域閘門／外部依賴後，real-runner 系列測試檔必須補對應 mock** — 否則測試失去 hermetic 性。
24. **測試要建關聯資料先建父列** — `tasks.project_id` 有 FK `REFERENCES projects(id)`。
25. **測試要建 repo 就直接 INSERT `project_repos`，不要走 `POST /repos`** — 該端點觸發背景 clone，與測試改寫 `clone_status` 競態。
26. **不要為了注入設定把同步函式改成 async** — `runClaude` 變 async 會讓 spawn 晚一個 microtask，既有「呼叫後同步對 mock child 發事件」的測試整片失效。改用同步讀取＋啟動載入＋存檔失效的快取模式。
27. **tour／測試指令 exit 0 不等於有跑測試** — 0 個測試也回 exit 0，必須檢查 log 內確有 `odoo.tests` 之類的執行標記。執行外部指令的 wrapper 即使成功也要回傳 stderr，否則下游「檢查 stderr 非空」的防線變成死碼。
28. **跑測試用的 Odoo 指令要自取空閒埠並帶 `--http-port`** — 不指定會撞常駐的 8069。
29. **查平台本地 DB 要手動帶 env** — 連線字串不在 env，藏在 repo 某支 `.ps1` config。用 `DATABASE_URL='postgres://…@localhost:5416/claude' node script.js`。

