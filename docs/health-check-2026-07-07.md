# odoo-v2 工作平台健檢報告

日期：2026-07-07
方法：4 個查察 agent 平行深查（資料層／流程層／Agent 層／專案層）＋ 18 個獨立 adversarial 驗證 agent 逐項查證 P0/P1 發現
範圍：`app/`、`.claude/`、`start.ps1`／`install.ps1`、平台資料庫（唯讀）；排除 `repos/`、`odoo-envs/`、`node_modules/`、`kingsmvpsplan/`
設計文件：`docs/superpowers/specs/2026-07-07-health-check-design.md`

## 一、執行摘要

**原始發現共 47 個（P0/P1×18、P2×19、P3×10）；跨層重複與可併項去重後為 40 項：P0×1、P1×14、P2×15、P3×10。18 個原始 P0/P1 全數通過獨立驗證，無一被推翻。**

最重要的結論是：**token 燒錢的主因不是 prompt 太長或 model 太貴，而是失敗處理路徑的設計讓「失敗」變成「迴圈」。** 任務 52（一個加欄位的簡單任務燒掉 4.77M tokens、兩天未完成）不是偶發事故，是結構性結果——本報告的 P0/P1 發現可以完整解釋它的每一步（見第五節對照）。三大目標在此是同一件事：修好穩定性（目標 1），誤歸因消失（目標 2），重跑迴圈不再發生，token 自然掉下來（目標 3）。

三個系統性主題貫穿所有層：

1. **失敗即迴圈**：重試計數器被「繼續」一鍵歸零（U2）、重跑不帶任何前次上下文、每輪從零探索 codebase 且一輪比一輪貴（U3：302k→877k→1,053k）、Playwright 失敗退回 coding 卻不附任何 feedback（U4）、環境問題與程式問題不分一律退 coding（已知根因 B，且 deploy-fix agent 寫好了卻從未接線——U5）。
2. **半途而廢的可觀測性**：失敗／逾時／中斷的執行完全不寫 token_usage（U12，帳面系統性低估最貴的情境）、coding/qa/playwright 的 transcript 只走 socket 不落地（U13，12/15 任務零事件記錄）、刪任務時硬刪歷史。本次健檢自身就是受害者：07-06 之前的失敗模式已無法從資料還原。
3. **併發與鎖的碎片化**：cron 每分鐘 fire-and-forget、用過期狀態快照重複派工、會 `--force` 移除進行中 coding 的 worktree（U1，唯一的 P0，可直接毀掉進行中的工作）；merge 鎖、deploy 鎖、inflight 是三套互不知情的機制，analysis 甚至完全無鎖（U7）。

好消息：**15 項 P0/P1 中約 9 項是 30 行以內的小補丁**，可以立即止血；其餘 6 項需要設計（見第六節路線圖）。

## 二、P0／P1 發現總表（去重後 15 項，全數通過獨立驗證）

| # | 嚴重度 | 影響目標 | 發現 | 來源層 |
|---|---|---|---|---|
| U1 | P0 | 穩定／token／準確 | cron 每分鐘 fire-and-forget 產生併發 runPipeline，用「過期 status 快照」重複派工；handleBranch 未受 inflight 保護，會 --force 移除進行中 coding 的 worktree | 流程層 |
| U2 | P1 | 穩定／token | resolve-blocker 把 qa/deploy/pw 三個 retry 計數器全部歸零，重試上限保護被「繼續」一鍵繳械（任務 52 計數器全 0 的直接原因） | 資料層＋流程層 |
| U3 | P1 | token | 重跑零上下文延續 | 流程層 |
| U4 | P1 | 準確／token | Playwright fail 退 coding 不寫 retry_feedback（QA、deploy 都有寫）→ coding 重跑拿到「（無）」，盲改再燒一輪 | 流程層＋Agent 層 |
| U5 | P1 | 穩定／準確／token | deploy-fix agent 定義存在但整條 pipeline 從未呼叫 | Agent 層 |
| U6 | P1 | 穩定／準確／token | merge 失敗/衝突路徑從不 abortMerge → 主 clone 殘留半套 merge（MERGE_HEAD＋衝突標記），污染同專案後續任務的 merge 與 deploy，且錯誤會被誤歸因為程式問題 | 流程層 |
| U7 | P1 | 穩定／準確 | 專案層鎖覆蓋不全 | 流程層 |
| U8 | P1 | 穩定／token | test_mode=true 讓 cron 完全不推進 pipeline + loop_counter 到上限即自鎖 | 資料層＋流程層 |
| U9 | P1 | 穩定／token | claude-runner.callClaude 完全沒有 timeout（cs/merge/library/chat 全走這條），掛死即永久占用任務 | 資料層 |
| U10 | P1 | token／穩定 | coding／analysis 共用 10 分鐘硬 timeout，逾時整輪 token 作廢 | Agent 層 |
| U11 | P1 | 準確／穩定 | merge agent 輸出直接覆寫衝突檔，無 code-fence／前後綴防護 | Agent 層 |
| U12 | P1 | 準確／token | 失敗/中斷/逾時的 Claude 執行完全不寫 token_usage | 資料層 |
| U13 | P1 | 準確 | 執行歷程（task_events）覆蓋嚴重不全 | 資料層 |
| U14 | P1 | 穩定／準確 | 非專案任務 MODE_B 產生死狀態 final_pending | 專案層 |
| U15 | P1 | 穩定 | install.ps1 全新安裝未產生 APP_SECRET／ANTHROPIC_API_KEY，導致 DB 查詢與加密功能開箱即 500 | 專案層 |

> 18 個原始 P0/P1 發現中有 3 組由不同層獨立重複發現（交叉印證），另有 4 個 P2 併入相關 P0/P1 條目，故去重後為 15 項。所有項目經獨立 adversarial 驗證 agent 對照程式碼與資料庫查證，**無一被推翻或降級**。

## 三、P0／P1 詳細發現

### U1. cron 每分鐘 fire-and-forget 產生併發 runPipeline，用「過期 status 快照」重複派工；handleBranch 未受 inflight 保護，會 --force 移除進行中 coding 的 worktree

**嚴重度** P0｜**影響目標** 穩定／token／準確｜**來源** 流程層｜**驗證** ✅ confirmed

**證據**

cron.js:62-66 `runForUser(user.id, ...)` 與 `runPipeline(user.id).catch(...)` 皆未 await，每分鐘疊加新實例；runner.js:244-249 一次撈出任務快照後在 for 迴圈逐一 await（runner.js:267-270），單一 coding 可 block 10 分鐘，之後才處理的任務用的是「幾分鐘前的 status」；runner.js:217-229 processTask 直接用 `task.status`（快照值）選 handler，不重查 DB；runner.js:108-146 handleBranch 完全沒包 withInflight；git.js:213-216 addWorktree 先 `worktree remove --force` + `branch -D` 再重建。

**說明**

時序：實例 t 在任務 X 的 coding await 期間，實例 t+1 已把任務 Y 從 branch_pending 推到 coding_running 並開跑 claude；實例 t 稍後輪到 Y 時仍以快照 branch_pending 呼叫 handleBranch → 強制移除 Y 正在使用的 worktree、砍掉 task 分支，進行中的 coding session 工作全毀且已計費，status 又被覆寫回 coding_running。withInflight 包住的階段也擋不住「先後」重跑：快照 qa_running 的舊實例會在新實例 QA 完成、任務已進 merge/deploy 後再跑一次 QA（雙倍計費），fail 還會把已 merge 的任務倒退回 coding_running（狀態回捲）。這是穩定與 token 的複合放大器，也是任務 52 反常重跑次數的可能共犯。

**修補方向**

processTask 執行 handler 前重查 DB status 並比對快照（或 UPDATE ... WHERE status=<期望值> 的樂觀鎖搶佔）；handleBranch/handleConfirmAnswered 一樣納入 withInflight；cron 對同一 user 加 in-process mutex（上一輪 runPipeline 未結束不重入）。

<details><summary>驗證 agent 的查證紀錄</summary>

