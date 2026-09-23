---
name: productize-saas-decision
description: 平台產品化（客戶自助登入＋問答＋改程式）已定調走 SaaS 多租戶；含三個擋路現況與一題未答的岔路
metadata: 
  node_type: memory
  type: project
  originSessionId: 1629885e-a788-49eb-9b57-0b3e853ed318
  modified: 2026-09-17T03:54:37.477Z
---

## ▶ 09-21 傍晚：3a 做到 7／11，Task 6 卡在一個語意衝突（最新，接手從這裡讀）

**帳本是唯一真相**：`.claude/worktrees/tenant-scope/.superpowers/sdd/2026-09-21-tenant-part3a-company-admin/progress.md` 結尾的「⏸ PAUSED」段落，含完整交接與下一步順序。計畫 `docs/superpowers/plans/2026-09-21-tenant-part3a-company-admin.md`（11 Task，2215 行）。

- **第 2 部已推未合併**（`origin/feat/tenant-scope` = `0b88db11`）。使用者裁決：**3a＋3b 都好了才一起合**。
- **3a 完成並審查通過 7 關**：1 功能開關／2 考試 24 支端點／3 公司管理／4 綁專案／5 公司 GIT／7 建帳號選公司／9 隱藏 Odoo 設定。線 A 全跑 379 suites 5665 passed、線 B 376 suites 5635 passed，皆 0 failed。**兩條線都沒 push。**
- **⚠ Task 6 的程式碼未 commit** 留在 `tenant-scope` 工作區（`company-routes.js`、其測試、`auth.js`、`index.js`）。刻意不 commit——卡住了。**別對那個 worktree 做 checkout/clean。**
- **卡點**：`approved=false` 同時代表「待審核」與「已停用」。`index.js` 的閘門刻意放行待審帳號去 `/auth/*`／`/settings*` 跑設定精靈；Task 6 要讓停用真的生效，就連帶擋掉那條路。三個解法都是產品語意取捨，agent 正確地拒絕自己拍板。
- **未取得的決定性事實**：正式 DB 現在有沒有 `approved=false` 的帳號（查詢被使用者中斷）。**沒有就選「改測試＋Task 8 先做」**（Task 8 關掉自助註冊＝唯一寫 false 的路徑，之後該欄位只剩一種意思）；**有的話**那些人會失去設定精靈，就要認真考慮「停用另開一欄」。
- **線 B 待合併**：`feat/tenant-admin-users` @ `6597db36` 已完成審查，等線 A 安靜就併。併完**一定要重跑全跑**——兩條各自綠不代表合起來綠（今天已驗過一次）。
- **平行階段結束**：剩下 Task 8／10／11 互相有依賴，單線跑。
- **今天兩個程序教訓**（已寫進帳本）：①修正輪也算「寫」，一個 worktree 同時只能有一個寫者；②預先產好的 brief 會在計畫被改後悄悄過期（Task 6 的 brief 差點漏掉「停用擋不住舊 token」那段）。
- **使用者當日裁決**：D1 一起合；D2「AI 執行畫面」兩個都收（連帶發現 `GET /api/tasks/:id/events` 規格漏列）；D3 考試判題**整個搬到平台 AI 通道**——獨立計畫、排在 3a／3b 之後，**必須有逐題比對的品質關卡**（搬錯會讓判題品質悄悄變，過去成績就不能比）。

---

## ▶ 09-21 進度（最新，接手從這裡讀）

**階段 2a 第 2 部「範圍檢查」程式全部做完，8 個 Task 全過，但使用者裁決先不合併：「先不要合併 全部都好了再合」。** 分支 `feat/tenant-scope` HEAD `0b88db11`（master 已併進來 `0c65c956`），工作區乾淨，**未合併未推未重啟、零實測**。全跑 373 suites／5601 passed／0 failed／EXITCODE=0。帳本（含 R1–R24 全部裁決）`.claude/worktrees/tenant-scope/.superpowers/sdd/2026-09-18-tenant-isolation-part2-scope/progress.md`，**刻意沒刪**（skill 規定合併後才刪，而還沒合併）。

- **Task 7（不走 HTTP 的三條路）跑了 3 輪修正**。最大收穫：**守衛一開始裝錯層**——`canRun` 不在 `runAgent`，在 `prepareSandboxRun`（`sandbox-run.js:122`），所以只掃 `runAgent` 的守衛守不到多數路徑（12 個檔直接呼叫 `runClaude`）。抓到的方式是把背景安全複查的 fail-open 提示當成「具名風險」交給審查者去追呼叫端；光看新程式碼完全正常。
- **五個呼叫端漏帶 `userId`**（chat-to-task／classify-rejections／wiki-drift／failure-classifier／chat-agent）⇒ `isUserCompanyInternal(null)` 第一行就回 true ⇒ 六種 CODEX_ELIGIBLE agent 有五種守衛完全沒作用。已補，並加一支**會自己紅**的靜態守衛。
- **整枝總審查又抓到第 1 部同形狀的 Critical：考試系統**。規格 §5.3 標「平台管理員限定」，第 1 部計畫明文交棒第 2 部，**第 2 部計畫從頭到尾沒提過「考試」**，連刻意不做的清單也沒有 ⇒ 拿計畫對規格會以為做完了。22 支端點只掛 `verifyToken`。
- **使用者裁決（09-21）：考試要保持可以考，不鎖管理員限定；以後改成「公司設定裡的功能開關」授予**。規格 §5.3 那一行已改（`2026-09-11-tenant-isolation-design.md:191` 刪節線＋新寫法），第 2 部計畫 1240 行也補進延後清單。**開第一家客戶公司之前必須先用功能開關擋住（客戶預設關閉）**。
- **合併前要講給使用者聽的清單從 3 樣修正成至少 8 樣**（總審查重數才發現）：上正式、資料庫查詢頁、建立／停止／刪除測試環境、**新增專案、修改專案、改對應設定、repo 四個操作、歸還對外名額**。而且**按鈕還留在畫面上**（前端是第 3 部），那 7 個人點下去會拿到 403。
- **兩支靜態守衛原本掃到 0 筆也會綠**（只斷言檔案數，沒斷言呼叫數）已補上量的下限（32→floor 28、82→floor 75）。
- **規格頁已更新並複製到 `docs/odoo-v2-saas-specs.html`**（09-21 10:56），新增兩列：「第 2 部合併前的告知事項」與「考試系統阻擋條件」。
- **下一步**：等使用者說可以合併 → Task 8 Step 3-5（合併對話、push、重啟、以真實一般使用者身分實測 17 個專案與任務 200）。

---

## ▶ 09-18 進度（最新，接手從這裡讀）

**AI 容器隔離已全面上線：開關 = `all`，分界 `all_on_at = 2026-09-18 01:15:39Z`（台北 09:15，使用者拍板）。現在進觀察期。** 帳本同 09-17 那條路徑。

- **3.6 判定通過**：09-17 22:00 夜間批次五種內部 AI（workflow_health／feedback_merge／fix_review／fix_verify／platform_fix）全在容器跑完、0 失敗（前 14 天基準 workflow_health 1/14 失敗）。1 條修正合併＋1 條駁回，平台 22:32 自己重啟（master 到 `e80c22cc`）。零容器殘留、零 `ro-` worktree 殘留。
- **3.7 完成**：`copy-agent-sessions.js --apply` copied 151／skipped 2（skipped＝目的地已有容器自己寫的新版，不覆蓋是對的）。`data/agent-home` 213M。切 all 前再跑一次＝copied 0。
- **3.8（projects，只開專案 1）全部通過**：問答 38s（引真 wiki 頁）、轉任務 3s、寫程式→QA判退→重改→QA過（兩輪都真 commit）、wiki 11s、cs 21s、卡關分診 6s、部署（使用者中途把專案 1 測試環境建好後重跑，一次成功→review_pending）。峰值 215MiB／2GB、27／128 pids、CPU 26%；閘道零攔截。
- **M11 意外結論：容器內更省更快**。cs 脈絡 362k→161k（-56%）、43.6s→20.8s；wiki 55k→31k、21.8s→11.3s。原因＝容器內沒有使用者層外掛與 `~/.claude/CLAUDE.md`（規格 §7 早寫過）。品質抽樣沒退步。樣本 n=1~2，日常使用再看。
- **3.9 裁決：上限維持 2g／2／128 不動**。取樣算出 1g／1／64，但那只涵蓋專案側輕量 agent；綁定條件是 platform_fix 在容器內跑整套 jest（M8 峰值 844MiB／48 pids／130%），照規則算剛好就是現值。**降下去會壓死夜間改善**。
- **本機 auto-mode classifier 擋掉兩件（不是平台問題，別盲目重試）**：①代簽別人的 JWT（冒用帳號）⇒ **analysis 關至今沒在容器驗過**，使用者裁決跳過、讓日常使用去驗；②叫鴻久容器 SELECT 客戶正式 DB ⇒ **`/ai/db/query` 走閘道那條路在容器模式下仍未驗證**，請使用者自己在鴻久對話問一題要查 DB 的問題。
- **all 已驗到名單外專案**：慈雲（project 2）wiki 重建 10s 完成，`data/agent-home/project-2/.claude/{skills,sessions,.claude.json}` 09:17 被寫入、主機家目錄沒動。
- **取樣器還在跑**：pid 19068，log `data/logs/agent-sandbox-stats.log`；觀察期結束（3.10 Step 3）要 `kill 19068`。
- **下一步**：3.10 Step 2 每天查一次（各關失敗率 vs 前 7 天、oom／session_missing、殘留容器、閘道 deny、`du -sh data/agent-home`）→ Step 3 使用者同意後才做 3.11（拿掉無容器路徑，重啟批次 R-C）。
- **殘骸**：tasks 105（project 6）／148（project 11）status 卡在 `*_running` 但最後更新是 2026-08-06／08-18，是死列不是真的在跑。測試任務 275 停在 review_pending（可留可刪）、276 已封存。

