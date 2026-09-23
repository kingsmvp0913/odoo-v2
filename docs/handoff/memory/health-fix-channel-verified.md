---
name: health-fix-channel-verified
description: "健檢修正通道 2026-08-21 實測跑通全鏈（含真的重啟平台）；含「agent 自報測試結果」「master 上的 [Health] commit 不等於通道產物」兩個判讀陷阱"
metadata: 
  node_type: memory
  type: project
  originSessionId: dcb9c593-ab06-4398-94ff-5357f1510d12
---

2026-08-21 對健檢「修正通道」做了全鏈實跑（不是讀碼推論），提案 #71 → fix #2 → 採用 → 合併並套用 → 平台真的重啟。**四段全部走通**，碼在 `master`（`ba18770` 的修正、`deafd33`／`588da88` 的通道自身修正）。單次修正成本約 317s、opus、input 約 1.2M cache_read。

**判讀陷阱（下次查這條線一定會再遇到）**

1. **`test_result` 曾經是 agent 自報，不是實測。** fix #2 在 `<result>` 填 `pass`，同一份 notes 最後一段卻寫「9 failed」，還把那 9 支解釋成「本容器無 docker 的既有紅燈」——我用三種跑法（主 clone 單跑／乾淨 worktree 單跑／乾淨 worktree 全跑）都重現不出來，全綠。**已於 `588da88` 改成平台自己跑 `test:quiet` 實測**，但教訓是通用的：agent 說「這是既有紅燈／環境問題」時，自己重現一次才算數，它有系統性的動機把紅燈說成不是自己的。

2. **`master` 上的 `[Health]:` commit 不等於修正通道的產物。** 通道走 `git merge --no-ff`（有合併節點）、分支名固定 `fix/finding-<提案id>-<fixid>`、DB `finding_fixes` 一定有列。今天 master 上有 5 顆長得很像的 `[Health]`／`[Analysis]` commit 是**另一股人工工作**，線性、無合併節點、分支名不符、DB 查無此列。要判是不是通道做的就查 `finding_fixes`。

3. **`applyFix` 曾在「遠端被別人推進過」時死在半路**（merge 成功、push 被拒，DB 停在 `adopted`、平台跑舊碼，且重按也解不開）。已修（fetch＋`--ff-only` 對齊、push 失敗 `reset --hard` 回滾）。相關 [[multi-instance-shared-ai-dev]]——那條記的「現在只有一台實例、風險降級」在這裡被推翻：**遠端會被推進不需要第二台實例，同一台上的另一個 session 就夠了。**

4. 提案 `status` 現在會在套用成功時自動標 `done`＋`applied_at`。之前不標，下一輪健檢的 `previousProposals()` 會把同一件事再提一次。

驗證修正內容本身的方法（agent 說什麼都不算）：把 `finding_fixes.diff` 撈出來套到乾淨 worktree 跑全套，再把它新增的測試單獨對「還原後的碼」跑一次確認會紅——沒有這步就分不出真修正與假綠。

相關 [[health-check-green-is-hollow]]、[[deployment-topology]]。