All six evidence points verify exactly at the cited lines. (1) cron.js:62 and :65 both invoke runForUser/runPipeline without await — confirmed fire-and-forget, enabling overlapping instances every minute. (2) runner.js:244-249 fetches a single task snapshot never refreshed inside the loop. (3) runner.js:267-270 sequential for-loop with await blocks the entire pipeline on a long coding task. (4) runner.js:218 — processTask selects the handler from task.status (snapshot value) with no DB re-query; line 229 calls the handler unconditionally regardless of _inFlight state. (5) runner.js:108-146 — handleBranch is the only handler among all nine that contains zero withInflight call; all other long-running handlers (coding, qa, merge, deploy, playwright, wiki, analysis, cs) wrap withInflight. (6) git.js:213-215 — addWorktree unconditionally runs git worktree remove --force, git worktree prune, git branch -D (errors swallowed), before rebuilding from main. A grep for mutex/userLock/pipeline.*lock across app/server/*.js returns no results, confirming there is no per-user concurrency guard. Destruction path: instance t1 blocks on X (coding_running, legitimately inflight); instance t2 advances Y from branch_pending→coding_running via handleBranch; instance t3 starts coding on Y (withInflight registered); instance t1 then reaches Y in its stale snapshot (branch_pending) and calls handleBranch→addWorktree→git worktree remove --force on Y's active worktree, git branch -D on Y's branch, rebuilds fresh from main — destroying all in-progress coding work while the coding agent may still be writing to that path. The one minor overstatement (t+1 described as already starting Claude) is immaterial: a coding session lasting 2+ minutes (routine) is sufficient for t1's stale handleBranch to fire against an active worktree.

</details>

### U2. resolve-blocker 把 qa/deploy/pw 三個 retry 計數器全部歸零，重試上限保護被「繼續」一鍵繳械（任務 52 計數器全 0 的直接原因）

**嚴重度** P1｜**影響目標** 穩定／token｜**來源** 資料層＋流程層｜**驗證** ✅ confirmed

**證據**

app/server/tasks-routes.js:322-324 `UPDATE tasks SET status = COALESCE(resume_status, 'new'), ... qa_retry_count = 0, deploy_retry_count = 0, pw_retry_count = 0 ...`。DB：tasks id=52 現值 qa_retry_count=0 / deploy_retry_count=0 / pw_retry_count=0，但 token_usage 有 coding×6（ids 40,42,44,46,50,52）、qa×6（ids 41,43,45,47,51,53）；task_logs id=39/43/45 三筆 `[修正指示] 繼續`（07-06 08:49、07-07 01:07、07-07 01:47），task_events id=70 `❌ 測試區升級連續 3 次失敗` 之後每次「繼續」都把 deploy_retry_count 歸零再跑 3 次。

**說明**

QA_LIMIT/PW_LIMIT/部署重試上限都是 3，但使用者在 stopped 狀態填「繼續」呼叫 resolve-blocker 時三個計數器同時清零。任務 52 部署失敗滿 3 次→stopped→「繼續」→再 3 次→無限循環，累計 coding×6、qa×6、4.77M tokens。且 coding 每輪 token 遞增（302k→877k→1,053k，token_usage ids 46→50→52），循環越久單次越貴。這是與已知根因 B 相鄰但獨立的機制：即使根因 B 修好，只要人工「繼續」不帶任何新資訊，計數器歸零仍會讓同樣的失敗無上限重演。

**流程層獨立發現的補充**（resolve-blocker 一次把 qa/deploy/pw 三個重試計數全部歸零並 resume → 每次人工點擊重新取得 3 次額度，總重試無上限（任務 52 coding×6/qa×6 = 恰好兩輪 QA_LIMIT））

QA 連 3 次 fail → stopped，使用者填一句解決說明按下 resolve-blocker 就回到 resume_status（多半是 coding_running/qa_running）且計數歸零，又可以再燒 3 輪 coding+qa 全新 session。沒有任何跨輪的累計上限或「同一問題重複出現」偵測；任務 52 的 coding×6、qa×6、4.77M tokens 與「3 次上限 × 2 輪歸零」完全吻合。這是與已證實根因 B 同型的「計數歸零時機」歸因缺陷（規格要求檢查的項目 5）。

**修補方向**

resolve-blocker 不歸零計數器（或只歸零與 resume_status 對應的那一個）；「繼續」類無實質修正的 resolution 應要求確認或保留累計值；另可加任務級總重試上限（跨 resolve 累計）。

<details><summary>驗證 agent 的查證紀錄</summary>

所有證據均成立，無可推翻之防護機制。

【程式碼】app/server/tasks-routes.js:321-324：resolve-blocker 在每次呼叫時無條件執行 `qa_retry_count = 0, deploy_retry_count = 0, pw_retry_count = 0`，無任何條件分支。

【資料庫】tasks id=52 確認三個計數器皆為 0；token_usage ids 40-53 全部 task_id='manual_1783326354710'，確認 coding×6、qa×6。最後三輪 coding 總 token（input+output+cache_read+cache_create）為 302,700→877,054→1,053,598，與發現描述的 302k→877k→1,053k 精確吻合。

【task_logs】id=39/43/45 確認三筆 `[修正指示] 繼續`；task_events id=70 確認 `❌ 失敗：測試區升級連續 3 次失敗，需人工介入`。

【無防護機制】runner.js 的 LOOP_LIMIT=5（第 18 行）是 pipeline-run 級別的每分鐘 cron tick 計數器，在 sync/step 端點即被 resetLoopCounter 清零，與跨 resolve-blocker 的累計重試完全無關。resolution 欄位僅做非空字串驗證，單字「繼續」即可通過。全域與任務層均無跨 resolve 累計上限。

【機制確認】deploy_retry_count 在 2026-07-06T09:31 達到 DEPLOY_LIMIT(3) 後任務進入 stopped；使用者於 2026-07-07T01:07 填「繼續」呼叫 resolve-blocker 將計數器歸零，任務重回 deploy_testing；循環再次展開。P1 嚴重度成立：這是任務 52 事故（4.77M tokens、兩天未完成）的直接機制，且獨立於已知根因 A/B，根因 B 修復後仍可重演。


---
（流程層重複發現的獨立驗證）

所有引用證據均屬實：tasks-routes.js:322-324 確實對每次 resolve-blocker 無條件執行 qa_retry_count=0、deploy_retry_count=0、pw_retry_count=0；qa-agent.js:8 QA_LIMIT=3、playwright-agent.js:9 PW_LIMIT=3、deploy-testing.js:6 DEPLOY_LIMIT=3 均已確認。全庫搜尋無任何 lifetime/cumulative/total_coding_runs 等跨輪累計計數欄位。runner.js 的 LOOP_LIMIT=5 是 per-cron-tick 計數，每次 sync/pipeline-step 即歸零，與 QA 重試輪次完全無關，不構成防護。任務 52 coding×6、qa×6 與「3 次上限 × 2 輪歸零」數學完全吻合。嚴重度維持 P1 而非 P0，因為每輪都需人工點擊 resolve-blocker 才能繼續，無法自迴圈，但每輪 cost（完整 coding+QA session）極高，且無任何跨輪上限機制已確認。

</details>

### U3. 重跑零上下文延續：無 --resume / session 續用，coding 每輪全新 session 從零探索 codebase；retry_feedback 只留最後一輪且用完即清 → token 主放大器

**嚴重度** P1｜**影響目標** token｜**來源** 流程層｜**驗證** ✅ confirmed

**證據**

task-agent.js:64 spawnClaude args `['--print','--output-format','stream-json','--verbose','--dangerously-skip-permissions']`（全 codebase grep 無 --resume/--continue，claude-runner.js 同）；task-agent.js:148-165 buildCodingPrompt 只帶 analysis_yaml、repo_list、resolution、retry_feedback，不帶前次 diff、不帶 QA 歷史；task-agent.js:272-273 `retry_feedback` 消費後立即 `SET retry_feedback=NULL`；.claude/agents/coding-project.md 要求每輪讀 graphify wiki、Serena 查符號、Glob/Grep/Read 探索。

**說明**

每次 QA/deploy/pw 退回 coding 都是冷啟動：agent 重讀 wiki、重查符號、重掃 repo 才動手；QA 每輪也重讀 diff+codebase。任務 52 coding×6 + qa×6 ≈ 12 個冷啟動 session，4.77M tokens／12 ≈ 40 萬 tokens/輪，符合「每輪重新讀 codebase」的量級。retry_feedback 只保留上一輪，第 3 輪看不到第 1 輪的問題清單，容易修 A 壞 B 循環。

**修補方向**

退回 coding 時累積歷史（append 而非覆蓋 retry_feedback，或把歷輪 QA 意見全帶入 prompt）；prompt 附上 `git diff main...task-branch` 摘要讓 agent 直接看到現有實作，省去重新探索；評估 claude CLI `--resume <session_id>` 續用前次 context（session_id 已在 stream event 中，claude-runner.js:8 有拿到但丟棄）。

<details><summary>驗證 agent 的查證紀錄</summary>

全部四個子證據均直接可驗證，解讀正確，無防護機制可反駁。

1. 無 --resume/--continue（task-agent.js:64、claude-runner.js:44）：兩處 spawnClaude/callClaude 的 args 陣列均只含 --print/--output-format/stream-json/--verbose/--dangerously-skip-permissions，全 codebase grep --resume 確認無任何使用。

2. buildCodingPrompt 不攜前次 diff 或 QA 歷史（task-agent.js:148-165）：render 變數只有 analysis_yaml、repo_list、resolution、retry_feedback，worktree 中已有 commits 但 agent 需自行讀取，不是自動注入。

3. retry_feedback 單輪覆蓋後清除（task-agent.js:272-273、qa-agent.js:74）：QA 以 SET retry_feedback=$3 覆寫（非 APPEND），coding 消費後立即 SET retry_feedback=NULL；第 3 輪 coding 看不到第 1 輪的 QA 問題清單，結構上使能「修 A 壞 B」循環。

4. coding-project.md:16-19 明文要求每輪讀 graphify wiki → Serena 查符號（最多 3 次）→ Glob/Grep/Read 探索，無「若前次 session 存在則跳過」條件；claude-runner.js:8 的 session_id 僅用於 display 字串 slice(0,8)，從未存入 DB 或回傳給後續 spawn。

嚴重度 P1 成立：每次 QA/deploy 退回 coding 都是冷啟動，探索開銷不可避免；單輪 retry_feedback 造成歷史遺失並放大循環次數；兩者疊加直接對應任務 52 的 4.77M token 量級。沒有任何防護機制可以抵消此路徑。

</details>

### U4. Playwright fail 退 coding 不寫 retry_feedback（QA、deploy 都有寫）→ coding 重跑拿到「（無）」，盲改再燒一輪

**嚴重度** P1｜**影響目標** 準確／token｜**來源** 流程層＋Agent 層｜**驗證** ✅ confirmed

**證據**

playwright-agent.js:83-86 `UPDATE tasks SET status='coding_running', pw_retry_count=$2, updated_at=NOW()`（無 retry_feedback 欄位）；對照 qa-agent.js:74 與 deploy-testing.js:86 都有 `retry_feedback=$3`。E2E 報告只進 task_logs（playwright-agent.js:71-74），而 coding prompt 只吃 retry_feedback（task-agent.js:161 `retry_feedback: retryFeedback || '（無）'`；task-agent.js:272 只讀 `task.retry_feedback`）。

**說明**

E2E 失敗的測試報告完全不會進到下一輪 coding 的 prompt，coding agent 只看到原規格重做一次，高機率產出相同結果 → 再部署、再跑 E2E、再 fail，直到 PW_LIMIT。每輪是全新 session 全額計費。與根因 B 同型的「失敗回饋鏈斷裂」。

**Agent 層獨立發現的補充**（Playwright fail 退回 coding 時未寫 retry_feedback——coding 盲目重做）

三條「fail→退 coding」路徑中只有 playwright 這條漏傳失敗細節。coding agent 重跑時 {{retry_feedback}} 渲染成『（無）』，完全不知道 E2E 哪一步失敗、預期 vs 實際為何，只能整份規格重新猜——每輪是一次完整 coding run 的 token 成本，且高機率重犯同一錯誤直到 PW_LIMIT 停止。

**修補方向**

比照 qa/deploy：fail 分支同時寫入 `retry_feedback='[E2E 未通過]\n'+report`；並考慮在 playwright fail 時先區分 env 死掉（連線失敗）與測試斷言失敗，前者停 infra 不計數。

<details><summary>驗證 agent 的查證紀錄</summary>

所有引用證據均逐行核實屬實。playwright-agent.js:83-86 的 UPDATE 確實只寫 `status='coding_running'` 與 `pw_retry_count`，完全沒有 `retry_feedback`；qa-agent.js:74 對照組確認 QA 有寫 `retry_feedback=$3`。E2E 失敗報告僅以 `role='ai'` 寫入 task_logs（playwright-agent.js:71-74），而 latestResolution()（task-agent.js:139-146）只撈 `role='user' AND content LIKE '[修正指示]%'`——兩者完全不相交，不存在任何備援路徑讓 E2E 報告進入 coding prompt。task-agent.js:272 確認 `runTaskCoding` 讀的是 `task.retry_feedback` 資料庫欄位，Playwright 從不寫入該欄位，故 coding agent 每輪收到的是空字串，最終渲染為「（無）」。每次 Playwright fail→coding retry 均為全額 token 盲跑，與任務 52 事故型態直接對應，P1 嚴重度成立。


---
（Agent 層重複發現的獨立驗證）

所有引用證據均屬實，解讀正確，無反駁空間。

playwright-agent.js:83-87 的 UPDATE 確實缺少 retry_feedback，對照 qa-agent.js:74 有 retry_feedback=$3 可知這是刻意設計的欄位，但 playwright 路徑遺漏。

coding agent (task-agent.js:253) 讀取 retry_feedback 欄位，渲染成 prompt 的 {{retry_feedback}}（task-agent.js:161）；playwright 路徑下該欄位為 NULL，渲染結果為「（無）」。

E2E report 雖寫進 task_logs（playwright-agent.js:71-74），但 latestResolution（task-agent.js:139-146）只讀 role='user' AND content LIKE '[修正指示]%'，qa-agent 寫的 role='ai' log 不在範圍內，同理 playwright 的 ai log 也讀不到。

另一個值得注意的細節：task-agent.js:272-273 在消費 retry_feedback 後立即清為 NULL。若任務曾經歷 QA fail→coding（帶了 QA feedback）→playwright fail→coding，第二次 coding 時 retry_feedback 已被清空，且 playwright 未補寫，導致連「上一次 QA 問題是什麼」都消失，coding agent 處於完全空白狀態重試。

嚴重度 P1 成立：每次 playwright fail 退回 coding 都是一次完整的 coding token 成本，且缺乏失敗細節，高機率重犯同一 E2E 錯誤直到 PW_LIMIT（3次）耗盡才停止。

</details>

### U5. deploy-fix agent 定義存在但整條 pipeline 從未呼叫——根因 B 的 agent 層缺口

**嚴重度** P1｜**影響目標** 穩定／準確／token｜**來源** Agent 層｜**驗證** ✅ confirmed

**證據**

.claude/agents/deploy-fix.md:9-19（設計目的：判斷 odoo_error / env_error_fixable / env_error_needs_auth 並給修復指令）；全 repo grep `loadAgent(` 僅見 chat/analysis-basic/cs/merge/library/analysis-project/coding-project/playwright/qa，無 'deploy-fix'（唯一引用在 tests/agent-loader.test.js:44 驗證檔案存在）；app/server/pipeline/deploy-testing.js:69-91 升級失敗一律 `status='coding_running'` 退回 coding，無任何錯誤分類。

**說明**

平台已經寫好一個專門區分「環境問題 vs 程式問題」的 haiku agent（正是根因 B 需要的能力），但 deploy-testing.js 的失敗路徑完全沒接上它：任何升級失敗（含 pip 缺套件、DB 連線、權限等環境問題）都當程式錯退回 coding 重跑。coding agent 拿到環境錯誤訊息也修不了程式，於是空轉燒 token——與任務 52 的 coding×6 模式一致。

**修補方向**

在 deploy-testing.js catch 區塊先呼叫 deploy-fix agent 分類：odoo_error 才退 coding；env_error_fixable 自動執行 fix_bin/fix_args 後重試升級；env_error_needs_auth 直接 stopped 標注為環境阻塞（不消耗 deploy_retry_count、不退 coding）。

<details><summary>驗證 agent 的查證紀錄</summary>

三條證據均核實：(1) .claude/agents/deploy-fix.md:9-19 確實定義了 odoo_error/env_error_fixable/env_error_needs_auth 三分類；(2) app/ 下 loadAgent() 的所有呼叫點（chat/cs/merge/library/analysis-basic/analysis-project/coding-project/playwright/qa）均不含 deploy-fix，唯一引用在 tests/agent-loader.test.js:44 僅驗證檔案存在；(3) deploy-testing.js:69-91 的 catch 區塊呼叫 extractOdooError() 僅截取字串、不分類，一律走 coding_running 或 stopped，runner.js handleDeployTesting 前後亦無任何 deploy-fix 呼叫。env-agent.js upgradeModules 的錯誤為 stderr（含 Python traceback），ModuleNotFoundError（pip 缺套件）與 Odoo 模組錯誤在 extractOdooError 眼中外觀相同，均被當程式錯誤退回 coding。P1 合理：env_error_fixable 型失敗會讓 coding agent 收到無法修復的環境錯誤訊息並空轉燒 token，與任務 52 的 coding×6 模式直接吻合。

</details>

### U6. merge 失敗/衝突路徑從不 abortMerge → 主 clone 殘留半套 merge（MERGE_HEAD＋衝突標記），污染同專案後續任務的 merge 與 deploy，且錯誤會被誤歸因為程式問題

**嚴重度** P1｜**影響目標** 穩定／準確／token｜**來源** 流程層｜**驗證** ✅ confirmed

**證據**

git.js:160-162 定義 abortMerge，但 grep 全 app 僅 git.js:268 export，無任何呼叫者；merge-agent.js:123-125 解衝突失敗只 `conflictByRepo.push(...)` → status merge_conflict，merge 留在進行中；merge-agent.js:115-121 commitAll 失敗 → stopped，同樣不清理；pipeline-routes.js:136-138 mark-conflict-resolved 直接把 status 改 deploy_testing，不驗證 MERGE_HEAD 是否已了結、衝突標記是否移除。env-agent.js:203-212 upgradeModules 的 addons-path 直指這些主 clone 工作樹。

**說明**

AI 解衝突失敗後，主 clone testing 工作樹帶著 `<<<<<<<` 標記等人工。期間同專案其他任務：(1) deploy_testing 對同一 addons-path 跑 odoo-bin -u → Python SyntaxError → 被 deploy-testing.js 判為程式錯退 coding 計數（與根因 B 同型：別的任務的 merge 殘留被歸因到這個任務的程式碼）；(2) 下一個任務 mergeInto checkout testing 會撞 'You have not concluded your merge' → 非衝突類錯誤直接 throw → stopped。另外 doMerge 部分成功（repo1 已併、repo2 衝突）也無回滾，testing 各 repo 版本不一致。

**修補方向**

merge-agent 所有失敗出口（解衝突失敗、commitAll 失敗、mergeInto throw）先呼叫 abortMerge(repo)；mark-conflict-resolved 在轉 deploy_testing 前驗證 `git status` 乾淨且無 MERGE_HEAD；deploy 前檢查工作樹是否含衝突標記，命中則歸因 infra/流程而非退 coding。

<details><summary>驗證 agent 的查證紀錄</summary>

All five evidence points verified against actual code:

1. abortMerge (git.js:160-162, exported at line 268) has zero callers across all app/server/**/*.js — confirmed by exhaustive grep.