---

## ▶ 09-18 收工：階段 2a 第 2 部做到一半（最新，接手從這裡讀）

**第 1 部已上線且驗收通過**（見下一段）。**第 2 部「看得到什麼」8 關做完 4 關**，worktree `.claude/worktrees/tenant-scope`、分支 `feat/tenant-scope`（from `7a8cf492`）、**未 push 未合併**。計畫 `docs/superpowers/plans/2026-09-18-tenant-isolation-part2-scope.md`，帳本 `.superpowers/sdd/2026-09-18-tenant-isolation-part2-scope/progress.md`（**所有裁決 R1–R11 都在裡面**）。基線 5488 → 目前 **5521 passed／0 failed**。

- 完成：Task 1 共用守衛＋欄位白名單、Task 2 專案端點（含 `/release` 接上 canReleaseProject）、Task 3 對話與 wiki、Task 4 測試區與資料庫查詢頁。**Task 5（搜尋、建立任務）派工中**；未做：Task 6 靜態守衛、Task 7 公司停用後 cron／AI／git 也要擋、Task 8 總審查＋合併。
- **補起來的真洞**：測試區 SSO 只驗登入（帶任一專案 id 就能以 admin 進別家測試區）、對話帶別家 project_id 就能接到別家 repo 與 DB、`PUT /api/tasks/:id/project` 可把任務改掛別家專案（**project_id 在 body 不在路徑，Task 6 的靜態守衛抓不到，只能手動補**）、搜尋打一個字列得出全平台客戶專案名、資料庫查詢頁對一般使用者是開的。
- **⚠ 我計畫寫的「第 2 部對現在的人零影響」是錯的（R5／R11）**。它會讓 7 個內部一般使用者失去三樣：①按「上正式」②資料庫查詢頁③建立／停止／刪除測試環境。三樣都是規格 §2 本來就要收的，但我原本排在第 3 部「上線前先告知那 7 個人」那一批 ⇒ **合併前必須再問使用者一次**。
- **測試 fixture 的兩條規則（各踩過一次）**：①既有測試紅了**先回報再動**——我為某情境下的裁決不是通行證，Task 3 就因為「比照先例」自己動手而被退回；②**絕不可為了繞過「看得到嗎」把 fixture 帳號改成 admin**——那會短路檢查、讓整個檔案對守衛失明。正確形狀是「帳號維持一般使用者＋給公司＋綁專案」，讓檢查跑過並通過。但「端點本來就要求 admin」而用 admin 是對的（Task 4 兩種同時出現，依端點性質拆）。
- **審查抓到而逐關審查看不見的**：第 1 部的整枝總審查抓到 1 Critical（規格要求「新建專案自動綁公司」，9 個 Task 沒人做，我的自我檢查還算成已涵蓋）＋3 Important。**這一關不可以省。**

## ▶ 09-18 傍晚：階段 2a 第 1 部已上線（最新，接手從這裡讀）

**租戶隔離第 1 部完成、合併、重啟、遷移、驗收全部做完。** master = `814187ba`（之後又被別股推到 `3d4579bd`）；平台 15:24 重啟。

- **9 個 Task 全過**（每關獨立審查＋整枝總審查）。整枝總審查抓到 **1 Critical＋3 Important**，全部修掉並複審通過（8 項全 ADDRESSED、零新破壞）。全跑 **362 suites／5478 passed／0 failed**。
- **Critical 是我計畫的漏洞**：規格 §4.3 寫明「新建專案要自動綁內部公司」，9 個 Task 沒有一個做，我的自我檢查還把它算成已涵蓋。後果會是：遷移後新建的專案，一般使用者在列表看得到任務、**點進去 404 且無錯誤訊息**。同型的還有新建帳號沒公司。**教訓：計畫的「規格涵蓋」自我檢查會漏，整枝總審查抓得到——不要省那一關。**
- **上線驗收（實測，非只看 DB）**：7 個帳號掛上內部公司、17 專案全綁、管理員仍 NULL、can_release 全 false、內部公司恰 1 筆、索引 `companies_internal_idx` 確認存在（**它建失敗是靜默的，必查**）。以 user 5 自簽 JWT 實打：`/auth/me` 公司正確、`/api/projects` 回 17 個、`/api/tasks` 200、**開單一任務 200**（這項是空窗期會變 404 的指標）。
- **`tools/migrate-tenants.js` 可重跑**，最後會自己比對「專案數＝內部公司綁定數」並印 ✅。

**第 2 部（尚未開始）＝ 2b，上線前要先告知那 6~7 個一般使用者。** 範圍寫在第 1 部計畫檔尾「第 2 部預告」。**兩條硬性順序條件**（都來自總審查）：
1. **必須先把 `canReleaseProject` 接上 `POST /api/projects/:id/release`，才可以開放任何畫面設定公司 PAT**。第 1 部拿掉了「沒有個人 PAT 就擋」這道事實上的煞車；一旦有公司 PAT，該公司每個成員都能對任何專案按上正式。
2. 同批要補 `buildGitEnv` 檢查 `companies.is_active`（停用公司的憑證目前仍可用於系統觸發的推送）。

**待辦（第 2 部要順手處理）**：`loadProjectForActor` 把 `columns` 串進 SQL 文字——今天零呼叫端所以安全，路由一旦從 request 組欄位就是注入洞；`admin-routes` 目前把新帳號一律預設掛內部公司（暫時措施，要換成明確選公司）。

---

### 09-18 下午：階段 2a 租戶隔離開工

**使用者選「階段 2a 租戶隔離」為下一塊**（我提的另一選項是階段 5 更版機制；2a 在主線上，3、4 都卡它後面）。**執行方式選 subagent-driven（一次只開一個）。**

- 規格早已全部定案（`docs/superpowers/specs/2026-09-11-tenant-isolation-design.md`，330 行，§8 六題 09-14 全決）。§10（測試區 DB 帳號＝階段 2c）**已完成不必再做**。
- **拆兩部**。第 1 部計畫已寫完：`docs/superpowers/plans/2026-09-18-tenant-isolation-part1-foundations.md`（83KB、9 個 Task）。第 2 部尚未寫，範圍列在第 1 部檔尾「第 2 部預告」。
- 第 1 部＝公司表／專案↔公司多對多／`users.company_id`／第三個角色值 `company_admin`／`req.actor`／公司不可用全域 403／`lib/tenant-access.js`／`loadTaskForActor` 加專案可見性／GIT 個人→公司退回／一次性遷移腳本。**做完現有 9 admin＋6 user 看到的東西完全一樣**；真正讓那 6 人失去工具的 2b 在第 2 部。
- **worktree** `.claude/worktrees/tenant-isolation`、分支 `feat/tenant-isolation`（from `e80c22cc`）。**基線 356 suites／5393 passed／0 failed**（帳本 `.superpowers/sdd/2026-09-18-tenant-isolation-part1-foundations/progress.md`）。
- ⚠ **新 worktree 沒有 node_modules**：symlink 到主 clone 的，並寫進 `.git/info/exclude`——`.gitignore` 的 `node_modules/` 有尾斜線，**不匹配 symlink**，不排除的話 `git add` 會夾帶。
- **寫計畫時查證推翻自己兩個假設**：①`gitEnv` 在 7 處被 `{...process.env, ...gitEnv}` 展開進子行程 ⇒ `buildGitEnv` 新增的 `source` 必須用 `Object.defineProperty(…, {enumerable:false})`，否則 git 會收到一個叫 `source` 的環境變數；②`loadTaskForActor` 多撈 `project_id` 不可無條件加，呼叫端本來就帶會變重複欄位（真 PG 合法、pg-mem 會出狀況）。
- **開工前自檢四條裁決（全寫在帳本）**：P-1 Task 2 不 require db（純函式，dead import）；P-2 Task 5 的閘門跑在 verifyToken 之前，不能吃 `req.actor`，必須自查；P-3／P-4 pg-mem 若不強制 partial unique index／ON DELETE CASCADE，測試改驗「約束存在」而非「效果發生」，**不准為了讓測試綠而拿掉約束**。

