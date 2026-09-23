---
name: pipeline-defects-found-2026-08-18
description: raifong T1 挖出的 5 個平台缺陷 —— 08-19 已全部修完並 commit（4db928e→a84da21），⚠ 尚未重啟 server、前端未人工實測；留存價值在四個判讀陷阱與「不要改」的判定
metadata: 
  node_type: memory
  type: project
  originSessionId: ad74472e-a22f-41ea-ab0d-aa05cf063070
---

2026-08-18 用 raifong 升級任務 #145／#149 實戰挖出，**2026-08-19 五項全部修完**（測試 2854→2861，零回歸）。

## 現況：碼已 commit，但還沒生效
五個 commit 都在 master：`4db928e`(P1) `7b8abe4`(P0) `f544d12`(P3) `c3f58da`(P2) `a84da21`(P4)。
- ⚠ **改了 `app/server/**.js`，沒重啟就還是舊碼**——要請使用者在主機 `docker restart`（容器內 kill node 會連 postgres 一起收掉，見 [[platform-restart-kills-container]]）。
- ⚠ **前端兩處未人工實測**（此 repo 前端零自動化測試）：卡關輸入框的三顆快捷鈕、封存的 warnings toast。含深色模式。
- ✅ P3 只動 prompt 與 guidance 字串，靠 mtime 熱載，免重啟。

## 各項修法（都附了測試，測試意圖寫在測試本身的註解裡）
- **P1 deploy log 互相覆蓋** → `saveDeployLog` 內部撞名就接 `_2`、`_3`。改函式內部一處、兩個呼叫點都受惠。**不用時間戳**是因為同毫秒兩次呼叫會讓測試 flaky。
- **P0 `advance target=deploy` 跳過 merge** → 改導向 `merge_running`（merge 成功本來就轉 deploy，分支已併時走 Already up to date）。**必須自己補歸零 `deploy_retry_count`**：落點改掉後 `RESUME_COUNTER` 查不到它，不補就重演 task 109「併完進部署第一下就觸頂」。另加一行 task_logs 說明，否則使用者要「重測部署」卻看到狀態變「併入測試」。
- **P3 規格未對版本驗存在性** → 兩個落點。`coreSourceGuidance`（source-routing 注入，六關共用）加「落筆前先 Grep 驗存在性」**與「規格與原始碼衝突時以原始碼為準」**——後者是給下游的，光堵源頭解不開已經卡住的任務，要讓審查關敢推翻錯規格。`analysis-project.md` 另要求跨版本升級任務附改名對照表。
- **P2 resolve-blocker 契約不透明** → 輸入框上方三顆情境快捷鈕，把 `decision="advance"、target="qa"` 這種契約詞彙**填進**輸入框（不直接送出，使用者仍能補上下文；接在既有內容後面，因為人常是先打完說明才想到要指定回哪一關）。
- **P4 封存不收回 testing commit** → 新增 `git.branchMergedInto`，碼真的在 testing 才呼叫既有的 `rebuildTesting`。**單筆與批次兩條 route 都要接**（使用者清任務多半用批次的，只修單筆等於留半個洞）。呼叫點必須排在 `is_hidden` 寫入之後，否則任務會被自己重併回去。

## ✅ 不要改：coding「無變更就停」是刻意設計且正確
`task-agent.js:655` 有完整理由（附實測 task 109）：帶失敗回饋進來卻沒產生 commit，放行只會讓 QA 判「same diff、已審過」照樣 pass，再部署必然重現同一失敗。
它在 T1 觸發五次不是它的錯，是被 P0／P3 餵了錯誤前提。修完 P0／P3 就不會誤傷。

## 四個判讀陷阱（這才是這份記錄的長期價值）
1. **subagent 的「已修」結論不可直接採信**——複驗 P1 的 subagent 判「已修」，但它自己的證據表格就顯示 code 路徑仍傳 `nextCount`；它把另一個 commit（`ba76aa1` 修計數器歸零）誤讀成修了 log 覆蓋。**那個 commit 反而讓 P1 更容易觸發**。高衝擊的「已修」結論一律自己讀碼複驗。
2. **檔名編號分布本身就是證據**——`data/logs` 裡 `-1` 有 21 份、`-3` 有 5 份、**`-2` 掛零**。遞增編號不可能長這樣，比讀碼推論更硬。
3. **「rebuildTesting 只在 isRebuild 分支被呼叫」已過時**——呼叫點已長到 4 個（DELETE、批刪、updateMainClone、mark-conflict-resolved），archive 才是唯一漏網的。舊記錄的否定式斷言引用前先 grep。
4. **正常重試路徑是安全的**（deploy 失敗→coding→qa→merge→deploy），別誤記成「重進 deploy 一律不 merge」——我一度這樣誤判過。

## 附帶：仍未修
新 repo 的 `base_branch` 為 NULL：`ensureMainBranch` 決定的實際落點沒回寫 DB，撞名守衛只能拿 `base_branch` 推算（正式資料 7 筆有 5 筆 `remote_ai_branch` 是 NULL）。raifong19 已由使用者手動改預設分支解除，但下一個新專案會重演。

相關：[[raifong-17-to-19-upgrade]]、[[platform-restart-kills-container]]
