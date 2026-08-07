---
paths:
  - "app/server/pipeline/**"
  - "app/server/runner.js"
---

# 平台開發：Pipeline

> 抽自 2026-07-29 的記憶整併。完整清單與來源見 `docs/rules-extraction-2026-07-29.md`。

### 狀態機與路由
47. **`resume_status` 是已被佔用的欄位，不可借來記別的語意** — `verdict-router.js`／`reject-triage.js` 用它記「要回去哪一關」。
48. **`runner.js` 在跑 handler 前會 `UPDATE resume_status = task.status`；每新增一個 resume 狀態都必須加進該覆寫的排除清單** — 漏加會讓狀態被自己覆寫回去形成死循環。
49. **`runPipeline` 的 SELECT 只撈 6 欄**（id, task_id, status, user_id, project_id, blocker_content）— handler 要用其他欄位必須自己重查，直接讀會拿到 undefined。
50. **路由端點不可 fire-and-forget 直接呼叫 agent，一律「改狀態＋`runPipeline()`」** — 直呼不經 `dispatchTask`、不登記 `_inFlight`，cron 掃到同一筆會重複派工。
51. **`runPipeline` 的手動呼叫點散布在 tasks-routes、index.js、pipeline-routes 多處，自動推進閘門必須靠 `auto` 參數區分** — 無條件卡在開頭會把使用者手動點的「繼續」一併擋掉。
52. **`goto(...)` 跳關預設會歸零 `reentry_count`，需要保留計數必須明確帶 `resetReentry:false`** — 忘了帶會讓斷路器修法變成 no-op。
53. **`reentry` 斷路器只計「無人監督的自動循環」，凡有人介入的那一輪一律不吃額度** — 累加點只有 QA／deploy／E2E 退 coding 那三處（各自呼叫 `bumpReentryOrStop`）。人工退回（`pipeline-routes.js` 的 reject）**刻意不 +1**；分診的 `fix`／`respec` 走 `goto(...)`、預設 `resetReentry=true` **歸零**且刻意不過斷路器（`reject-triage.js`）。理由：斷路器防的是機器空轉燒 token，而人填的修正指示帶著新資訊。**所以「任務 reentry 快撞頂、不敢退回」是錯誤顧慮，別據此改走 respec。**〔2026-08-07 更正：本條原記載的「人工退回也 +1、兩次相加即鎖死」是**已修掉的舊行為**，當時照舊文推論會得出錯誤結論。〕
54. **各關失敗不得無條件退回 coding，必須先分類（code／env／transient／規格歧義）再路由** — 「不管什麼錯都跳回開發」是 token 長尾的真病根，單一任務可燒掉全平台 25% output。規格歧義退 coding 只會無限來回，該停下問人。
55. **所有「停下來問人」的情境統一走同一個 clarify 閘門，不要各自開新狀態** — 各自造狀態會產生殭屍狀態與重複機制。泛化既有 `enterClarifyGate`（收 resumeStatus／fromStatus／carryFeedback）由 `resume_status` 導回原關。
56. **讓某關能「對話」時，重用該關既有的 agent 重跑機制，不要新增狀態分支** — 追問＝帶新脈絡重判，既有分類分支完全不動即自然分流。
57. **merge 衝突相關的狀態流不分叉：全程停在 `merge_conflict`** — 衝突本質是兩段碼撞同幾行的取捨，退回重做不會消除衝突。三個 merge agent 職責鏈 `merge`→`merge-explain`→`merge-clarify` 各司其職。
58. **新增 verdict 欄位時必須同步更新「無效審查／fail 無細節」那類守衛的豁免條件** — 守衛只看舊欄位時，只帶新欄位的合法 fail 會被判無效審查、連兩輪 stopped。
59. **查表式降級的 fallback 要指向最嚴格的選項** — `MODE_RULES[mode] || 最寬鬆` 會讓呼叫端拼錯字就靜默繞過所有限制。
60. **行為的推進與否要由結構（狀態機／mode）決定，不能靠 prompt 自律** — 把守門條件寫在 prompt 裡等於沒有守門。