## ▶ 09-17 進度（最新，接手從這裡讀）

**第 3 部合併前的工作全部完成；09-17 使用者核准後已 fast-forward 推到 origin/master = `a2b1c24d`（主 clone 工作目錄沒動，等 upgrade.sh pull）；`data/config.json` 已加 `TRUSTED_PROXY_IPS=10.0.10.6`；規格頁已更新。⏸ 等使用者跑 upgrade.sh（R-A），重啟後從 Task 3.5 接。** 帳本（含全部裁決 R1–R17）：`.claude/worktrees/agent-sandbox/.superpowers/sdd/2026-09-15-agent-sandbox-part3-rollout/progress.md`。全跑 351 suites／5343 passed／0 failed（已併 master ba8653fb）。
完成：3.1、3.2、3.3（自我檢測，加測 agent 網路主機側位址＋正向對照）、3.13（使用者裁決改「上鎖」＋宿主跑 git 前清空重建 admin 目錄、任務 ref 只收 commit id、等容器不佔專案鎖；修了 4 輪）、3.14（zip 不跟 symlink）、3.15（合併前擋含 symlink 的任務分支）、總審查＋修正波。
**總審查新增的使用者裁決**：登入鎖定改認 nginx 轉來的 `X-Real-IP`，**只在直連位址列在 `TRUSTED_PROXY_IPS` 時才信**；這台 nginx（agency-NginxUI-1）連進來的位址實測 `10.0.10.6`（容器重建可能變）；登入成功會把打錯次數歸零（R17）。
**R-A 交接（①已做）**：①這台 `data/config.json` 加 `"TRUSTED_PROXY_IPS":"10.0.10.6"`（未設＝所有真人共用一個來源、網路上的人能封鎖管理員）②告訴使用者：3.13 守衛、3.15 合併擋關、登入鎖定**不看開關、重啟即生效**（總審查已查正式 6 個 worktree 與全部 repo，不會誤判）③其餘照計畫 3.4 Step 5。
**09-17 下午（重啟前停手）**：①D1（docker wait 無時限＋容器未建好就被判結束）已修並審過，**只推到 `feat/agent-sandbox` = `53acfbb8`，沒進 master**（使用者要求重啟前的新工作先不併）。②**使用者裁決：現在就補 `objects/` 共用可寫**（D2：每任務自己的物件庫、共用唯讀、平台驗證後搬入）；派工內容存在帳本目錄 `d2-dispatch.md`，**被我停掉時還沒改任何檔**，下次照那份重派（opus、一個 agent）。③主 clone 還沒 pull（master 工作目錄仍 ba8653fb），未 commit 檔從 5 個變 9 個＝別的 session 在做，別碰。
**09-17 16:22 平台已重啟後：自我檢測 93/93 通過（用鴻久 task 273，使用者指定），開關切到 `internal`**（健檢／夜間改善進容器）。明早查 09-17 22:00 起的 workflow_health 等 token_usage 與失敗。273 已審核通過（使用者按）。開 projects 前要先做完並合併 D2。
**09-17 17:15 D1＋D2＋審核頁 diff 修正已合併推上 origin/master = `6b916f48`（使用者核准），等使用者 upgrade.sh 重啟。** 17:01 internal 實測：單張任務健檢 run 47 在容器跑完 24s、結果正確。
**09-17 17:2x**：開關管理頁已推 master（前端，要 pull 才出現）；D2 上線後自我檢測 94/94 通過（odoo17 測試任務 **275，已暫停在 branch_pending**，留給 3.8 試跑用）。
**D2 已完成並審過（09-17）**：`ebdea505`＋修正 `e79bd984` 已合併進 master（6b916f48）並於 17:08 重啟上線；審核頁 diff 小瑕疵也已修（f65e996f）。任務物件庫在 `repos/<專案>/.agent-objects/<task_id>`（刻意不放 data/）。
**資源上限已預填（09-17，重啟前手動建欄位＋寫值，mode 仍 off）**：AI 2g／2 cpus／128 pids；閘道 256m／0.5／128（M10 規則由 M8 峰值 844MiB／48 PIDs／130% CPU 算出）。Claude token 設定頁本來就存了。
**開 projects／all 之前**：docker wait 與 objects 兩項已修並上線；仍要做：切換前一刻 `tools/copy-agent-sessions.js --apply`（R18：現在搬會過期）、再提醒使用者「任務 A 能動 task/B」與「chat 設成 Codex 沒有容器保護」。
**使用者特性**：抽象 git 說明看不懂，要用「具體步驟發生什麼」的例子；嫌同時開太多 subagent、token 有限 ⇒ [[limit-parallel-subagents]]；停掉背景 AI 前要先問。

## 09-16 進度

**進度一律標在規格頁上**，見 [[spec-progress-annotation]]——使用者只從平台網頁看進度，對話裡的回報他看不到。開發順序規格新增 `## 0. 目前進度` 表＝唯一進度來源。

**平台 09-15 17:53 已重啟**（`ps -eo lstart -C node`），故 09-15 的 commit 全部已上線，含 `8ca9913d`（2c）與 `bef45402`（對話 AI 產檔）。容器沒重建（Created 07-30），`pip --user` 裝的 reportlab／matplotlib 還在。

**已完成並驗證**：0.1 備份（09-16 04:00 自動備份確認產生）、0.5 健檢提案人工核准（run 45 兩條停在 `pending`，run 44 還是自動 `done`）、**2c 測試區獨立 DB 帳號**（Task 7 全過，細節見 [[testenv-db-superuser]]）。

**2c 上線後撞到的缺口（已修 `56b1cdd9`，已 push）**：撤 PUBLIC 連線時把 `postgres` 維護庫也撤了 → Odoo 完全起不來、log 一片空白。同批另修 `cron.test.js` 讀真實備份目錄造成的紅燈（`a0cfc6e1`）。全跑 4961 passed／0 failed。

**⭐ 階段 1 第 1 部：12 個實作 Task 全部完成（09-16）**。worktree `.claude/worktrees/agent-sandbox`、分支 `feat/agent-sandbox`、**12 個 commit、尚未 push、尚未合併 master**（合併排在開發順序步驟 1.3，且合併時開關關）。基線 319 suites／4964 passed → **330 suites／5132 passed／0 failed**，全程零紅燈。
Task 0＋M1／M2／M3(Step1-2) 也完成，量測全文 `docs/superpowers/plans/2026-09-15-agent-sandbox-M1-table.md`；M2 附帶證實 **session 不綁 cwd**（換目錄仍續接得到，但整包重建快取：該次 80,988 cache tokens／$0.32）。**M3 Step 3（唯讀角色真的登入得了）要等重啟批次 R-A，未做。**
產出：`lib/agent-profiles.js`（誰看得到什麼的唯一真相，24 個 agentType）／`agent-run-token.js`（每次執行一張通行證）／`agent-sandbox-flag.js`＋`teams_settings` 九欄＋管理員端點（**預設 off，合併不改變行為**）／`agent-sandbox.js`（docker run 參數、env 白名單）／`agent-mounts.js`（掛載清單）／`ai-scope.js`＋改 `ai-token.js`（socket 只認執行通行證）／8 個 `/ai/*` 端點加檢查／`ai-socket-server.js`（unix socket 入口）／`ai-platform-routes.js`（`/ai/glossary`＋`/ai/platform/query`）／`platform-readonly.js`（唯讀 LOGIN 角色）／`git-hardening.js`（平台跑 git 不執行 hook）。
**⭐ 第 2 部：16 個 Task 全部完成（09-16）**，分支 `feat/agent-sandbox` 共 **28 個 `[AgentSandbox]` commit，已 push**（`f16ffc2c`）。**仍未合併 master、開關仍 `off`、平台未重啟 ⇒ 正式環境行為零改變，也還沒有任何一次 AI 真的跑在容器裡**（那是第 3 部）。全跑 **343 suites／5236 passed／0 failed**。
產出：`agent-infra.js`／`agent-gateway/gateway.js`（CONNECT 白名單 4 網域）／`pipeline/sandbox-run.js`／改寫 `claude-runner.js`（容器分支、停止＝`docker kill`）／`failure-classifier` 的 `oom`→env／`agent-orphans.js`（**只認自己標籤，絕不列舉全機容器、絕不 prune**）／8 個呼叫點補脈絡＋靜態守衛測試／`git-identity.pickGitIdentity`（不給 PAT）／`agent-env.pickLegacyEnv`（考試與 Codex）／三個 skill 改打 `/ai`／`SKILLS_BY_SCOPE` 白名單掛載／`lib/agent-session-migrate.js`＋`tools/copy-agent-sessions.js`（切換日複製 session，**尚未真的跑過**）。
**M5**：啟動 153／248 ms（門檻 2 秒）。**2.13**：context7 MCP 經閘道查得到文件、**0 次被擋**，白名單不必加。

