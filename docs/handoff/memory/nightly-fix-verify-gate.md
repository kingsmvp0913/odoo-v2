---
name: nightly-fix-verify-gate
description: 夜間改善通道新增「合併前複檢」關卡（fix-verify）已 commit 未重啟未實跑；含健檢提案自動跳過人工核准、與前端語法錯在全跑中完全隱形的實測數字
metadata: 
  node_type: memory
  type: project
  originSessionId: aab45417-af0a-44c4-81da-49262a29526d
---

2026-09-05 為改善通道補上第四關：`改碼 → 跑測試 → fix-review → **fix-verify** → merge`。commit `249bb057`（未 push、**未重啟所以尚未生效**、**從沒實跑過**）。今晚 22:00 若有候選就是首航。

**為什麼要多這一關**（不是同一關跑兩次）：`fix-review` 只拿得到 diff 的文字，看不到呼叫端與被改檔案的其餘部分、不能執行任何東西。`fix-verify` 跑在修正的 worktree 內、有 context7、**有權直接改碼**，專查「diff 看不出來」的那類：呼叫端沒跟著改、同一個 bug 的第二處、改完載不載得進來。它自己與 `fix-verify.js` 都進了 `finding-fix.js` 的 DENY 清單。

三件事不採信 agent 自報（比對前後 staged diff 判有無動手／重跑 classifyChanges／重跑測試比 `baseline_failed`＋`baseline_passed` 兩個新欄位）。**新欄位靠 migrate 建，所以「沒重啟」＝新碼與新欄位都沒生效＝今晚照舊流程跑，不會半新半舊。**

## 三個查證出來的事實（都跟直覺相反）

1. **`[Health]` commit 大半不是通道產物**：那批 19 個 commit 只有 4 個是 `Merge fix/finding-xxx`（走完測試＋審核），其餘 15 個是 Claude Code／kingsmvp2 **直接 commit 在 master**（人工 session 手改）。壞掉整頁的 `a791fe13` 就是手改那類——所以「審核怎麼沒抓到」的前提不成立，它從沒進過審核。分辨法：`git log --format='%h|%an|%p'` 看 parent 數與 author。同 [[health-fix-channel-verified]]。
2. **前端語法錯在全跑中 100% 隱形**：把 `a791fe13` 原封不動跑當時的完整套件＝**256 suites／4169 tests 全綠、exit 0**。jest 不載 `app/public`，所以 fix-review 拿到的 `test_result` 一定是 pass、一定會 approve。已補 `frontend-syntax.test.js`（`vm.Script` 只編譯不執行，走訪全樹）擋住這一類，並在 worktree 環境實測過壞版會紅。詳見 [[ui-next-frontend-verify-loop]]。
3. **健檢自己產的提案從來沒經過人工核准**：`health-check-runner.js` 的 `openFeedbackForFinding` 寫死 `INSERT ... 'approved'`，`insertFinding` 對 auto-fix 範圍內的 proposal 也直接落 `approved` ⇒ 當晚自動改碼、自審、合併、`docker restart`。「改善提案」頁那顆核准鈕只對使用者自己提的意見（`status='new'`）有作用。夜間批次**沒有獨立開關**，健檢停用也擋不住（`cron.js` 有它自己的 due 判斷）。

## 已知未做

- `verify_notes`／`review_notes` 只到 API（`admin-routes.js` 的 findings/:id/fix），**ui-next 前端沒有任何地方顯示**，也沒有看 diff／手動採用的畫面（那批把按鈕拿掉了，只剩 legacy `js/views/AdminHealthCheck.js` 還有）。
- 多一關 ＝ 每組多一輪 agent＋可能多一次全套測試，而批次 deadline 是台北 02:00、runway 上限 4 小時 ⇒ 每晚跑得完的組數會變少（超時的記在 skipped，不會壞）。
- 複查另找到一個真實但**裁決為不修**的缺陷：`db.js` 開機把所有 `health_check_runs` 的 running 無條件標 error，而 `resumeInterruptedRuns()` 排在 `migrate()` 之後 ⇒ 中斷續跑永遠撈到 0 筆。**不修的理由**：每晚自動那條是「健檢跑完才觸發改善」（`cron.js` 的 `.finally`），批次重啟時健檢早已結束；唯一撞得到的是「手動按立即健檢的 2~7 分鐘內平台被重啟」，損失＝一次呼叫、畫面看得到失敗、再按一次即可。

## 這一輪最大的教訓：抄註解沒驗證，差點做出過度的修法

`cron.js` 原本寫「runAudit 是背景長工（20+ 個 opus）」，我照抄後把「健檢被打斷」估成損失一整晚與一大筆錢，據此建議立刻修上面那個缺陷。**使用者反問「現在不是一個 AI 嗎」，一查 `token_usage` 才發現實測是每天 1 次呼叫、2.1~6.5 分鐘**——那個數字是已退役的逐關診斷（每關各跑一次模型）的規模。已改註解並把實測數字寫進去（`d3560643`）：只刪舊數字不夠，沒有數字下一個人還是只能猜。同類過期描述還有兩處「21 關」，其中一處講的 `runHealthCheck` fallback 早已整條退役。

⚠ 通則：**這個 repo 的註解密度極高、品質也高，所以特別容易被當成事實照抄**。凡註解裡的量級數字（幾個 agent、幾分鐘、幾筆）要當結論用，先用 `token_usage`／DB 量一次。