### 併發與鎖
61. **per-project 鎖只序列化 merge／deploy／worktree／analysis-pull／approve；coding／QA／E2E 平行不持鎖** — 讓長工時 AI 關卡持鎖會讓同專案多張任務互卡。
62. **會逐 hunk 呼叫 AI 的長時作業不可用阻塞式 `withProjectLock`，改用 `tryProjectLock` 取不到就早退** — 冪等作業下一 tick 再試即可。
63. **merge／deploy／E2E 這條尾巴必須每專案獨佔（`mergeGateBlocked` 由 DB 狀態推導）** — deploy 打共用 `testing` 分支＋共用測試 DB，但升級只跑 `-u <本任務模組>`；別的任務中途 merge 進 testing 會讓一致性被打破，正確的碼被判失敗退回。coding 因各自 worktree 天生隔離。
64. **併發上限必須在派工當下即時核對，不能靠迴圈開頭的快照** — cron 跨 user fire-and-forget 時快照造成 TOCTOU，每 tick 都超派。
65. **cron tick 內禁止 `await` 沒有 timeout 的網路呼叫；通知類副作用一律 fire-and-forget** — socket 掛住會讓 `_tickRunning` 永久為 true、凍結整個 cron。
66. **cron tick 裡各項獨立工作不得共用 early return** — 同步失敗的 early return 會連帶跳過夜間關機、閒置回收；且 early return 一旦不可達，覆蓋它的測試變成假綠。

### agent 契約
67. **agent 輸出一律走 `<result>` 契約 ＋ `parseAgentResult`，解析失敗要軟 fallback、不可擋住收尾** — 貪婪 regex／裸 YAML 會被散文與 fence 汙染。
68. **不要在 `parseAgentResult` 外面包 try/catch** — 它唯一往外拋的例外是「補救呼叫被 abort」＝手動暫停；吞掉會把使用者的暫停誤標成任務失敗。
69. **agent 回 exit 0 / status=completed 不等於成功——沒吐結果契約就是失敗** — agent 被自己開的背景監控帶走時仍是 exit 0。
70. **AI 產出的 YAML／規格解析失敗時，絕不可覆蓋既有 spec，要 fail loud 停下**。
71. **AI 產出的檔案內容若殘留 ``` fence，視為「回了散文而非乾淨碼」，直接拒寫** — `stripFence` 只處理「整段以 ``` 開頭」，中段 fence 攔不下來。守衛放在寫檔前，`writeFileSync` 放在 hunk 迴圈之後、失敗即提早 return。
72. **解析 agent 回傳的 verdict／列舉值前先 `trim().toLowerCase()`** — 模型輸出的大小寫與尾隨空白不穩定。
73. **AI 回傳的「要寫入哪些頁／哪些檔」一律用白名單過濾，且內容非空白才寫入** — 白名單是防止它亂改無關頁面的唯一防線。
74. **pipeline agent 可以做成無狀態（每輪 fresh 重送整包規則／spec），不需要 `--resume`** — 實測 coding 全價 input 只佔總輸入 0.28%（cache_read 19.3M vs full 56.5K），重送幾乎免費；無狀態同時根治整包重寫與 drift。
75. **失敗重試不要升級模型（維持 sonnet），並把彈跳上限壓低（MAX_REENTRY=2）跌倒即停交人工** — 升 opus 重跑只會白燒（實測一次 $8.1／849s）產出「不是我的錯」的 blocker。`retry_feedback` 仍餵回 prompt。

### 使用者可見性
76. **對話／時間軸的真相來源是 `task_logs`，不是 `task_messages`** — 前端時間軸只讀 `task_logs`；只寫 `task_messages` 會讓使用者的提問在介面上完全消失。
77. **agent 產出的結論若只存欄位、不寫 `task_logs`，對使用者等同不存在** — 只在特定 pending 狀態面板顯示的內容，任務一往前走面板就消失。自動轉關的分支也要留理由。
78. **前一關已查到的 findings 要往下一關傳** — cs 花 40 個工具查出的根因全丟掉、分析再重查同一件事＝雙倍 token。傳遞時標明「待驗證、勿直接採信」。
79. **在 pipeline 加「提問／回答」這類非退回分支時，必須完整回滾該次退回的所有副作用，並用守衛（如 `&& isReject`）限制分支只在正確狀態生效** — 不回滾會留下 `task_rejections` 孤兒列、`reentry_count` 虛增。