**⚠ M6 找到隔離的洞，已依使用者裁決處置**：AI 容器在 `--internal` 網路上**仍連得到主機的 8771（平台 API）與 22（SSH）**——`--internal` 只擋連外網、不擋連主機，而 8771 聽 `*`、22 聽 `0.0.0.0`。**沒破**：PG 8772（只聽 127.0.0.1／10.0.0.1）、`/ai/*`（`ai-token.js:71` 要 loopback）、測試區埠。真正可利用的只有「登入端點零次數限制 ⇒ 無限猜密碼」。
實測證明 `--network none` 容器**仍可經掛入的 unix socket 連主機**（AI 不會斷線），但**使用者選擇不改設計**，改補登入失敗次數限制（見 [[login-attempt-lockout]]）。M6 其餘各項全部符合預期，量測設施零殘留。

**第 2 部：五個量測 M5–M9 全部做完**（結果全文在 `docs/superpowers/plans/2026-09-15-agent-sandbox-M1-table.md`）。三個結論會影響後續 Task，別重量：
- **M7**：容器內跑得動 `claude -p`、`--resume` 接得到，且**掛在容器家目錄的 skill 在 headless 下會載入** ⇒ Task 2.15 照原設計即可，不必改 agent prompt。
- **M8**：容器 Node v22.23.2、峰值 **844 MiB／48 PIDs** ⇒ 正式上限 `2g／512 pids` 夠用，**不需要換 node:20-slim**。容器內全跑的紅燈都是環境造成：①要補掛平台 `.git`(ro)＋worktree 管理目錄(rw)（Task 1.5 的 platform-fix 本來就有）②`--tmpfs /tmp` 是 **noexec** ⇒ `git-hardening.test.js` 的對照組在容器內必紅，**要列進 Task 3.2 的排除清單**。
- **M9 推翻計畫假設**：shell 自己 SIGKILL 自己是 **0** 不是 137；**137 ＝ 主進程被 SIGKILL**，既可能是記憶體上限也可能是平台自己 `docker kill`（停止／逾時）⇒ Task 2.6 不能只看 137 判 OOM。

**下一步：第 3 部（上線推進，15 個 Task）**，計畫 `docs/superpowers/plans/2026-09-15-agent-sandbox-part3-rollout.md`。
第 3 部才會真的把 AI 關進容器（合併 master → 重啟 → 開關由 `off` 逐步打開），**在那之前正式環境行為完全沒變，也還沒有任何一次 AI 真的跑在容器裡**。
第 3 部要記得的兩件事：①M8 測到容器的 `--tmpfs /tmp` 是 **noexec** ⇒ `git-hardening.test.js` 的對照組在容器內必紅，**要列進 Task 3.2 的排除清單**；②切換日要跑 `node tools/copy-agent-sessions.js --apply` 把續接中的 session 複製進各 scope 家目錄（**至今尚未真的跑過**），不跑的話每個續接任務與對話第一輪會白跑一輪。

**`GIT_PAT` 那題已結案（不需使用者裁決）**：計畫 Task 1.4 的 `ENV_WHITELIST` 本來就排除 `GIT_PAT`／`GIT_ASKPASS*`、保留 `GIT_AUTHOR_*`／`GIT_COMMITTER_*` ⇒ 容器內 commit 作者正確但拿不到 PAT。我先前誤報成待決。

**別碰**：主 clone 有 5 個考試系統未 commit 檔（別股工作）。另一股在做健檢 signal（`e1ef9ce0` 已自行 commit）。

---

## 09-15 收工（部分已被上面取代）

**已上線**（09-15 14:00 使用者重啟、實測過）：`eb011faf` 平台 DB 每日備份（04:00、`data/backups/`、管理員設定→進階「平台資料庫備份」可清單／立即備份／下載）；`5f962094` 健檢提案一律人工核准＋健檢頁／意見回饋管理核准雙向同步。

**已 push、收工時未確認是否重啟**：`8ca9913d` 2c 測試區獨立 PG 角色（見 [[testenv-db-superuser]]）。

**明天依序做**：
1. **先確認有沒有重啟**：`ps -o lstart -C node`（node 啟動時間要晚於 09-15 下午）＋ `psql … -Atc "select has_database_privilege('public','aidev','CONNECT')"` 回 `f`＝2c 已生效。沒重啟就請使用者在主機跑 `upgrade.sh`（**本 session／subagent 在跑時不能重啟，會一起被砍**）。
2. **確認 09-16 04:00 每日備份真的產生**：`ls data/backups/platform-db-20260916.dump`；排程頁 platform-backup 的 note 不該有 ⚠。
3. **2c 正式驗證**＝`docs/superpowers/plans/2026-09-15-testenv-db-role.md` Task 7：**重建「立勝補習班」（project 18）前要先問使用者**；驗 `USER=testenv_p18`、DB 擁有者、容器內連 aidev／別的 test DB 被擋、SSO 登入正常；另掃 `odoo-test-*` 還有沒有 `USER=odoo` 殘留（夜間關機跳過的要請使用者重建）。
4. **開始階段 1（AI 容器）**：三份計畫 `docs/superpowers/plans/2026-09-15-agent-sandbox.md`（第 1 部）、`-part2-runner.md`、`-part3-rollout.md`，52 Task、未實跑。從第 1 部 Task 0 開始（**worktree 必須在 `.claude/worktrees/` 底下**，否則量測容器掛不到），先做量測 M1–M3。需要重啟的步驟集中在 R-A／R-B／R-C，第 1、2 部不需重啟。Q1–Q5 已決（第 1 部檔頭「使用者裁決」表）。

**別忘**：主 repo 有 5 個考試系統未 commit 檔（別的工作），重啟會一起上線，不要動它們。使用者要求決策題**一題一題問**（見 [[ask-decisions-one-at-a-time]]）。

---

## 09-14 收工狀態（部分已被上面取代）