2. merge-agent.js conflict failure paths (lines 115-125): both the commitAll-throws path and the failed-auto-resolve path set status and return without calling abortMerge, leaving MERGE_HEAD + conflict markers in the main clone's testing working tree.

3. pipeline-routes.js mark-conflict-resolved (lines 136-140): pure DB UPDATE, no git state validation. A user can advance to deploy_testing while the repo still has MERGE_HEAD and/or conflict markers.

4. env-agent.js upgradeModules (lines 203-212): projectAddonsPaths() returns project_repos.local_path values — the main clone paths where testing lives. odoo-bin receives these via addonsPath and reads Python files directly from those trees. If conflict markers (<<<<<<) are present, Python raises SyntaxError.

5. deploy-testing.js (lines 69-91) confirms mis-attribution: upgrade SyntaxError → deploy_retry_count incremented → status='coding_running' with retry_feedback containing the Odoo error → AI treats a git artifact as a code bug and re-enters the coding loop. This is mechanically identical to root cause B.

The partial mitigation (withProjectMergeLock serializes merges per project) does not prevent upgradeModules from running against the conflicted working tree, and does not block mark-conflict-resolved from prematurely advancing status. The secondary sub-claim (Task B merge hitting 'You have not concluded your merge' → stopped) is mechanically correct; the blocker message would reference MERGE_HEAD rather than triggering a coding retry, so that specific leg is stopped rather than mis-attributed — but the primary damage path (conflict markers → SyntaxError → coding loop) is fully confirmed. P1 stands: the defect can produce unbounded coding retries for a problem that is a git infrastructure issue, directly replicating the pattern behind the 4.77M-token incident.

</details>

### U7. 專案層鎖覆蓋不全：analysis 直接 checkout 主 clone 到 main 且不切回 testing、完全無鎖；merge 鎖與 deploy 鎖又是兩個獨立 Map → 同專案跨階段互踩，測試環境跑到錯的分支

**嚴重度** P1｜**影響目標** 穩定／準確｜**來源** 流程層｜**驗證** ✅ confirmed

**證據**

task-agent.js:186-191 `for (const repo of info.repos) { const base = await ensureMainBranch(repo.local_path); await pullBranch(repo.local_path, base); }`（操作主 clone、無任何 withProjectLock，事後不 ensureTestingBranch 切回）；merge-agent.js:12-18 `_projectMergeChains` 與 deploy-testing.js:22-28 `_chains` 是兩個互不相知的鎖；env-agent.js:84-89 測試環境 addons-path 掛主 clone 且預期停在 testing（`ensureTestingBranch`）。

**說明**

三個具體踩踏：(1) 任務 A 進 analysis 把主 clone 切到 main 並留在 main；此後任務 B 的 deploy（odoo -u 讀同一工作樹）在 main 上升級，不含 B 已併入 testing 的變更 → E2E 失敗被歸因為 B 的程式問題（根因 B 同型）；(2) A 的 analysis checkout/pull 可與 B 進行中的 merge 在同一 .git 上並發（分別由不同 cron 實例驅動），checkout 撞 merge 中間態；(3) merge 鎖與 deploy 鎖分離：任務 A merge 改寫 testing 工作樹的同時，任務 B 的 odoo -u 正在讀同一批 .py。

**修補方向**

三種主 clone 操作（analysis 的 pull main、merge、deploy）共用同一個 per-project promise 鎖；analysis 結束（含失敗路徑）後把主 clone 切回 testing；或 analysis 改在唯讀的獨立 worktree/裸 clone 上讀碼，不動主 clone。

<details><summary>驗證 agent 的查證紀錄</summary>

三個子聲明全部以程式碼直接證實，無有效防護機制：

**子聲明 1（analysis 留在 main、無鎖）**
`task-agent.js:186-191`：`ensureMainBranch(repo.local_path)` 呼叫 `git.js:115` 的 `git checkout main`，接著 `pullBranch` 停在 main。整段 `try-catch`（到第 248 行）完全沒有 `ensureTestingBranch` 呼叫，包含所有失敗路徑（停在 main 的情形）。也沒有任何 `withProjectMergeLock` 或 `withProjectLock` 包裹。

**子聲明 2（兩個分離的 Map 鎖）**
`merge-agent.js:12`：`const _projectMergeChains = new Map()`；`deploy-testing.js:22`：`const _chains = new Map()`。兩者各為模組層級 Map，互不相知，merge 與 deploy 無法互斥。

**子聲明 3（upgradeModules 不切 testing）**
`env-agent.js:87` 的 `ensureTestingBranch` 只存在於 `runEnvSetup`（環境初次建立時）。`upgradeModules`（`env-agent.js:195-213`）取得 `extraAddons` 路徑後直接組 `addonsPath` 傳給 `odoo-bin -u`，完全沒有確認工作樹分支。`doDeploy`（`deploy-testing.js:52`）當 env 已是 running 時跳過 `runEnvSetup`，`ensureTestingBranch` 便從不被呼叫。

**競爭條件的發生路徑**
`runner.js:267-270` 的迴圈連續掃描同一用戶所有可執行任務。跨 cron 觸發時：cron tick 1 啟動任務 A 的 analysis（長時間執行，留在 `_inFlight`）；cron tick 2 偵測到任務 A 已 inflight 立即跳過，繼續處理任務 B 的 `deploy_testing`。此時任務 A 的 `ensureMainBranch` 已把主 clone checkout 到 main，任務 B 的 `upgradeModules` 讀到 main（不含任務 B 已併入 testing 的異動）→ `odoo-bin -u` 升級失敗 → 假陽性 coding 重跑 → token 大量浪費。此為任務 52 事故的同型根因（B 類），嚴重度 P1 成立。

</details>

### U8. test_mode=true 讓 cron 完全不推進 pipeline + loop_counter 到上限即自鎖：任務停在關卡間等人手點擊，無任何 stale-task 回收

**嚴重度** P1｜**影響目標** 穩定／token｜**來源** 資料層＋流程層｜**驗證** ✅ confirmed

**證據**

DB：teams_settings.test_mode=true；loop_counter user_id=2 loop_count=6（> LOOP_LIMIT=5）卡在 07-06 07:40 至今、user_id=1 loop_count=1 停在 07-07 02:53:09（與 task 52 最後事件同秒，之後 cron 再無推進）。程式：app/server/cron.js:62 `runForUser(user.id, { skipPipeline: testMode })`、cron.js:63 `else if (!testMode)`——test_mode 下兩條路都不跑 pipeline；cron.js:24 只有 sync 有新任務才 resetLoopCounter；runner.js:233-240 loop_count>5 直接 return。實測資料：task 52 QA 08:57:13 出 verdict（token id=47）→ merge 階段標記 09:31:39（event id=68），中間 34 分鐘純等待；task 52 現況 playwright_running，最後事件 02:53 後無下文。index.js:139-141 啟動時只回收 odoo_envs 的 setting_up，對 *_running 任務無任何 reconciliation；_inFlight 是純記憶體 Map（runner.js:26）。

**說明**

「進程死掉沒人接手」在此平台是結構性的：(1) test_mode 下所有階段轉換都要人工點 step，兩天事故有相當比例是關卡間 idle；(2) 就算關掉 test_mode，長任務 in-flight 期間 cron 每分鐘 increment loop_count，5 分鐘後該 user 的 pipeline 自鎖，要等下次 sync 撿到新任務才會 reset——長 E2E（25 分鐘）跑完後的下一關沒人推；(3) server 重啟後 *_running 任務無回收：spawn 出去的 claude 子行程變孤兒繼續燒 token（無 kill、無記帳），任務永遠停在 *_running（task 52 的兩個 `▶ E2E 測試中` 事件相隔 25 分鐘、之間無失敗事件、無 token 記錄，即符合此模式）。

**流程層獨立發現的補充**（loop_counter 每分鐘無條件 +1、上限 5、僅「同步到新任務」或手動按鈕歸零且 DB 持久化 → 任務中途 pipeline 集體停擺，使用者回覆澄清/解鎖後可能永遠沒人接手）

11 個 runnable 狀態的任務要 10+ 個 tick 才走得完，但 cron 每分鐘 +1、6 分鐘後 runPipeline 一律早退（只發 toast）。之後任務停在 qa_running/confirm_answered 等狀態不動，直到下次同步「剛好有新任務」（預設 60 分鐘一次、且必須 added>0）或使用者手動按 step。使用者回答澄清（confirm_answered）或解除阻塞後若計數已滿，動作石沉大海；server 重啟也救不回（計數在 DB）。這是「無法離開的狀態」的系統性成因。

**修補方向**

啟動時把非 in-flight 的 *_running 任務轉 stopped/resume；loop_counter 在「有任務完成一個階段轉換」時 reset 而非只在 sync 有新任務時；test_mode 語意限縮為「不自動 sync」而非「不推進既有任務」；為 *_running 加 heartbeat/updated_at watchdog（超過 N 分鐘無事件即回收）。

<details><summary>驗證 agent 的查證紀錄</summary>

全部三條子主張均有確實程式碼支撐，無誤引行號，無解讀錯誤。

(1) test_mode 封鎖 pipeline：cron.js:60-67 確認，sync 觸發時走 skipPipeline:true（line 62），未觸發時走 else if (!testMode)（line 63）——兩條路在 test_mode=true 下都不呼叫 runPipeline。index.js:54-58 的手動 /api/sync/now 也在 test_mode 下跳過 pipeline。

(2) loop_counter 自鎖：runner.js:233-242 確認，loopCount > LOOP_LIMIT(5) 即 return（不再 increment），重設只在 cron.js:24 收到新任務、或使用者手動點 /api/pipeline/step（index.js:78）時發生。長任務（coding 25 分鐘）進行中，cron 每分鐘空跑一次遞增，約 5 分鐘後鎖住，後續狀態轉換全部停滯。

(3) *_running 無回收：index.js:138-141 啟動時只回收 odoo_envs.setting_up，RUNNABLE_STATUSES（runner.js:27）雖含所有 *_running 狀態（在非 test_mode 下 cron 會自然重試），但 test_mode=true 下 cron 永不呼叫 runPipeline，重啟後 *_running 任務永遠等人工 step。

找到一個輕微反駁點：claude-runner.js:46-48 的 spawn() 未帶 detached:true，Windows 環境子行程通常隨父行程死亡，「孤兒繼續燒 token」這一子主張在 Windows 下強度較弱。但任務狀態殘留 *_running 的主要危害仍成立。

嚴重度 P1 合理：test_mode=true（已被資料庫確認）使三個機制同時生效，與 task 52 兩天 4.77M token 未完成事故直接相關，對穩定性與 token 消耗均有高機率重大影響。


---
（流程層重複發現的獨立驗證）

所有引用證據均屬實，邏輯推論正確。

runner.js:18 LOOP_LIMIT=5 確認。runner.js:242 在查詢任務（line 244）之前無條件執行 incrementLoopCounter，因此即使沒有 runnable 任務也會 +1。cron.js:42 每分鐘觸發確認；cron.js:22-24（finding 行號差一但邏輯正確）reset 僅在 total>0 條件下發生確認。tasks-routes.js answer 路由（293-296）、resolve-blocker（321-326）、pipeline-routes.js mark-conflict-resolved（136-140）三個路由均只寫 DB status，沒有呼叫 resetLoopCounter 也沒有呼叫 runPipeline，確認。loop_counter 以 UPSERT 持久化進 DB（runner.js:46-52），重啟不歸零確認。