### 其他
80. **凡是重寫 `merge_conflict_data` 的地方一律 spread 既有物件，不可整包覆寫** — 該欄位承載 `sync`／`prior_status` 等路由旗標，覆寫會讓整個分析＋開發階段被靜默跳過。
81. **把 repo 標成 `clone_status='error'` 等同讓它從整個 pipeline 消失** — 全平台查詢都帶 `WHERE clone_status='done'`。
82. **同步進來的任務一律要綁得到平台專案，綁不到就在源頭 `continue` 不入庫** — 不綁專案的任務下游沒有可行路徑。
83. **來源系統的主同步 domain 只抓未結案單，「單子從結果消失」不能推斷結案** — 要用反面條件（Odoo `fold=true`、eService 非 draft/open）明確判定。
84. **eService 同步的 domain 限 `state = 'open'`（只抓處理中），未處理／驗收完成／結案／作廢一律不進來** — 這是刻意的產品決策範圍，勿擅自擴 domain。用白名單而非排除清單，故不需知道其餘 state 代碼。未處理（`draft`）佔了原同步量的絕大多數且多為客戶剛丟進、尚未分流的雜訊單，一被接手轉 `open` 下輪同步自動補拉。**同步 domain 與 `archiveClosedTasks` 的結案條件（見 83）刻意不對稱**：退回未處理的單既不更新也不封存，會留在平台上——這是已裁決的取捨，不是待修的 bug。
85. **同步既有資料的修法要在「插入」與「既有」兩個分支都呼叫** — 來源端事後才補的資料永遠不會被回填。同時依實際列數重算 `has_attachment` 之類旗標。
86. **新增附件來源不需要改 pipeline——`assembleTaskContext` 查 `task_attachments` 無 origin 過濾** — 但附件必須早於 `runPipeline` 寫入，否則該輪 agent 讀不到。
87. **wiki 的 `node_type='notes'`（project-notes）是人工維護保留節點，AI 不得覆寫** — `_ensureNode` 用 `ON CONFLICT DO NOTHING`、refresh/delete 對 notes 一律擋 400。
88. **wiki 的 `_ensureNode` 對已存在頁走 `ON CONFLICT DO NOTHING`，要更新父頁必須明確走 UPDATE 路徑** — 否則 overview／模組頁一旦建立就永遠不再更新。
89. **pipeline 程式碼不得 `require` route 檔取用共用邏輯，要抽 `lib/` 單一來源** — route 檔會拖進 `auth` → 連帶要求 `JWT_SECRET` 才能載入。循環依賴改用 lazy require。
90. **刪除／封存任務前一律先 `abortTask`** — 不先中止會留下仍在跑的 pipeline 與孤兒狀態。
91. **全域 `app.use('/api', gate)` 型閘門只做單一職責，角色限縮要各 endpoint 自己查 role**。
92. **「只動自己的資料」（`WHERE user_id = req.userId`）的 endpoint 不需要 admin-only 檢查** — 資料範圍限縮已是真正的防護。pause 這類找不到列時回 404、不要 abort。
93. **部署／執行錯誤分類三條硬規則**：`odoo.addons.*` 缺失屬 code 不屬 env；`err.killed`（逾時被砍）判 env 且不重試；部署成功要歸零 `deploy_retry_count`。斷路器觸頂時要保留 `blocker_type`／真因。
94. **pipeline 各關不自行驗證（禁 py_compile／xmllint／odoo-bin／建 DB）** — 一律交 deploy 的「安裝／升級模組」統一把關。本地驗證與 deploy 重工，且 agent 為此會自行摸索環境＝耗時主因。
95. **E2E（Odoo 原生 tour）確實有做規格驗證，弱點只在斷言強度——不要改做自動 intent-verifier** — 「驗真意」由既有 `review_pending` 人工 gate 兜底。
96. **`task_events` 不適合當 agent 的輸入資料源** — 存的是整段終端串流而非失敗片段，噪音大。失敗訊號改用 `blocker_content` 樣本＋`stopped_rate`＋`reentry_count`。
97. **審核退回理由可能被誤植** — 退回內容若指向被審任務分支裡不存在的模組，先用 `git ls-tree -d <branch> --name-only` 驗證再處理，避免持續誤植消耗 reentry 額度。
98. **測試環境「已建置」要同時認 `.docker-ready` 與 `.ready` 兩種標記檔**。