- **規格全部定案**：26 題待決＋R1～R5 都已裁決並寫入 `docs/superpowers/specs/2026-09-11-*.md`（gitignored、只在這台）；網頁版 `docs/odoo-v2-saas-specs.html`（改規格後在 `specs/_page/` 跑 `node build-specs-page.js` 再複製到 `docs/`）。**總覽 §2 表是最新裁決清單，下面的舊段落若與它衝突以總覽為準**（例如下文「R3～R5 待決」「四種角色」「is_internal 看全部」都已被推翻）。
- **09-14 定案重點**：不開 staging（開關只對測試公司開）；角色三種（平台管理員／公司管理員／一般使用者），內部人員＝內部公司成員；專案↔公司多對多 `project_companies`＋`can_release`；AI key 看發起者公司（`companies.is_internal` 只管付錢、API 不可設）；R4 2b 跟 2a 一起上；平台 DB 備份先放這台留 14 天。
- **程式碼已 push**：`a0fdda97` 修規格頁點選單變空白（srcdoc iframe 補 `<base href="about:srcdoc">`，免重啟）。平台 09-14 09:14 已重啟，`PLATFORM_CONTAINER` 生效。
- **下次要選的第一步**（09-14 我提議、使用者尚未選）：①階段 0.1 平台 DB 每日備份（至今零備份；我建議用平台 cron 跑 pg_dump 到 `data/backups/`、留 14 天）②階段 2c 測試區獨立 DB 帳號（見 [[testenv-db-superuser]]）。兩者都不依賴其他塊。之後照開發順序：階段 1（子專案 0 把 AI 關起來）→ 2a/2b → 3 → 4。
- **09-15 提示詞注入已寫進規格**（總覽 §6、開發順序階段 6 硬條件＋R6、4 §4.3、0 §10）：策略＝限制傷害範圍不做過濾偵測，hook 只當輔助；最大洞 I1＝夜間改善自動合併（AI 碼合併後在容器外跑），「合併要人按」是第一家客戶前硬條件。**I1 現在就存在**：健檢讀 eService 同步的客戶原文（`sync.js:370`）。**R6 已決（09-15）：維持自動合併（不清空 `cli_push_user_id`），改擋入口**＝健檢提案一律人工核准（階段 0.5，`health-check-runner.js:133` 與 `:238-251` 兩處設 approved 要改）＋A 內部 scope 拆兩級、只有 workflow_health 能用 `/ai/platform/query`＋B 合併後紀錄可回查（`finding_fixes` 已存 diff，只回最新一筆、意見回饋來源待確認）。我已講明剩餘風險：人核准文字、合併的是程式；使用者知情選擇，別再提議改回合併前人工按。ops §4.3 表被 R6 覆蓋兩列（合併自動、重啟仍等週末）。使用者說規格更新完就準備開始實作。
- **09-15 開始實作 0.1 平台 DB 備份**（使用者選平台 cron 而非主機 crontab）：worktree `.claude/worktrees/platform-backup`、分支 `feat/platform-db-backup`；`lib/platform-backup.js`＋cron.js 04:00＋排程頁顯示最近一次成功（**這台 webhook／Teams 都沒設，失敗通知送不到人**）＋`.gitignore /data/backups/`。基線 312 suites／4870 passed。還原演練實跑通過。兩支會跑 tick 的 cron 測試必須 mock `lib/platform-backup`（夜間改善跑測試時 DATABASE_URL 是真的）。規格原寫 DB 名 `claude` 是錯的，實際 `aidev`。**同分支再加**：①使用者要求的管理員設定→進階「平台資料庫備份」區塊（清單＋立即備份＋下載；下載是使用者知情選擇，限 admin、檔名白名單、log 記 user_id）②0.5 健檢提案一律 pending＋健檢頁／意見回饋管理核准雙向同步（原本健檢頁核准已開單的提案，夜間批次永遠撈不到）。playwright 淺深色都驗過（備份 API 用假資料，正式未重啟）。**已 commit＋push 到 origin/master**：`eb011faf` [Backup]、`5f962094` [Health]（09-15，全跑 315 suites／4901 passed）。**09-15 14:00 已重啟並實測**：排程頁有 platform-backup、立即備份產生 `platform-db-20260915-140109.dump`（10.7MB／0.56s）、下載位元組一致且檔頭 PGDMP、`..%2F` 回 400；worktree 與分支已清。**還沒驗**：09-16 04:00 每日備份是否真的自動產生；0.5 要等下一輪健檢產出提案才看得到 pending＋開單 new。下一步照開發順序：2c 測試區獨立 DB 帳號或階段 1 子專案 0。
- **09-15 下午**：2c 已實作 push `8ca9913d`（見 [[testenv-db-superuser]]），**未重啟**（使用者：session／subagent 在跑時不能重啟）。階段 1 計畫已寫成三份 `docs/superpowers/plans/2026-09-15-agent-sandbox{,-part2-runner,-part3-rollout}.md`（16＋21＋15 Task，未實跑，重啟集中成 R-A／R-B／R-C 三批，第 1、2 部不需重啟）。第 1 部檔頭 X1–X21 列規格不符處（考試系統 3 處直接 spawn claude 且帶全部 env、附件／log 掛載漏列、chat／cs 現在載得到 pushRepo 等全部 skill、SET ROLE 唯讀不安全要另建 LOGIN 角色）。**待使用者決定 Q1–Q5**：Q1 考試 AI 進不進容器（預設只做 env 白名單）／Q2 internal-fix 看不看 wiki／tasks（預設只給術語表）／Q3 Codex 名單／**Q4 git ref 守衛（容器可寫主 clone .git＝能直接移動 testing／main 繞過 QA，候補 Task 3.13）**／Q5 測試專案選哪個。**09-15 使用者已答**：Q1 考試 AI 不進容器（只做 env 白名單）；Q5 測試專案＝project 1「odoo17」（0 未結任務、0 正式連線）。Q2 **不給**（改平台碼的 platform_fix／fix_review／fix_verify／feedback_merge 只給 /ai/glossary；使用者一度誤會成「幫代管客戶改 Odoo 的任務流程」，已說明不受影響）；使用者要求決策題**一題一題問**；Q3 **Codex 先限內部人員、之後再裝容器**（使用者先說「正常要能選」，說明衝突後選此；CODEX_ELIGIBLE 名單保留，客戶公司帳號觸發時一律 Claude，子專案 1 有公司表前行為不變；剩餘風險：內部人員用 Codex 處理含客戶文字的單仍無容器保護，Codex 容器化列為後續）；Q4 **加分支守衛**（使用者先問「commit 不是程式負責？」→ 查證：coding AI 依 `coding-project.md:50` 自己跑 `git add -A && git commit`，合併進 testing／main 才是平台 `git.js` mergeInto；AI 能下任何 git 指令＝能移動 main；使用者選守衛而非「改成平台代 commit」）。**Q1–Q5 全部已決，已回寫**：計畫第 1 部檔頭加「使用者裁決」表；第 2 部 Task 2.12 只剩 codex env 白名單（拿掉 provider 限制）；第 3 部 3.13 必做排在 3.4 前、`<Q5>`＝1、3.11 不動 agent-runner；總覽 §2 加 5 列；tenant spec §7 表加「非內部公司觸發 Codex → 丟例外」（子專案 1 必接，否則客戶 AI 能經 Codex 繞過容器）。規格網頁已重產。
- 開發方式：一律獨立 worktree、每天早上先併 master 重量基線（R1 不暫停夜間改善）；commit 用私有 GIT_INDEX_FILE（[[shared-index-race-on-commit]]）。09-14 基線 304 suites／4825 passed。


2026-09-10 開始討論「把 odoo-v2 平台產品化，客戶自己登入、問答、改程式」。走 brainstorming 的**架構級**路徑，尚未寫規格、尚未動任何碼。

**已定調的一件事**：使用者選了 **一套系統多家客戶共用（SaaS 多租戶）**，不是「一客戶一套獨立系統」，也不是「先只開放問答」。⇒ 每張表要加租戶欄位、查詢要全面改寫，工作量最大但只維護一套。

**⚠⚠ 頭號擋路石：AI 沒有沙箱（09-11 實查）**：`claude-runner.js:159` 以 `--dangerously-skip-permissions` spawn claude、cwd＝worktree、無 bwrap／容器、與平台同 OS 使用者；`data/config.json`（664）含 `APP_SECRET`／`JWT_SECRET`／`DATABASE_URL` ⇒ 客戶需求或附件裡一句提示詞注入，AI 就能讀總鑰匙→解密**所有客戶**的 SSH 密碼／API key／PAT、簽 admin JWT、連平台 DB。另 `/ai/*` 通行碼 `aiToken()` 無參數＝**全平台一組**，拿它可列任意專案的 DB 連線並下 SELECT（我 09-11 用它直接列出鴻久連線）。

**子專案 0「把 AI 關起來」的實查（09-11）**：AI 合法需求＝該家 worktree（rw）＋`data/odoo-core`／企業版（ro）＋`/ai/*`（經 getSQL／getLog／wikiQuery skill 走 curl）＋Anthropic／Context7 網路＋`--resume` 的 session 檔。**走不通的兩條**：藏秘密（同 uid，平台讀得到的 AI 原則上都讀得到）／Claude Code 內建沙箱（Linux 靠 bwrap，此容器 `No permissions to create a new namespace`，09-08 chat 102/103 實例；要開得放寬整個平台容器）。**可行前提**：容器內 `docker` 可用（29.7.2，id=1004），`docker-env.js`／`odoo-core-src.js`／`vpn-gateway.js` 已在開 sibling 容器——掛載路徑要同構，見 [[vpn-sibling-mount-homomorphic]]。`/ai/db/query` 的專案 id 是從連線反查、不綁呼叫者（`lib/ai-token.js` 註解自承）。使用者問過「能不能用 tmux 隔離」→ 不行（tmux 只分畫面、同 uid 同檔案同網路）；「tmux＋每家一個系統使用者」要 root，09-11 實測 `sudo: command not found`（useradd 在但無權限），客戶是陸續加入所以也不能靠 Dockerfile 預建。**一次性容器的啟動成本（09-11 實測）**：`docker run --rm node:22-slim` 接預設網路＋bind mount 5 次 226–259ms（無網路 125–164ms）；對比近 30 天 `token_usage` chat p50 40.6s／p90 141.8s（322 次）、cs p50 76.0s ⇒ 每題多約 0.25s ≈ 0.6%。使用者顧慮「客人很常問問題」由此解除；問答慢的是 AI 本身不是啟動。未量：正式映像檔（裝 claude／git）的啟動差異。**比讀檔更直接的外洩（09-11 實查）**：`start.sh:30-41` 把 `JWT_SECRET`／`APP_SECRET`／`DATABASE_URL`（有設時連 `ANTHROPIC_API_KEY`）export 進 node 環境，而 `claude-runner.js:197` 以 `{ ...process.env, … }` 整包傳給 agent ⇒ **任何一次 AI 執行 `echo $APP_SECRET` 即得總鑰匙**。**光開容器不夠（實測）**：預設 bridge＋`--add-host host.docker.internal:host-gateway` 的容器連得到平台 8771、宿主 SSH 22、測試區 DB 8772、測試區埠 21000（5416 refused）⇒ 需 `--internal` 網路＋出口閘道白名單。`/ai/*` 閘門是「來源必須 loopback」（`ai-token.js:70`），容器來的請求會被擋，要改認閘道來源。Codex 通道仍在用（30 天 gpt-5.6 共 11 次），也要納入或對客戶停用。context7 生成檔 `pipeline/mcp/context7.local.json` 內含平台的 Context7 key。