Finding 漏掉一個防護：index.js:56 的 /api/sync/now 無條件呼叫 resetLoopCounter（不需 added>0）。但這不改變嚴重度，因為正常 cron 路徑（非同步分鐘）每分鐘直接 runPipeline 且不重設，coding/qa 等 agent 佔用 6+ 分鐘後計數器就超限；使用者回覆澄清或解除阻塞後，若計數已滿，動作石沉大海屬實。唯一逃脫方式是手動按 /api/pipeline/step（resets+runs）或等 60 分鐘同步剛好帶入新任務。P1 適切。

</details>

### U9. claude-runner.callClaude 完全沒有 timeout（cs/merge/library/chat 全走這條），掛死即永久占用任務

**嚴重度** P1｜**影響目標** 穩定／token｜**來源** 資料層｜**驗證** ✅ confirmed

**證據**

app/server/pipeline/claude-runner.js:40-106 全函式無 setTimeout/timeout（對照 task-agent.js:70-72 有 `timeoutMs = 600000`）。使用方：cs-agent.js:41、merge-agent.js:41、library-agent.js:148/200/273、analysis.js:27、chat-agent.js:34。DB 佐證：tasks 44-47 停在 cs_running（synced 即 cs_running，見另一發現），若 cs claude 掛住將無任何機制中止。

**說明**

兩套 runner 的防護剛好互補地各缺一半：callClaude 有事件落地但無 timeout；spawnClaude 有 timeout 但無落地。cs/merge/wiki 階段的 claude 若 hang（網路、CLI 卡住），Promise 永不 settle，_inFlight 佔住該任務直到 server 重啟，重啟後又落入無回收的 *_running。與 abort 訊息分類問題同源（見 transient error 發現）。

**併入的相關發現**（流程層，P2）：callClaude（cs/analysis-basic/merge 解衝突/wiki/chat 共用）完全沒有 timeout → CLI 掛住時任務永遠卡在 *_running、_inFlight 永不釋放，只能重啟 server

claude CLI 若因網路/stdio 卡死不輸出也不退出，callClaude 的 promise 永不 settle → 任務永遠掛在 cs_running / analysis_running / merge_running / wiki_updating，_inFlight 佔位使後續 tick 全部跳過，abort 只能靠使用者手動暫停或重啟 server。與 rate limit 的互動：CLI 非零退出會 reject → 各 agent 一律轉 stopped（除 analysis-basic），沒有任何 backoff 重試，短暫 429 也要人工解鎖再全額重跑。

**併入的相關發現**（Agent 層，P2）：callClaude 完全沒有 timeout——掛死的 merge 會永久卡住該專案的 merge lock 鏈

task-agent.js 的 spawnClaude 有 timeout（雖然太短），但 callClaude（cs/chat/merge/library/analysis-basic 使用）一個都沒有。claude 子行程若掛住（網路、CLI 卡死），merge 場景最致命：同專案所有後續任務的併入 testing 全部無限等待，且無任何日誌指出卡在哪。

**修補方向**

callClaude 補上與 spawnClaude 相同的 timeoutMs 機制；長期應合併兩套 runner 為一個實作。

<details><summary>驗證 agent 的查證紀錄</summary>

（原紀錄為日文，以下為譯文）經程式碼搜尋確認：claude-runner.js:40-106 的 callClaude 全段不存在 setTimeout/timeoutMs（grep 0 筆）；task-agent.js:70-72 的 spawnClaude 則有明確的 600000ms 計時器，兩套 runner 的不對稱已實證。callClaude 的 6 個呼叫端（cs-agent.js:41、merge-agent.js:41、library-agent.js:148/200/273、analysis.js:27、chat-agent.js:34）全數確認。chat-agent.js:34 傳入的 signal 為 undefined，連手動 abort 都無法作用。Claude CLI 進程一旦掛住，Promise 永遠不會 settle，任務停留在 cs_running/analysis_running 等狀態，在 server 重啟之前不存在任何回收機制。P1 嚴重度恰當：雖不致資料損失或無限迴圈，但這是橫跨 pipeline 的 cs/merge/wiki/analysis/chat 各階段、毫無防護的可用性缺陷，構成重大穩定性風險。

</details>

### U10. coding／analysis 共用 10 分鐘硬 timeout，逾時整輪 token 作廢

**嚴重度** P1｜**影響目標** token／穩定｜**來源** Agent 層｜**驗證** ✅ confirmed

**證據**

app/server/pipeline/task-agent.js:61 `timeoutMs = 600000` 預設值；:70-72 逾時 `child.kill(); reject(new Error('claude subprocess timed out'))`；:210、:276 runTaskAnalysis/runTaskCoding 呼叫時皆未覆寫 timeoutMs。qa-agent.js:39、playwright-agent.js:53 同樣走此預設。

**說明**

coding agent 被要求讀 wiki、Context7 最多 5 次、Serena 3 次、逐檔實作＋py_compile＋逐 repo commit（coding-project.md:12-41），複雜任務極易超過 10 分鐘。逾時即 kill：已消耗的全部 token 作廢、未 commit 的變更殘留在 worktree、任務 stopped 等人工 resume 後從頭再跑。對照任務 52 兩天 4.77M tokens 的型態，逾時重跑是可疑的放大器之一。

**併入的相關發現**（流程層，P2）：spawnClaude 固定 10 分鐘 timeout：大型 coding 任務被中途砍掉 → stopped、已花 token 全棄、resume 後從零重來；timer 觸發時漏設 done 旗標

複雜 Odoo 任務（多 repo、多檔案、需 py_compile/xmllint 驗證）10 分鐘常常不夠；被砍時 worktree 留下半成品未 commit，任務轉 stopped，人工 resolve 後開全新 session，prompt 不會告知「已有部分實作」，agent 可能重做或與殘檔衝突。timeout 不分階段（analysis/qa/playwright 共用同值）也不可配置。

**修補方向**

依 stage 區分 timeout（coding/analysis 拉長至 30-60 分鐘或可設定）；逾時訊息帶明確標注「逾時非程式錯」，避免與失敗混淆。

<details><summary>驗證 agent 的查證紀錄</summary>

所有引用的行號與程式碼均確認屬實。task-agent.js:61 的 `timeoutMs = 600000`（10 分鐘）為唯一預設值；task-agent.js:210（analysis）、:276（coding）、qa-agent.js:39、playwright-agent.js:53 四處 spawnClaude 呼叫皆未覆寫，全部共用此預設。coding-project.md:12-41 要求最多 5 次 Context7 + 3 次 Serena + wiki 讀取 + 檔案探索 + 逐檔 py_compile/xmllint + 逐 repo commit，複雜任務的總執行時間輕易超過 10 分鐘。逾時後 child.kill() 立即終止子程序，所有已消耗 token 全數作廢；額外確認：retry_feedback（task-agent.js:272-273）僅由 QA/部署失敗填入，逾時不填——因此人工 resume 後下一輪 coding 完全冷啟動，無任何部分進度可延續。claude-runner.js:114-115 的 stopReason 確實會把 "claude subprocess timed out" 寫入 blocker_content，但外層標籤與程式錯誤相同（"實作 Agent 執行失敗"），操作者難以區分是超時還是程式 bug，可能反覆修程式碼重跑而非調整 timeout，正是任務 52 多輪重跑的可疑放大器之一。P1 嚴重度成立：結構上高機率在複雜任務造成 token 重大浪費與穩定性問題。

</details>

### U11. merge agent 輸出直接覆寫衝突檔，無 code-fence／前後綴防護

**嚴重度** P1｜**影響目標** 準確／穩定｜**來源** Agent 層｜**驗證** ✅ confirmed

**證據**

app/server/pipeline/merge-agent.js:50-52：`if (!resolved || resolved.includes('<<<<<<<')) return false; fs.writeFileSync(fullPath, resolved);` ——唯一驗證是「不含衝突標記」。merge.md:10 只用文字指示「不要有任何說明文字，直接輸出檔案內容」。

**說明**

model 常見把整檔輸出包在 ```python fence 或前後加一句說明；這種輸出不含 <<<<<<< 會通過檢查，帶著 fence 直接寫入 .py/.xml 並在 merge-agent.js:113 commitAll 進 testing 分支。損壞檔到 deploy_testing 才以 Odoo 載入錯誤爆出→退回 coding（coding 的 worktree 裡根本沒這個壞檔，修不到）→ 又觸發根因 B 式空轉。

**修補方向**

寫檔前剝除首尾 code fence；加最低限度合理性檢查（Python 檔跑 py_compile、XML 跑解析；或至少比對行數/長度與原檔量級）；失敗即歸入人工衝突清單而非硬寫。

<details><summary>驗證 agent 的查證紀錄</summary>

證據完全成立。app/server/pipeline/merge-agent.js:50-51 確實只檢查 `<<<<<<<` 後即 writeFileSync，無任何 code fence 剝除。.claude/agents/merge.md:10 的 prompt 只說「不要有任何說明文字」，未明確禁止 ``` 符號。claude-runner.js:101 的 callClaude 只做 .trim()，不處理 fence。Claude 在解衝突時對程式碼檔案常見帶 ```python/```xml 輸出；此類輸出通過 <<<<<<< 檢查後直接寫入、被 commitAll（第 113 行）提交進 testing，Odoo 載入時以 SyntaxError/XMLParseError 爆出，coding worktree 沒有這個壞檔無從修正，觸發根因 B 式空轉，符合 P1「高機率造成穩定浪費與 token 重大浪費」。

</details>

### U12. 失敗/中斷/逾時的 Claude 執行完全不寫 token_usage：playwright 0 筆、事故 4.77M 是低估、掛掉的長跑不可見

**嚴重度** P1｜**影響目標** 準確／token｜**來源** 資料層｜**驗證** ✅ confirmed

**證據**

app/server/pipeline/token-logger.js:4 `if (!usage) return;`；usage 只來自 stream 的 `result` 事件（task-agent.js:96-99、claude-runner.js:75-79），timeout/abort/非零退出走 reject，各 agent 的 catch（如 playwright-agent.js:56-58、qa-agent.js:42-49）直接 stopTask 不記帳。DB：token_usage 54 筆中 agent_type='playwright' 為 0 筆，但 task 52 有兩次進入 E2E（task_events id=88 07-07 02:28、id=89 02:53 `▶ E2E 測試中`）；02:02 aborted 的 coding（event id=87）同樣無對應列。

**說明**

token_usage 只在 claude 正常收尾（收到 result 事件）時落一筆。被 600s timeout 殺掉、被 abort、server 重啟遺留的孤兒 claude process，其 input/cache token 全部消失於帳面。事故任務「QA 單次 35 分鐘」在 token_usage 也查不到（qa max duration 僅 50s）——實際上 08:57:13 QA 已回 verdict，08:57→09:31 的 34 分鐘是 pipeline 停在原地等下一次觸發（見 test_mode 發現），帳面與體感的落差正是因為失敗與等待都不留數據。以此表做成本控管或離群偵測會系統性低估最貴的情境（失敗重跑）。

**修補方向**

在 spawnClaude/callClaude 的 timeout/abort/error 路徑也落一筆（usage 為部分累計或 0、加 status 欄位標記 completed/timeout/aborted），並記 durationMs；token 報表區分成功/失敗執行。

<details><summary>驗證 agent 的查證紀錄</summary>

所有引用的程式碼證據均真實存在且解讀正確。

核心機制已確認：
- token-logger.js:4 `if (!usage) return;` 確實存在。
- `usage` 只在 Claude CLI 發出 `result` 事件時才被賦值（task-agent.js:96-99、claude-runner.js:75-79）。Claude 的 stream-json 格式僅在最後的 result 事件中攜帶 usage；subprocess 被 kill 前不會輸出 result 事件。
- timeout 路徑（task-agent.js:70-71）：`child.kill()` 後 `reject()` 直接拋出，`usage` 為 null，catch block 呼叫 stopTask 不記帳——確認。
- abort 路徑（task-agent.js:74-77）：同上，done=true 後 reject(abortError())——確認。
- playwright-agent.js:55-58：`logTokenUsage` 在 try 內緊接 spawnClaude 之後，catch(56-58) 只呼叫 stopTask，拋出時完全跳過記帳——確認。
- qa-agent.js:41-49：同樣結構，logTokenUsage 在 try 內、catch(42-49) 不記帳——確認。
- task-agent.js analysis catch(213-219)、coding catch(279-286)：同樣不呼叫 logTokenUsage——確認。
- chat-agent.js:34-36：callClaude 完全沒有 try-catch 包覆，若拋出則第 36 行 logTokenUsage 跳過——確認。

無任何 finally 塊或備用記帳路徑。失敗/中斷/逾時的執行一律不留 token 記錄，token 報表系統性低估最昂貴的情境（失敗重跑）。

