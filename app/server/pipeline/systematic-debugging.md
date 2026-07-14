# 系統化除錯（pipeline 版）

> 遇到失敗時：先找到 root cause 再動手改，別亂猜。

## Iron Law
沒有確認 root cause，不准提出或動手修復。症狀式修補＝失敗。

## 四階段（依序，勿跳）

### 1. 找 root cause
- 完整讀錯誤訊息／stack trace，記下檔案、行號、錯誤碼。
- 能否穩定重現？可用既有測試或 `odoo-bin -d <db> --test-enable --stop-after-init` 重跑。
- 查近期變更：`git diff`、近期 commit、新依賴／設定差異。
- 多層系統（controller→service→DB、clone→init→seed→deploy）先在各邊界加診斷輸出，
  跑一次看「哪一層」壞，再深入那一層，而非一開始就猜。

### 2. 比對模式
- 找同 codebase 內類似的可運作程式。
- 逐項列出「可運作」與「壞掉」的差異，別預設「這不可能有關」。

### 3. 假設與驗證
- 明確寫下單一假設：「我認為 X 是 root cause，因為 Y」。
- 做最小改動驗證，一次只動一個變數；驗證前不疊加其他修復。
- 沒中 → 換新假設，別在舊修復上再加。

### 4. 修復
- 先寫能重現該 bug 的測試（最小、可自動化）。
- 只針對 root cause 做單一修復，不順手重構、不「反正都改到了」。
- 驗證：該測試會過、其餘測試沒被弄壞。
- 同一問題修 3 次仍失敗 → 停手，質疑架構是否根本錯（shared state／耦合），別再猜第 4 次。

## Odoo 常見 root cause 優先排查
- 原生 SQL 前後未 `flush_model()`／`invalidate_model()` → 畫面不更新／讀到舊值。
- 用了原生 `round()`（銀行家捨入）→ 金額尾數錯，應改 `Decimal` + `ROUND_HALF_UP`。
- view 繼承衝突／xpath 找不到節點 → 畫面沒套用。
- log 位置見 CLAUDE.md 第 5 節（odoo runtime／deploy／e2e）。

## 卡住時（無人可即時詢問）
- 同一問題 3 次以上失敗，或判定為環境／外部問題 → 停手。
- 在最終結果裡寫清楚：已確認的 root cause（或為何無法確認）、已試過哪些方案、目前卡在哪。
- 不要臆造修復、不要靜默略過失敗。