**內部 AI 的二階注入實查（09-11）**：意見回饋 `POST /api/feedback` 只驗登入（客戶也能送），但進夜間改善前要 admin 經 `PATCH /api/admin/feedback/:id` 設 approved（有人工閘）；**健檢提案則經 `nightly-fix.js:144` `inAutoFixScope` 自動入選、無人工閘**，且 `teams_settings.cli_push_user_id` 已設＝夜間修正 `adoptFix→applyFix` **自動合併進平台 master**。⇒ 客戶文字→健檢 AI 讀到→提案→platform-fix 改平台碼→自動進 master，全程無人。Codex 只有 `chat` 在用（gpt-5.6-sol 5＋terra 6 次，最後 09-07）。

**使用者對內部 AI 的回覆（09-11）**：原話「健檢應該是這個平台在用的，夜間改善只是讓客戶可以提，只是到時候可能要有更版機制，沒辦法像現在這樣馬上上去」⇒ 健檢＝平台內部工具；夜間改善＝客戶提建議的管道；**需要平台更版機制**（不能自動合併＋重啟就上線），已歸入子專案 4。追問「讀到客戶文字時可 `echo $APP_SECRET` 外送、與上不上線無關」後，**使用者裁決：健檢／改善 AI 也關進容器，權限比客戶大**（可讀改平台 repo worktree、平台 DB 只給唯讀帳號、拿不到總鑰匙與客戶正式機憑證；健檢照樣看全部任務、改善照樣讀客戶原文）。

**Codex（09-11 裁決）**：客戶只用 Claude，Codex 留內部用 ⇒ 客戶容器映像只裝 claude。備註：Codex 自帶沙箱靠 bwrap，在平台容器（AppArmor＋seccomp）起不來且 exit 0 靜默失敗（`sandbox-signature.js:4-8`）；若日後內部 Codex 也進容器，應關掉它自帶沙箱改靠容器。

**設計第 1 段（09-11 使用者已核准）**：容器只掛 worktree(rw)＋主 clone .git(rw)＋odoo-core/企業版(ro)＋per-tenant claude 記錄夾(rw)；env 白名單（tenant API key、per-run 通行證、/ai base）；`--internal` 網路＋出口閘道只放 Anthropic／Context7／平台 /ai；per-run 通行證綁專案＋到期；非 root、限 CPU/記憶體、停止＝砍容器。只涵蓋客戶觸發的 agent。

**設計第 2 段（09-11 已提、待核准）錯誤處理＋測試**：①停止／逾時現為 `killChildGracefully` SIGTERM→5s→SIGKILL（`lib/proc.js:71-73`），套在 `docker run` 上 SIGKILL 只砍 CLI、容器續跑燒錢 ⇒ 容器固定命名＋`docker kill`；②平台重啟不再連帶砍 AI（`runner.js:574` 前提反轉）⇒ 啟動時先清帶 label 的容器；③**全 pipeline 沒有 `--resume` 找不到 session 的退路**（grep 0 筆）⇒ 切換時複製現有 session 進各家資料夾＋加「找不到就全新執行並寫時間軸」；④OOM（exit 137）要講明；⑤docker 掛掉大聲停，**絕不退回無隔離執行**（rules/pipeline 59）。測試：容器參數純函式 jest（比照 `docker-env.test.js`，斷言 env 無三把鑰匙）＋跨租戶通行證 403＋真開容器的攻擊實測腳本全過才准切換。