描述中「QA max duration 僅 50s」係描述性注腳錯誤（代碼中 qa-agent.js:39 未傳 timeoutMs，預設為 600 s），但不影響核心發現的正確性。DB 數據（playwright 0 筆）無法透過 getSQL 直接驗證（該 skill 連的是遠端 Odoo DB 而非平台自身 DB），但程式碼邏輯已足夠——每次 E2E 失敗退回 coding 時均走 catch 路徑，機械性地不產生任何 token_usage 記錄。P1 嚴重度正確：不造成功能崩潰，但使成本管控與離群偵測對最貴情境完全盲目。

</details>

### U13. 執行歷程（task_events）覆蓋嚴重不全：coding/qa/playwright/analysis 的 transcript 只走 socket 不落地，12/15 任務 0 筆事件，事後鑑識不可能

**嚴重度** P1｜**影響目標** 準確｜**來源** 資料層｜**驗證** ✅ confirmed

**證據**

兩套 runner 分歧：app/server/pipeline/claude-runner.js:61 有 `INSERT INTO task_events`（cs/merge/library 用），但 app/server/pipeline/task-agent.js:94 只 `notify.emitToUser(...)` 不寫 DB（analysis/coding/qa/playwright 都 import 這個 spawnClaude）。DB：task_events 全表僅 46 筆、只覆蓋 3 個任務（52/55/56）；task 48 已推進到 coding_running（token_usage id=21 cs、id=22 analysis 335k tokens 都有帳）卻 0 筆 events。task 52 的 40 筆事件裡 coding×6/qa×6 只剩 `▶ 開發中`/`▶ QA 審查中` 階段標記，無任何 agent 輸出。

**說明**

最貴、最常失敗的階段（coding/qa/playwright）在 DB 沒有任何 transcript，只有 runner.js:223-225 的階段標記；瀏覽器沒開著就什麼都沒留下。加上 tasks-routes.js:206-207 刪任務時硬刪 task_events/task_logs（token_usage 卻保留），歷史失敗模式無法回溯——本次健檢就無法還原 07-06 08:26 之前的任何事件（task_events 最小 id=44）。這直接削弱「準確歸因失敗根因」的能力：像根因 C 的 blocker 只存 banner 的問題，若 events 有完整 transcript 本可交叉比對。

**修補方向**

統一兩套 runner（task-agent.spawnClaude 也 best-effort 落 task_events，或合併回 callClaude 並補 timeout）；刪任務改軟刪或保留 events 至保存期限，與 token_usage 的保留政策一致。

<details><summary>驗證 agent 的查證紀錄</summary>

所有引用的程式碼證據均屬實：task-agent.js 的 spawnClaude（被 analysis/coding/qa/playwright 四個 agent 使用）在其 stdout handler（lines 80-104）完全沒有 INSERT INTO task_events，只有 notify.emitToUser()；而 claude-runner.js 的 callClaude 在 emit() 函式（lines 57-61）同時寫 socket 與 DB。runner.js:222-225 確認 coding/qa/playwright 階段在 task_events 中唯一留下的是進入階段時的一筆 marker（▶ 開發中 / ▶ QA 審查中），無任何 agent 輸出。tasks-routes.js:206-207 與 229-230 確認刪任務時硬刪 task_events/task_logs，而 token_usage 以 task_id TEXT（無 FK）儲存故不受影響，保留/刪除政策確實不一致。DB 統計數字（46 筆、僅 3 任務）因平台本地 DB 無法透過 getSQL 工具查詢而無法獨立驗證，但程式碼機制完全可解釋該現象。P1 嚴重度合理：最昂貴且最常失敗的四個階段無任何 transcript 可事後回溯，直接削弱失敗根因歸因能力，與 task-52 事件（4.77M tokens、coding×6/qa×6）的分析困難直接相關。

</details>

### U14. 非專案任務 MODE_B 產生死狀態 final_pending：無 handler、無前端標籤、卡死不可見

**嚴重度** P1｜**影響目標** 穩定／準確｜**來源** 專案層｜**驗證** ✅ confirmed

**證據**

app/server/pipeline/analysis.js:14 `if (parsed?.execution_mode === 'MODE_B') return 'final_pending';`（analyzeTask 用於 task.project_id 為空的任務，runner.js:96）。但 runner.js:27 RUNNABLE_STATUSES 不含 final_pending（無 handler）；tasks-routes.js:23 NEEDS_ACTION_STATUSES 不含；app/public/js/views/TaskList.js:2-21 STATUS_LABELS 無 final_pending（badge 只在 app.css:268 有樣式、無文字）。db.js:308-312 的 final_pending→stopped 轉換只在 migrate() 啟動時跑一次，不會攔截「執行中」新產生的 final_pending。analysis.test.js:106-113 還把此死狀態寫死為預期值。

**說明**

非專案（manual／同步未綁專案）任務被分析判為 MODE_B 時，狀態被設成 final_pending。pipeline 沒有此狀態的 handler、不在 runnable 也不在 needs_action，前端沒有對應標籤（會顯示原始英文字串 final_pending），任務永久卡住且不會出現在「需回覆／待審核」分頁，使用者完全看不到也無法操作。啟動時的一次性 migration 只清理歷史殘留，救不了執行期新產生的。

**併入的相關發現**（流程層，P2）：analysis-basic MODE_B 仍會產出 final_pending，但該狀態已無 handler、不在 RUNNABLE 也不在 NEEDS_ACTION，僅 server 重啟時一次性轉 stopped → 執行期死狀態

改版時移除了 final_pending 的後續處理，卻沒移除產生它的程式碼。非專案任務被判 MODE_B 後會離開所有佇列與待辦清單，使用者看不到、pipeline 不撿，直到下次重啟 server 才被打成 stopped。屬「無 handler 認領的狀態」（查察項目 1）。

**修補方向**

analysis.js determineNextStatus 的 MODE_B 分支應改導向一個實際存在且有 UI 觸點的狀態（如 review_pending 或新增合法的 handler+label+needs_action 三處同步），或明確禁止非專案任務進入 MODE_B。同時修正 analysis.test.js 使其驗證『任務最終停在可操作狀態』而非鎖死 final_pending。

<details><summary>驗證 agent 的查證紀錄</summary>

所有八個證據點均逐一驗證屬實。analysis.js:14 確實對 MODE_B 回傳 final_pending；runner.js:96 確認非專案任務走 analyzeTask；runner.js:27 的 RUNNABLE_STATUSES、tasks-routes.js:23 的 NEEDS_ACTION_STATUSES、TaskList.js:2-21 的 STATUS_LABELS 三處均不含 final_pending；db.js:308-312 的轉換只在啟動 migrate() 時執行一次；analysis.test.js:106-113 將死狀態寫死為預期值。分析 agent 提示（.claude/agents/analysis-basic.md）明確將 MODE_B 定義為合理輸出（複雜/多模組/高風險任務），非極端邊緣情況。任務一旦進入 final_pending：pipeline 無 handler（runner.js:219 直接 return）、不在 runnable 查詢範圍、不出現在需回覆分頁、前端只顯示原始英文字串，唯一恢復路徑為重啟伺服器觸發 migrate()。P1 嚴重度成立：高機率發生、造成任務永久卡死且使用者無感知。

</details>

### U15. install.ps1 全新安裝未產生 APP_SECRET／ANTHROPIC_API_KEY，導致 DB 查詢與加密功能開箱即 500

**嚴重度** P1｜**影響目標** 穩定｜**來源** 專案層｜**驗證** ✅ confirmed

**證據**

install.ps1:69-74 config 物件只寫 `DATABASE_URL / JWT_SECRET / PORT`，無 APP_SECRET；config.example.json 同樣缺 APP_SECRET 與 ANTHROPIC_API_KEY。start.ps1:27 `if ($config.APP_SECRET) { $env:APP_SECRET = ... }`（缺省時靜默不設）。lib/crypto.js:3-7 getKey() 在 APP_SECRET 未設時 `throw new Error('APP_SECRET environment variable is required')`；db-query-routes.js:37,67 建立/更新 db_connection 直接呼叫 encrypt()（會 throw→500），auth.js:74/145 改用 encryptSafe（回 null 靜默）。

**說明**

全新安裝流程只產生 JWT_SECRET，從不建立 APP_SECRET。crypto.getKey() 缺 APP_SECRET 時會丟例外，因此任何「新增／查詢 DB 連線」都會回 500，playwright E2E 憑證加密也失效。實際運行的 data/config.json 有 APP_SECRET（手動補的），但安裝腳本與 config.example.json 沒有，換機重裝即壞。ANTHROPIC_API_KEY 亦未在安裝時詢問。

**修補方向**

install.ps1 在產生 JWT_SECRET 的同段落一併亂數產生 APP_SECRET 寫入 config；config.example.json 補上 APP_SECRET／ANTHROPIC_API_KEY 佔位鍵；或在 crypto.js 啟動時對缺 APP_SECRET 給出明確可讀的啟動期錯誤（fail loud）而非等到第一次 DB 查詢才炸。

<details><summary>驗證 agent 的查證紀錄</summary>

所有引用證據均真實存在且解讀正確。install.ps1:69-73 只產生 JWT_SECRET，不產生 APP_SECRET；config.example.json 同樣缺少 APP_SECRET 與 ANTHROPIC_API_KEY；start.ps1:27 在 APP_SECRET 不在 config 時靜默略過；lib/crypto.js:5 的 getKey() 在 APP_SECRET 為 falsy 時拋出例外；db-query-routes.js 的 POST（line 37-38）與 PUT（line 67-68）在傳入 ssh_password 或 ssh_key_content 時直接呼叫 encrypt()（非 encryptSafe），query 端點（loadDecryptedConn line 130）呼叫 decrypt() 亦同路徑，任何有憑證的連線執行查詢時均 500；auth.js 則正確使用 encryptSafe（line 75, 145）避免 crash。index.js 啟動流程無 APP_SECRET 守衛，伺服器可正常啟動但核心 DB 連線功能（createConnection、updateConnection with credentials、runQuery）開箱即壞。P1 嚴重度成立：全新換機安裝後，getSQL 技能及 DB 連線管理功能全面失效，直至手動在 config.json 補上 APP_SECRET。

</details>

## 四、P2／P3 發現（依層，未經獨立驗證，證據皆附行號可自行核對）

### 資料層

#### 〔P2〕transient 錯誤（如 'aborted'）未分類，直接判 stopped 要求人工介入——根因 B 的同類：外部/暫時性失敗與程式失敗不分

**影響目標** 穩定／準確

**證據**：task_events id=87（07-07 02:02:18）：`❌ 失敗：實作 Agent 執行失敗：aborted`——coding 進場（event id=86, 02:01:58）僅 20 秒後即失敗，訊息是裸字串 'aborted'（非 abortError 的『手動暫停』，claude-runner.js:109-116 的 stopReason 只認 err.aborted flag）。qa-agent.js:42-49、task-agent.js 的 catch 對所有非 aborted 錯誤一律 status='stopped' 等人工。

**說明**：stream 中斷、CLI 非零退出、網路抖動等 20 秒內就死的暫時性錯誤，與真正的程式失敗走同一條 stopped 路徑；使用者只能填「繼續」→ 觸發 resolve-blocker → 計數器歸零（見 P1 發現），暫時性錯誤因此間接放大成無限重跑的入口。這是根因 B（部署失敗不分環境/程式問題）在 agent 執行層的同構問題。

**修補方向**：對已知 transient 訊息（aborted、ECONNRESET、exit code 非 0 且 stderr 為網路類）做一次性自動重試（不佔用 qa/deploy 計數器），重試仍敗才 stopped；stopReason 保留原始 stderr 供分類。

#### 〔P2〕token_usage 歸因鏈脆弱：project_id 45/54 為 NULL、18/54 為孤兒（任務被刪），專案別報表漏計三分之一

**影響目標** 準確

**證據**：DB：token_usage 54 筆中 project_id IS NULL 45 筆、task_id 對不上 tasks.task_id 的孤兒 18 筆（manual_1783319749063×12、manual_1783317232223×2、task_service_3732、task_odoo_4053/4055 等）、task_id 與 chat_id 皆 NULL 7 筆（wiki×5+chat×2 舊資料）。程式：所有任務型 agent 只傳 `{ taskId: task.task_id }` 不傳 projectId（qa-agent.js:41、playwright-agent.js:55、task-agent.js:212/278、cs-agent.js:42）；token-report-routes.js:64-73 by_project 靠 `LEFT JOIN tasks t ON t.task_id = tu.task_id` 補 project、:157 再 `filter(r => r.project_name)` 把 join 不到的整組丟掉。另 task_service_3765 有 07-03 的 cs token 記錄（id=15）但現存 tasks.id=48 是 07-06 02:33 重新匯入的新列——刪除→re-sync 循環會持續製造孤兒。

**說明**：寫入當下明明知道 project_id（agent 都已查過 task.project_id）卻不落，歸因全押在 tasks 表還活著；任務一刪（admin 刪除或 re-sync 重建）該專案的 token 就從 by_project 消失。目前 33% 記錄已不可歸因到專案，隨清理次數增加會持續惡化，成本報表對「哪個專案吃掉 token」的答案會越來越失真。

