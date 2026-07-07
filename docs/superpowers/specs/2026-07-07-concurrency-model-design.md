# 主題 C：併發模型與鎖統一 — 設計文件

日期：2026-07-07
狀態：已核准
健檢對應：U1（完整解，止血已做大部分）、U7（鎖碎片化）、U8（loop_counter 節流／reentry_count 死欄位）

## 背景與目標

目標架構：~14 users × 每人 5 個併發任務（≈70），**同專案多張任務要能平行**（worktree 隔離），
之後 merge 進共用 testing 環境整合測試。現行 `for...await` 循序處理 ＋ loop_counter 節流
擋住這個目標。

三目標：穩定（併發下不互踩）、準確（analysis 不讀到污染狀態）、省 token（不因鎖/節流白等或誤跑）。

## 核心洞察：鎖只蓋「短的共用變動」，長操作各自隔離

共用資源只有：主 clone 的工作目錄、單一測試 env／測試 DB。真正需要互斥的是「會變動它們的短操作」，
不是「長時間的讀取」。

| 長操作（不持鎖、各自隔離空間） | 短變動（持 per-project 鎖、幾秒） |
|---|---|
| coding（worktree）、QA（worktree） | merge（task→testing） |
| E2E（讀共用 env，HTTP） | deploy（odoo-bin -u） |
| **analysis（自己的 main worktree）** | worktree add/remove（含 analysis 的） |
| | approve 併 main |

## 元件

### C-1. project-lock.js（統一 per-project 序列鎖）
把 merge/deploy 各自的 Promise 鏈收成一份共用：
```
withProjectLock(projectId, fn)  // 同專案一次一個，前一個不論成敗都接續
```
取代 merge-agent 的 _projectMergeChains 與 deploy-testing 的 _chains。

### C-2. 套用鎖到短變動
- merge-agent runMergeAgent → withProjectLock
- deploy-testing runDeployTesting → withProjectLock（沿用現有 lock 換成共用）
- runner handleBranch 的 worktree add/remove → withProjectLock
- pipeline-routes approve（併 main）→ withProjectLock
- E2E **不**持鎖（讀共用 env；deploy 撞 E2E 由主題 A env 檢查安全處理）

### C-3. analysis 走隔離 main worktree
analysis 不再直接讀共用主 clone（會讀到別任務 merge 後切到 testing 的污染狀態）。改為：
- 持鎖建立拋棄式 detached worktree（各 repo 於 main HEAD），排在 analysis 專用暫存目錄
- claude 讀該隔離 worktree（cwd＝隔離 worktree 父目錄），**不持鎖**（隔離安全）
- 讀完（成功或失敗）持鎖移除 worktree
好處：永遠讀乾淨 main；大單掛 testing 再久也不污染別張 analysis；analysis 與 merge 可平行。

### C-4. 併發派工排程（取代循序 for-loop ＋ loop_counter）
- `_inFlight` 改存 `{ ctrl, userId }`（可算每人在跑幾個）。
- runPipeline：`_pipelineRunning` 當「掃描鎖」（防同 user 重複掃）；掃描時算
  `slots = min(MAX_PER_USER − 該user在飛, MAX_GLOBAL − _inFlight.size)`，
  撈「可跑且不在 _inFlight」的任務取 slots 個，逐個 dispatchTask（不 await）。
- dispatchTask：**同步**佔位 `_inFlight.set`（在任何 await 前，單執行緒保證無競態）→ 跑 → finally 移除。
- 原散在各 handler 的 withInflight 收斂到 dispatchTask 統一管理；handler 收 signal。
- 上限用環境變數：PIPELINE_MAX_PER_USER（預設 5）、PIPELINE_MAX_GLOBAL（預設 30，可調）。
- **移除 loop_counter 全部邏輯**（getLoopCount/increment/>5 停）；cron 移除 resetLoopCounter 呼叫。
  runaway 由 per-stage 重試上限（qa/deploy/pw 各 3）＋ C-5 兜底。

### C-5. reentry_count 接上線
- 每次任務從下游（qa/deploy/pw fail）退回 coding_running 時 +1。
- 用途：(a) 前端顯示真實循環次數（任務 52 實際 6 次卻顯示 0）；(b) 兜底硬上限
  （≥ MAX_REENTRY，預設 10 → 強制 stopped「循環過多，需人工」），補在 per-stage 上限之外。

## 測試計畫（Rule 9 驗證意圖）

C-1 project-lock：
1. 同 projectId 兩次呼叫序列化（第二個等第一個完成才跑）；不同 projectId 平行。
2. 前一個 reject 不卡住後一個。

C-4 併發派工：
3. 單 user 有 8 個可跑任務、上限 5 → 只派 5，其餘留下輪。
4. 已在 _inFlight 的任務不重複派。
5. 全機上限 → 跨 user 總量不超過 MAX_GLOBAL。
6. dispatch 同步佔位：兩次快速 runPipeline 不會重複派同一任務。

C-3 analysis worktree：
7. analysis 在隔離 worktree 讀（cwd 非共用主 clone）；讀完移除 worktree。
8. 別任務把共用 clone 切到 testing，不影響此 analysis 的讀取內容。

C-5 reentry_count：
9. qa/deploy/pw fail 退 coding → reentry_count +1。
10. reentry_count ≥ 上限 → 強制 stopped。

回歸：現有 merge/deploy/E2E/analysis 既有測試不破。

## 範圍
- 單一 Node 程序，用 in-process async primitive；不做 DB advisory lock／多程序（YAGNI）。
- test_mode 行為不變（cron 跳過推進，屬 manual stepping；可視化留主題 D）。
- 驗證：真實多任務併發跑，觀察同專案多張平行、無互踩、analysis 讀 main 正確。