**設計第 2 段已核准（09-11）；規格文件尚未寫**（使用者中途要求先統整機制清單，寫規格被暫停）。寫規格時可直接用的查證：路徑 `docs/superpowers/specs/2026-09-11-agent-sandbox-design.md` 被 `.gitignore:70 /docs/` 排除（不 commit）；worktree＝`<專案根>/.worktrees/<task_id>/<repo subdir>`（`task-agent.js:75`），repo 在 `repos/<folder>/<label>`；平台映像 `odoo-v2:latest`（閘道可沿用）；目前 docker 網路全是 bridge、無 internal；Claude Code 官方支援 `HTTPS_PROXY`／`https_proxy`（不支援 SOCKS），必要網域至少 `api.anthropic.com`＋`platform.claude.com`（OAuth refresh），`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 可關 Datadog 兩個；呼叫 AI 的 agentType 共 22 種（workflow_health／platform_fix／fix_review／fix_verify／feedback_merge 屬內部，其餘屬客戶觸發；另 `repair`／`chat-title` 為附屬呼叫）。

**寫規格前補查（09-11）**：平台容器 `NetworkMode=host`、8771 聽 `*`、8772 聽 127.0.0.1＋10.0.0.1；同構掛載只有 `/home/odoo/odoo-v2`、`/home/odoo/odoo-envs`（`~/.claude` 是 volume `odoo-v2_claude-home`，不同構）；企業版 `enterprise/{17,19}`；claude＝npm 全域 2.1.266，程式本體含 `CLAUDE_CONFIG_DIR`／`DISABLE_AUTOUPDATER`／`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`／`HTTPS_PROXY` 字串（WebFetch env-vars 頁回 NOT FOUND 是截斷假象，別信）；context7-mcp 以 undici ProxyAgent 吃 `HTTPS_PROXY`（`dist/lib/api.js:37-64`），連 `context7.com`／`mcp.context7.com`；skill 中 **platformDB（DATABASE_URL）與 odooGlossary（query.js）直連平台 DB**，getSQL／wikiQuery／getLog 走 curl；**使用者層外掛 superpowers／hookify／code-review／context7／security-guidance、`~/.claude/CLAUDE.md`、RTK PreToolUse hook 現在都套在每個 pipeline AI 上**（runner 帶 `SECURITY_GUIDANCE_DISABLE=1` 即證據）⇒ 進容器後行為會變。設計推導出的新洞：**主 clone `.git` 若 rw 掛入，AI 可改 `.git/config`（fsmonitor／filter driver）或 `.git/hooks`，之後平台在主機跑 git 時就會執行**⇒ config 與 hooks 必須唯讀覆蓋。

**子專案 0 規格已寫（09-11）**：`docs/superpowers/specs/2026-09-11-agent-sandbox-design.md`（gitignored、未 commit），自我檢查中修正：內部 AI 不可掛運作中的 `/home/odoo/odoo-v2`（含 config.json 與 ai.sock）改掛乾淨 worktree／internal scope 不可碰 `/ai/db/*`（客戶正式 DB）。**待使用者審閱規格**，核准後才進 writing-plans。**09-11 使用者要求「先把規格都寫完再來看」⇒ 五塊規格＋總覽全部寫完**（皆 gitignored 未 commit）：`2026-09-11-productize-overview.md`（入口：已定調表、我自做的 9 個設計選擇 D1-D9、25 項待決彙整、被推翻的說法）／`tenant-isolation-design.md`／`byok-api-key-design.md`／`customer-self-serve-flow-design.md`／`saas-operations-design.md`。最需使用者注意：D1 客戶管理員用新 role `company_admin` 不重用 admin（至少 6 處散落 role==='admin'）、3-P1 合併衝突建議不給客戶＝「全程不經過你」唯一例外。寫規格時新查到：`loadTaskForActor`（`lib/task-access.js`）是任務權限單點＝本人或 admin；`GET /api/projects` 回全部專案；測試區 SSO 只驗登入；`buildGitEnv` 單點 15 呼叫；`--max-budget-usd` 只在 -p 有效且只管單次；**平台 DB 完全沒備份**；夜間改善 `applyFix` 合併後 `docker restart`。

**開 staging 平台的撞車點（09-11 實查，規劃「不影響現有平台」用）**：compose 單一 service `odoo-v2`、`network_mode: host`、PG 內建在容器內埠 `PGPORT_APP` 預設 8772（`docker/entrypoint.sh:11`）；主機 20 核／187G／596G 空、跑約 110 個容器（與其他公司服務共用）。①測試區容器名 `odoo-test-<dirName>`（`docker-env.js:77-80`）無實例前綴、建環境第一步砍同名 ⇒ staging 用同樣 folder_name 會砍掉正式的測試區；②`selfContainerName()` 沒設 `PLATFORM_CONTAINER` 時用 hostname 比對全部容器（`finding-fix.js:432-439`），host 網路下兩個容器 hostname 相同 ⇒ **一開 staging，正式平台的夜間改善重啟就會丟「無法唯一辨識」**，要先幫正式容器設 `PLATFORM_CONTAINER=odoo-v2`；③NGINX_* 不可給 staging（見 [[tests-wipe-real-nginx-conf]]）。**使用者開 artifact 網址說「沒網頁」**（伺服器端存在、本機 playwright 渲染零錯誤 ⇒ 多半是瀏覽器沒登入同帳號），改要求「放 docs、平台網址底下要登入才看得到、放在更多工具加連結」：檔案已複製到 `docs/odoo-v2-saas-specs.html`，產生器與樣板在 `docs/superpowers/specs/_page/`（改規格後在該目錄跑 `node build-specs-page.js`，輸出寫在同目錄，要再複製到 docs/）。私人 artifact 仍在 https://claude.ai/code/artifact/b956b64f-cb1b-42a2-b7f3-eb0ce32ccf4d。**09-11 已實作「更多工具→產品化規格」（限管理員，使用者核准）**：後端 `app/server/docs-routes.js`（`GET /api/docs/saas-specs`，verifyToken＋requireAdmin，讀 `DOCS_DIR`||repo 根 `docs/odoo-v2-saas-specs.html`，缺檔 404「規格頁尚未產生」）＋`index.js` 掛載；前端 `ui-next/pages/SaasSpecs.js`（`Api.getBlob` 取 HTML → `<iframe sandbox="allow-scripts" :srcdoc>`，刻意不給 allow-same-origin 以免 CDN 腳本讀到 localStorage token）、`index.html` UI_NEXT_PAGES、`app.js` 路由 `/saas-specs` requiresAdmin、`UiNextApp.js` 選單按鈕 v-if isAdmin（icon lock）、`07-admin.css` `.ui-next-specs-frame`。測試 `docs-routes.test.js`＋`frontend-saas-specs.test.js` 8 支先紅後綠；基線 297 suites／4780 passed／3 skipped。第一次全跑撞 `rwd-gate.test.js`「app.js 每條路由都要列進 `app/rwd/routes.js`（或 covered:false＋why）」→ 已補 `saas-specs` covered:false；修正後全跑 299 passed／1 skipped suites、4798 passed／3 skipped、exit 0。**新增前端路由一定要同步補 `app/rwd/routes.js`**。**已 commit＋push `1ed47965`**（私有 GIT_INDEX_FILE＋數量閘門 10 檔、path-limited reset、push 後 origin 同步；commit 前把程式註解裡「尚未修補的漏洞細節」改成「內部規劃文件」，因 repo 公開）。**未重啟、畫面未人工實測**（沒重啟前按鈕會 404）。（檔案 `scratchpad/odoo-v2-saas-specs.html`，產生器 `build-specs-page.js` 讀 docs/superpowers/specs 六份＋開發順序；scratchpad 是 session 專屬，換 session 要用 `url` 參數更新）。**開發順序已寫**（`2026-09-11-productize-rollout-plan.md`）：原則＝staging 先跑、合併≠啟用（開關預設關）、DB 只加不改、重啟攢批排時段；階段 0 備份→暫停夜間自動合併→正式設 PLATFORM_CONTAINER（需重啟一次）→建 staging；階段 1 子專案 0；2a 公司範圍（內部人員無感）／2b 內部一般人失去工具（要約日期）；3 BYOK（現無公司專案＝零影響）；4 客戶按到底；5 營運（更版機制）；6 第一家客戶。**R1 已決（09-11）：不暫停夜間自動合併**（使用者原話「我基本上都會是早上做」；夜間健檢 22:00 起跑、`cron.js:121`）⇒ 條件：開發一律獨立 worktree、每天早上先把 master 併進開發分支並重量基線、**R2 必須在開 staging 前完成**。使用者說重啟一律跑 `upgrade.sh`（Docker 模式＝`git pull --ff-only`＋`docker restart odoo-v2`，**不重建容器**⇒ 寫進 compose 的環境變數不會生效；重建則會清掉容器內 `~/.claude.json` 要再跑 `setup.js`）。**R2 已決（09-11）：`PLATFORM_CONTAINER` 改由 `start.sh` 從 `data/config.json` 讀**（比照 PORT），這台 config 加 `"PLATFORM_CONTAINER":"odoo-v2"`，照常 upgrade.sh 即生效。**已實作**：`start.sh` 加讀 `PLATFORM_CONTAINER`（無自動測試——start.sh 會啟動整個平台無從單測；改以抽出 read_config 片段實跑驗證：有鍵→odoo-v2、無鍵→unset）、這台 `data/config.json` 已加鍵；開發順序規格已更新 R1/R2 並重產 docs 網頁。**09-11 使用者下班前停在 R3～R5 待決**（R3 staging 放這台／R4 2b 日期／R5 備份位置）；**平台仍未跑 upgrade.sh**（產品化規格頁 404、PLATFORM_CONTAINER 都要重啟才生效）。**原待使用者同意 R1-R5**：暫停夜間自動合併、正式重啟設 PLATFORM_CONTAINER、開 staging 吃主機資源、2b 日期、備份存放位置。第 0 塊規格已補「容器名／網路／label 帶實例 id，啟動清理要篩 aidev.instance」。

**別漏的二階注入**：健檢／改善通道 agent 以 `REPO_ROOT` 為 cwd 全權跑，卻會讀到客戶產生的文字（退回原因、prompt_logs）。

**拆法 v2（09-11 使用者已核准，從 0 開始）**：0 把 AI 關起來（per-tenant 隔離＋per-tenant AI token）→ 1 租戶隔離（公司表、projects 掛公司、API 過濾、兩角色、關頁面端點）→ 2 BYOK（主管自填 key、加密、逐任務注入、花費上限、同意 Commercial Terms）→ 3 客戶按到底（YAML 規格白話化、上正式改主管可按且免個人 PAT／admin、批次清單、退版備份）→ 4 營運（開通、收費、責任條款、監控）。

**人工關卡誰按（09-11 已定調）**：原話「客戶改程式我是打算讓他直接按」，追問後確認**按到底、包含上正式機**，全程不經過使用者。⇒ 必須有「上正式機前自動備份＋壞了一鍵還原」子系統（出事時沒人幫客戶擋），且規格審核關客戶要看得懂（現在是 YAML）。

**三個擋路的現況（實查 2026-09-10）**

1. `projects` 表**沒有 owner／tenant 欄位**（`app/server/db.js:189`），只有 `name UNIQUE`。`tasks` 有 `user_id`，所以任務層有主人、專案層沒有。租戶隔離的第一刀就落在這裡。參見 [[multi-instance-shared-ai-dev]] 的單實例前提。
2. **自助註冊是既有半成品可以接著用**：`POST /api/auth/register` 建 `role='user'`／`approved=false`，`index.js:78` 有「未核准閘門」擋掉所有工作台 API，登入時 403 回 `pendingApproval`。不必從零做註冊流程。
3. **最危險的邊界**：客戶一登入就站在這些東西旁邊——遠端客戶 DB 查詢（`db-query-routes.js`）、以及自動部署存著的客戶正式機 SSH 憑證（⚠ 09-10 我把 `Terminal.js` 也列為危險是**錯的**：它只是唯讀重播該任務的 task_events＋socket 即時輸出，不是 shell；風險降級為「露出 AI 原始輸出／內部路徑」）（見 [[auto-deploy-security-fixes]]、[[auto-deploy-remote-wip]]）。這些現在全部只擋 `verifyToken`。

**開通由使用者代設（09-11 裁決）**：repo、測試區、正式機 SSH、DB 連線都由使用者開通時設好，**客戶畫面完全不出現任何憑證設定頁**。⇒ 不必處理客戶自填主機位址的 SSRF 類風險；但現有「一般使用者能建專案／加 repo／建環境」（`project-routes.js:462` 註解）對客戶角色必須關掉。

**客戶公司內分兩種角色（09-11 裁決）**：一家公司多帳號；「主管」能按上正式機、管自己公司帳號；「一般人」只能問答、提需求、在測試區驗收。理由：「🚀 上正式」是專案層批次（`project-routes.js:925`），一人按會帶上同事已核准的任務，必須有人負責。

**客戶可見頁面（09-11 裁決）**：只開「問答、任務、Wiki」。資料庫查詢頁、AI 執行畫面（Terminal）、流程圖／架構圖、考試、用量報表、設定裡的憑證區全部對客戶關閉（前端隱藏要三處齊做：nav／router guard／後端 403，見 rules/frontend.md 38）。

**角色細分討論（09-11，待答）**：現有帳號 admin 9／user 6（全為內部人員，尚無客戶）。使用者提議「管理員／客戶管理員／一般」三種；我指出少一格「內部人員」（那 6 個 user 會沒地方放），建議模型＝`company_id`（空＝內部）＋角色 ⇒ 平台管理員／內部人員／客戶管理員／客戶一般人。使用者另問「使用者還要綁專案？」→ **裁決：只綁公司**（帳號掛公司、看得到該公司全部專案；分部門日後再加）。使用者反問「內部人員和客戶一般人不是差不多嗎？只差在專案」→ 我說明還差在工具（DB 查詢頁、AI 執行畫面、建專案／加 repo／建環境、release 合併 main 皆非 admin 可用，已決定對客戶關閉），提議二維模型：角色 {管理員, 一般} × 所屬 {內部(company_id 空), 某公司}。**使用者裁決（09-11）**：內部一般人**只需要個人設定**，其餘工具（DB 查詢頁、DB 連線管理含 SSH／VPN、AI 執行畫面、專案／repo 管理、測試環境、release 合併 main、流程圖／架構圖／考試）**全部改為只有管理員**⇒ 內部一般人＝客戶一般人＋看全部專案＋個人設定。**GIT 規則（09-11 裁決）**：公司可綁一組 GIT；有個人 GIT 用個人、沒有用公司的——這推翻 `project-routes.js:930`「推 main 只用操作者本人 PAT、沒設就擋、不退機器憑證（為了歸屬）」的刻意設計，順帶解掉 [[deploy-fetch-missing-pat]] 的系統觸發無 PAT 問題。個人設定頁日後也會改。**衝突已解（09-11 裁決）**：客戶**也能在個人設定填個人 GIT**（推上去看得出是誰）⇒ 「客戶畫面不出現任何憑證」縮小為「客戶碰不到主機／DB／SSH／VPN 憑證，只能填自己的個人 GIT」。PAT 由平台 node 執行 push 時使用，不進 AI 容器。注意「鴻久」專案同時掛鴻久與鴻伍正式連線（db_connections id 2、3），鴻伍若成獨立客戶要先拆專案。

**公司開關＋使用期間（09-11 使用者補充）**：公司要有啟用開關與使用期間，之後走**訂閱制** ⇒ 子專案 1（公司欄位）＋4（收費）。與子專案 0 的接點：發 per-run 通行證／開容器前檢查「該公司可用」，第 0 塊先留檢查點。09-11 使用者選「回去寫第 0 塊規格」。

**⚠ 最大的擋路石：Anthropic 條款（09-11 實查 code.claude.com/docs/en/legal-and-compliance）**：平台是用 `teams_settings.claude_oauth_token_enc` 的**訂閱 token**（主＋備用）跑 claude CLI。條款原文「Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials…」＋「does not permit third-party developers … to route requests through Free, Pro, or Max plan credentials on behalf of their users」。例外只有「unless we've mutually agreed otherwise」。⇒「客戶按、使用者的訂閱付錢」不能直接賣。技術面換 key 很簡單（`claude-auth.js:81` 已認 `ANTHROPIC_API_KEY`），卡的是錢與合約。**09-11 使用者裁決：客戶自帶 API key（BYOK）**，不找 Anthropic 業務談。衍生三件：per-tenant key 加密存（比照 `github_pat_enc`）並逐任務注入／非客戶觸發的 AI 工作（夜間健檢、改善通道）仍走使用者的 key 要分帳／客戶帳單直接來自 Anthropic ⇒ 需要單張任務花費上限防嚇到客戶。

**與舊裁決衝突（未解）**：09-08 使用者裁決「部署不備份 DB」（理由：太耗效能／跑太久，`docs/superpowers/specs/2026-09-08-auto-deploy-design.md` §6.5、`deploy-run.js:187`）——當時前提是使用者親自把關上正式。客戶按到底後前提變了，要重新問，別直接沿用。09-11 使用者提議「每天凌晨備份＋binlog 重播退版」，實查與文件查證結果：①PG 叫 WAL 不叫 binlog；②四條客戶正式連線（id 2/3 鴻久＋鴻伍、7/8 慈雲）全是 PG16、`wal_level=replica`、**`archive_mode=off`**，開啟要重啟 DB（文件：only at server start）；③**PITR 的底必須是 `pg_basebackup`，`pg_dump` 不能重播 WAL**；④**PITR 只能倒整個 cluster**——conn 2 與 3 查出同一組 DB（`odoo_prd` 805MB／`odoo_dev`／`odoo_tst`／`hutest`）＝**鴻久與鴻伍正式在同一個 cluster，替一家退版會連另一家一起倒**；⑤任何倒帶法都會丟掉上線後新打的資料。慈雲 cluster 全部不到 90MB。**使用者回覆「我覺得應該還是會太久，這個先保留 idea 但是之後再討論」⇒ 退版備份擱置、未決**（不是裁決不備份）；再談時從三選一接續：上線前單庫 pg_dump／WAL 歸檔＋每晚 basebackup／兩者都做。他的顧慮是「太久」但沒實測過，805MB 實際要跑多久是下次該先量的數字。另：`/api/projects/:id/release` 推 main 用**操作者本人的 GitHub PAT**、部署要 admin（`project-routes.js:930,997`），客戶沒有 PAT 也不是 admin ⇒ 這兩道都要換掉。

**計費的原料已經有了、閘門沒有**：`token_usage` 已按 `user_id`／`project_id`／`agent_type` 記帳，但沒有任何額度上限或阻擋邏輯。要注意這張表本身低估成本，見 [[token-usage-underreports-cost]]。

**09-14 進度**：平台 09-14 09:14 已重啟⇒`PLATFORM_CONTAINER` 生效（0.3 完成）、`/api/docs/saas-specs` 回 401（路由已掛）。**R5 已決：備份先放這台、留 14 天、之後再搬**（已寫進開發順序規格）；平台 DB 仍零備份、0.1 尚未做。R3 使用者反問「為什麼需要 staging」；R4 使用者要「先確定到時候的使用者分級」再談日期。
**09-14 裁決（已全部寫進規格＋重產 docs 網頁）**：①**R3 不開 staging**，改「功能開關可只對某家公司開＋固定一家測試公司／測試專案」在正式平台驗證（開發順序 §2.1 重寫、舊撞車點表保留為 2.1-舊）；②**角色改三種**：平台管理員（admin、無公司）／公司管理員（company_admin）／一般使用者（user），**除 admin 外人人屬於一家公司**；內部人員＝「內部公司」成員；③**專案可掛多家公司**（新表 `project_companies`＋`can_release`，使用者主動選多對多、否決我建議的 is_internal 看全部）；新建專案自動綁內部公司；內部公司不特判、靠全綁看到全部；④上正式看綁定 `can_release`，內部公司綁定強制 false；⑤AI key＝**發起的人所屬公司**（任務＝`tasks.user_id`，重跑也算建任務者；問答＝發問者）⇒ 仍需 `companies.is_internal`（只管付錢、只遷移時建、API 不可設）；`canRun(scope, actorUserId)`。R4 只剩日期（等 2a 做完）。規格改前備份在該 session scratchpad `specs-bak-0914`（session 專屬）。
**09-14 全部待決題已裁決並寫入規格**（使用者要求「全部先確認完再說」）：1-P1 只看自己／P2 隱藏／P3 關註冊／**P4 管理員無個人 GIT 不退回**／**P5 公司停用立刻中止**（非我建議）／P6 只停用；2-P1 可代填記 set_by／P2 歷史 p90/p99／**P3 沿用用量報表加公司條件開給公司管理員（後端強制自家）**／P4 一家一把；3-P1 衝突轉平台／P2 要求助鈕／P3 測試區維持 admin／**P4 上正式不備份**（確認視窗＋條款明寫）／P5 待上正式唯讀可見；4-O1 不串金流／**O2 每家固定月費**／O3 14、3 天／**O4 不自動刪**／O5 不做匯出／**O6 維護時段每週六日**／O8 每家各自上限／O9 上線前修 443＋評估客戶自有網域／**O10 自己擬**；**R4 2b 跟 2a 一起上**。**新發現（09-14 實查，已寫進規格 1 §10、開發順序 2c）**：測試區 Odoo 用平台 `DATABASE_URL` 帳號 `odoo`＝**PG 超級使用者**（`env-agent.js:193`→`dbEnvFlags`），同一 PG(8772) 有 `aidev`＋17 個 `test_*`；SSO 帳號含 group_system 可寫伺服器動作跑 Python ⇒ 讀平台 DB／別家測試資料／`COPY TO PROGRAM`；**不經 AI 容器，子專案 0 擋不住**；修法＝每測試區非超級使用者 PG 角色＋REVOKE CONNECT，客戶進測試區前必完成。規格頁 bug（點選單變空白）：srcdoc iframe 的 `#連結` 以平台網址解析→iframe 載入平台首頁讀不到 token；修＝`SaasSpecs.js` 補 `<base href="about:srcdoc">`（純前端靜態檔免重啟，已 playwright 在正式頁驗過）；**已 commit＋push `a0fdda97`**（私有 index、2 檔、限定路徑 reset，origin 已同步）。規格頁徽章改成不算含「已決」的列（樣板在 gitignored 的 `_page/`，未進版控）。