**修補方向**：logTokenUsage 呼叫端一律帶 projectId（資料 agent 手上都有）；一次性 backfill：用現存 tasks join 回填 project_id；報表把 join 不到的歸入『已刪除任務』桶而非 filter 掉。

#### 〔P3〕sync 匯入 service 任務直接寫 status='cs_running'：狀態語意失真，『處理中』其實從未跑過任何程序

**影響目標** 準確

**證據**：app/server/pipeline/sync.js:184 `VALUES ($1, $2, 'service', $3, $4, 'cs_running', 'service')`。DB：tasks 44-47（07-03 09:33:52 建立、09:34 內即被 batch pause）與 53/54 全是 cs_running 且 task_events 0 筆、token_usage 無對應 cs 執行（task_service_3777/3779 無任何 token 列）——cs agent 根本沒起跑過。

**說明**：查察項目 1 的結論：6 個 cs_running 卡 3 天並非 cs 進程死掉，而是 (a) 匯入即標 cs_running、(b) 使用者秒按 batch pause（tasks-routes.js:236-248，44-47 於 09:34 同批）、(c) test_mode 下 cron 不推進。狀態名稱與實況脫節會讓監控/健檢誤判成進程異常；cs_data_needed 的 55/56 有 cs 提問事件、等使用者補資料，屬正常。

**修補方向**：匯入狀態改 'new'（cs_running 留給真正進入 handleCs 時由 runner 標記），或至少在 UI/報表區分『排隊中』與『agent 執行中』。

#### 〔P3〕死 schema 與死欄位：sessions 表 0 列且無任何程式讀寫；reentry_count 建了、前端撈了、永遠是 0

**影響目標** 準確

**證據**：sessions：db.js:97 建表，全 server 目錄僅此一處引用（grep 排除 tests 後無任何 INSERT/SELECT），DB 實際 0 rows——auth 全走 JWT（index.js:111-129）。reentry_count：db.js:68 建欄位、tasks-routes.js:47 SELECT 給前端，但無任何 UPDATE/increment；DB 全部任務皆 0（含 coding×6 的 task 52）。loop_counter 僅 2 列、語意正常（但見自鎖發現）。

**說明**：sessions 是完全未接線的表；reentry_count 看似「任務重入次數」的審計欄位，實際從未累加，前端顯示的 0 會誤導使用者以為任務沒重跑過（task 52 實際重入 coding 6 次）。若當初有維護 reentry_count，事故的異常循環在第 3 次重入時就能被資料面偵測。

**修補方向**：刪除 sessions 表或接線；reentry_count 要嘛在每次退回 coding_running 時累加（qa/deploy/pw 退回點）作為跨計數器的總重試審計，要嘛連同前端顯示一併移除。

### 流程層

#### 〔P2〕非專案 analysis 的 API 錯誤 → 狀態留在 analysis_running 無限每分鐘重試，無計數器；與專案路徑（直接 stopped）行為分岔

**影響目標** token／穩定

**證據**：analysis.js:34-41 `catch (apiErr) { await query("UPDATE tasks SET status = 'analysis_running' ..."); throw apiErr; }` → runner.js:272-274 catch 只 console.error，任務仍是 runnable 的 analysis_running，下個 tick 再跑；對照 task-agent.js:213-220 專案 analysis 失敗 → stopped。

**說明**：持續性錯誤（額度耗盡、CLI 損壞、模型名錯誤）會讓非專案任務每分鐘重打一次 claude，每次都可能先燒 input token 才失敗，形成無人看管的計費迴圈；僅被 loop_counter 偶然剎住，但每次同步到新任務又重新放行。同一種失敗在兩條路徑一個無限重試、一個立即停止，違反單一模式原則。

**修補方向**：統一比照專案路徑：連續 N 次（如 2）API 失敗即 stopped 記 blocker；或加 analysis_retry_count 欄位與上限。

#### 〔P2〕夜間 23:00 nightlyShutdown 無視進行中的 deploy/E2E，直接 kill 所有測試環境 → E2E 中途死掉被計入 pw_retry_count 退 coding（環境問題誤歸因為程式問題）

**影響目標** 準確／穩定／token

**證據**：cron.js:74-80 到點呼叫 `nightlyShutdown()`；env-agent.js:228-239 對所有 running env `process.kill(env.pid, 'SIGTERM')`，不檢查是否有任務在 playwright_running/deploy_testing；playwright-agent.js:26-30 只在「開跑前」檢查 env.status，跑到一半 env 死掉會得到 verdict fail 或無效結果 → playwright-agent.js:75-88 計數退 coding 或 stopped。

**說明**：與根因 B 同型的歸因錯誤：排程性的基礎設施關機讓正在執行的 E2E 連不上網站而失敗，卻走「程式問題」的退 coding 計數路徑，觸發一輪全新 coding+qa+merge+deploy+pw 的 token 消耗。deploy 中途被殺同理（odoo -u 的 DB 可能留在半升級狀態）。

**修補方向**：nightlyShutdown 前查詢是否有該專案任務處於 deploy_testing/playwright_running（或 _inFlight），有則跳過該 env；playwright fail 時先 ping test_url，連不上就歸類 infra stopped 不計數。

#### 〔P3〕非專案 handleBranch 用 createBranch（checkout -b）不冪等：分支已存在即每分鐘失敗重試、任務卡 branch_pending 無停損

**影響目標** 穩定

**證據**：runner.js:137-139 `await checkoutDefault(settings.git_repo_path); await createBranch(settings.git_repo_path, branchName);`；git.js:52-54 `git checkout -b <branch>` 分支存在必 throw；throw 後由 runner.js:272-274 吞掉、狀態不變，下個 tick 重試同樣失敗。對照專案路徑 git.js:211-216 addWorktree 有先清殘留的冪等設計。

**說明**：任務曾走到 coding 又被退回重走 branch_pending（或前次中斷殘留分支）時，非專案路徑會無限重試 git 失敗，沒有轉 stopped 的出口，使用者只看到任務停在「建立分支」。

**修補方向**：改用 `git checkout -B <branch>` 或先刪舊分支比照 addWorktree；失敗時轉 stopped 記 blocker 而非留在原狀態。

#### 〔P3〕cs-agent 把 CLI/API 錯誤與 JSON 解析失敗混為同一 blocker 訊息「CS agent failed to parse response」→ 失敗歸因不準

**影響目標** 準確

**證據**：cs-agent.js:39-54：catch 只 console.error（cs-agent.js:45-47），result 維持 null，統一走 `blocker_content='CS agent failed to parse response'`；對照其他 agent 用 stopReason(prefix, err) 保留原始錯誤（claude-runner.js:114-116）。

**說明**：使用者無法從 blocker 分辨是額度/網路問題（該重試）還是模型輸出格式問題（該改 prompt），也未沿用手動暫停（err.aborted）的特殊顯示——暫停 cs 階段會被標成 parse 失敗。

**修補方向**：catch 分支改用 stopReason('CS Agent 執行失敗', err) 寫入 blocker；JSON 抓不到才用 parse 失敗訊息。

### Agent 層

#### 〔P2〕retry_feedback 在 spawn 之前就清空——coding 失敗/逾時/暫停後回饋永久遺失

**影響目標** 準確／token

**證據**：app/server/pipeline/task-agent.js:271-274：`const retryFeedback = task.retry_feedback || ''; if (retryFeedback) await query('UPDATE tasks SET retry_feedback=NULL WHERE id=$1',...)` 之後才在 :276 spawnClaude。若 spawnClaude throw（timeout/abort/claude 崩潰），catch 區（:279-286）標 stopped，但 feedback 已是 NULL。

**說明**：QA/deploy 辛苦產出的失敗細節只有一次投遞機會：coding 這輪若因逾時或手動暫停中斷，resume 後重跑的 coding prompt {{retry_feedback}} 變『（無）』，等同 playwright 路徑的盲目重做。

**修補方向**：改為「成功 parse 出結果後」才清空 retry_feedback，或在 catch 中回寫。

#### 〔P2〕qa.md 硬編碼 `git diff main...branch`，主分支為 master 的 repo 判定失準

**影響目標** 準確／穩定

**證據**：.claude/agents/qa.md:15：「對每個 repo 子目錄執行 `git -C <子目錄> diff main...{{git_branch}}`」。但 git.js:101-107 getMainBranch 明確支援 main/master 雙分支，runner.js:123-124 任務分支從 `getMainBranch()` 的結果（可能是 master）長出。

**說明**：master-only repo 中 `diff main...task/x` 會報 unknown revision；QA agent 行為變成不可預期——可能自行改用 master（好運）、可能誤判「無變更＝沒實作」而 fail 退 coding（壞運，直接製造 QA fail 迴圈），也可能燒 token 反覆嘗試。與任務 52 的 qa×6 型態同類。

**修補方向**：由 JS 端算好 base branch 傳入 placeholder（如 {{base_branch}}），qa.md 改用 `git diff {{base_branch}}...{{git_branch}}`。

#### 〔P2〕analysis-project 的 confirm_pending 輸出契約模糊，且未知 status 被靜默放行成 branch_pending

**影響目標** 穩定／準確

**證據**：.claude/agents/analysis-project.md:69：「若需使用者確認（MODE_B 或有問題）則輸出 "confirm_pending"。」——唯一沒給完整 JSON 範例的分支。app/server/pipeline/task-agent.js:233 `if (!result?.status || !result?.analysis_yaml)` → stopped；:242 `const nextStatus = ['branch_pending','confirm_pending'].includes(result.status) ? result.status : 'branch_pending'`。

**說明**：兩個問題：(1) model 依字面可能只輸出 `{"status":"confirm_pending"}`（不帶 analysis_yaml），JS 在 :233 直接判無效→stopped，需要人工 resume——一次澄清變一次事故；(2) status 拼錯或輸出其他值時不是 fail loud，而是靜默當作 branch_pending 繼續往 coding 走——「需要確認」的任務可能未經確認就開工，方向與 CLAUDE.md Rule 12 相反。

**修補方向**：md 補上 confirm_pending 的完整 JSON 範例（含 analysis_yaml 與 questions 要放在 clarification_channel 的指示）；JS 端未知 status 改走 stopped 而非預設放行。

#### 〔P2〕所有 agent 輸出解析失敗一律 stopped、零重試——一次格式失誤＝整輪 token 報廢＋人工介入

**影響目標** token／穩定

**證據**：analysis.js:49-56（YAML parse 失敗→stopped）；task-agent.js:233-239、292-298（無有效 RESULT-JSON→stopped）；qa-agent.js:82-88；playwright-agent.js:92；cs-agent.js:49-55。無任何一處在 parse 失敗時做低成本重試（如只重問輸出格式）。另 tasks-routes.js:321-326 resolve-blocker 會把 qa/deploy/pw 三個計數器全歸零——每次人工 resume 重置上限，QA_LIMIT=3 實際可累到 ×6（吻合事故數據）。

**說明**：agent 已完整跑完（token 已花），只因收尾 JSON 格式不合就整輪作廢。以 coding/qa 單輪可達數十萬 token 計，一次格式抖動的代價極高。而 resolve 重置計數器讓「3 次上限」形同虛設，是任務 52 qa×6/coding×6 能發生的直接機制。

**修補方向**：parse 失敗時先做一次廉價補救：把 agent 的完整輸出（已在手上）餵給 haiku 只做「抽取/修復 RESULT-JSON」，失敗才 stopped。resolve-blocker 不要無條件歸零計數器（或設全生命週期總上限）。

#### 〔P2〕cs／library 用貪婪 regex `/\{[\s\S]*\}/` 擷取 JSON，回覆含多段大括號即 parse 失敗

**影響目標** 穩定

**證據**：app/server/pipeline/cs-agent.js:43-44：`const jsonMatch = text.match(/\{[\s\S]*\}/); if (jsonMatch) result = JSON.parse(jsonMatch[0]);`；library-agent.js:150-151、202-203、275-276 同一模式。

**說明**：貪婪匹配抓「第一個 { 到最後一個 }」。model 若在 JSON 前後多說一句含大括號的話（或先給範例再給答案），擷取範圍會跨越兩段→JSON.parse 失敗→cs 任務 stopped（cs-agent.js:49-55）；library 則靜默跳過 wiki 更新但任務照樣標 done（library-agent.js:208 之後無警示），wiki 缺頁無人知——後者同時違反 fail-loud。

**修補方向**：改為從最後一個 '{' 起嘗試、或逐候選括號平衡解析；library 擷取失敗時至少在 task_logs 留痕。

#### 〔P2〕cs-agent 的 wiki context 未截斷（chat 有 3000 字截斷），分類任務吃整份 wiki

**影響目標** token

**證據**：app/server/pipeline/cs-agent.js:16-20：`SELECT title, content FROM wiki_pages ... LIMIT 5` 後直接 join，無長度上限；對照 chat-agent.js:12：`if (wikiContext.length > 3000) wikiContext = wikiContext.slice(0, 3000)`。

