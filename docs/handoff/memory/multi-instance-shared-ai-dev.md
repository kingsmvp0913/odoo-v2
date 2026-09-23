---
name: multi-instance-shared-ai-dev
description: 有第二個平台實例與本機共用同一遠端 ai-dev，打破 mergeToAiBranch「ai-dev 只有平台會寫」的單寫者假設
metadata: 
  node_type: memory
  type: project
  originSessionId: 9219470b-9fa1-4791-8aa0-c663e4a1fc6e
---

實際部署上**不只一個平台實例**在跑同一條 pipeline，且各自本機 clone 共用**同一個遠端 ai-dev**。這打破了 `git.js` `mergeToAiBranch` 原本的假設「ai-dev 只有平台會寫，故不存在非 fast-forward 競態」。

症狀（2026-08-04 實際發生，task 85 / odoo17_hungjou）：另一實例先跑完 push 上遠端 ai-dev，這台 approve 時 push 撞 non-fast-forward，approve endpoint 把 git 原文包成 500 死錯丟前端，使用者無法解。更病態的是**同一張任務同時在兩個實例上各跑一遍**，各產一份 binary docx，撞同一檔無法自動合。

已修（commit 7cdf092）：`reconcileAndPushAi` push 被打回才 fetch＋併回重推（bounded retry）；真衝突拋 `AiPushConflictError` 導進既有 `merge_conflict` 閘門（`push_ai` 變體，解完回 `review_pending` 重按審核冪等續推）。

**但 git 這層只是止血**——更深的病是「同一來源任務被兩個實例各自接單重跑」，要根治得在來源任務去重／實例間互斥層處理。相關：[[deployment-topology]]。

---

**2026-08-12 現況更新：使用者確認「目前就這一台」，此根因降級為潛在風險，不需現在修。**
（若日後再開第二台跑同一條 pipeline，它會原封不動回來。）

⚠ **但 `master` 這條線不是只有你在推**：2026-08-14 push 平台自身的改動時撞 non-fast-forward，
遠端多了一筆我沒有的 commit（`b6f6440 [Respec]`）。不論那是第二台實例還是使用者的另一個 session，
**operational 結論一樣：push 前先 `git fetch origin master` 比對，別假設 master 停在你離開時的位置。**
撞到時先 `git show --stat` 看檔案有無重疊——無重疊直接 rebase 即可（該次三筆全乾淨）。
**rebase 後要重跑測試**：上游那筆動了 `app/server`，合併後的狀態是沒人驗過的新組合。

同日把「為什麼擋不住」查到底了，日後真要修時直接用：

- **認領全程沒有任何原子搶占**。`runner.js:512-517` 只是 `SELECT ... WHERE status = ANY(RUNNABLE_STATUSES)`
  讀快照，接著 `dispatchTask`（`runner.js:451-452`）只查**單一行程的記憶體** `_inFlight` Map。
  從頭到尾沒有一次把 `tasks.status` 條件式 UPDATE 成「已認領」。
- **全庫沒有 `FOR UPDATE`／`pg_advisory_lock`／`SKIP LOCKED`**，`tasks` 表也沒有
  `locked_by`／`owner_instance`／`claimed_at` 這類欄位。
- **`project-lock.js` 的 `withProjectLock` 是行程內 async mutex**（檔頭自己寫明 in-process），跨機無效。
- **`dispatch-lease.js` 是全庫唯一真正的條件式 CAS**（`UPDATE dispatcher_lease SET ... WHERE id=1
  AND (holder=$1 OR expires_at<$3)`），但它的前提是**多行程共用同一個 DB**。而
  `data/config.json` 的 `DATABASE_URL` 指向 `localhost`——**每個實例連自己本機的 Postgres**，
  於是兩台各自搶到自己那張牌，形同虛設。⚠ 這是判讀時最容易誤解的一點：看到 dispatch-lease 會
  以為併發已經處理好了。
- 因此兩實例唯一共用的協調點只有**遠端 Odoo（任務來源）與遠端 git `ai-dev`**，修法必須落在這兩者之一
  （或引入共用協調服務），不可能靠現有的本機 DB 解決。