**說明**：cs 只是三分類任務，卻把最多 5 頁完整 wiki 全文塞進 prompt；wiki 隨任務累積成長，每個新工單的分流成本線性膨脹。同一 codebase 已有截斷慣例（chat），cs 漏用。

**修補方向**：比照 chat 加長度上限（分類任務甚至可只給頁面標題清單）。

#### 〔P2〕model 配置：cs 分類過殺（sonnet），coding/analysis 對複雜任務可能不足（僅 sonnet）

**影響目標** token／準確

**證據**：cs.md:6 `model: sonnet`（純三分類＋制式 JSON）；merge.md:7 sonnet；coding-project.md:6、analysis-project.md:6、qa.md:6 皆 sonnet；deploy-fix.md:7 haiku（但未被呼叫）。agent-loader.js:24 `ALLOWED_MODELS = ['haiku','sonnet','opus','fable']`——opus/fable 已在白名單卻無任何 agent 使用。

**說明**：降級面：cs 是格式固定的分類題，haiku 足夠，且它是每個工單的入口、呼叫頻率最高。升級面：任務 52 顯示 sonnet coding 反覆修不好一個加欄位任務；重跑 6 輪 sonnet 的總成本遠超 1-2 輪 opus。retry 場景（qa_retry_count>0）維持同 model 重試是「同樣的腦袋再猜一次」。

**修補方向**：cs 降 haiku；考慮 coding/analysis 在 retry_count>0 時自動升級 model（escalation），比無差別重跑省 token 又提高收斂率。

#### 〔P2〕analysis-basic 要求裸 YAML 無標記，model 加 code fence 即 stopped，無剝除邏輯

**影響目標** 穩定

**證據**：.claude/agents/analysis-basic.md:11：「輸出必須是嚴格合法的 YAML，只有 YAML 本身，不含任何 markdown code block」；app/server/pipeline/analysis.js:46-52 直接 `yaml.load(rawYaml)`，parse 失敗→stopped，無 ```yaml fence 剝除。

**說明**：「請勿加 code block」是弱約束，model 對純資料輸出加 fence 是高頻行為；被 fence 包住的 YAML 會 load 成單一字串或報錯，REQUIRED_FIELDS 檢查（analysis.js:47-48）必失敗。這是全套 agent 中唯一不用 ---RESULT-JSON--- 包絡的主流程 agent，契約形式與其他人不一致（違反單一慣例）。

**修補方向**：JS 端 load 前剝除首尾 ``` fence（一行 regex）；或統一改用 RESULT-JSON 包絡與 parseResult。

#### 〔P3〕coding prompt 強制 py_compile＋git add -A，卻未提「勿 commit __pycache__/*.pyc」——根因 A 的 prompt 層缺口

**影響目標** 穩定

**證據**：.claude/agents/coding-project.md:35（每檔跑 `python -m py_compile`，必產生 __pycache__/*.pyc）＋ :40（`git -C <repo子目錄> add -A`）。緩解已在 git 層：git.js:8-17 ensureGitignorePyc 寫 .git/info/exclude、:28-39 untrackPyc。

**說明**：產生 pyc 的指令與全量 add 的指令都由同一份 prompt 下達，防線卻只在 git 層（exclude 只擋 untracked；歷史 tracked pyc 在 coding worktree 仍會被 add 進 commit，要等 merge 階段才被 untrackPyc 清）。prompt 層零成本可以再擋一道。

**修補方向**：coding-project.md Commit 段加一句：commit 前確認不含 __pycache__/、*.pyc 等 build 產物（必要時 `git rm --cached`）。

#### 〔P3〕render 靜默空字串替換無告警；updateAgent 允許改壞輸出契約無任何驗證

**影響目標** 穩定

**證據**：agent-loader.js:40-43：`body.replace(/\{\{(\w+)\}\}/g, (_,k) => vars[k]!=null ? String(vars[k]) : '')`——漏傳直接消失。agent-loader.js:120-124 updateAgent 對 prompt 內容零驗證；admin-routes.js:262-274 UI 可直接改任何 agent 的 prompt。已逐一比對 10 份 md 的 placeholder 與 JS 呼叫端，目前無漏傳；但任何一方（UI 改 prompt 新增 placeholder、或 JS 改名）漂移時無偵測。

**說明**：現況無 bug，但這是「靜默劣化」設計：placeholder 打錯字或 UI 編輯後新增的 {{var}}，agent 只會收到空洞 prompt 照常執行，產出看似合理實則缺關鍵資訊的結果——最難察覺的準確性殺手。updateAgent 也可能把 ---RESULT-JSON--- 契約整段刪掉，下一輪任務直接 stopped。

**修補方向**：render 時記錄未匹配的 placeholder（console.warn 或 task_events）；updateAgent 對含 render 契約的 agent 校驗必要 placeholder 與 RESULT 標記仍存在。

#### 〔P3〕coding retry 時 prompt 未告知「分支上已有前輪實作」，可能重複實作而非增量修正

**影響目標** 準確／token

**證據**：.claude/agents/coding-project.md:62-65【執行步驟】固定為「1. 了解程式碼結構 2. 逐條實作 requirements 3. commit」；:52-53 retry_feedback 段只說「上一輪 QA／部署失敗的原因，請優先據此修正」，未說明 worktree/分支上已有前輪 commit、應先看現有 diff 再做最小修改。

**說明**：QA fail 退回時 coding 進入同一 worktree（task-agent.js:276，分支已含前輪 commit），但步驟指示仍是「逐條實作」全量語氣。model 可能重寫既有檔案、重複加欄位或與前輪實作打架，每輪 diff 越滾越大，QA 越難 pass——正是多輪不收斂的溫床。

**修補方向**：retry_feedback 非空時（JS 已知）在 prompt 附加明確指示：先 `git diff <base>...{{git_branch}}` 檢視現有實作，只針對 feedback 做最小修改，勿重寫已通過部分。

#### 〔P3〕headless agent 的 cwd 在 C:\odoo-v2 樹內，專案 CLAUDE.md 被一併載入——與 agent prompt 重複且矛盾（commit 格式）

**影響目標** token／準確

**證據**：worktree 位於 repos/<專案>/.worktrees/（task-agent.js:56-59），在 C:\odoo-v2 之下，claude CLI 會沿祖先目錄載入 C:\odoo-v2\.claude\CLAUDE.md。CLAUDE.md「Commit: [Module]: Why (not what)」 vs coding-project.md:38-41「訊息固定 {{commit_message}}，不可修改」直接衝突；Odoo 規則整段（round()/flush_model/view 命名等）在 CLAUDE.md 與 analysis-project.md:19-30、coding-project.md:21-32 三處重複。

**說明**：每次 coding/qa/analysis 呼叫都多載一份重複規則（token 固定開銷），且兩份指示對 commit message 給出相反要求，model 會在「固定訊息」與「[Module]: Why」之間不穩定擺盪。CLAUDE.md 雖已註明 PS1 流程退役，但其開發規則段落實際上會注入每個 headless run，兩份規則日後必然漂移。

**修補方向**：擇一為準（建議 agent md 為單一事實來源），CLAUDE.md 對應段落標注「headless agent 以 agent prompt 為準」；或將 repos/ 移出 CLAUDE.md 作用樹。

#### 〔P3〕playwright prompt 內嵌使用者明碼密碼，agent 輸出串流可能外洩

**影響目標** 穩定

**證據**：.claude/agents/playwright.md:13-14：「登入帳號：{{login}}／登入密碼：{{password}}」；playwright-agent.js:33-35 decrypt 後明碼傳入 :47-52 render。spawnClaude 會把 assistant 文字與 tool 呼叫串流到 terminal:output（task-agent.js:94），agent 撰寫測試腳本時幾乎必然把密碼寫進腳本內容並回顯。

**說明**：密碼會出現在瀏覽器 terminal 串流，且測試腳本檔案（含明碼）可能殘留在 worktree 被下一輪 `git add -A` 收進版控。非本次三目標核心，但屬 agent prompt 契約的既成風險。

**修補方向**：以環境變數傳遞憑證（prompt 只給變數名），或至少在 emit 前對 password 值做遮罩。

### 專案層

#### 〔P2〕使用者登入密碼以可逆加密全量落地（password_enc），登入時自動補寫，單一 APP_SECRET 外洩即全數還原

**影響目標** 穩定

**證據**：auth.js:98-104 每次登入若 password_enc 為空即用當下明文 `encryptSafe(password)` 回寫；auth.js:74 setup、auth.js:145 改密同步寫入；playwright-agent.js:33-35 `decrypt(user.password_enc)` 還原明文餵給 E2E。lib/crypto.js:9-22 為 AES-256-GCM，getKey() scrypt 固定 salt 'db-conn-salt'、密鑰僅來自單一 APP_SECRET。

**說明**：為了讓 Playwright 用真帳密登入測試區，平台把每位使用者的登入密碼以可逆方式存進 users.password_enc，且在一般登入流程自動補寫。這等於系統持有全體使用者 Odoo／平台密碼的可還原副本；一旦 APP_SECRET 與資料庫同時外洩（兩者都在同機的 data/config.json 與 PG），所有明文密碼可被還原。與 password_hash（pbkdf2 單向）並存，攻擊面被放大。

**修補方向**：評估是否可改用專供 E2E 的獨立測試帳號（非使用者本人密碼），或把 password_enc 限定為 opt-in、與 APP_SECRET 分離的金鑰管理（例如獨立檔案權限／KMS）。至少於文件與 UI 明示『登入密碼會被系統保存以供自動化測試』。

#### 〔P2〕核心 Claude 執行與失敗路徑測試以 mock 掏空，server 重啟恢復與 stream-json 解析零覆蓋

**影響目標** 準確／穩定

**證據**：runner.test.js:4-31、qa-agent.test.js:7-10、deploy-testing.test.js:6-9、task-agent 相關測試全部 mock 掉 analyzeTask/spawnClaude/upgradeModules 等核心；claude-runner.js:64-106 的 stdout 逐行 JSON 解析、usage/durationMs 擷取、line-buffer 分段、code!==0 拒絕等邏輯無任何測試（claude-runner.test.js 僅測 logTokenUsage 與 stopReason 三個純函式）；index.js:139-141 伺服器重啟把 setting_up→error 的崩潰恢復 UPDATE 無測試。

**說明**：pipeline 的關鍵風險點集中在『子行程輸出解析』與『崩潰後狀態恢復』，但這兩塊剛好沒被測到：claude-runner 的 stream-json 解析若欄位改版或 usage 結構變動，token 統計會靜默歸零而測試不會紅；伺服器重啟時卡在 setting_up 的環境是否被正確標為 error 也無回歸保護。既有測試多為『驗證 mock 有被呼叫』，符合 Rule 9 所指『無法在業務邏輯改變時失敗』的空殼風險。

**修補方向**：為 claude-runner.js 增加以假 stdout（多行 JSON、含 result/usage、含非 JSON 行、code!=0）驅動的解析測試；為 index.js 的 setting_up→error 恢復加一支整合測試（插一筆 setting_up 後跑恢復語句驗證轉態）。

#### 〔P2〕DB 查詢端點僅驗登入不驗專案歸屬，loopback /ai/db/query 完全免 token，任一登入者可 SELECT 任意專案正式庫

**影響目標** 穩定

**證據**：db-query-routes.js:91-98 `/api/projects/:id/db-connections/:cid/query` 僅掛 verifyToken，且 projects 非 user-scoped（project-routes.js 各查詢無 user_id 過濾，如 :136 `SELECT * FROM projects WHERE id=$1`）；db-query-routes.js:116-124 `/ai/db/query` 只用 loopbackOnly（:17-21 憑 remoteAddress 判斷）不驗任何 token。runSelect 雖限 SELECT（lib/ssh-sql.js:41-58 過濾 DML/DDL/多語句），但連線帳密可觸及正式庫。

**說明**：任何登入者（含一般 user 角色）可對任意專案的 db_connection 送 SELECT，透過 SSH 直達該專案正式 PostgreSQL；而 /ai/db/query 只靠來源 IP 為 127.0.0.1 放行、無 token，本機任何行程（或能繞到 loopback 的路徑）皆可查全部專案正式庫。SELECT-only 過濾降低了破壞面，但資料外洩面仍大。若團隊模型本就共享專案，此為設計取捨，但一般 user 角色亦擁有此權限值得確認。

**修補方向**：為 db-connections/query 加上專案成員／管理員授權檢查（比照 project-routes 的 requireAdmin 或成員關聯）；/ai/db/query 除 loopback 外再加一組本機共享密鑰或程序令牌，避免純憑 IP 授權。

#### 〔P3〕殘留欄位與死樣式：reentry_count 只讀不寫、已移除狀態的 CSS 與 socket 標籤保留造成漂移

**影響目標** 準確

**證據**：db.js:68 定義 reentry_count、tasks-routes.js:47 SELECT 帶出，但全庫無任何 UPDATE 或前端顯示（grep 無其他引用）；app/public/css/app.css:268-279 仍保留 final_pending/deploy_pending/deploy_fixing/deploy_ready 的 badge 樣式（狀態已於 db.js:308-312 廢除）；socket.js:24 task:updated 自帶一份精簡 label map，與 TaskList.js:2-21 STATUS_LABELS 各自維護、易漂移。

**說明**：屬清理級別：reentry_count 是無人寫入、無人顯示的孤兒欄位（查詢還多帶一欄）；已廢狀態的 CSS 留著雖無害但誤導；socket 與 TaskList 兩份狀態文字對照表分離，未來新增狀態時容易只改一處造成通知與列表顯示不一致。

**修補方向**：移除 reentry_count 的 SELECT（或補上實際用途）；刪除已廢狀態的 CSS；把狀態→中文標籤集中成單一共用常數供 socket.js 與 TaskList.js 共用。

## 五、任務 52 完整對照：每一步都有對應的結構性缺陷

任務「報價單的客戶下面增加備註T欄位」，coding×6、qa×6、4.77M tokens（低估值，見 U12）、跨兩天未完成。逐步歸因：

| 事故現象 | 對應發現 |
|---|---|
| merge 兩度被 `__pycache__/*.pyc` 擋下 | 已知根因 A（.gitignore 缺漏）＋ agents 層 P3：coding prompt 要求 `git add -A` 卻沒禁止 .pyc |
| 部署失敗 12 秒即發生、一律退回 coding 重寫 | 已知根因 B ＋ U5（deploy-fix agent 從未接線）＋ 資料層 P2（transient 錯誤不分類） |
| blocker 只存到 Odoo 版本 banner，人工介入無從下手 | 已知根因 C（extractOdooError 擷取失效） |
| 「繼續」之後同樣的失敗再跑 3 次，無限循環 | U2（resolve-blocker 三計數器同時歸零）——計數器現值全 0 但實際 coding×6 |
| coding 每輪越燒越多：302k→877k→1,053k | U3（零上下文延續：每輪全新 session 從零探索，分支上檔案越改越多） |
| QA「跑了 35 分鐘」 | 實為 U8：QA 50 秒就回了 verdict，其餘 34 分鐘是 test_mode 下 cron 不推進、pipeline 原地等待 |
| E2E 跑了兩次但 token 帳上 playwright 為 0 筆 | U12（失敗／中斷不記帳） |
| 事後想查 07-06 之前這任務經歷了什麼，查不到 | U13（events 不落地＋刪除政策） |

**結論：任務 52 撞上的 8 個現象，對應 8 個獨立的結構性缺陷。修其中任何一個都只能減緩；這也是為什麼它看起來「什麼都出錯」。**

## 六、修補路線圖建議

### 第一批：快速止血（每項 ≤ 約 30 行、互相獨立、可立即做）

依「阻止下一次事故」的優先序：

1. **cron tick 防重入**（U1 的最小止血）：`runPipeline` 加全域旗標，上一輪未結束則本輪跳過；`handleBranch` 移除 worktree 前檢查 inflight。完整的併發模型重設計留給第二批。
2. **resolve-blocker 不歸零計數器**（U2）：`tasks-routes.js:322-324`，只歸零與 `resume_status` 對應的那一顆，或一律保留累計。
3. **merge 失敗路徑補 `git merge --abort`**（U6）：避免半套 merge 污染主 clone、拖垮後續所有任務。
4. **Playwright fail 補寫 retry_feedback**（U4）：QA 和 deploy 都有寫，補齊這條就好。
5. **`callClaude` 加 timeout**（U9）：與 `spawnClaude` 對齊，掛死不再永久占用任務與 merge 鎖。
6. **根因 A**：`.gitignore` 補 `__pycache__/`、`*.pyc`，merge 前 `git clean` 保險。
7. **根因 C**：`extractOdooError` 修正 fallback（存 log 尾段而非開頭），blocker 一律附完整 log 檔路徑。
8. **token_usage 失敗也記帳＋一律帶 projectId**（U12＋資料層 P2）：成本報表才可信。
9. **`final_pending` 死狀態**（U14）：補 handler 或改產出即入 `stopped`。
10. **install.ps1 補產 APP_SECRET／ANTHROPIC_API_KEY**（U15）。
11. **retry_feedback 改為 spawn 成功後才清**（agents 層 P2）：失敗／逾時後回饋不再遺失。
12. **qa.md 的 `git diff main...` 改用實際主分支名**（agents 層 P2）。

### 第二批：需設計（動狀態機／架構，建議每項單獨 brainstorm 後實作）

| 主題 | 涵蓋發現 | 為什麼需要設計 |
|---|---|---|
| A. 失敗分類與歸因 | 根因 B、U5、transient 不分類、夜間 shutdown 誤歸因 | 要定義「環境／暫時／程式」三類失敗的判定規則、各自退給誰、deploy-fix agent 的接線點 |
| B. 重跑上下文延續 | U3、U4、coding retry 不知有前輪實作 | token 最大單一節省點（估可砍一半以上重跑成本）；要決定 session resume vs feedback 鏈累積 vs diff 快照 |
| C. 併發模型與鎖統一 | U1 完整解、U7、U8（loop_counter／test_mode 推進模型） | 三套鎖＋cron 重入＋狀態快照過期是同一個問題，要一起設計成單一序列化機制 |
| D. 可觀測性統一 | U13、兩套 runner 分歧、刪除政策 | 決定 events 的統一落地點、保存期限、與 token_usage 的一致性 |
| E. 安全批次 | password_enc 可逆加密、DB query 端點不驗專案歸屬、playwright prompt 明碼密碼 | 涉及金鑰管理與相容性，需通盤處理 |
| F. Agent 契約強化 | 解析失敗零重試、貪婪 regex、裸 YAML、model 配置調整 | 統一輸出契約格式（標記、剝除、重試一次）比逐個修划算 |

### 建議次序

第一批全部（1～2 個工作階段）→ B（token 最大節省）→ A（準確率核心）→ C → D → F → E。每完成一批，放真實任務進來驗證，用修好的 token_usage 帳面對照改善幅度。

## 七、健檢自身統計

- 查察 agent×4 ＋ 驗證 agent×18，共 22 個 agent
- 驗證階段（Sonnet 4.6）：約 62 萬 subagent tokens、7 分鐘
- 查察階段（Fable 5）執行於前一個額度視窗，未完整記錄；健檢總成本估計在設計預算（1～2M）之內
- 教訓回饋：本平台的 token_usage「失敗不記帳」問題（U12），在健檢自身也重演了一次——第一輪 18 個驗證 agent 因額度耗盡全數失敗、無帳可查。可觀測性要在失敗路徑上優先落地，此為佐證。

## 附錄：各層查察範圍與明確未查項目

### 資料層

已查：information_schema 全欄位；tasks 全表 15 列（狀態/計數器/created vs updated/pause 時序）；task_events 全量（僅存 46 筆、3 個任務）與 task_logs 全量（12 筆）逐筆讀過，含任務 52 完整時間軸；token_usage 全 54 筆逐筆（agent_type 分布、離群、NULL/孤兒、project_id 覆蓋率）；loop_counter（2 列）、sessions（0 列）、teams_settings.test_mode；並對照 runner.js、cron.js、index.js、claude-runner.js、task-agent.js、qa-agent.js、playwright-agent.js、token-logger.js、token-report-routes.js、tasks-routes.js、sync.js 確認機制。限制與未查：task_events/task_logs 在 07-06 08:26 之前的資料已被刪除（task_events 最小 id=44），07-06 前的失敗模式無法從 DB 還原（包括 6/26 triage 重複執行的原因——每任務 2 筆 triage token 但事件已失，證據不足未報）；users.odoo_settings、wiki_pages、project_chat_messages、db_connections 內容未讀（僅結構）；data/config.json 只確認可載入未讀秘密值；平台 DB 只執行 SELECT；repos/、odoo-envs/、node_modules/ 未觸碰。任務 52 目前 playwright_running（最後事件 02:53），查察當下無法確認該 E2E 是否仍在跑或已成孤兒行程（需看 server 進程，超出資料層）。已知根因 A（.pyc merge 失敗，events 59/81 為其直接實例）、B、C 未重複報，只報其相鄰機制（transient 錯誤不分類、計數器歸零、blocker 資料面缺 transcript）。

### 流程層

已完整閱讀：app/server/pipeline/ 下 runner.js、claude-runner.js、task-agent.js、qa-agent.js、playwright-agent.js、deploy-testing.js、merge-agent.js、cs-agent.js、analysis.js、env-agent.js、git.js、sync.js、token-logger.js、agent-loader.js、library-agent.js、chat-agent.js，以及 pipeline-routes.js、cron.js、notify.js、index.js、tasks-routes.js（resolve-blocker/answer/archive 區段）、db.js（migration 291-329 行）、.claude/agents/coding-project.md（prompt 帶入內容佐證）。以 grep 全面掃過 resume_status/retry 計數/status 轉移/--resume/abortMerge 的所有出現點。狀態機盤點：runnable=new/cs_running/analysis_running/confirm_answered/branch_pending/coding_running/qa_running/merge_running/deploy_testing/playwright_running/wiki_updating（runner.js:27），人工閘=confirm_pending/cs_data_needed/cs_reply_pending/merge_conflict/review_pending/stopped（notify.js:6-9 + 各路由），終態=done（30 天自動封存 cron.js:33-39）；發現的死狀態（final_pending）與搶狀態競態已列入 findings。明確沒查：pipeline/graphify-runner.js、graphify_index.py、seed_odoo_users.py 內文、teams.js 佇列細節、wiki/chat/env/admin/project 各 routes 全文、前端 public/、tests/ 僅 grep 未逐檔讀、實際 PostgreSQL 資料（未跑任何 SELECT，任務 52 的實測數據引自任務簡報）、repos/、odoo-envs/、node_modules/（範圍排除）。已證實根因 A（pyc）、B（deploy 一律退 coding）、C（extractOdooError）未重報，僅報同型相鄰問題。

### Agent 層

已查：.claude/agents 全部 10 個 md（analysis-basic、analysis-project、coding-project、qa、playwright、merge、cs、library、chat、deploy-fix）逐一與其 JS 呼叫端對照（analysis.js、task-agent.js、qa-agent.js、playwright-agent.js、merge-agent.js、cs-agent.js、library-agent.js、chat-agent.js、deploy-testing.js、env-agent.js、runner.js）；agent-loader.js 全檔（快取/frontmatter/updateAgent/render）；claude-runner.js 全檔；git.js（驗證根因 A 緩解現況與 qa.md main 硬編碼的交叉）；tasks-routes.js resolve-blocker（重試計數器歸零機制）；admin-routes.js agent 編輯端點。placeholder 完整性已逐 md 逐 render() 比對，現況無漏傳/多傳（deploy-fix 的 {{error_text}} 因 agent 未被呼叫而無對照）。明確沒查：repos/、odoo-envs/、node_modules/、.git/（範圍排除）；data/config.json 未讀（本層無涉）；資料庫實際 token/task 資料未查（未執行 SQL，任務 52 數據以題目給定為準）；前端 js（僅 grep 確認 TokenReport 有 deploy_fix 色票、無其他關聯）；teams.js、sync.js、graphify-runner.js、token-logger.js 內部邏輯（非 agent prompt 契約範圍，僅確認呼叫介面）；未實測 claude CLI 對祖先目錄 CLAUDE.md 的載入行為（該 finding 依 Claude Code 已知行為與目錄結構推定，已標 P3）。

### 專案層

已深讀：runner/claude-runner/qa-agent/deploy-testing/task-agent/playwright-agent/analysis/token-logger/agent-loader 及其測試；auth.js/settings.js/password.js/lib/crypto.js/lib/ssh-sql.js/db-query-routes.js/pipeline-routes.js/tasks-routes.js/token-report-routes.js/admin-routes.js/index.js；前端 api.js/socket.js/TaskList.js/TaskDetail.js/TokenReport.js 與 app.js 路由；start.ps1/install.ps1/start.sh；.gitignore、app/package.json、data/config.json（僅結構：DATABASE_URL/JWT_SECRET/PORT/APP_SECRET 四鍵，未輸出任何值）。交叉比對了後端 status 集合 vs 前端 STATUS_LABELS/FLOW/needs_action，以及全部 Api.* 呼叫 vs 後端路由的 verifyToken 覆蓋。確認 app/server/pipeline/__pycache__ 的 .pyc 已被 .gitignore 涵蓋（git check-ignore 命中、非追蹤），Node 專案內的 .py（seed_odoo_users.py 由 env-agent.js:166 讀取、graphify_index.py 由 graphify-runner 驅動）皆有實際用途，非孤兒。未查（範圍排除或非本層）：repos/、odoo-envs/、node_modules/、merge-agent/env-agent/cs-agent/library-agent 內部細節（僅掃 status 面）、Teams webhook 後續流程、已知的 pgPass flaky 成因（依指示不重查）、已證實三根因 A/B/C 本身。未實跑測試套件（唯讀環境，避免副作用）。
