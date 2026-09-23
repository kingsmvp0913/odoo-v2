# 把 AI 關起來（子專案 0）實作計畫 — 第 1 部：量測、純函式與 `/ai` 平台端

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每次 AI 執行改在用完即丟的 docker 容器內跑，拿不到 `APP_SECRET`／`JWT_SECRET`／`DATABASE_URL`、別專案資料、客戶憑證；對外只連得到 Anthropic、Context7 與平台 `/ai`（經 unix socket＋每次執行通行證）。

**Architecture:** 平台 node（host 網路、持有全部憑證）以 `docker run -i --rm` 開 AI 容器，容器只接 `--internal` 網路 `<實例id>-agent-net`；出口閘道容器 `<實例id>-gw`（不持憑證）同時接 internal 網路與預設 bridge，3128 做 CONNECT 白名單、8080 把 `/ai/*` 轉進 `data/run/ai.sock`。平台端 socket listener 只掛 `/ai/*`、只認每次執行通行證，依 scope（`project-<id>`／`internal-audit`／`internal-fix`／`none`）檢查端點與專案。全部藏在 `teams_settings.agent_sandbox_mode` 開關後面，預設 `off`。

**Tech Stack:** Node 20（平台）、express 4、pg 8.22、jest 29＋pg-mem＋supertest、docker CLI 29（經宿主 socket）、`@anthropic-ai/claude-code@2.1.266`、`@upstash/context7-mcp@3.2.3`。

**Spec:** `docs/superpowers/specs/2026-09-11-agent-sandbox-design.md`（另讀 `2026-09-11-productize-overview.md` §2、§6 與 `2026-09-11-productize-rollout-plan.md` 階段 1）

## 本計畫的三個檔案

| 檔 | 內容 | 對應開發順序 | Task 數 |
|---|---|---|---|
| **第 1 部（本檔）** `2026-09-15-agent-sandbox.md` | 前置量測 M1–M3、profile 表、通行證、開關、容器參數純函式、掛載解析、`/ai` scope、socket listener、`/ai/glossary`、`/ai/platform/query`、git 加固 | 1.1（平台端） | 16（Task 0＋量測 M1–M3＋實作 1.1–1.12） |
| 第 2 部 `2026-09-15-agent-sandbox-part2-runner.md` | 映像檔、出口閘道、infra 確保、runner 容器分支、kill／137／session 遺失、孤兒容器清理、呼叫端補參數、Codex／考試 env 白名單、MCP、skill 改打 `/ai`、session 複製 | 1.1（執行端） | 21（實作 2.1–2.16＋量測 M5–M9） |
| 第 3 部 `2026-09-15-agent-sandbox-part3-rollout.md` | 內部 AI 乾淨 worktree／修正 worktree 掛載、自我檢測（攻擊實測）端點＋腳本、資源上限量測、1.2–1.7 分段啟用與移除舊路徑 | 1.2–1.7 | 15（實作 3.1–3.13，其中 3.13 為未裁決候補＋量測 M10、M11） |

**執行順序固定：第 1 部 → 第 2 部 → 第 3 部。** 各部的 Task 互相引用的函式名稱以各 Task 的 **Interfaces** 區塊為準。

## Global Constraints

- 全跑測試一律 `cd app && npm run test:quiet`；動手前先量基線（`Tests:`／`Test Suites:` 兩行），之後的紅燈先當自己造成（rules/always 1、2）。
- commit 前 `git status --porcelain -uno` 逐檔挑選，**禁用 `git add -A`**；`docs/` 不進版控（rules/always 4、8）。
- 開發一律在自己的 git worktree＋分支，不共用主 clone；主 clone 常駐 `testing`（rules/always 5、9）。
- 改 `app/server/**.js` 要重啟才生效；**重啟由使用者在主機跑 `upgrade.sh`**，容器內不得 kill node（記憶 platform-restart-kills-container）。
- 查表式降級一律指向最嚴格：未知 mode→`all`、未知 agentType→丟例外、缺資源上限→丟例外（rules/pipeline 59）。
- **禁止退回無容器執行**：容器模式任何準備失敗都 reject，不得改走 `spawn('claude')`（規格 §6）。
- 絕不放進容器 env：`APP_SECRET`、`JWT_SECRET`、`DATABASE_URL`；呼叫端帶白名單外的 env key → 丟例外（規格 §4.2）。
- 路徑一律由既有變數推導（`APP_DIR`＝`path.resolve(__dirname,'..','..','..')` 慣例、`ODOO_ENV_BASE`、`CORE_SRC_ROOT`、`ENTERPRISE_BASE_DIR`、`project_repos.local_path`、`uploadRoot()`），**不寫死 `/home/odoo/...`**（CLAUDE.md §0）。本計畫出現的絕對路徑只是 09-15 這台機器的實查值。
- 容器名、網路名、label 全部帶實例 id＝`PLATFORM_CONTAINER`（正式＝`odoo-v2`）；未設時容器模式丟例外（規格 §4.2）。
- `memory`／`cpus`／`pids` 三個上限未設定前，建構函式丟例外（規格 §4.2、總覽 D6）。
- `runClaude` 在開關 `off` 時必須維持**同步 spawn**（rules/testing 26）。
- `scripts/` 下的程式不得 `require` npm 套件（rules/infra 113）。
- 改 `.claude/skills/` 後必跑 `node scripts/sync-skills.js`（rules/always 13）。
- 不改 `.claude/agents/*.md` 的 placeholder 與 `<result>` 契約（agentPrompt 鐵則 1、2）；本計畫原則上不動 agent prompt。
- Commit 訊息格式 `[AgentSandbox]: <為什麼>`，結尾附 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`。
- 內部 scope 兩級（09-15 R6-A）：只有 `workflow_health` 拿得到 `/ai/platform/query`；`platform_fix`、`fix_verify`、`fix_review`、`feedback_merge` 拿不到。夜間改善自動合併**維持不變**。
- Codex 不容器化；只做 env 白名單；客戶觸發的 agentType 在容器模式下設成 codex 直接報錯（規格 §4.6）。
- 不開 staging；在正式平台以開關＋測試專案驗證（總覽 §2 09-14 R3）。

## 與規格不符之處（09-15 對照現行碼）

| # | 規格說法 | 現況 | 本計畫怎麼處理 |
|---|---|---|---|
| X1 | `start.sh:30-41` export 三把鑰匙（含 `DATABASE_URL`、`ANTHROPIC_API_KEY`） | 行號位移：`JWT_SECRET` 30、`APP_SECRET` 37、`PLATFORM_CONTAINER` 45-46（新增）、`DATABASE_URL` **47**、`ANTHROPIC_API_KEY` **56-57** | 結論不變，不影響設計 |
| X2 | rules/infra 131「`spawn('claude')` 只有一處」；§2.13 字面 22 種 agentType 就是全部 AI 呼叫 | 另有 **3 處**直接 `spawn('claude')`：`lib/exam/challenge.js:191`、`lib/exam/review.js:401`、`lib/exam/evidence.js:368`（考試系統，未帶 env＝整包繼承 `process.env`，含 `APP_SECRET`）；`admin-routes.js:76` 以 `runClaude` 驗 token 但**沒帶 agentType** | 考試：第 2 部 Task 2.11 先做 env 白名單，是否進容器列為待決 Q1；token 驗證補 `agentType:'auth_probe'`（第 2 部 Task 2.9） |
| X3 | §2.13「`chat` 不在字面清單（用變數帶的）」 | 現在 `chat-agent.js:163` 已是字面 `agentType: 'chat'`；另 `clarify-chat.js:202`、`spec-review.js:119` 用的是 `'respec'`；`token_usage` 有 `feedback_triage`（31 筆）但碼裡已無（09-09 拿掉的關卡） | M1 盤點表以「碼＋token_usage」雙向對照；`feedback_triage` 不登記（已不存在的呼叫點） |
| X4 | §2.11「整條 pipeline **沒有** `--resume` 找不到 session 的退路（grep 0 筆）」 | 已有退路：`with-resume.js:52-66`（cs／chat／spec-review／clarify-chat）、`qa-agent.js:154-176`、`task-agent.js:344-369`（analysis，含 task_logs）、`task-agent.js:589-608`（spec_tour，含 task_logs）——**任何非 timeout 的續接失敗都已降級 fresh**；缺的是「辨識出是 session 遺失」與 qa／對話閘門的 task_logs 說明 | 第 2 部 Task 2.4 只補辨識（`claudeStatus:'session_missing'`）與缺的 task_logs，不重做退路 |
| X5 | §4.5「`data/` 在 `.gitignore` 內，worktree 天生沒有它」 | `.gitignore` 是**逐檔**列（`/data/config.json`、`/data/odoo-core/`…），`data/config.example.json`、`data/create-odoo-role.sql` 是 tracked；`config.json` 仍不會進 worktree，結論成立 | 新增的 `data/run/`、`data/agent-home/` 必須補進 `.gitignore`（第 1 部 Task 1.8） |
| X6 | §2.7 getSQL／getLog／wikiQuery 三個 skill 都走 `curl $AIDEV_AI_BASE/ai/...` | `getLog/SKILL.md:28,49` **寫死 `http://localhost:3939`**，容器內必失敗 | 第 2 部 Task 2.14 改成 `$AIDEV_AI_BASE` |
| X7 | §4.2 掛載表只列 worktree／主 clone／odoo-core／enterprise／skills／hooks／mcp／HOME | 另外有 agent **合法會讀**的宿主路徑：①任務附件 `uploadRoot()/task_<tasks.id>/`（`sync.js:445-446` 給絕對路徑）②對話附件 `chat_<chatId>/`（`chat-agent.js:39`、`chat-to-task.js`）③意見附件 `feedback_<id>/`（`finding-fix.js:255-262`，給 platform_fix）④`cs-capability.md:16`「執行／部署／測試異常→讀對應 log」＝`ODOO_ENV_BASE/<folder>/odoo.log`、`data/logs/deploy-task*`、`e2e-task*` | Task 1.5 的掛載解析把這四類以 **ro、只限本專案／本任務** 納入 |
| X8 | §4.2 MCP 設定檔唯讀掛入即可 | `claude-runner.js:53-74` 生成的 context7 設定用 `process.execPath`（宿主 node）＋平台 `app/node_modules` 路徑，容器內兩者都不存在 | 映像檔內裝 `@upstash/context7-mcp@3.2.3`（第 2 部 Task 2.1）；容器專用設定檔由第 2 部 Task 2.5 的 `sandboxMcpConfigPath` 生成，Task 2.13 在容器內實測經 proxy 查得到文件 |
| X9 | §2.9 只說 pipeline AI 會載入使用者層外掛 | chat／cs／chat-title／chat-to-task／deploy_fix／reject_classify／wiki_drift_classify／wiki／feedback_merge／repair／merge 系**沒傳 cwd**＝cwd 是平台 repo 根（容器 `WorkingDir=/home/odoo/odoo-v2`），它們現在**原生載得到平台全部 `.claude/skills`**（含 platformDB、pushRepo）；進容器後 cwd 變了，這些 skill 會消失 | M7 量測「HOME 下 `.claude/skills` 在 headless 是否載入」；第 2 部 Task 2.14 依結果以 ro 掛載白名單 skill 進容器 HOME |
| X10 | 總覽 §6.3「現在自動核准的兩處：`health-check-runner.js:133`、`:238-251`」 | 已改：commit `5f962094`（09-15，**已在 master**，開發順序 0.5 寫的是「分支 feat/platform-db-backup」）——`:133`、`:256` 都是 `const status = 'pending'` | 0.5 已完成；是否已重啟不知道，1.3 重啟時一併生效 |
| X11 | 總覽 §6.3 `nightly-fix.js:654`；開發順序 §2.2 `finding-fix.js:583-596`、§2.1 `finding-fix.js:432-439` | 現在分別是 `nightly-fix.js:656、769-770`、`finding-fix.js:631`（docker restart）、`finding-fix.js:459-477`（pickSelfContainer） | 僅行號位移 |
| X12 | 規格 §4.4 internal 可看全平台 `/ai/wiki/*`、`/ai/tasks/*`；§4.5 只拿掉 fix 類的 `/ai/platform/query` | R6-A 的理由是「改碼的 AI 只讀得到核准過、放進 prompt 的文字」，而 `/ai/tasks/spec` 回的 `analysis_yaml`、wiki 疑難排解都是客戶文字，照同一理由也不該給；09-15 grep：fix 類四份 prompt 都**沒有**用到任何 `/ai/` 端點 | 採最嚴格：`internal-fix` 只給 `/ai/glossary`；列為待決 Q2（使用者若要放寬，改 `SCOPE_ENDPOINTS` 一行） |
| X13 | §4.4「`/ai/platform/query` 用唯讀 DB 角色」 | 平台 PG 只有一個角色 `odoo`（superuser）。若用 `SET ROLE` 切到 NOLOGIN 角色，查詢內 `SELECT set_config('role','odoo',false)` 就切回 superuser（session_user 仍是 odoo）→ **必須用另一個 LOGIN 角色、另開連線** | Task 1.11 建 LOGIN 角色 `aidev_ai_ro`，密碼由 `APP_SECRET` 派生（不另存），欄位級 GRANT；M3 先量 `pg_hba` 允不允許 |
| X14 | §4.3 閘道拒絕時記「來源容器名」 | 閘道不掛 docker socket（不持任何權限），只看得到來源 IP | 閘道 log 記來源 IP；對應容器名用 `docker network inspect <net>` 查（runbook 寫明） |
| X15 | 開發順序 1.2「攻擊實測在正式平台跑」排在 1.3「合併進 master」之前 | 攻擊實測要用平台 node 的通行證清單與 socket，**程式沒合併＋重啟就跑不起來**（R3 不開 staging） | 第 3 部改為：1.3 合併（開關 off）＋重啟 → 1.2 自我檢測全過 → 1.4 開內部 |
| X16 | 開發順序 §2.1 功能開關要能「指定公司 id」 | 公司表是子專案 1 才有 | 本期開關支援 `off／internal／projects／all`＋專案 id 清單；公司維度留給子專案 1 |
| X17 | §4.1 基底 `node:22-slim` | 平台本體是 Node **20.20.2**；`platform_fix` 要在容器內跑平台的 jest | M8 量測容器內全跑結果與宿主基線是否一致；不一致就改 `node:20-slim`（第 2 部 Task 2.1 的 build arg） |
| X18 | `CODEX_ELIGIBLE`（`agent-loader.js:75-77`）＝`reject-classifier、deploy-fix、wiki-drift-classifier、chat-to-task、library、chat` | **全部都是客戶觸發的 agent**，沒有任何內部 agent 可選 Codex ⇒「Codex 只留內部」落地後 Codex 等於沒有用途；09-15 所有 `.claude/agents/*.md` 都沒設 `provider:`（全是 claude） | 本期：容器模式下這些 agentType 設 codex → 丟例外；`CODEX_ELIGIBLE` 名單怎麼改列為待決 Q3（1.7 前要決定） |
| X19 | 規格 §4.4 只說「用唯讀 DB 角色」 | commit `8ca9913d`（09-15，已在 origin/master、**未重啟**）的 2c：`index.js:265` 啟動時跑 `revokePublicConnectAll()`＝對每個 `datallowconn` 的 DB（含 `aidev`）`REVOKE CONNECT ... FROM PUBLIC`（`lib/testenv-db-role.js:132-137`） | 唯讀角色必須**明確** `GRANT CONNECT ON DATABASE <current_database()> TO aidev_ai_ro`（REVOKE FROM PUBLIC 不會收回對個別角色的授權）；Task 1.10 的 `buildRoleSql` 與測試已納入；`ensureReadonlyRole` 在啟動順序上排在 revoke 之後 |
| X20 | 規格 §2.4 只量到「5416 refused」 | `docker/entrypoint.sh` 每次啟動改寫 `pg_hba.conf`：`local trust`、`host 127.0.0.1/32 trust`、`::1 trust`、`host <docker0 網段，這台 10.0.0.0/24> scram-sha-256` ⇒ **任何碰得到宿主 loopback 8772 的東西免密碼就是 superuser `odoo`** | 第 3 部自我檢測必驗：AI 容器內 TCP 連 `127.0.0.1:8772`、`host.docker.internal:8772`、docker0 閘道（這台 `10.0.0.1`）`:8772` 全部失敗；M3 改從 bridge 丟棄式容器驗唯讀角色密碼登入（127.0.0.1 是 trust，驗不到密碼） |
| X21 | 開發順序 §3「攢一批、挑時段跑 `upgrade.sh`」 | 使用者在**任何 Claude session（含執行本計畫的 agent）還在跑時不能重啟**——重啟會連同 session 一起砍掉（09-15 主 session 告知；記憶 platform-restart-kills-container） | 需要重啟的步驟集中成三個批次 **R-A／R-B／R-C**（第 3 部），每批開頭都是「執行者停手、回報、交給使用者在沒有 session 時重啟」，重啟後由新 session 接續；第 1、2 部**完全不需要重啟** |

## 使用者裁決（09-15，已全部決定；下方原「待決」表保留問題脈絡）

| # | 裁決 | 對計畫的影響 |
|---|---|---|
| Q1 | **考試系統的 AI 不進容器** | 照預設：只做第 2 部 Task 2.11 env 白名單 |
| Q2 | **不給**：internal-fix 只拿 `/ai/glossary` | 照預設（X12）。使用者確認：不影響「幫代管客戶改 Odoo」的任務流程，那是客戶 profile |
| Q3 | **Codex 先限內部人員，之後再裝容器**：`CODEX_ELIGIBLE` 名單保留、照常可選；客戶公司的帳號觸發時一律 Claude | 第 2 部 Task 2.12 **只做 env 白名單，拿掉「容器模式下客戶 agent 設 codex 就報錯」**（那會連內部人員處理代管客戶的單也擋掉）。依「觸發者所屬公司」擋 Codex 需要公司表 ⇒ 移到子專案 1（`canRun(scope, actorUserId)` 檢查點）。第 3 部 Task 3.11 不清空名單。已知剩餘風險：內部人員以 Codex 處理含客戶文字的單，仍無容器保護；Codex 容器化列後續 |
| Q4 | **加分支守衛** | 第 3 部 Task 3.13 由候補改為**必做**，排在 3.3 之後、3.4（合併＋R-A）之前 |
| Q5 | **測試專案＝project 1「odoo17」**（09-15 查：0 未結任務、0 正式連線） | 第 3 部所有 `<Q5>` 代入 `1` |

## 原待決（問題脈絡）

| # | 問題 | 為什麼要問 | 計畫目前的預設（最嚴格） |
|---|---|---|---|
| Q1 | **考試系統的三個 AI 呼叫**（`lib/exam/challenge.js`、`review.js`、`evidence.js`）要不要進容器？ | 規格 §10「全部 agentType 對照表含考試系統，對不上就停下來問」。它們直接 `spawn('claude')`、`--dangerously-skip-permissions`、整包繼承 `process.env`（含 `APP_SECRET`）；`/api/exam/run` 只驗登入（`exam-upload-routes.js:323`），截圖由使用者上傳＝注入入口。檔頭自己寫「要真正的隔離得把子行程放進容器」（`review.js:48-50`） | 本期先做 env 白名單（第 2 部 Task 2.11，拿不到三把鑰匙），**不進容器**；若要進容器，需另補一個 profile（掛 `data/odoo-core/<ver>` 唯讀、暫存 cwd）與它自己的 stream 解析改走 runner，工作量約 2 個 Task |
| Q2 | `internal-fix`（platform_fix、fix_verify、fix_review、feedback_merge）要不要看得到全平台 `/ai/wiki/*`、`/ai/tasks/*`？ | X12：R6-A 的理由同樣適用於 wiki／任務規格裡的客戶文字；09-15 這四份 prompt 都沒用到 `/ai` | 不給（只給 `/ai/glossary`） |
| Q3 | `CODEX_ELIGIBLE` 名單（全是客戶 agent）1.7 之後怎麼辦？ | X18：「Codex 只留內部」落地後 Codex 沒有任何可用的關卡 | 本期只在容器模式下擋；1.7（第 3 部 Task 3.11）前請使用者選：清空名單／改列內部 agent（需另外驗證 Codex 在那些關卡的契約） |
| Q4 | 容器可寫任務主 clone 的 `.git`（commit 必要），因此也改得到同專案 `main`／`testing` 的 ref，可繞過 QA 與人工審核直接影響部署。要不要加「執行前後 ref 快照比對、只准本任務分支變動」的守衛？ | 規格 §4.2 只把 `.git/config`、`hooks` 設唯讀；refs 竄改是同專案內的洞，與總覽 §6.2 I2 同類但路徑更短 | 不做（規格未含）；第 3 部 Task 3.13 已寫好候補 Task，裁決後才執行 |
| Q5 | 哪一個專案當「測試專案」（自我檢測、1.5 試跑都用它）？ | 開發順序 §2.1：測試專案只綁測試部署目標、不指向真客戶正式機；子專案 1 的測試公司還不存在 | 無預設；第 3 部 M10 前必須指定（需含至少一張已建 worktree 的任務，另需任一「別的專案」只供跨專案存取測試讀路徑名） |

## 檔案地圖（第 1 部）

| 檔 | 動作 | 責任 |
|---|---|---|
| `app/server/lib/agent-profiles.js` | Create | agentType → {scope 種類、掛載種類、附件種類、要不要 log}；scope → 可用 `/ai` 端點群組。**唯一真相** |
| `app/server/lib/agent-run-token.js` | Create | 每次執行通行證：派生金鑰、簽發、驗證、執行中清單、作廢、`canRun` 檢查點 |
| `app/server/lib/agent-sandbox-flag.js` | Create | 開關與資源上限的同步快取（啟動載入、存檔重載） |
| `app/server/db.js` | Modify（ALTER 清單 `teams_settings` 段，約 1098 行後） | 新增 9 個欄位 |
| `app/server/admin-routes.js` | Modify | `GET/PUT /api/admin/agent-sandbox` |
| `app/server/lib/agent-sandbox.js` | Create | `buildAgentRunArgs` 純函式：env 白名單、`--mount`、label、網路、上限 |
| `app/server/lib/agent-mounts.js` | Create | 依 profile＋專案／任務解出掛載清單與 workdir（async，DB 讀取可注入） |
| `app/server/lib/ai-scope.js` | Create | `/ai` 端點群組與專案檢查 middleware |
| `app/server/lib/ai-token.js` | Modify | `aiEndpointGuard` 分流：socket 來的只認通行證 |
| `app/server/db-query-routes.js`、`wiki-routes.js`、`ai-task-routes.js` | Modify | 各 `/ai/*` 加群組與專案檢查 |
| `app/server/lib/ai-socket-server.js` | Create | 只掛 `/ai/*` 的 express app＋unix socket listener |
| `app/server/ai-platform-routes.js` | Create | `/ai/glossary`、`/ai/platform/query` |
| `app/server/lib/platform-readonly.js` | Create | 唯讀 LOGIN 角色、欄位遮蔽、唯讀查詢 |
| `app/server/lib/git-hardening.js` | Create | `core.hooksPath=/dev/null`、`core.fsmonitor=false` 注入 git env |
| `app/server/lib/git-identity.js` | Modify | `buildGitEnv` 回傳值套用加固 |
| `app/server/index.js` | Modify | 註冊 `ai-platform-routes`；啟動時載開關、起 socket、建唯讀角色、加固 git env |
| `.gitignore` | Modify | `/data/run/`、`/data/agent-home/` |
| 測試：`app/server/tests/agent-profiles.test.js`、`agent-run-token.test.js`、`agent-sandbox-flag.test.js`、`agent-sandbox.test.js`、`agent-mounts.test.js`、`ai-scope-routes.test.js`、`ai-socket-server.test.js`、`ai-platform-routes.test.js`、`platform-readonly.test.js`、`git-hardening.test.js` | Create | 各配一支 |

---

## Task 0：開 worktree、量測試基線

**Files:** 無程式變更

- [ ] **Step 1：開 worktree 與分支**（主 clone 不留東西；rules/always 5）

```bash
cd /home/odoo/odoo-v2
git fetch origin
git worktree add -b feat/agent-sandbox .claude/worktrees/agent-sandbox origin/master
cd .claude/worktrees/agent-sandbox/app && ln -s ../../../../app/node_modules node_modules
```
（`node_modules` 以 symlink 借主 clone 的相依，比照 `finding-fix.js:118` linkNodeModules；不要 `npm install`。）

⚠ **worktree 必須放在 `/home/odoo/odoo-v2` 底下**（`.claude/worktrees/` 已由 `.git/info/exclude` 排除）：平台容器裡的 docker CLI 用的是**宿主**的路徑，只有 `/home/odoo/odoo-v2` 與 `/home/odoo/odoo-envs` 是同構 bind mount。放在 `/home/odoo/odoo-v2/.claude/worktrees/agent-sandbox` 會落在平台容器自己的檔案系統裡，第 2 部 M6–M8 的量測容器掛不到它，容器重建時也會整個消失。

- [ ] **Step 2：量基線**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/agent-sandbox/app && npm run test:quiet > /tmp/claude-baseline.txt 2>&1; echo "EXITCODE=$?" >> /tmp/claude-baseline.txt
grep -E "^Tests:|^Test Suites:|EXITCODE" /tmp/claude-baseline.txt
```
Expected：記下三行。之後每個 Task 的全跑都跟它比；**不要**把基線寫進任何 rules 檔（rules/always 2）。

- [ ] **Step 3：每天開工先併 master**（夜間改善會改 master；開發順序 §3-2）

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/agent-sandbox && git fetch origin && git merge origin/master
```

---

## Task M1（量測）：全部 AI 呼叫點的 agentType × cwd × 掛載需求對照表

**為什麼**：規格 §10「全部 agentType 的 cwd 與掛載需求實作計畫第一步逐一對照；對不上就停下來問」。Task 1.1 的 `AGENT_PROFILES` 是依 09-15 的實查寫的，執行當天必須再核一次（碼可能又被夜間改善改過）。

**Files:** 產出 `docs/superpowers/plans/2026-09-15-agent-sandbox-M1-table.md`（不進版控）

- [ ] **Step 1：碼裡的呼叫點**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/agent-sandbox/app/server
grep -rn "runAgent(\|runClaude(\|withResume({\|spawn('claude'\|spawn('codex'" --include=*.js . | grep -v tests/ > /tmp/claude-m1-sites.txt
grep -rn -A14 "runAgent(\|runClaude(\|withResume({" --include=*.js . | grep -v tests/ | grep -E "agentType|cwd|env:|projectId|taskId|chatId" >> /tmp/claude-m1-sites.txt
wc -l /tmp/claude-m1-sites.txt
```

- [ ] **Step 2：帳面上真的跑過的 agentType**

```bash
cd /home/odoo/odoo-v2
node .claude/skills/platformDB/query.js "SELECT agent_type, COUNT(*) n, MAX(recorded_at) last FROM token_usage GROUP BY agent_type ORDER BY n DESC"
```

- [ ] **Step 3：逐列填表並與下表比對**（09-15 實查值；左欄每一個都必須在 Task 1.1 的 `AGENT_PROFILES` 裡）

| agentType | 呼叫點（09-15） | 現行 cwd | 期望 profile（Task 1.1） |
|---|---|---|---|
| analysis | `task-agent.js:345,375` | 任務 worktree 父目錄 | project／task-worktree／附件 task |
| coding | `task-agent.js:637` | 同上（env 帶 gitEnv） | project／task-worktree／附件 task |
| spec_tour | `task-agent.js:590,604` | 同上（env 帶 gitEnv） | project／task-worktree／附件 task |
| qa | `qa-agent.js:155,187` | 同上 | project／task-worktree／附件 task |
| respec | `respec-agent.js:117`、`clarify-chat.js:202`、`spec-review.js:119` | worktree 或未傳 | project／task-worktree-or-none／附件 task |
| reject_triage | `reject-triage.js:143` | worktree，不存在退專案根 | project／task-worktree-or-clone／附件 task |
| cs | `cs-agent.js:97`（withResume） | 未傳（＝平台根） | project／project-clone／附件 task／log |
| chat | `chat-agent.js:142`（withResume） | 未傳 | project／project-clone／附件 chat／log |
| merge、merge-explain、merge-clarify | `merge-agent.js:83,157,217` | 未傳 | project／project-clone |
| wiki | `library-agent.js:201,304,423` | 未傳 | project／project-clone |
| chat-to-task | `chat-to-task.js:61` | 未傳 | project／none／附件 chat |
| chat-title | `chat-title.js:55` | 未傳 | none／none |
| deploy_fix | `failure-classifier.js:93` | 未傳 | none／none |
| reject_classify | `classify-rejections.js:26` | 未傳 | none／none |
| wiki_drift_classify | `wiki-drift.js:56` | 未傳 | none／none |
| repair | `agent-result.js:89,113` | 未傳 | none／none |
| auth_probe（新名） | `admin-routes.js:76`（現無 agentType） | 未傳 | none／none |
| workflow_health | `health-check-runner.js:94,335` | 平台 repo 根 | internal-audit／platform-clean |
| fix_review | `fix-review.js:105` | `os.tmpdir()` | internal-fix／platform-clean |
| feedback_merge | `feedback-merge.js:44` | 未傳 | internal-fix／platform-clean |
| platform_fix | `finding-fix.js:338` | `.claude/worktrees/fix-<id>` | internal-fix／platform-fix／附件 feedback |
| fix_verify | `fix-verify.js:79` | 同上 | internal-fix／platform-fix |
| （考試）review／challenge／evidence | `lib/exam/*.js` 直接 spawn | tmpdir | **不在本表**，見待決 Q1 |

- [ ] **Step 4：核對 log 檔名裡的 id 是哪一種**（Task 1.5 假設 `deploy-task<N>`、`e2e-task<N>` 的 N＝`tasks.id`）

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/agent-sandbox/app/server
grep -rn "deploy-task\|e2e-task" --include=*.js . | grep -v tests/
ls /home/odoo/odoo-v2/data/logs | head -5
```
Expected：組檔名處用的是 `task.id`（整數）。若是 `task.task_id`（業務字串），把 Task 1.5 `projectLogFiles` 的 `^(deploy|e2e)-task(\d+)-` 改成 `^(deploy|e2e)-task(.+?)-\d+`，並把比對集合換成 `task_id`。

- [ ] **Step 5：判定**：表中任何一列與碼不符（多出新 agentType、cwd 變了、多了 env key）→ **停下來問使用者**，不要自己補 profile。全部相符 → 繼續。

---

## Task M2（量測）：`--resume` 找不到 session 時 claude 印什麼

**為什麼**：規格 §6「偵測用的錯誤字面計畫階段實測取得，比照 `sandbox-signature.js` 只收啟動器自己印的字面，不猜」。第 2 部 Task 2.4 的 `MISSING_SESSION` 要照抄這裡的結果。

**Files:** 無

- [ ] **Step 1：宿主（平台容器內，互動 shell）跑一次不存在的 session**

```bash
cd /tmp && claude -p --output-format stream-json --verbose --resume 00000000-0000-4000-8000-000000000000 "回覆 ok" > /tmp/claude-m2.out 2> /tmp/claude-m2.err; echo "EXITCODE=$?" >> /tmp/claude-m2.out
cat /tmp/claude-m2.err; tail -5 /tmp/claude-m2.out
```

- [ ] **Step 2：記錄**：exit code、訊息在 stdout 還是 stderr、是否為 JSON `result` 事件（`subtype`／`result` 欄），逐字抄下**最能唯一辨識**的那一行（例：含 session id 的那句）。存進 M1 表檔的「M2」段。

- [ ] **Step 3：再用一個真的存在但屬於別的 cwd 的 session 試一次**（第 2 部 Task 2.16 要用：換 cwd 後同一個 session id 能不能續接）

```bash
SID=$(ls -t /home/odoo/.claude/projects/-home-odoo-odoo-v2/*.jsonl | head -1 | xargs basename | sed 's/.jsonl$//')
mkdir -p /tmp/claude-m2-cwd && cd /tmp/claude-m2-cwd && claude -p --output-format stream-json --verbose --resume "$SID" "只回覆 ok" > /tmp/claude-m2b.out 2>&1; echo "EXITCODE=$?" >> /tmp/claude-m2b.out; tail -3 /tmp/claude-m2b.out
```
Expected：記下是否失敗、字面是否與 Step 2 相同。

---

## Task M3（量測）：唯讀 LOGIN 角色真的要密碼、而且權限生效；有沒有危險 extension

**為什麼**：Task 1.10／1.11 建 `aidev_ai_ro` 並以派生密碼連線（X13）。09-15 已知 `pg_hba.conf` 由 `docker/entrypoint.sh` 每次啟動改寫為 `local trust`、`host 127.0.0.1/32 trust`、`::1 trust`、`host <docker0 網段> scram-sha-256`（X20）⇒ 平台從 `127.0.0.1:8772` 連線**不驗密碼**，權限仍照角色生效。要驗「密碼真的有用」只能從 bridge 網路的丟棄式容器連 docker0 位址；從平台容器連 `10.0.0.1` 來源 IP 是宿主 LAN 位址，會得到 `no pg_hba.conf entry`，不能拿來驗。

**Files:** 無（本量測在 Task 1.11 合併＋重啟**之後**才做得到角色登入那半；Step 1、2 現在就能做）

- [ ] **Step 1：確認 pg_hba 與這台的 docker0 網段**（唯讀）

```bash
docker exec odoo-v2 sh -c 'grep -vE "^\s*(#|$)" "$PGDATA/pg_hba.conf"'
docker network inspect bridge --format '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}'
```
Expected：與 X20 相同；若 `host 127.0.0.1/32` 不是 trust 或 docker0 那列不存在 → 記下實際值，回報使用者（Task 1.11 的連線方式要跟著改）。

- [ ] **Step 2：看 extension**

```bash
cd /home/odoo/odoo-v2 && node .claude/skills/platformDB/query.js "SELECT extname FROM pg_extension ORDER BY 1"
```
Expected：出現 `dblink`、`postgres_fdw`、`adminpack`、`plpython*u` 任一 → 停下來問（唯讀角色可能經它們繞出去）。

- [ ] **Step 3（重啟批次 R-A 之後才做，見第 3 部）：從 bridge 丟棄式容器驗唯讀角色**

```bash
GW=$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
PW=$(cd /home/odoo/odoo-v2/app/server && APP_SECRET="$(node -p "require('/home/odoo/odoo-v2/data/config.json').APP_SECRET")" node -p "require('./lib/platform-readonly').roPassword()")
# 錯密碼必須失敗（證明 scram 真的在驗）
docker run --rm --add-host host.docker.internal:host-gateway -e PGPASSWORD=wrong --entrypoint psql odoo-idx:17 -h host.docker.internal -p 8772 -U aidev_ai_ro -d aidev -c 'SELECT 1' ; echo "EXIT_WRONG=$?"
# 對密碼：可讀一般欄位、讀不到密碼雜湊、寫不進去
docker run --rm --add-host host.docker.internal:host-gateway -e PGPASSWORD="$PW" --entrypoint psql odoo-idx:17 -h host.docker.internal -p 8772 -U aidev_ai_ro -d aidev \
  -c 'SELECT COUNT(*) FROM tasks' -c 'SELECT password_hash FROM users LIMIT 1' -c 'UPDATE tasks SET title=title WHERE false' -c "SELECT set_config('role','odoo',false)"
unset PW
```
Expected：`EXIT_WRONG` 非 0（password authentication failed）；`COUNT` 有數字；`password_hash` → `permission denied`；`UPDATE` → `read-only transaction` 或 `permission denied`；`set_config('role','odoo')` → `permission denied to set role`。任何一項不符 → 停下來回報，不開 `/ai/platform/query`（開關維持 off／internal 以外不受影響，但健檢 agent 查 DB 會失敗）。`odoo-idx:17` 是這台已有的測試區映像（內含 psql）；不存在時換任一含 `psql` 的現有映像，**不要為此 pull 新映像**。

---
## Task 1.1：`agent-profiles.js`——agentType 與 scope 的唯一真相

**Files:**
- Create: `app/server/lib/agent-profiles.js`
- Test: `app/server/tests/agent-profiles.test.js`

**Interfaces:**
- Consumes：無
- Produces：
  - `AGENT_PROFILES: { [agentType]: { scope: 'project'|'none'|'internal-audit'|'internal-fix', mount: 'task-worktree'|'task-worktree-or-none'|'task-worktree-or-clone'|'project-clone'|'none'|'platform-clean'|'platform-fix', attachments?: 'task'|'chat'|'feedback', logs?: true } }`
  - `SCOPE_ENDPOINTS: { project: ['db','wiki','tasks','glossary'], 'internal-audit': ['wiki','tasks','platform','glossary'], 'internal-fix': ['glossary'], none: [] }`
  - `profileFor(agentType: string) → profile`（未登記丟 `Error`，訊息含 agentType）
  - `runScope(profile, projectId: number|null) → 'project-<id>'|'none'|'internal-audit'|'internal-fix'`（project 類但 projectId 為 null → `'none'`）
  - `scopeKind(scope: string) → 'project'|'none'|'internal-audit'|'internal-fix'`（無法辨識丟例外）
  - `endpointsFor(scope: string) → string[]`
  - `isInternalProfile(profile) → boolean`

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/agent-profiles.test.js
// 意圖：AI 在容器裡拿得到什麼，全由這張表決定。表錯一格＝某個 agent 看得到不該看的東西，
// 或查不到該查的東西而整關失敗。以下每條都對應一個 09-15 已裁決的權限邊界。
const p = require('../lib/agent-profiles');

describe('profileFor：未登記的 agentType 一律擋下（rules/pipeline 59：fallback 指向最嚴格）', () => {
  test('拼錯字不可以默默拿到任何 profile', () => {
    expect(() => p.profileFor('codng')).toThrow(/codng/);
    expect(() => p.profileFor(undefined)).toThrow();
  });
  test('09-15 盤點出的每個 agentType 都有 profile', () => {
    for (const t of ['analysis', 'coding', 'spec_tour', 'qa', 'respec', 'reject_triage', 'cs', 'chat',
      'merge', 'merge-explain', 'merge-clarify', 'wiki', 'chat-to-task', 'chat-title', 'deploy_fix',
      'reject_classify', 'wiki_drift_classify', 'repair', 'auth_probe', 'workflow_health', 'fix_review',
      'feedback_merge', 'platform_fix', 'fix_verify']) {
      expect(p.profileFor(t)).toBeTruthy();
    }
  });
});

describe('R6-A：內部 scope 拆兩級，只有健檢 AI 查得到平台 DB', () => {
  test('workflow_health 是 internal-audit，端點含 platform', () => {
    const s = p.runScope(p.profileFor('workflow_health'), null);
    expect(s).toBe('internal-audit');
    expect(p.endpointsFor(s)).toContain('platform');
  });
  test.each(['platform_fix', 'fix_verify', 'fix_review', 'feedback_merge'])(
    '%s 拿不到 /ai/platform/query，也拿不到客戶文字的 wiki／tasks', (t) => {
      const s = p.runScope(p.profileFor(t), null);
      expect(s).toBe('internal-fix');
      expect(p.endpointsFor(s)).not.toContain('platform');
      expect(p.endpointsFor(s)).not.toContain('wiki');
      expect(p.endpointsFor(s)).not.toContain('tasks');
    });
});

describe('內部 scope 一律查不到客戶正式 DB（總覽 D4）', () => {
  test.each(['internal-audit', 'internal-fix'])('%s 不含 db', (s) => {
    expect(p.endpointsFor(s)).not.toContain('db');
  });
});

describe('客戶 agent 的 scope 綁專案', () => {
  test('有 projectId → project-<id>', () => {
    expect(p.runScope(p.profileFor('chat'), 12)).toBe('project-12');
    expect(p.endpointsFor('project-12')).toEqual(['db', 'wiki', 'tasks', 'glossary']);
  });
  // cs 會遇到還沒綁專案的任務：沒有專案就沒有任何可查的東西，退到 none 而不是丟例外讓分流整關壞掉
  test('project 類但沒有 projectId → none（什麼端點都沒有）', () => {
    expect(p.runScope(p.profileFor('cs'), null)).toBe('none');
    expect(p.endpointsFor('none')).toEqual([]);
  });
  test('分類器類不需要任何資料 → none，即使帶了 projectId', () => {
    expect(p.runScope(p.profileFor('deploy_fix'), 5)).toBe('none');
  });
  test('scopeKind 認不得的字串丟例外（不猜）', () => {
    expect(() => p.scopeKind('project-')).toThrow();
    expect(() => p.scopeKind('internal')).toThrow();
    expect(p.scopeKind('project-3')).toBe('project');
  });
});

describe('內部 AI 不會掛到客戶 repo，客戶 AI 不會掛到平台 repo', () => {
  test('內部 profile 的掛載種類只能是 platform-*', () => {
    for (const [t, prof] of Object.entries(p.AGENT_PROFILES)) {
      if (p.isInternalProfile(prof)) expect(prof.mount).toMatch(/^platform-/);
      else expect(prof.mount).not.toMatch(/^platform-/);
      expect(t).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/agent-profiles.test.js`
Expected：FAIL，`Cannot find module '../lib/agent-profiles'`

- [ ] **Step 3：實作**

```js
// app/server/lib/agent-profiles.js
/**
 * agent-profiles.js — 每個 agentType 在容器裡「是誰、看得到什麼」的唯一真相（子專案 0 §4.2、§4.5）
 *
 * scope 種類：
 *   project        客戶觸發、綁單一專案；/ai 只能查該專案
 *   none           不需要任何資料（分類器、標題、補救）；/ai 一律不給
 *   internal-audit 健檢；看得到全平台任務／wiki、可唯讀查平台 DB，查不到客戶正式 DB
 *   internal-fix   改碼／審碼（R6-A 09-15）；只給公開術語表——它們只該讀到人核准過、放進 prompt 的文字
 *
 * 新增 agentType 一定要在這裡登記；沒登記的在容器模式下直接丟例外（rules/pipeline 59）。
 */
const AGENT_PROFILES = Object.freeze({
  analysis:            Object.freeze({ scope: 'project', mount: 'task-worktree', attachments: 'task' }),
  coding:              Object.freeze({ scope: 'project', mount: 'task-worktree', attachments: 'task' }),
  spec_tour:           Object.freeze({ scope: 'project', mount: 'task-worktree', attachments: 'task' }),
  qa:                  Object.freeze({ scope: 'project', mount: 'task-worktree', attachments: 'task' }),
  respec:              Object.freeze({ scope: 'project', mount: 'task-worktree-or-none', attachments: 'task' }),
  reject_triage:       Object.freeze({ scope: 'project', mount: 'task-worktree-or-clone', attachments: 'task' }),
  cs:                  Object.freeze({ scope: 'project', mount: 'project-clone', attachments: 'task', logs: true }),
  chat:                Object.freeze({ scope: 'project', mount: 'project-clone', attachments: 'chat', logs: true }),
  merge:               Object.freeze({ scope: 'project', mount: 'project-clone' }),
  'merge-explain':     Object.freeze({ scope: 'project', mount: 'project-clone' }),
  'merge-clarify':     Object.freeze({ scope: 'project', mount: 'project-clone' }),
  wiki:                Object.freeze({ scope: 'project', mount: 'project-clone' }),
  'chat-to-task':      Object.freeze({ scope: 'project', mount: 'none', attachments: 'chat' }),
  'chat-title':        Object.freeze({ scope: 'none', mount: 'none' }),
  deploy_fix:          Object.freeze({ scope: 'none', mount: 'none' }),
  reject_classify:     Object.freeze({ scope: 'none', mount: 'none' }),
  wiki_drift_classify: Object.freeze({ scope: 'none', mount: 'none' }),
  repair:              Object.freeze({ scope: 'none', mount: 'none' }),
  auth_probe:          Object.freeze({ scope: 'none', mount: 'none' }),
  workflow_health:     Object.freeze({ scope: 'internal-audit', mount: 'platform-clean' }),
  fix_review:          Object.freeze({ scope: 'internal-fix', mount: 'platform-clean' }),
  feedback_merge:      Object.freeze({ scope: 'internal-fix', mount: 'platform-clean' }),
  platform_fix:        Object.freeze({ scope: 'internal-fix', mount: 'platform-fix', attachments: 'feedback' }),
  fix_verify:          Object.freeze({ scope: 'internal-fix', mount: 'platform-fix' }),
});

// 端點群組：db＝/ai/db/*、wiki＝/ai/wiki/*、tasks＝/ai/tasks/*、glossary＝/ai/glossary、platform＝/ai/platform/query
const SCOPE_ENDPOINTS = Object.freeze({
  project: Object.freeze(['db', 'wiki', 'tasks', 'glossary']),
  'internal-audit': Object.freeze(['wiki', 'tasks', 'platform', 'glossary']),
  'internal-fix': Object.freeze(['glossary']),
  none: Object.freeze([]),
});

function profileFor(agentType) {
  const prof = Object.prototype.hasOwnProperty.call(AGENT_PROFILES, agentType) ? AGENT_PROFILES[agentType] : null;
  if (!prof) throw new Error(`未登記的 agentType：${agentType}（容器模式下必須先在 lib/agent-profiles.js 登記）`);
  return prof;
}

function isInternalProfile(profile) {
  return profile.scope === 'internal-audit' || profile.scope === 'internal-fix';
}

function runScope(profile, projectId) {
  if (profile.scope !== 'project') return profile.scope;
  const id = Number(projectId);
  return projectId != null && Number.isInteger(id) && id > 0 ? `project-${id}` : 'none';
}

function scopeKind(scope) {
  if (scope === 'none' || scope === 'internal-audit' || scope === 'internal-fix') return scope;
  if (/^project-[1-9]\d*$/.test(String(scope))) return 'project';
  throw new Error(`無法辨識的 scope：${scope}`);
}

function endpointsFor(scope) {
  return [...SCOPE_ENDPOINTS[scopeKind(scope)]];
}

module.exports = { AGENT_PROFILES, SCOPE_ENDPOINTS, profileFor, runScope, scopeKind, endpointsFor, isInternalProfile };
```

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/agent-profiles.test.js`
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/lib/agent-profiles.js app/server/tests/agent-profiles.test.js
git commit -m "[AgentSandbox]: 容器裡每個 AI 看得到什麼要有唯一一張表，內部 AI 拆成只有健檢查得到平台 DB 的兩級

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 1.2：`agent-run-token.js`——每次執行通行證

**Files:**
- Create: `app/server/lib/agent-run-token.js`
- Test: `app/server/tests/agent-run-token.test.js`

**Interfaces:**
- Consumes：`endpointsFor(scope)`（Task 1.1）
- Produces：
  - `RUN_TOKEN_LABEL = 'aidev:agent-run:v1'`
  - `issueRunToken({ scope, projectId, ttlMs, now? }) → { runId: string(16 hex), token: string, exp: number }`（登記進執行中清單）
  - `verifyRunToken(token, now?) → { ok: true, run: { runId, scope, projectId, endpoints } } | { ok: false, reason: string }`
  - `revokeRun(runId) → void`
  - `activeRunCount() → number`
  - `canRun(scope, actorUserId) → Promise<boolean>`（本期恆 true；子專案 1、2 接上）
  - `_resetRunsForTesting() → void`

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/agent-run-token.test.js
// 意圖：容器進來的 /ai 請求只認這張通行證。它必須：綁住 scope 與專案（改一個字就失效）、
// 執行結束立刻作廢（不是等到期）、平台重啟後全部失效（清單在記憶體）、外洩也賠不到 APP_SECRET。
process.env.APP_SECRET = 'test-secret-run-token';
const t = require('../lib/agent-run-token');

beforeEach(() => t._resetRunsForTesting());

test('簽發後驗得過，並帶出 scope、專案與可用端點', () => {
  const { token, runId } = t.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 60000 });
  const v = t.verifyRunToken(token);
  expect(v.ok).toBe(true);
  expect(v.run).toEqual({ runId, scope: 'project-7', projectId: 7, endpoints: ['db', 'wiki', 'tasks', 'glossary'] });
});

test('執行結束作廢後立刻驗不過（不只看到期時間）', () => {
  const { token, runId } = t.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 3600000 });
  t.revokeRun(runId);
  expect(t.verifyRunToken(token)).toEqual({ ok: false, reason: expect.stringMatching(/作廢|不在執行中/) });
});

test('過期驗不過', () => {
  const now = 1_000_000;
  const { token } = t.issueRunToken({ scope: 'none', projectId: null, ttlMs: 1000, now });
  expect(t.verifyRunToken(token, now + 500).ok).toBe(true);
  expect(t.verifyRunToken(token, now + 1001).ok).toBe(false);
});

// 竄改 scope／專案是最直接的越權手法：把 project-7 改成 project-8 或 internal-audit
test.each([
  [(parts) => { parts[2] = 'project-8'; parts[3] = '8'; }],
  [(parts) => { parts[2] = 'internal-audit'; parts[3] = '0'; }],
  [(parts) => { parts[4] = String(Number(parts[4]) + 999999); }],
])('竄改任何欄位都驗不過', (mutate) => {
  const { token } = t.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 60000 });
  const parts = token.split('.');
  mutate(parts);
  expect(t.verifyRunToken(parts.join('.')).ok).toBe(false);
});

test('平台重啟（清單清空）後舊通行證全部失效', () => {
  const { token } = t.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 60000 });
  t._resetRunsForTesting();
  expect(t.verifyRunToken(token).ok).toBe(false);
});

test('舊的全域通行碼不是合法的每次執行通行證', () => {
  const { aiToken } = require('../lib/ai-token');
  expect(t.verifyRunToken(aiToken()).ok).toBe(false);
  expect(t.verifyRunToken('').ok).toBe(false);
  expect(t.verifyRunToken(undefined).ok).toBe(false);
});

test('通行證不含 APP_SECRET，且與全域通行碼用不同金鑰', () => {
  const { token } = t.issueRunToken({ scope: 'none', projectId: null, ttlMs: 60000 });
  expect(token).not.toContain(process.env.APP_SECRET);
  expect(t.RUN_TOKEN_LABEL).not.toBe('aidev:ai-endpoints:v1');
});

test('APP_SECRET 未設定時拒絕簽發（fail closed）', () => {
  const saved = process.env.APP_SECRET;
  delete process.env.APP_SECRET;
  try { expect(() => t.issueRunToken({ scope: 'none', projectId: null, ttlMs: 1000 })).toThrow(/APP_SECRET/); }
  finally { process.env.APP_SECRET = saved; }
});

test('project scope 的 projectId 必須與 scope 一致，否則拒絕簽發', () => {
  expect(() => t.issueRunToken({ scope: 'project-7', projectId: 8, ttlMs: 1000 })).toThrow();
  expect(() => t.issueRunToken({ scope: 'internal-fix', projectId: 3, ttlMs: 1000 })).toThrow();
});

test('canRun 本期恆為 true（檢查點先留著）', async () => {
  await expect(t.canRun('project-1', 5)).resolves.toBe(true);
});

test('activeRunCount 反映簽發與作廢', () => {
  const a = t.issueRunToken({ scope: 'none', projectId: null, ttlMs: 1000 });
  t.issueRunToken({ scope: 'none', projectId: null, ttlMs: 1000 });
  expect(t.activeRunCount()).toBe(2);
  t.revokeRun(a.runId);
  expect(t.activeRunCount()).toBe(1);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/agent-run-token.test.js`
Expected：FAIL，`Cannot find module '../lib/agent-run-token'`

- [ ] **Step 3：實作**

```js
// app/server/lib/agent-run-token.js
/**
 * agent-run-token.js — 容器內 AI 打 /ai 用的「每次執行通行證」（子專案 0 §4.4）
 *
 * 格式：v1.<runId>.<scope>.<projectId|0>.<exp>.<hmac>
 * 金鑰：HMAC(APP_SECRET, RUN_TOKEN_LABEL)——比照 ai-token.js 不直接拿 APP_SECRET 簽，外洩賠不到它。
 * 執行中清單在記憶體：執行結束立刻作廢；平台重啟＝全部失效（容器也會在啟動時被清掉，見 agent-orphans）。
 */
const crypto = require('crypto');
const { endpointsFor, scopeKind } = require('./agent-profiles');

const RUN_TOKEN_LABEL = 'aidev:agent-run:v1';
const _runs = new Map(); // runId → { scope, projectId, exp }

function runKey() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error('APP_SECRET 未設定，無法簽發 AI 執行通行證');
  return crypto.createHmac('sha256', secret).update(RUN_TOKEN_LABEL).digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', runKey()).update(payload).digest('hex');
}

function checkScopeProject(scope, projectId) {
  const kind = scopeKind(scope);
  if (kind === 'project') {
    if (Number(projectId) !== Number(scope.slice('project-'.length))) throw new Error(`scope ${scope} 與 projectId ${projectId} 不一致`);
  } else if (projectId != null) {
    throw new Error(`scope ${scope} 不可帶 projectId`);
  }
}

function issueRunToken({ scope, projectId, ttlMs, now = Date.now() }) {
  checkScopeProject(scope, projectId);
  const runId = crypto.randomBytes(8).toString('hex');
  const exp = now + ttlMs;
  const payload = `v1.${runId}.${scope}.${projectId == null ? 0 : Number(projectId)}.${exp}`;
  const token = `${payload}.${sign(payload)}`;
  _runs.set(runId, { scope, projectId: projectId == null ? null : Number(projectId), exp });
  return { runId, token, exp };
}

function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verifyRunToken(token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 6 || parts[0] !== 'v1') return { ok: false, reason: '通行證格式不正確' };
  const [, runId, scope, pid, expStr, mac] = parts;
  let expected;
  try { expected = sign(parts.slice(0, 5).join('.')); } catch (e) { return { ok: false, reason: e.message }; }
  if (!timingSafeEqualHex(mac, expected)) return { ok: false, reason: '通行證簽章不符' };
  const run = _runs.get(runId);
  if (!run) return { ok: false, reason: '通行證已作廢或不在執行中（執行結束／平台重啟）' };
  const projectId = Number(pid) === 0 ? null : Number(pid);
  if (run.scope !== scope || run.projectId !== projectId || String(run.exp) !== expStr) {
    return { ok: false, reason: '通行證內容與執行中紀錄不符' };
  }
  if (now > run.exp) return { ok: false, reason: '通行證已過期' };
  return { ok: true, run: { runId, scope, projectId, endpoints: endpointsFor(scope) } };
}

function revokeRun(runId) { _runs.delete(runId); }
function activeRunCount() { return _runs.size; }

// 檢查點（§4.4）：子專案 1 接「發起者所屬公司啟用中且在期間內」，子專案 2 接「公司已設 key、未超花費上限」
async function canRun(_scope, _actorUserId) { return true; }

function _resetRunsForTesting() { _runs.clear(); }

module.exports = { RUN_TOKEN_LABEL, issueRunToken, verifyRunToken, revokeRun, activeRunCount, canRun, _resetRunsForTesting };
```

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/agent-run-token.test.js server/tests/agent-profiles.test.js`
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/lib/agent-run-token.js app/server/tests/agent-run-token.test.js
git commit -m "[AgentSandbox]: 全平台一組的 /ai 通行碼擋不住跨專案查詢，改成每次執行一張、綁 scope 與專案、結束即作廢的通行證

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 1.3：開關與資源上限（`teams_settings` 欄位、同步快取、管理員端點）

**Files:**
- Modify: `app/server/db.js`（ALTER 清單，接在 `{ table: 'teams_settings', col: 'nightly_fix_last_day', ... }`（09-15 為第 1098 行）之後）
- Create: `app/server/lib/agent-sandbox-flag.js`
- Modify: `app/server/admin-routes.js`（`registerRoutes` 內、`const auth = [verifyToken, requireAdmin];`（第 44 行）之後）
- Test: `app/server/tests/agent-sandbox-flag.test.js`

**Interfaces:**
- Consumes：`isInternalProfile(profile)`（Task 1.1）
- Produces：
  - `MODES: Set<'off'|'internal'|'projects'|'all'>`
  - `normalizeMode(v) → mode`（未知值→`'all'`）
  - `parseProjectIds(text: string|null) → Set<number>`
  - `loadAgentSandboxFlag() → Promise<void>`（讀失敗 → mode 設 `'all'`）
  - `getSandboxMode() → mode`
  - `sandboxAppliesTo(profile, projectId: number|null) → boolean`
  - `getSandboxLimits() → { memory: string|null, cpus: string|null, pids: number|null }`
  - `getGatewayLimits() → { memory: string|null, cpus: string|null, pids: number|null }`
  - `validateFlagInput(body) → { mode, projectIds: number[], memory, cpus, pids, gwMemory, gwCpus, gwPids }`（不合法丟 `Error` 帶 `statusCode: 400`）
  - `_setFlagStateForTesting(partialState) → void`
  - HTTP：`GET /api/admin/agent-sandbox` → `{ mode, project_ids: number[], limits, gateway_limits, changed_at }`；`PUT /api/admin/agent-sandbox`（body 同上欄位名：`mode, project_ids, memory, cpus, pids, gateway_memory, gateway_cpus, gateway_pids`）

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/agent-sandbox-flag.test.js
// 意圖：開關決定 AI 在不在容器裡跑。三件事不能錯：
//  1. 認不得的值要落到最嚴格（全開），不能默默變成「關」而繞過隔離（rules/pipeline 59）
//  2. internal 只影響健檢／夜間改善，客戶 agent 照舊；projects 只影響清單內的測試專案
//  3. 只有平台管理員能改；改完不必重啟就生效（rules/infra 122）
process.env.JWT_SECRET = 'test-agent-sandbox-flag';
const { newDb } = require('pg-mem');
const request = require('supertest');
const f = require('../lib/agent-sandbox-flag');
const { profileFor } = require('../lib/agent-profiles');

describe('純邏輯', () => {
  test('未知 mode → all（最嚴格），合法值原樣', () => {
    expect(f.normalizeMode('of')).toBe('all');
    expect(f.normalizeMode(null)).toBe('all');
    expect(f.normalizeMode('internal')).toBe('internal');
  });
  test('parseProjectIds 只收正整數', () => {
    expect([...f.parseProjectIds('3, 12,x,-1,0')]).toEqual([3, 12]);
    expect(f.parseProjectIds(null).size).toBe(0);
  });
  test('off：誰都不進容器', () => {
    f._setFlagStateForTesting({ mode: 'off', projectIds: new Set([1]) });
    expect(f.sandboxAppliesTo(profileFor('workflow_health'), null)).toBe(false);
    expect(f.sandboxAppliesTo(profileFor('coding'), 1)).toBe(false);
  });
  test('internal：只有內部 agent 進容器', () => {
    f._setFlagStateForTesting({ mode: 'internal', projectIds: new Set([1]) });
    expect(f.sandboxAppliesTo(profileFor('platform_fix'), null)).toBe(true);
    expect(f.sandboxAppliesTo(profileFor('coding'), 1)).toBe(false);
    expect(f.sandboxAppliesTo(profileFor('deploy_fix'), 1)).toBe(false);
  });
  // 用「清單內 1、清單外 2」兩個專案，才分得出「看清單」與「全開」
  test('projects：內部＋清單內專案進容器，清單外照舊', () => {
    f._setFlagStateForTesting({ mode: 'projects', projectIds: new Set([1]) });
    expect(f.sandboxAppliesTo(profileFor('workflow_health'), null)).toBe(true);
    expect(f.sandboxAppliesTo(profileFor('coding'), 1)).toBe(true);
    expect(f.sandboxAppliesTo(profileFor('coding'), 2)).toBe(false);
    expect(f.sandboxAppliesTo(profileFor('chat-title'), null)).toBe(false);
  });
  test('all：全部進容器', () => {
    f._setFlagStateForTesting({ mode: 'all', projectIds: new Set() });
    expect(f.sandboxAppliesTo(profileFor('chat-title'), null)).toBe(true);
  });
  test('validateFlagInput 擋格式錯的上限與 mode', () => {
    expect(() => f.validateFlagInput({ mode: 'maybe' })).toThrow();
    expect(() => f.validateFlagInput({ mode: 'off', memory: '4 GB' })).toThrow();
    expect(() => f.validateFlagInput({ mode: 'off', cpus: 'two' })).toThrow();
    expect(() => f.validateFlagInput({ mode: 'off', pids: 10 })).toThrow();
    expect(() => f.validateFlagInput({ mode: 'projects', project_ids: ['a'] })).toThrow();
    expect(f.validateFlagInput({ mode: 'projects', project_ids: [3], memory: '4g', cpus: '2', pids: 512 }))
      .toMatchObject({ mode: 'projects', projectIds: [3], memory: '4g', cpus: '2', pids: 512 });
  });
});

describe('DB 載入與管理員端點', () => {
  let dbModule, app, adminToken, userToken;
  beforeAll(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    dbModule = require('../db');
    dbModule._setPoolForTesting(new Pool());
    await dbModule.migrate();
    const { createApp } = require('../index');
    app = createApp();
    const { hashPassword } = require('../password');
    const pw = await hashPassword('pw');
    await dbModule.query(
      "INSERT INTO users (username, password_hash, display_name, role) VALUES ('sbadm',$1,'A','admin'), ('sbusr',$1,'U','user')", [pw]);
    adminToken = (await request(app).post('/api/auth/login').send({ username: 'sbadm', password: 'pw' })).body.token;
    userToken = (await request(app).post('/api/auth/login').send({ username: 'sbusr', password: 'pw' })).body.token;
  }, 30000);
  afterAll(() => dbModule._setPoolForTesting(null));

  test('新 DB 預設 off（合併進 master 不改變行為）', async () => {
    await f.loadAgentSandboxFlag();
    expect(f.getSandboxMode()).toBe('off');
    expect(f.getSandboxLimits()).toEqual({ memory: null, cpus: null, pids: null });
  });

  test('一般使用者不能改', async () => {
    const res = await request(app).put('/api/admin/agent-sandbox')
      .set('Authorization', `Bearer ${userToken}`).send({ mode: 'all' });
    expect(res.status).toBe(403);
  });

  test('管理員改完立即生效、記下改動時間', async () => {
    const res = await request(app).put('/api/admin/agent-sandbox').set('Authorization', `Bearer ${adminToken}`)
      .send({ mode: 'projects', project_ids: [9], memory: '4g', cpus: '2', pids: 512, gateway_memory: '256m', gateway_cpus: '0.5', gateway_pids: 128 });
    expect(res.status).toBe(200);
    expect(f.getSandboxMode()).toBe('projects');
    expect(f.sandboxAppliesTo(profileFor('qa'), 9)).toBe(true);
    expect(f.getSandboxLimits()).toEqual({ memory: '4g', cpus: '2', pids: 512 });
    expect(f.getGatewayLimits()).toEqual({ memory: '256m', cpus: '0.5', pids: 128 });
    const g = await request(app).get('/api/admin/agent-sandbox').set('Authorization', `Bearer ${adminToken}`);
    expect(g.body).toMatchObject({ mode: 'projects', project_ids: [9] });
    expect(g.body.changed_at).toBeTruthy();
  });

  test('DB 裡被寫進怪值 → 載入後是 all', async () => {
    await dbModule.query("UPDATE teams_settings SET agent_sandbox_mode='typo' WHERE id=1");
    await f.loadAgentSandboxFlag();
    expect(f.getSandboxMode()).toBe('all');
    await dbModule.query("UPDATE teams_settings SET agent_sandbox_mode='off' WHERE id=1");
    await f.loadAgentSandboxFlag();
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/agent-sandbox-flag.test.js`
Expected：FAIL，`Cannot find module '../lib/agent-sandbox-flag'`

- [ ] **Step 3：db.js 加欄位**（接在 `nightly_fix_last_day` 那列之後；新欄位允許 NULL，mode 預設 `'off'`；rules/db-schema 40、42）

```js
    // 子專案 0：AI 容器隔離的開關與資源上限。mode 預設 off——合併進 master 不改變任何行為。
    // 上限三個（agent 與閘道各一組）沒設就不准跑容器（總覽 D6），值由量測後管理員寫入，不在這裡猜。
    { table: 'teams_settings', col: 'agent_sandbox_mode', sql: "ALTER TABLE teams_settings ADD COLUMN agent_sandbox_mode TEXT DEFAULT 'off'" },
    { table: 'teams_settings', col: 'agent_sandbox_project_ids', sql: 'ALTER TABLE teams_settings ADD COLUMN agent_sandbox_project_ids TEXT' },
    { table: 'teams_settings', col: 'agent_sandbox_memory', sql: 'ALTER TABLE teams_settings ADD COLUMN agent_sandbox_memory TEXT' },
    { table: 'teams_settings', col: 'agent_sandbox_cpus', sql: 'ALTER TABLE teams_settings ADD COLUMN agent_sandbox_cpus TEXT' },
    { table: 'teams_settings', col: 'agent_sandbox_pids', sql: 'ALTER TABLE teams_settings ADD COLUMN agent_sandbox_pids INTEGER' },
    { table: 'teams_settings', col: 'agent_gateway_memory', sql: 'ALTER TABLE teams_settings ADD COLUMN agent_gateway_memory TEXT' },
    { table: 'teams_settings', col: 'agent_gateway_cpus', sql: 'ALTER TABLE teams_settings ADD COLUMN agent_gateway_cpus TEXT' },
    { table: 'teams_settings', col: 'agent_gateway_pids', sql: 'ALTER TABLE teams_settings ADD COLUMN agent_gateway_pids INTEGER' },
    { table: 'teams_settings', col: 'agent_sandbox_changed_at', sql: 'ALTER TABLE teams_settings ADD COLUMN agent_sandbox_changed_at TIMESTAMPTZ' },
```

- [ ] **Step 4：實作 `agent-sandbox-flag.js`**

```js
// app/server/lib/agent-sandbox-flag.js
/**
 * agent-sandbox-flag.js — AI 容器隔離的開關（teams_settings.agent_sandbox_*）
 *
 * 讀取端同步（runClaude 在 off 時必須同步 spawn，rules/testing 26）；非同步只發生在啟動載入與管理員存檔，
 * 比照 lib/claude-auth.js。模組預設 off 只為了測試不經載入時維持舊行為；正式啟動一定會 load。
 * 讀 DB 失敗 → all（最嚴格）：寧可 AI 全部因容器不可用而停下，也不要靜默跑回沒有隔離的路徑。
 */
const { query } = require('../db');
const { isInternalProfile } = require('./agent-profiles');

const MODES = new Set(['off', 'internal', 'projects', 'all']);
const EMPTY_LIMITS = Object.freeze({ memory: null, cpus: null, pids: null });

let _state = { mode: 'off', projectIds: new Set(), limits: EMPTY_LIMITS, gatewayLimits: EMPTY_LIMITS, changedAt: null };

function normalizeMode(v) { return MODES.has(v) ? v : 'all'; }

function parseProjectIds(text) {
  const out = new Set();
  for (const s of String(text || '').split(',')) {
    const t = s.trim();
    if (/^[1-9]\d*$/.test(t)) out.add(Number(t));
  }
  return out;
}

async function loadAgentSandboxFlag() {
  try {
    const { rows: [r] } = await query(
      `SELECT agent_sandbox_mode, agent_sandbox_project_ids, agent_sandbox_memory, agent_sandbox_cpus, agent_sandbox_pids,
              agent_gateway_memory, agent_gateway_cpus, agent_gateway_pids, agent_sandbox_changed_at
         FROM teams_settings WHERE id = 1`);
    _state = {
      mode: normalizeMode(r ? (r.agent_sandbox_mode ?? 'off') : 'off'),
      projectIds: parseProjectIds(r && r.agent_sandbox_project_ids),
      limits: { memory: (r && r.agent_sandbox_memory) ?? null, cpus: (r && r.agent_sandbox_cpus) ?? null, pids: (r && r.agent_sandbox_pids) ?? null },
      gatewayLimits: { memory: (r && r.agent_gateway_memory) ?? null, cpus: (r && r.agent_gateway_cpus) ?? null, pids: (r && r.agent_gateway_pids) ?? null },
      changedAt: (r && r.agent_sandbox_changed_at) ?? null,
    };
  } catch (err) {
    console.error('[AGENT-SANDBOX] 讀取開關失敗，改為最嚴格（all）：', err.message);
    _state = { ..._state, mode: 'all' };
  }
}

function getSandboxMode() { return _state.mode; }
function getSandboxLimits() { return { ..._state.limits }; }
function getGatewayLimits() { return { ..._state.gatewayLimits }; }
function getFlagState() { return { mode: _state.mode, projectIds: [..._state.projectIds], limits: getSandboxLimits(), gatewayLimits: getGatewayLimits(), changedAt: _state.changedAt }; }

function sandboxAppliesTo(profile, projectId) {
  const m = _state.mode;
  if (m === 'off') return false;
  if (m === 'all') return true;
  if (isInternalProfile(profile)) return true;
  if (m === 'projects') return projectId != null && _state.projectIds.has(Number(projectId));
  return false;
}

function bad(msg) { return Object.assign(new Error(msg), { statusCode: 400 }); }

function validateFlagInput(body = {}) {
  if (!MODES.has(body.mode)) throw bad(`mode 必須是 ${[...MODES].join(' / ')}`);
  const ids = body.project_ids == null ? [] : body.project_ids;
  if (!Array.isArray(ids) || ids.some(x => !Number.isInteger(x) || x <= 0)) throw bad('project_ids 必須是正整數陣列');
  const mem = v => { if (v == null || v === '') return null; if (!/^[1-9]\d*[mg]$/.test(String(v))) throw bad('記憶體上限格式為數字＋m 或 g（例：4g）'); return String(v); };
  const cpu = v => { if (v == null || v === '') return null; if (!/^\d+(\.\d+)?$/.test(String(v)) || Number(v) <= 0) throw bad('cpus 必須是正數'); return String(v); };
  const pid = v => { if (v == null || v === '') return null; if (!Number.isInteger(v) || v < 32 || v > 65536) throw bad('pids 必須是 32–65536 的整數'); return v; };
  return {
    mode: body.mode, projectIds: ids,
    memory: mem(body.memory), cpus: cpu(body.cpus), pids: pid(body.pids),
    gwMemory: mem(body.gateway_memory), gwCpus: cpu(body.gateway_cpus), gwPids: pid(body.gateway_pids),
  };
}

function _setFlagStateForTesting(partial) {
  _state = { mode: 'off', projectIds: new Set(), limits: EMPTY_LIMITS, gatewayLimits: EMPTY_LIMITS, changedAt: null, ...partial };
}

module.exports = {
  MODES, normalizeMode, parseProjectIds, loadAgentSandboxFlag, getSandboxMode, getSandboxLimits, getGatewayLimits,
  getFlagState, sandboxAppliesTo, validateFlagInput, _setFlagStateForTesting,
};
```

- [ ] **Step 5：admin-routes.js 加端點**（`const auth = [verifyToken, requireAdmin];` 之後；只寫自己的欄位，不經 `teams-routes.js` 的 `$1..$20` upsert，rules/db-schema 45）

```js
  // 子專案 0：AI 容器隔離開關與資源上限。只有平台管理員能看能改；存完立即重載快取，不必重啟。
  app.get('/api/admin/agent-sandbox', ...auth, (_req, res) => {
    const s = require('./lib/agent-sandbox-flag').getFlagState();
    res.json({ mode: s.mode, project_ids: s.projectIds, limits: s.limits, gateway_limits: s.gatewayLimits, changed_at: s.changedAt });
  });

  app.put('/api/admin/agent-sandbox', ...auth, async (req, res) => {
    const flag = require('./lib/agent-sandbox-flag');
    let v;
    try { v = flag.validateFlagInput(req.body || {}); }
    catch (err) { return res.status(err.statusCode || 400).json({ error: err.message }); }
    try {
      await query(
        `INSERT INTO teams_settings (id, agent_sandbox_mode, agent_sandbox_project_ids, agent_sandbox_memory, agent_sandbox_cpus,
                                     agent_sandbox_pids, agent_gateway_memory, agent_gateway_cpus, agent_gateway_pids, agent_sandbox_changed_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (id) DO UPDATE SET agent_sandbox_mode=$1, agent_sandbox_project_ids=$2, agent_sandbox_memory=$3,
           agent_sandbox_cpus=$4, agent_sandbox_pids=$5, agent_gateway_memory=$6, agent_gateway_cpus=$7,
           agent_gateway_pids=$8, agent_sandbox_changed_at=NOW()`,
        [v.mode, v.projectIds.join(','), v.memory, v.cpus, v.pids, v.gwMemory, v.gwCpus, v.gwPids]);
      await flag.loadAgentSandboxFlag();
      console.log(`[AGENT-SANDBOX] 管理員 ${req.userId} 設定 mode=${v.mode} projects=[${v.projectIds.join(',')}]`);
      const s = flag.getFlagState();
      res.json({ mode: s.mode, project_ids: s.projectIds, limits: s.limits, gateway_limits: s.gatewayLimits, changed_at: s.changedAt });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
```
（`query` 在 admin-routes.js 頂端已 require；若 Step 6 報 `query is not defined`，照檔頭既有寫法補 `const { query } = require('./db');`。）

- [ ] **Step 6：跑測試確認通過**

Run: `cd app && npx jest server/tests/agent-sandbox-flag.test.js`
Expected：PASS

- [ ] **Step 7：全跑一次**（db.js 動了，所有 migrate 的測試都會吃到）

Run: `cd app && npm run test:quiet > /tmp/claude-t13.txt 2>&1; echo "EXITCODE=$?" >> /tmp/claude-t13.txt; grep -E "^Tests:|^Test Suites:|EXITCODE" /tmp/claude-t13.txt`
Expected：與 Task 0 基線相比多出本 Task 的測試數、沒有新紅燈

- [ ] **Step 8：Commit**

```bash
git add app/server/db.js app/server/lib/agent-sandbox-flag.js app/server/admin-routes.js app/server/tests/agent-sandbox-flag.test.js
git commit -m "[AgentSandbox]: 容器隔離要能先只開給內部 AI 與測試專案，且認不得的設定值必須落到全開而不是關

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 1.4：`buildAgentRunArgs`——容器參數純函式

**Files:**
- Create: `app/server/lib/agent-sandbox.js`
- Test: `app/server/tests/agent-sandbox.test.js`（比照 `docker-env.test.js` 的純函式測法，規格 §8.1）

**Interfaces:**
- Consumes：無（純函式）
- Produces：
  - `ENV_WHITELIST: string[]`、`SECRET_ENV_KEYS: string[]`、`FORBIDDEN_ENV: string[]`
  - `buildAgentRunArgs(run) → { argv: string[], childEnv: object, containerName: string }`
    - `run = { instanceId, runId, scope, image, network, user: 'uid:gid', mounts: [{ source, target?, readonly: boolean }], workdir, home, env: object, limits: { memory, cpus, pids }, command: string[] }`
    - `argv` 交給 `spawn('docker', argv, { env: childEnv })`；祕密值只在 `childEnv`，**不出現在 argv**（argv 在 `/proc/<pid>/cmdline` 同 uid 可讀）
  - `gitDirMounts(repoPath, mode: 'rw'|'ro') → mount[]`（rw 時 `.git/config`、`.git/hooks` 疊一層 ro）

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/agent-sandbox.test.js
// 意圖：隔離的正確性全在「docker run 帶了什麼參數」。這裡鎖死規格 §8.1 的每一條：
// 就算平台行程的 env 裡有，容器也拿不到三把總鑰匙；.git/config 與 hooks 一定唯讀（否則平台在主機跑 git
// 時會執行容器寫進去的指令＝逃出容器）；網路、--rm、cap-drop、no-new-privileges、三個資源上限一個都不能少。
const s = require('../lib/agent-sandbox');

function baseRun(over = {}) {
  return {
    instanceId: 'odoo-v2', runId: 'abcd1234abcd1234', scope: 'project-7', image: 'aidev-agent:2.1.266',
    network: 'odoo-v2-agent-net', user: '1004:1004',
    mounts: [{ source: '/srv/repos/p7/.worktrees/t1', readonly: false }],
    workdir: '/srv/repos/p7/.worktrees/t1', home: '/srv/app/data/agent-home/project-7',
    env: { AIDEV_AI_BASE: 'http://odoo-v2-gw:8080', AIDEV_AI_TOKEN: 'tok-secret-value', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-value' },
    limits: { memory: '4g', cpus: '2', pids: 512 },
    command: ['claude', '-p', '--output-format', 'stream-json'],
    ...over,
  };
}
const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];

describe('env 白名單', () => {
  const saved = {};
  beforeAll(() => { for (const k of ['APP_SECRET', 'JWT_SECRET', 'DATABASE_URL']) { saved[k] = process.env[k]; process.env[k] = `leak-${k}`; } });
  afterAll(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('平台 env 裡有三把總鑰匙，argv 與 childEnv 都沒有', () => {
    const { argv, childEnv } = s.buildAgentRunArgs(baseRun());
    const all = JSON.stringify([argv, childEnv]);
    for (const k of ['APP_SECRET', 'JWT_SECRET', 'DATABASE_URL']) {
      expect(all).not.toContain(k);
      expect(all).not.toContain(`leak-${k}`);
    }
  });
  test('呼叫端硬塞總鑰匙 → 丟例外', () => {
    expect(() => s.buildAgentRunArgs(baseRun({ env: { APP_SECRET: 'x' } }))).toThrow(/APP_SECRET/);
  });
  // 寫錯 key（或把整包 gitEnv 帶進來，裡面有 GIT_PAT）不能靜默丟掉，否則會以為有傳、實際沒傳
  test('白名單外的 key → 丟例外，訊息點名那個 key', () => {
    expect(() => s.buildAgentRunArgs(baseRun({ env: { GIT_PAT: 'ghp_x' } }))).toThrow(/GIT_PAT/);
    expect(() => s.buildAgentRunArgs(baseRun({ env: { HOME: '/root' } }))).toThrow(/HOME/);
  });
  test('祕密值不進 argv（只以 -e KEY 傳名字），值在 childEnv', () => {
    const { argv, childEnv } = s.buildAgentRunArgs(baseRun());
    expect(argv.join(' ')).not.toContain('tok-secret-value');
    expect(argv.join(' ')).not.toContain('oauth-secret-value');
    expect(argv).toContain('AIDEV_AI_TOKEN');
    expect(childEnv.AIDEV_AI_TOKEN).toBe('tok-secret-value');
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-secret-value');
  });
  test('非祕密值以 KEY=VALUE 傳；HOME 固定指向 scope 家目錄', () => {
    const { argv } = s.buildAgentRunArgs(baseRun());
    expect(argv).toContain('AIDEV_AI_BASE=http://odoo-v2-gw:8080');
    expect(argv).toContain('HOME=/srv/app/data/agent-home/project-7');
  });
  test('childEnv 只有 docker CLI 需要的 PATH 與祕密值', () => {
    const { childEnv } = s.buildAgentRunArgs(baseRun());
    expect(Object.keys(childEnv).sort()).toEqual(['AIDEV_AI_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'PATH'].sort());
  });
});

describe('容器參數', () => {
  test('--rm、-i、網路、cap-drop、no-new-privileges、read-only、tmpfs、user', () => {
    const { argv } = s.buildAgentRunArgs(baseRun());
    expect(argv.slice(0, 3)).toEqual(['run', '-i', '--rm']);
    expect(flagValue(argv, '--network')).toBe('odoo-v2-agent-net');
    expect(flagValue(argv, '--cap-drop')).toBe('ALL');
    expect(flagValue(argv, '--security-opt')).toBe('no-new-privileges');
    expect(argv).toContain('--read-only');
    expect(flagValue(argv, '--tmpfs')).toBe('/tmp');
    expect(flagValue(argv, '--user')).toBe('1004:1004');
    expect(flagValue(argv, '--workdir')).toBe('/srv/repos/p7/.worktrees/t1');
  });
  test('名稱與 label 帶實例 id（兩套平台不互砍）', () => {
    const { argv, containerName } = s.buildAgentRunArgs(baseRun());
    expect(containerName).toBe('odoo-v2-run-abcd1234abcd1234');
    expect(flagValue(argv, '--name')).toBe(containerName);
    expect(argv).toEqual(expect.arrayContaining(['aidev.run=1', 'aidev.instance=odoo-v2', 'aidev.scope=project-7']));
  });
  test('三個資源上限都帶上；memory-swap 等於 memory（不給 swap 繞過上限）', () => {
    const { argv } = s.buildAgentRunArgs(baseRun());
    expect(flagValue(argv, '--memory')).toBe('4g');
    expect(flagValue(argv, '--memory-swap')).toBe('4g');
    expect(flagValue(argv, '--cpus')).toBe('2');
    expect(flagValue(argv, '--pids-limit')).toBe('512');
  });
  test.each(['memory', 'cpus', 'pids'])('缺 %s → 丟例外（沒有「不設上限」的預設）', (k) => {
    expect(() => s.buildAgentRunArgs(baseRun({ limits: { memory: '4g', cpus: '2', pids: 512, [k]: null } }))).toThrow(/上限/);
  });
  test('image 之後接 command，command 在最後', () => {
    const { argv } = s.buildAgentRunArgs(baseRun());
    const i = argv.indexOf('aidev-agent:2.1.266');
    expect(argv.slice(i + 1)).toEqual(['claude', '-p', '--output-format', 'stream-json']);
  });
  test('實例 id 缺或含非法字元 → 丟例外', () => {
    expect(() => s.buildAgentRunArgs(baseRun({ instanceId: '' }))).toThrow();
    expect(() => s.buildAgentRunArgs(baseRun({ instanceId: 'a b' }))).toThrow();
  });
});

describe('掛載', () => {
  test('用 --mount（來源不存在時 docker 會報錯，不會默默建一個 root 擁有的空目錄）', () => {
    const { argv } = s.buildAgentRunArgs(baseRun());
    expect(argv).toContain('type=bind,source=/srv/repos/p7/.worktrees/t1,target=/srv/repos/p7/.worktrees/t1');
    expect(argv).not.toContain('-v');
  });
  test('gitDirMounts rw：.git 可寫，config 與 hooks 疊唯讀', () => {
    const m = s.gitDirMounts('/srv/repos/p7/main', 'rw');
    expect(m).toEqual([
      { source: '/srv/repos/p7/main/.git', readonly: false },
      { source: '/srv/repos/p7/main/.git/config', readonly: true },
      { source: '/srv/repos/p7/main/.git/hooks', readonly: true },
    ]);
  });
  test('唯讀覆蓋層排在父目錄之後（docker 依序疊，順序錯會被父層蓋掉）', () => {
    const mounts = [...s.gitDirMounts('/srv/r/.', 'rw')].reverse();
    const { argv } = s.buildAgentRunArgs(baseRun({ mounts }));
    const specs = argv.filter(a => a.startsWith('type=bind,'));
    const idxGit = specs.findIndex(x => x.includes('target=/srv/r/.git,') || x.endsWith('target=/srv/r/.git'));
    const idxCfg = specs.findIndex(x => x.includes('target=/srv/r/.git/config'));
    expect(idxGit).toBeLessThan(idxCfg);
    expect(specs[idxCfg]).toMatch(/,readonly$/);
  });
  test('相對路徑或含逗號的路徑 → 丟例外（--mount 以逗號分欄）', () => {
    expect(() => s.buildAgentRunArgs(baseRun({ mounts: [{ source: 'rel/path', readonly: true }] }))).toThrow();
    expect(() => s.buildAgentRunArgs(baseRun({ mounts: [{ source: '/a,b', readonly: true }] }))).toThrow();
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/agent-sandbox.test.js`
Expected：FAIL，`Cannot find module '../lib/agent-sandbox'`

- [ ] **Step 3：實作**

```js
// app/server/lib/agent-sandbox.js
/**
 * agent-sandbox.js — 每次 AI 執行的 docker run 參數（子專案 0 §4.2），純函式。
 *
 * env 走白名單：沒列的 key 一律丟例外；三把總鑰匙另外點名擋。
 * 祕密值只放 childEnv、argv 只寫 `-e KEY`：argv 在 /proc/<pid>/cmdline 同 uid 看得到。
 * 掛載一律 --mount：-v 在來源不存在時會替你建一個 root 擁有的空目錄，錯誤被藏起來。
 */
const path = require('path');

const FORBIDDEN_ENV = ['APP_SECRET', 'JWT_SECRET', 'DATABASE_URL'];
const SECRET_ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'AIDEV_AI_TOKEN', 'E2E_PASSWORD'];
const ENV_WHITELIST = [
  ...SECRET_ENV_KEYS,
  'AIDEV_AI_BASE', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy',
  'CLAUDE_CODE_PROMPT_CACHE_TTL', 'SECURITY_GUIDANCE_DISABLE', 'DISABLE_AUTOUPDATER',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
];
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function assertAbs(p, what) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || /[,\n]/.test(p)) {
    throw new Error(`${what} 必須是不含逗號的絕對路徑：${p}`);
  }
}

function gitDirMounts(repoPath, mode) {
  const gitDir = path.join(repoPath, '.git');
  if (mode !== 'rw') return [{ source: gitDir, readonly: true }];
  return [
    { source: gitDir, readonly: false },
    { source: path.join(gitDir, 'config'), readonly: true },
    { source: path.join(gitDir, 'hooks'), readonly: true },
  ];
}

function buildAgentRunArgs(run) {
  const { instanceId, runId, scope, image, network, user, mounts = [], workdir, home, env = {}, limits = {}, command } = run;
  if (!instanceId || !NAME_RE.test(instanceId)) throw new Error(`實例 id 不合法：${instanceId}`);
  if (!runId || !/^[a-f0-9]+$/.test(runId)) throw new Error(`runId 不合法：${runId}`);
  if (!image || !network || !user || !scope) throw new Error('image／network／user／scope 都必須提供');
  if (!Array.isArray(command) || !command.length) throw new Error('command 必須是非空陣列');
  if (limits.memory == null || limits.cpus == null || limits.pids == null) {
    throw new Error('容器資源上限未設定（memory／cpus／pids 三個都要設，見 PUT /api/admin/agent-sandbox）');
  }
  assertAbs(workdir, 'workdir');
  assertAbs(home, 'home');

  const containerName = `${instanceId}-run-${runId}`;
  const argv = [
    'run', '-i', '--rm',
    '--name', containerName,
    '--label', 'aidev.run=1', '--label', `aidev.instance=${instanceId}`, '--label', `aidev.scope=${scope}`,
    '--network', network,
    '--user', user,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp',
    '--memory', String(limits.memory), '--memory-swap', String(limits.memory),
    '--cpus', String(limits.cpus), '--pids-limit', String(limits.pids),
  ];

  const all = [{ source: home, readonly: false }, ...mounts];
  const normalized = all.map(m => {
    assertAbs(m.source, '掛載來源');
    const target = m.target || m.source;
    assertAbs(target, '掛載目標');
    return { source: m.source, target, readonly: !!m.readonly };
  });
  // 父目錄先掛、子路徑後掛：唯讀覆蓋層才不會被父層蓋掉
  normalized.sort((a, b) => a.target.split('/').length - b.target.split('/').length);
  for (const m of normalized) {
    argv.push('--mount', `type=bind,source=${m.source},target=${m.target}${m.readonly ? ',readonly' : ''}`);
  }

  const childEnv = { PATH: process.env.PATH };
  argv.push('-e', `HOME=${home}`, '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8');
  for (const [k, v] of Object.entries(env)) {
    if (FORBIDDEN_ENV.includes(k)) throw new Error(`禁止把 ${k} 放進 AI 容器`);
    if (!ENV_WHITELIST.includes(k)) throw new Error(`env key 不在容器白名單：${k}（見 lib/agent-sandbox.js ENV_WHITELIST）`);
    if (v == null) continue;
    if (SECRET_ENV_KEYS.includes(k)) { argv.push('-e', k); childEnv[k] = String(v); }
    else argv.push('-e', `${k}=${v}`);
  }

  argv.push('--workdir', workdir, image, ...command);
  return { argv, childEnv, containerName };
}

module.exports = { ENV_WHITELIST, SECRET_ENV_KEYS, FORBIDDEN_ENV, buildAgentRunArgs, gitDirMounts };
```

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/agent-sandbox.test.js`
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/lib/agent-sandbox.js app/server/tests/agent-sandbox.test.js
git commit -m "[AgentSandbox]: AI 子行程整包繼承平台 env、echo 一下就拿到總鑰匙，容器參數改成 env 白名單＋.git 設定唯讀＋資源上限必填

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 1.5：`resolveSandboxMounts`——依 profile 解出掛載清單

**Files:**
- Create: `app/server/lib/agent-mounts.js`
- Test: `app/server/tests/agent-mounts.test.js`

**Interfaces:**
- Consumes：`gitDirMounts(repoPath, mode)`（Task 1.4）；`getProjectInfo(projectId)`、`worktreeParent(root, taskId)`（既有 `pipeline/task-agent.js:62-76`）；`majorOf(v)`（既有 `lib/odoo-core-src.js`）；`uploadRoot()`（既有 `lib/attachments.js:6`）
- Produces：
  - `resolveSandboxMounts(ctx, deps?) → Promise<{ mounts: mount[], workdir: string }>`
    - `ctx = { profile, projectId: number|null, taskDbId: number|null, cwd: string|undefined, chatId: number|null, feedbackIds: number[], home: string, platformWorktree: string|null, appDir: string }`
    - `deps`（皆可注入）：`query, getProjectInfo, worktreeParent, majorOf, existsSync, readdirSync, statSync, coreSrcRoot, uploadRoot, envBase, logDir, fixWorktreeRoot`
  - `platformPaths(appDir) → { skills, hooks, mcp, gitDir, nodeModules, fixWorktreeRoot }`
  - `MAX_LOG_FILES = 50`
- **不變量（測試鎖死）**：永遠不掛 `appDir` 本體、`appDir/data`（有 `config.json` 與 `ai.sock`）、別專案的路徑。

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/agent-mounts.test.js
// 意圖：掛載清單就是 AI 在容器裡看得到的整個世界。這裡用真的暫存目錄樹驗：
//  - 客戶 agent 只看得到自己的專案（別專案 repo、平台 repo 本體、data/config.json 一律不在清單）
//  - 任務 worktree 可寫，但主 clone 的 .git/config 與 hooks 唯讀（總覽 D5）
//  - 內部 AI 只掛乾淨 worktree，絕不掛正在運作的平台資料夾（總覽 D7）
//  - agent 合法要讀的附件與 log 有掛、而且只掛本任務／本專案的（X7）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveSandboxMounts } = require('../lib/agent-mounts');
const { profileFor } = require('../lib/agent-profiles');

let R, deps, appDir;
const mk = (...p) => { const d = path.join(R, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const touch = (...p) => { const f = path.join(R, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };

beforeAll(() => {
  R = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mounts-'));
  appDir = mk('app-root');
  mk('app-root', '.agents', 'skills'); mk('app-root', 'app', 'server', 'pipeline', 'hooks'); mk('app-root', 'app', 'server', 'pipeline', 'mcp');
  touch('app-root', 'data', 'config.json'); mk('app-root', '.git', 'hooks'); touch('app-root', '.git', 'config');
  mk('app-root', 'app', 'node_modules');
  mk('repos', 'p7', 'main', '.git', 'hooks'); touch('repos', 'p7', 'main', '.git', 'config');
  mk('repos', 'p7', '.worktrees', 'task_7', 'main');
  mk('repos', 'p8', 'main', '.git');
  mk('core', '17');
  mk('uploads', 'task_70'); mk('uploads', 'task_71'); mk('uploads', 'chat_5'); mk('uploads', 'feedback_3');
  touch('logs', 'deploy-task70-1.log'); touch('logs', 'e2e-task70-1712.log'); touch('logs', 'deploy-task99-1.log');
  touch('envs', 'odoo17_p7', 'odoo.log'); touch('envs', 'odoo17_p7', 'odoo.conf');
  mk('app-root', '.claude', 'worktrees', 'fix-12'); mk('app-root', '.git', 'worktrees', 'fix-12');
  mk('app-root', '.claude', 'worktrees', 'ro-abc');

  deps = {
    query: async (sql, params) => {
      if (/FROM tasks WHERE id/.test(sql)) return { rows: params[0] === 70 ? [{ task_id: 'task_7', project_id: 7 }] : [] };
      if (/FROM tasks WHERE project_id/.test(sql)) return { rows: params[0] === 7 ? [{ id: 70 }, { id: 71 }] : [] };
      throw new Error(`unexpected sql ${sql}`);
    },
    getProjectInfo: async (id) => id === 7 ? {
      name: 'P7', folder_name: 'odoo17_p7', odoo_version: '17.0', enterprise_src: null,
      root: path.join(R, 'repos', 'p7'),
      repos: [{ label: 'main', local_path: path.join(R, 'repos', 'p7', 'main'), subdir: 'main' }],
    } : null,
    worktreeParent: (root, taskId) => path.join(root, '.worktrees', taskId),
    majorOf: v => String(parseInt(v, 10)),
    coreSrcRoot: path.join(R, 'core'),
    uploadRoot: path.join(R, 'uploads'),
    envBase: path.join(R, 'envs'),
    logDir: path.join(R, 'logs'),
    fixWorktreeRoot: path.join(appDir, '.claude', 'worktrees'),
  };
});
afterAll(() => fs.rmSync(R, { recursive: true, force: true }));

const base = over => ({ projectId: 7, taskDbId: 70, cwd: undefined, chatId: null, feedbackIds: [], home: path.join(appDir, 'data', 'agent-home', 'project-7'), platformWorktree: null, appDir, ...over });
const sources = m => m.mounts.map(x => x.source);
const find = (m, src) => m.mounts.find(x => x.source === src);

function expectNoPlatformSecrets(m) {
  for (const src of sources(m)) {
    expect(src).not.toBe(appDir);
    expect(src.startsWith(path.join(appDir, 'data'))).toBe(false);
    expect(src.startsWith(path.join(R, 'repos', 'p8'))).toBe(false);
    expect(src).not.toMatch(/odoo\.conf$/);
  }
}

test('task-worktree：worktree 可寫、.git 可寫但 config／hooks 唯讀、核心原始碼與本任務附件唯讀', async () => {
  const wt = path.join(R, 'repos', 'p7', '.worktrees', 'task_7');
  const m = await resolveSandboxMounts(base({ profile: profileFor('coding'), cwd: wt }), deps);
  expect(m.workdir).toBe(wt);
  expect(find(m, wt).readonly).toBe(false);
  expect(find(m, path.join(R, 'repos', 'p7', 'main', '.git')).readonly).toBe(false);
  expect(find(m, path.join(R, 'repos', 'p7', 'main', '.git', 'config')).readonly).toBe(true);
  expect(find(m, path.join(R, 'repos', 'p7', 'main', '.git', 'hooks')).readonly).toBe(true);
  expect(find(m, path.join(R, 'core', '17')).readonly).toBe(true);
  expect(find(m, path.join(R, 'uploads', 'task_70')).readonly).toBe(true);
  expect(sources(m)).not.toContain(path.join(R, 'uploads', 'task_71'));
  expect(find(m, path.join(appDir, '.agents', 'skills')).readonly).toBe(true);
  expectNoPlatformSecrets(m);
});

test('呼叫端給的 cwd 與任務 worktree 不符 → 丟例外（表對不上就停，不猜）', async () => {
  await expect(resolveSandboxMounts(base({ profile: profileFor('qa'), cwd: path.join(R, 'repos', 'p8', 'main') }), deps)).rejects.toThrow(/cwd/);
});

test('worktree 不存在 → 丟例外', async () => {
  await expect(resolveSandboxMounts(base({ profile: profileFor('qa'), taskDbId: 71, cwd: undefined }), {
    ...deps, query: async (sql) => /WHERE id/.test(sql) ? { rows: [{ task_id: 'task_missing', project_id: 7 }] } : { rows: [] },
  })).rejects.toThrow(/worktree/);
});

test('project-clone（chat）：專案根唯讀、只掛本專案任務的 log 與本專案 odoo.log、對話附件', async () => {
  const m = await resolveSandboxMounts(base({ profile: profileFor('chat'), taskDbId: null, chatId: 5 }), deps);
  expect(m.workdir).toBe(path.join(R, 'repos', 'p7'));
  expect(find(m, path.join(R, 'repos', 'p7')).readonly).toBe(true);
  expect(find(m, path.join(R, 'envs', 'odoo17_p7', 'odoo.log')).readonly).toBe(true);
  expect(sources(m)).toContain(path.join(R, 'logs', 'deploy-task70-1.log'));
  expect(sources(m)).toContain(path.join(R, 'logs', 'e2e-task70-1712.log'));
  expect(sources(m)).not.toContain(path.join(R, 'logs', 'deploy-task99-1.log'));
  expect(find(m, path.join(R, 'uploads', 'chat_5')).readonly).toBe(true);
  expect(m.mounts.every(x => x.readonly)).toBe(true);
  expectNoPlatformSecrets(m);
});

test('task-worktree-or-clone（reject_triage）：cwd 是專案根時退成唯讀主 clone', async () => {
  const m = await resolveSandboxMounts(base({ profile: profileFor('reject_triage'), cwd: path.join(R, 'repos', 'p7') }), deps);
  expect(m.workdir).toBe(path.join(R, 'repos', 'p7'));
  expect(m.mounts.every(x => x.readonly)).toBe(true);
});

test('task-worktree-or-none（respec）：沒有 cwd 就只有基本掛載＋附件，workdir 是家目錄', async () => {
  const m = await resolveSandboxMounts(base({ profile: profileFor('respec') }), deps);
  expect(m.workdir).toBe(base({}).home);
  expect(sources(m).some(s => s.startsWith(path.join(R, 'repos')))).toBe(false);
  expect(sources(m)).toContain(path.join(R, 'uploads', 'task_70'));
});

test('none（deploy_fix）：只有 skills／hooks／mcp，全部唯讀', async () => {
  const m = await resolveSandboxMounts(base({ profile: profileFor('deploy_fix'), projectId: null, taskDbId: null }), deps);
  expect(sources(m).sort()).toEqual([
    path.join(appDir, '.agents', 'skills'),
    path.join(appDir, 'app', 'server', 'pipeline', 'hooks'),
    path.join(appDir, 'app', 'server', 'pipeline', 'mcp'),
  ].sort());
  expect(m.mounts.every(x => x.readonly)).toBe(true);
});

test('project 類但沒有 projectId（未綁專案的 cs）→ 與 none 相同，不掛任何 repo', async () => {
  const m = await resolveSandboxMounts(base({ profile: profileFor('cs'), projectId: null, taskDbId: null }), deps);
  expect(sources(m).some(s => s.startsWith(path.join(R, 'repos')))).toBe(false);
});

test('platform-clean（健檢）：只掛乾淨 worktree 與平台 .git，全部唯讀', async () => {
  const wt = path.join(appDir, '.claude', 'worktrees', 'ro-abc');
  const m = await resolveSandboxMounts(base({ profile: profileFor('workflow_health'), projectId: null, taskDbId: null, platformWorktree: wt }), deps);
  expect(m.workdir).toBe(wt);
  expect(m.mounts.every(x => x.readonly)).toBe(true);
  expect(sources(m)).toContain(path.join(appDir, '.git'));
  expectNoPlatformSecrets(m);
});

test('platform-clean 沒給 worktree、或 worktree 不在允許的目錄 → 丟例外', async () => {
  await expect(resolveSandboxMounts(base({ profile: profileFor('fix_review'), projectId: null, taskDbId: null }), deps)).rejects.toThrow();
  await expect(resolveSandboxMounts(base({ profile: profileFor('fix_review'), projectId: null, taskDbId: null, platformWorktree: appDir }), deps)).rejects.toThrow();
});

// 修正工作區要能改檔、跑 jest，但不能改平台 repo 的 refs（否則可以直接改寫 master 指標、繞過審核）
test('platform-fix：工作區可寫、node_modules 唯讀、平台 .git 唯讀只開自己的 worktree admin 目錄', async () => {
  const wt = path.join(appDir, '.claude', 'worktrees', 'fix-12');
  const m = await resolveSandboxMounts(base({ profile: profileFor('platform_fix'), projectId: null, taskDbId: null, cwd: wt, feedbackIds: [3] }), deps);
  expect(m.workdir).toBe(wt);
  expect(find(m, wt).readonly).toBe(false);
  expect(find(m, path.join(appDir, '.git')).readonly).toBe(true);
  expect(find(m, path.join(appDir, '.git', 'worktrees', 'fix-12')).readonly).toBe(false);
  expect(find(m, path.join(appDir, 'app', 'node_modules')).readonly).toBe(true);
  expect(find(m, path.join(R, 'uploads', 'feedback_3')).readonly).toBe(true);
  expectNoPlatformSecrets(m);
});

test('platform-fix 的 cwd 不在修正工作區根目錄底下 → 丟例外', async () => {
  await expect(resolveSandboxMounts(base({ profile: profileFor('fix_verify'), projectId: null, taskDbId: null, cwd: appDir }), deps)).rejects.toThrow();
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/agent-mounts.test.js`
Expected：FAIL，`Cannot find module '../lib/agent-mounts'`

- [ ] **Step 3：實作**

```js
// app/server/lib/agent-mounts.js
/**
 * agent-mounts.js — 依 agent profile 解出容器掛載清單（子專案 0 §4.2、§4.5；計畫 X7）
 *
 * 全部同構路徑（容器內外相同），來源一律由既有變數推導，不寫死。
 * 不變量：不掛 APP_DIR 本體、APP_DIR/data（config.json、ai.sock）、別專案路徑、odoo-envs 的 odoo.conf（含 DB 密碼）。
 */
const fs = require('fs');
const path = require('path');
const { gitDirMounts } = require('./agent-sandbox');

const MAX_LOG_FILES = 50;
const LOG_RE = /^(deploy|e2e)-task(\d+)-/;

function platformPaths(appDir) {
  return {
    skills: path.join(appDir, '.agents', 'skills'),
    hooks: path.join(appDir, 'app', 'server', 'pipeline', 'hooks'),
    mcp: path.join(appDir, 'app', 'server', 'pipeline', 'mcp'),
    gitDir: path.join(appDir, '.git'),
    nodeModules: path.join(appDir, 'app', 'node_modules'),
    fixWorktreeRoot: process.env.FIX_WORKTREE_DIR || path.join(appDir, '.claude', 'worktrees'),
  };
}

function defaults(appDir) {
  return {
    query: (...a) => require('../db').query(...a),
    getProjectInfo: (...a) => require('../pipeline/task-agent').getProjectInfo(...a),
    worktreeParent: (...a) => require('../pipeline/task-agent').worktreeParent(...a),
    majorOf: (...a) => require('./odoo-core-src').majorOf(...a),
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, statSync: fs.statSync,
    coreSrcRoot: require('./odoo-core-src').CORE_SRC_ROOT,
    uploadRoot: require('./attachments').uploadRoot(),
    envBase: process.env.ODOO_ENV_BASE || path.resolve(appDir, 'odoo-envs'),
    logDir: process.env.DEPLOY_LOG_DIR || path.join(appDir, 'data', 'logs'),
    fixWorktreeRoot: platformPaths(appDir).fixWorktreeRoot,
  };
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function resolveSandboxMounts(ctx, deps = {}) {
  const d = { ...defaults(ctx.appDir), ...deps };
  const pp = platformPaths(ctx.appDir);
  const mounts = [];
  const ro = src => { if (d.existsSync(src)) mounts.push({ source: src, readonly: true }); };

  ro(pp.skills); ro(pp.hooks); ro(pp.mcp);

  const { profile } = ctx;
  let kind = profile.mount;
  if (profile.scope === 'project' && ctx.projectId == null) kind = 'none';
  let workdir = ctx.home;

  const attach = () => {
    if (profile.attachments === 'task' && ctx.taskDbId != null) ro(path.join(d.uploadRoot, `task_${ctx.taskDbId}`));
    if (profile.attachments === 'chat' && ctx.chatId != null) ro(path.join(d.uploadRoot, `chat_${ctx.chatId}`));
    if (profile.attachments === 'feedback') for (const id of ctx.feedbackIds || []) ro(path.join(d.uploadRoot, `feedback_${id}`));
  };

  if (kind === 'platform-clean') {
    const wt = ctx.platformWorktree;
    if (!wt || !isInside(wt, d.fixWorktreeRoot) || !path.basename(wt).startsWith('ro-') || !d.existsSync(wt)) {
      throw new Error(`內部 AI 的乾淨 worktree 不存在或不在 ${d.fixWorktreeRoot}/ro-*：${wt}`);
    }
    mounts.push({ source: wt, readonly: true }, { source: pp.gitDir, readonly: true });
    return { mounts, workdir: wt };
  }

  if (kind === 'platform-fix') {
    const wt = ctx.cwd;
    if (!wt || !isInside(wt, d.fixWorktreeRoot) || !path.basename(wt).startsWith('fix-') || !d.existsSync(wt)) {
      throw new Error(`修正工作區 cwd 不在 ${d.fixWorktreeRoot}/fix-*：${wt}`);
    }
    const admin = path.join(pp.gitDir, 'worktrees', path.basename(wt));
    if (!d.existsSync(admin)) throw new Error(`找不到修正工作區的 git admin 目錄：${admin}`);
    mounts.push({ source: wt, readonly: false }, { source: pp.gitDir, readonly: true }, { source: admin, readonly: false });
    ro(pp.nodeModules);
    attach();
    return { mounts, workdir: wt };
  }

  if (kind === 'none') { attach(); return { mounts, workdir }; }

  const info = await d.getProjectInfo(ctx.projectId);
  if (!info) throw new Error(`專案 ${ctx.projectId} 沒有 clone 完成的 repo，無法組容器掛載`);

  const projectData = () => {
    const major = d.majorOf(info.odoo_version);
    if (major) ro(path.join(d.coreSrcRoot, major));
    if (info.enterprise_src) ro(info.enterprise_src);
  };

  let wt = null;
  if (ctx.taskDbId != null && (kind === 'task-worktree' || kind === 'task-worktree-or-none' || kind === 'task-worktree-or-clone')) {
    const { rows: [t] } = await d.query('SELECT task_id, project_id FROM tasks WHERE id=$1', [ctx.taskDbId]);
    if (!t || Number(t.project_id) !== Number(ctx.projectId)) throw new Error(`任務 ${ctx.taskDbId} 不屬於專案 ${ctx.projectId}`);
    wt = d.worktreeParent(info.root, t.task_id);
  }

  const useWorktree = () => {
    if (!wt || !d.existsSync(wt)) throw new Error(`任務 worktree 不存在：${wt}`);
    if (ctx.cwd !== undefined && ctx.cwd !== wt) throw new Error(`呼叫端 cwd（${ctx.cwd}）與任務 worktree（${wt}）不符`);
    mounts.push({ source: wt, readonly: false });
    for (const r of info.repos) mounts.push(...gitDirMounts(r.local_path, 'rw'));
    projectData(); attach();
    return { mounts, workdir: wt };
  };

  const useClone = async () => {
    mounts.push({ source: info.root, readonly: true });
    projectData(); attach();
    if (profile.logs) {
      ro(path.join(d.envBase, info.folder_name || info.name, 'odoo.log'));
      const { rows } = await d.query('SELECT id FROM tasks WHERE project_id=$1', [ctx.projectId]);
      const ids = new Set(rows.map(r => String(r.id)));
      let files = [];
      try { files = d.readdirSync(d.logDir); } catch { files = []; }
      files
        .filter(f => { const mm = LOG_RE.exec(f); return mm && ids.has(mm[2]); })
        .map(f => path.join(d.logDir, f))
        .sort((a, b) => d.statSync(b).mtimeMs - d.statSync(a).mtimeMs)
        .slice(0, MAX_LOG_FILES)
        .forEach(ro);
    }
    return { mounts, workdir: info.root };
  };

  if (kind === 'task-worktree') return useWorktree();
  if (kind === 'task-worktree-or-none') {
    if (ctx.cwd === undefined) { attach(); return { mounts, workdir }; }
    return useWorktree();
  }
  if (kind === 'task-worktree-or-clone') {
    if (ctx.cwd === info.root) return useClone();
    return useWorktree();
  }
  if (kind === 'project-clone') return useClone();
  throw new Error(`未知的掛載種類：${kind}`);
}

module.exports = { resolveSandboxMounts, platformPaths, MAX_LOG_FILES };
```

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/agent-mounts.test.js`
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/lib/agent-mounts.js app/server/tests/agent-mounts.test.js
git commit -m "[AgentSandbox]: 容器只該看得到本專案的碼、附件與 log，平台資料夾與別專案一律不掛，修正工作區改不到平台 refs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 1.6：`/ai` 守衛分流——socket 來的只認每次執行通行證

**Files:**
- Create: `app/server/lib/ai-scope.js`
- Modify: `app/server/lib/ai-token.js:68-89`（`aiEndpointGuard`）
- Test: `app/server/tests/ai-scope.test.js`

**Interfaces:**
- Consumes：`verifyRunToken(token)`（Task 1.2）
- Produces：
  - `aiEndpointGuard(req,res,next)`：`req.aidevVia === 'socket'` → 驗每次執行通行證，失敗 **401**，成功設 `req.aiRun = { runId, scope, projectId, endpoints }`；否則走原本 loopback＋全域通行碼（行為不變），並設 `req.aiRun = null`
  - `requireAiEndpoint(group: 'db'|'wiki'|'tasks'|'glossary'|'platform') → middleware`（`req.aiRun` 為 null＝互動式舊路徑，放行；群組不在 `endpoints` → **403**）
  - `projectForbidden(req, projectId) → boolean`（僅 project scope 且專案不符時 true）
  - `forbidProject(res) → res`（回 403＋固定訊息）
  - `req.aidevVia` 只由 Task 1.8 的 socket app 設定

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/ai-scope.test.js
// 意圖（規格 §8.2）：從 socket 進來的請求一律只認「這次執行」的通行證——舊的全域通行碼在 socket 上無效，
// 過期／作廢回 401；scope 沒開的端點群組回 403；project scope 查別專案回 403。
// TCP loopback 的舊路徑（互動式 /getSQL）行為完全不變。
process.env.APP_SECRET = 'test-ai-scope-secret';
const express = require('express');
const request = require('supertest');
const { aiEndpointGuard, aiToken, AI_TOKEN_HEADER } = require('../lib/ai-token');
const { requireAiEndpoint, projectForbidden, forbidProject } = require('../lib/ai-scope');
const rt = require('../lib/agent-run-token');

function socketLikeApp() {
  const app = express();
  app.use((req, _res, next) => { req.aidevVia = 'socket'; next(); });
  app.get('/ai/db/probe', aiEndpointGuard, requireAiEndpoint('db'), (req, res) => {
    if (projectForbidden(req, Number(req.query.pid))) return forbidProject(res);
    res.json({ ok: true, run: req.aiRun });
  });
  app.post('/ai/platform/query', aiEndpointGuard, requireAiEndpoint('platform'), (req, res) => res.json({ ok: true }));
  return app;
}
function tcpApp() {
  const app = express();
  app.get('/ai/db/probe', aiEndpointGuard, requireAiEndpoint('db'), (req, res) => res.json({ ok: true, run: req.aiRun }));
  return app;
}

beforeEach(() => rt._resetRunsForTesting());

test('socket＋本次通行證 → 放行並帶出 aiRun', async () => {
  const { token } = rt.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 60000 });
  const res = await request(socketLikeApp()).get('/ai/db/probe?pid=7').set(AI_TOKEN_HEADER, token);
  expect(res.status).toBe(200);
  expect(res.body.run.scope).toBe('project-7');
});

test('A 專案的通行證查 B 專案 → 403', async () => {
  const { token } = rt.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 60000 });
  const res = await request(socketLikeApp()).get('/ai/db/probe?pid=8').set(AI_TOKEN_HEADER, token);
  expect(res.status).toBe(403);
});

test('過期的通行證 → 401', async () => {
  const { token } = rt.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 1, now: Date.now() - 10000 });
  const res = await request(socketLikeApp()).get('/ai/db/probe?pid=7').set(AI_TOKEN_HEADER, token);
  expect(res.status).toBe(401);
});

test('已作廢的通行證 → 401', async () => {
  const { token, runId } = rt.issueRunToken({ scope: 'project-7', projectId: 7, ttlMs: 60000 });
  rt.revokeRun(runId);
  const res = await request(socketLikeApp()).get('/ai/db/probe?pid=7').set(AI_TOKEN_HEADER, token);
  expect(res.status).toBe(401);
});

test('socket 上帶舊的全域通行碼 → 401', async () => {
  const res = await request(socketLikeApp()).get('/ai/db/probe?pid=7').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(401);
});

test('非 internal-audit 呼叫 /ai/platform/query → 403（含 internal-fix，R6-A）', async () => {
  for (const [scope, pid] of [['project-7', 7], ['internal-fix', null], ['none', null]]) {
    const { token } = rt.issueRunToken({ scope, projectId: pid, ttlMs: 60000 });
    const res = await request(socketLikeApp()).post('/ai/platform/query').set(AI_TOKEN_HEADER, token);
    expect(res.status).toBe(403);
  }
  const { token } = rt.issueRunToken({ scope: 'internal-audit', projectId: null, ttlMs: 60000 });
  expect((await request(socketLikeApp()).post('/ai/platform/query').set(AI_TOKEN_HEADER, token)).status).toBe(200);
});

test('internal scope 查客戶正式 DB 群組 → 403', async () => {
  const { token } = rt.issueRunToken({ scope: 'internal-audit', projectId: null, ttlMs: 60000 });
  const res = await request(socketLikeApp()).get('/ai/db/probe?pid=7').set(AI_TOKEN_HEADER, token);
  expect(res.status).toBe(403);
});

test('TCP loopback 舊路徑行為不變：全域通行碼放行、aiRun 為 null', async () => {
  const res = await request(tcpApp()).get('/ai/db/probe').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(200);
  expect(res.body.run).toBeNull();
});

test('TCP 上帶每次執行通行證不算數（舊路徑只認全域通行碼）', async () => {
  const { token } = rt.issueRunToken({ scope: 'internal-audit', projectId: null, ttlMs: 60000 });
  const res = await request(tcpApp()).get('/ai/db/probe').set(AI_TOKEN_HEADER, token);
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/ai-scope.test.js`
Expected：FAIL，`Cannot find module '../lib/ai-scope'`

- [ ] **Step 3：實作 `ai-scope.js`**

```js
// app/server/lib/ai-scope.js
/**
 * ai-scope.js — /ai 端點依「本次執行的 scope」做群組與專案檢查（子專案 0 §4.4）
 * req.aiRun 由 aiEndpointGuard 設定：socket 來的是 { runId, scope, projectId, endpoints }；TCP 舊路徑是 null（互動式，不限）。
 */
function requireAiEndpoint(group) {
  return (req, res, next) => {
    if (!req.aiRun) return next();
    if (!req.aiRun.endpoints.includes(group)) {
      return res.status(403).json({ ok: false, error: `本次執行的範圍（${req.aiRun.scope}）不含 /ai/${group}` });
    }
    return next();
  };
}

function projectForbidden(req, projectId) {
  if (!req.aiRun || !String(req.aiRun.scope).startsWith('project-')) return false;
  return Number(projectId) !== Number(req.aiRun.projectId);
}

function forbidProject(res) {
  return res.status(403).json({ ok: false, error: '該專案不屬於本次執行的範圍' });
}

module.exports = { requireAiEndpoint, projectForbidden, forbidProject };
```

- [ ] **Step 4：改 `aiEndpointGuard`**（`lib/ai-token.js` 第 68 行起整個函式換成下面；上方的註解保留）

```js
// /ai/* 的完整守衛。
// socket 來的（只有出口閘道掛得到那個檔，見 lib/ai-socket-server.js）：只認每次執行通行證，全域通行碼無效。
// TCP 來的：本機來源 **且** 帶對全域通行碼（互動式 session 用，行為不變）。
function aiEndpointGuard(req, res, next) {
  if (req.aidevVia === 'socket') {
    const { verifyRunToken } = require('./agent-run-token');
    const v = verifyRunToken((req.headers && req.headers[AI_TOKEN_HEADER]) || '');
    if (!v.ok) return res.status(401).json({ ok: false, error: `AI 執行通行證無效：${v.reason}` });
    req.aiRun = v.run;
    return next();
  }
  req.aiRun = null;
  const ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ ok: false, error: 'AI endpoint 僅限本機' });
  }
  const expected = aiToken();
  if (!expected) {
    return res.status(403).json({ ok: false, error: 'AI endpoint 通行碼未設定（APP_SECRET 未設），請檢查啟動設定' });
  }
  const got = (req.headers && req.headers[AI_TOKEN_HEADER]) || '';
  if (!timingSafeEqualStr(got, expected)) {
    return res.status(403).json({
      ok: false,
      error: `AI endpoint 通行碼不正確或未帶（header ${AI_TOKEN_HEADER}）——agent 是否在 server 重啟前就派工了？重新派工即可`,
    });
  }
  return next();
}
```
（`agent-run-token` 用 lazy require：它 require `agent-profiles`，ai-token.js 被很多 route 檔頂層 require，保持載入面最小。）

- [ ] **Step 5：跑測試確認通過（含既有兩支守衛測試）**

Run: `cd app && npx jest server/tests/ai-scope.test.js server/tests/ai-endpoint-token.test.js server/tests/db-query-ai.test.js`
Expected：PASS

- [ ] **Step 6：Commit**

```bash
git add app/server/lib/ai-scope.js app/server/lib/ai-token.js app/server/tests/ai-scope.test.js
git commit -m "[AgentSandbox]: 容器經 socket 打 /ai 時全域通行碼要失效，改認每次執行通行證並依 scope 擋端點與專案

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 1.7：既有 8 個 `/ai/*` 端點加上群組與專案檢查

**Files:**
- Modify: `app/server/db-query-routes.js:287-321`（`/ai/db/connections`、`/ai/db/query`、`/ai/db/log`）
- Modify: `app/server/wiki-routes.js:144,160,267`（`/ai/wiki/pages`、`/search`、`/page`）
- Modify: `app/server/ai-task-routes.js:32,70`（`/ai/tasks/similar`、`/spec`）
- Test: `app/server/tests/ai-scope-routes.test.js`

**Interfaces:**
- Consumes：`requireAiEndpoint`、`projectForbidden`、`forbidProject`（Task 1.6）；`issueRunToken`（Task 1.2）
- Produces：8 個端點在 `req.aiRun` 有值時的 scope 行為；`req.aiRun === null` 時行為與現在逐字相同

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/ai-scope-routes.test.js
// 意圖：真的 route 檔掛在「模擬 socket」的 app 上，驗規格 §8.2 在實際端點成立：
// A 專案的通行證查 B 專案的連線／wiki／任務 → 403；不帶 project 列連線 → 只看得到本專案；
// internal scope 查客戶正式 DB → 403；互動式舊路徑（TCP）完全不受影響。
process.env.APP_SECRET = 'test-ai-scope-routes';
process.env.JWT_SECRET = 'test-ai-scope-routes-jwt';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const { AI_TOKEN_HEADER, aiToken } = require('../lib/ai-token');
const rt = require('../lib/agent-run-token');

const mockRunSelect = jest.fn();
jest.mock('../lib/ssh-sql', () => ({ runSelect: (...a) => mockRunSelect(...a) }));

let dbModule, socketApp, tcpApp, pA, pB, connA, connB;
function mount(app) {
  app.use(express.json());
  require('../db-query-routes').registerRoutes(app);
  require('../wiki-routes').registerRoutes(app);
  require('../ai-task-routes').registerRoutes(app);
  return app;
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const ins = async (name, folder) => (await dbModule.query(
    'INSERT INTO projects (name,folder_name,odoo_version) VALUES ($1,$2,$3) RETURNING id', [name, folder, '17.0'])).rows[0].id;
  pA = await ins('甲', 'scope_a'); pB = await ins('乙', 'scope_b');
  connA = (await dbModule.query("INSERT INTO db_connections (project_id,name,ssh_host,ssh_user,db_name) VALUES ($1,'ca','1.1.1.1','u','d') RETURNING id", [pA])).rows[0].id;
  connB = (await dbModule.query("INSERT INTO db_connections (project_id,name,ssh_host,ssh_user,db_name) VALUES ($1,'cb','1.1.1.2','u','d') RETURNING id", [pB])).rows[0].id;
  await dbModule.query("INSERT INTO wiki_pages (project_id, slug, title, node_type, content) VALUES ($1,'bpage','B 頁','overview','內容')", [pB]);
  const s = express();
  s.use((req, _res, next) => { req.aidevVia = 'socket'; next(); });
  socketApp = mount(s);
  tcpApp = mount(express());
});
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(() => { rt._resetRunsForTesting(); mockRunSelect.mockReset(); });

const tokFor = (scope, pid) => rt.issueRunToken({ scope, projectId: pid, ttlMs: 60000 }).token;

test('A 專案通行證用 B 的 connection_id 查 → 403，而且沒有真的連線', async () => {
  const res = await request(socketApp).post('/ai/db/query').set(AI_TOKEN_HEADER, tokFor(`project-${pA}`, pA))
    .send({ connection_id: connB, sql: 'SELECT 1' });
  expect(res.status).toBe(403);
  expect(mockRunSelect).not.toHaveBeenCalled();
});

test('A 專案通行證查自己的連線 → 放行', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, rows: [], row_count: 0 });
  const res = await request(socketApp).post('/ai/db/query').set(AI_TOKEN_HEADER, tokFor(`project-${pA}`, pA))
    .send({ connection_id: connA, sql: 'SELECT 1' });
  expect(res.status).toBe(200);
  expect(mockRunSelect).toHaveBeenCalledTimes(1);
});

test('/ai/db/log 用別專案連線 → 403', async () => {
  const res = await request(socketApp).post('/ai/db/log').set(AI_TOKEN_HEADER, tokFor(`project-${pA}`, pA))
    .send({ connection_id: connB, at: '2026-09-15 10:00' });
  expect(res.status).toBe(403);
});

test('不帶 project 列連線 → 只回本專案的', async () => {
  const res = await request(socketApp).get('/ai/db/connections').set(AI_TOKEN_HEADER, tokFor(`project-${pA}`, pA));
  expect(res.status).toBe(200);
  expect(res.body.connections.map(c => c.name)).toEqual(['ca']);
});

test('帶別專案的 project 參數列連線 → 403', async () => {
  const res = await request(socketApp).get('/ai/db/connections?project=scope_b').set(AI_TOKEN_HEADER, tokFor(`project-${pA}`, pA));
  expect(res.status).toBe(403);
});

test.each([
  ['/ai/wiki/pages?project=scope_b'],
  ['/ai/wiki/search?project=scope_b&q=內容'],
  ['/ai/wiki/page?project=scope_b&slug=bpage'],
  ['/ai/tasks/spec?project=scope_b&task=1'],
  ['/ai/tasks/similar?project=scope_b&q=x'],
])('A 專案通行證讀 B 專案 %s → 403', async (url) => {
  const res = await request(socketApp).get(url).set(AI_TOKEN_HEADER, tokFor(`project-${pA}`, pA));
  expect(res.status).toBe(403);
});

test('internal-audit 可讀任一專案 wiki；查客戶正式 DB → 403', async () => {
  const t = tokFor('internal-audit', null);
  expect((await request(socketApp).get('/ai/wiki/pages?project=scope_b').set(AI_TOKEN_HEADER, t)).status).toBe(200);
  expect((await request(socketApp).get('/ai/db/connections').set(AI_TOKEN_HEADER, t)).status).toBe(403);
});

test('internal-fix 讀 wiki → 403（只給術語表，計畫 X12）', async () => {
  const res = await request(socketApp).get('/ai/wiki/pages?project=scope_b').set(AI_TOKEN_HEADER, tokFor('internal-fix', null));
  expect(res.status).toBe(403);
});

test('互動式舊路徑不受影響：TCP＋全域通行碼列得到全部連線', async () => {
  const res = await request(tcpApp).get('/ai/db/connections').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(200);
  expect(res.body.connections.map(c => c.name).sort()).toEqual(['ca', 'cb']);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/ai-scope-routes.test.js`
Expected：FAIL（跨專案那幾條拿到 200）

- [ ] **Step 3：改 `db-query-routes.js`**（檔頭 require 區加一行；三個端點換成下面）

```js
const { requireAiEndpoint, projectForbidden, forbidProject } = require('./lib/ai-scope');
```

```js
  app.get('/ai/db/connections', aiEndpointGuard, requireAiEndpoint('db'), async (req, res) => {
    try {
      const project = req.query.project;
      let rows;
      if (project) {
        const { resolveProjectId } = require('./lib/project-ref');
        const pid = await resolveProjectId(project);
        if (pid != null && projectForbidden(req, pid)) return forbidProject(res);
        ({ rows } = await query(
          `SELECT c.id, c.name, c.db_engine, p.name AS project FROM db_connections c JOIN projects p ON p.id=c.project_id
           WHERE p.folder_name=$1 OR p.name=$1 ORDER BY c.name`, [project]));
        if (req.aiRun && String(req.aiRun.scope).startsWith('project-')) {
          ({ rows } = await query(
            `SELECT c.id, c.name, c.db_engine, p.name AS project FROM db_connections c JOIN projects p ON p.id=c.project_id
             WHERE p.id=$1 ORDER BY c.name`, [req.aiRun.projectId]));
        }
      } else if (req.aiRun && String(req.aiRun.scope).startsWith('project-')) {
        ({ rows } = await query(
          `SELECT c.id, c.name, c.db_engine, p.name AS project FROM db_connections c JOIN projects p ON p.id=c.project_id
           WHERE p.id=$1 ORDER BY c.name`, [req.aiRun.projectId]));
      } else {
        ({ rows } = await query(
          `SELECT c.id, c.name, c.db_engine, p.name AS project FROM db_connections c JOIN projects p ON p.id=c.project_id ORDER BY p.name, c.name`));
      }
      res.json({ ok: true, connections: rows });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });

  app.post('/ai/db/query', aiEndpointGuard, requireAiEndpoint('db'), async (req, res) => {
    try {
      const { connection_id, sql } = req.body || {};
      const { rows: [c] } = await query('SELECT project_id FROM db_connections WHERE id=$1', [connection_id]);
      if (!c) return res.json({ ok: false, error: '找不到連線' });
      if (projectForbidden(req, c.project_id)) return forbidProject(res);
      const conn = await loadDecryptedConn(connection_id, c.project_id);
      res.json(await runSelect(conn, sql || ''));
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });

  app.post('/ai/db/log', aiEndpointGuard, requireAiEndpoint('db'), async (req, res) => {
    try {
      const { connection_id, at, window, level, keyword } = req.body || {};
      const { rows: [c] } = await query('SELECT project_id FROM db_connections WHERE id=$1', [connection_id]);
      if (!c) return res.json({ ok: false, error: '找不到連線' });
      if (projectForbidden(req, c.project_id)) return forbidProject(res);
      const conn = await loadDecryptedConn(connection_id, c.project_id);
      res.json(await runLogTail(conn, { at, window, level, keyword }));
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });
```
（有 `project` 參數時先查一次維持「互動式舊路徑」原 SQL 逐字不變，project scope 再以 `p.id` 覆寫結果——避免 `folder_name=$1 OR name=$1` 撞號時帶出別專案的列，見 `lib/project-ref.js` 檔頭。）

- [ ] **Step 4：改 `wiki-routes.js` 三個端點**（檔頭加 require；每個端點在 `aiEndpointGuard` 後插 `requireAiEndpoint('wiki')`，並在 `const pid = await resolveProjectId(...)` 那行**之後**插一行檢查）

```js
const { requireAiEndpoint, projectForbidden, forbidProject } = require('./lib/ai-scope');
```
三處的路由宣告改為：
```js
  app.get('/ai/wiki/pages', aiEndpointGuard, requireAiEndpoint('wiki'), async (req, res) => {
  app.get('/ai/wiki/search', aiEndpointGuard, requireAiEndpoint('wiki'), async (req, res) => {
  app.get('/ai/wiki/page', aiEndpointGuard, requireAiEndpoint('wiki'), async (req, res) => {
```
三處 `const pid = await resolveProjectId(req.query.project);` 下一行都插：
```js
      if (pid != null && projectForbidden(req, pid)) return forbidProject(res);
```

- [ ] **Step 5：改 `ai-task-routes.js` 兩個端點**（同 Step 4 的做法，群組為 `'tasks'`）

```js
const { requireAiEndpoint, projectForbidden, forbidProject } = require('./lib/ai-scope');
```
```js
  app.get('/ai/tasks/similar', aiEndpointGuard, requireAiEndpoint('tasks'), async (req, res) => {
  app.get('/ai/tasks/spec', aiEndpointGuard, requireAiEndpoint('tasks'), async (req, res) => {
```
兩處 `const pid = await resolveProjectId(req.query.project);` 下一行插：
```js
      if (pid != null && projectForbidden(req, pid)) return forbidProject(res);
```
（`/ai/tasks/similar` 的檢查必須在 `if (!q) return ...` 之後、`if (!pid) return ...` 之前——照上面插在 resolve 下一行即是。）

- [ ] **Step 6：跑測試確認通過（含既有 /ai 測試）**

Run: `cd app && npx jest server/tests/ai-scope-routes.test.js server/tests/ai-task-routes.test.js server/tests/db-query-ai.test.js server/tests/wiki-ai.test.js server/tests/log-routes.test.js server/tests/wiki-search-hybrid.test.js`
Expected：PASS

- [ ] **Step 7：Commit**

```bash
git add app/server/db-query-routes.js app/server/wiki-routes.js app/server/ai-task-routes.js app/server/tests/ai-scope-routes.test.js
git commit -m "[AgentSandbox]: /ai/db/query 的專案是從連線反查的、不綁呼叫者，容器通行證帶別專案 id 就查得到別家正式庫

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 1.8：unix socket listener（只掛 `/ai/*`）＋啟動接線＋`.gitignore`

**Files:**
- Create: `app/server/lib/ai-socket-server.js`
- Modify: `app/server/index.js`（`migrate().then(async () => {` 區塊內，`await require('./lib/context7-auth').loadContext7Key();`（09-15 第 330 行）之後）
- Modify: `.gitignore`
- Test: `app/server/tests/ai-socket-server.test.js`

**Interfaces:**
- Consumes：`aiEndpointGuard` 的 socket 分流（Task 1.6，看 `req.aidevVia`）；`loadAgentSandboxFlag()`（Task 1.3）
- Produces：
  - `aiSocketPath() → string`（`process.env.AIDEV_AI_SOCKET` 或 `<APP_DIR>/data/run/ai.sock`）
  - `createAiSocketApp() → express app`（非 `/ai/` 開頭一律 404；設 `req.aidevVia='socket'`；註冊 db-query、wiki、ai-task 三個 route 檔；Task 1.9 會再加 `ai-platform-routes`）
  - `startAiSocketServer(sockPath) → Promise<http.Server>`（目錄 0700、socket 檔 0600；殘留的 socket 檔先刪、若同路徑是一般檔案則丟例外）

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/ai-socket-server.test.js
// 意圖：出口閘道唯一連得到的平台入口就是這個 socket 檔。它必須：只有 /ai/* 有東西（/api 一律 404）、
// 權限 600（別的 uid 連不上）、只認每次執行通行證（全域通行碼無效）。用真的 unix socket 驗，不靠 mock。
process.env.APP_SECRET = 'test-ai-socket';
process.env.JWT_SECRET = 'test-ai-socket-jwt';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const { AI_TOKEN_HEADER, aiToken } = require('../lib/ai-token');
const rt = require('../lib/agent-run-token');

let dbModule, server, sock, dir;
function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, path: urlPath, method: 'GET', headers }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query("INSERT INTO projects (name,folder_name,odoo_version) VALUES ('s','sock_p','17.0')");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisock-'));
  sock = path.join(dir, 'run', 'ai.sock');
  const { startAiSocketServer } = require('../lib/ai-socket-server');
  server = await startAiSocketServer(sock);
});
afterAll(async () => {
  await new Promise(r => server.close(r));
  dbModule._setPoolForTesting(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('socket 檔權限 600、所在目錄 700', () => {
  expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.dirname(sock)).mode & 0o777).toBe(0o700);
});

test('非 /ai/ 路徑一律 404（/api 不經 socket 暴露）', async () => {
  expect((await get('/api/tasks')).status).toBe(404);
  expect((await get('/')).status).toBe(404);
});

test('帶本次通行證 → 200', async () => {
  rt._resetRunsForTesting();
  const { token } = rt.issueRunToken({ scope: 'internal-audit', projectId: null, ttlMs: 60000 });
  const res = await get('/ai/wiki/pages?project=sock_p', { [AI_TOKEN_HEADER]: token });
  expect(res.status).toBe(200);
});

test('帶全域通行碼 → 401', async () => {
  const res = await get('/ai/wiki/pages?project=sock_p', { [AI_TOKEN_HEADER]: aiToken() });
  expect(res.status).toBe(401);
});

test('重啟時殘留的 socket 檔會被清掉重建', async () => {
  const { startAiSocketServer } = require('../lib/ai-socket-server');
  await new Promise(r => server.close(r));
  // close 會移除 socket；手動放一個殘留 socket 模擬被 kill 的情形
  const stale = http.createServer();
  await new Promise(r => stale.listen(sock, r));
  stale.unref();
  server = await startAiSocketServer(sock);
  expect(fs.statSync(sock).isSocket()).toBe(true);
});

test('同路徑是一般檔案 → 丟例外（不亂刪不是 socket 的東西）', async () => {
  const { startAiSocketServer } = require('../lib/ai-socket-server');
  const f = path.join(dir, 'run', 'not-a-socket');
  fs.writeFileSync(f, 'x');
  await expect(startAiSocketServer(f)).rejects.toThrow(/不是 socket/);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/ai-socket-server.test.js`
Expected：FAIL，`Cannot find module '../lib/ai-socket-server'`

- [ ] **Step 3：實作**

```js
// app/server/lib/ai-socket-server.js
/**
 * ai-socket-server.js — 容器經出口閘道打 /ai 的唯一入口（子專案 0 §3、§4.4；總覽 D8）
 *
 * 為什麼是 unix socket：平台是 host 網路，閘道從 bridge 連回 8771 的來源 IP 與 nginx 反代進來的一樣，
 * 用 IP 分不出是誰。socket 檔只有掛了 data/run 的閘道容器碰得到。
 * 只掛 /ai/*：同一批 route 檔也註冊了 /api 路由，前置 middleware 一律 404 擋掉。
 * req.aidevVia 只在這個 app 設定；TCP 那個 app 永遠沒有這個欄位，無從偽造。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

function aiSocketPath() {
  return process.env.AIDEV_AI_SOCKET || path.join(__dirname, '..', '..', '..', 'data', 'run', 'ai.sock');
}

function createAiSocketApp() {
  const app = express();
  app.use((req, res, next) => {
    if (!req.path.startsWith('/ai/')) return res.status(404).json({ ok: false, error: 'Not found' });
    req.aidevVia = 'socket';
    return next();
  });
  app.use(express.json());
  require('../db-query-routes').registerRoutes(app);
  require('../wiki-routes').registerRoutes(app);
  require('../ai-task-routes').registerRoutes(app);
  app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
  return app;
}

async function startAiSocketServer(sockPath) {
  if (Buffer.byteLength(sockPath) >= 104) throw new Error(`unix socket 路徑太長（上限 103 bytes）：${sockPath}`);
  const dir = path.dirname(sockPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  let st = null;
  try { st = fs.lstatSync(sockPath); } catch { st = null; }
  if (st) {
    if (!st.isSocket()) throw new Error(`${sockPath} 已存在且不是 socket，拒絕覆蓋`);
    fs.unlinkSync(sockPath);
  }
  const server = http.createServer(createAiSocketApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => { server.off('error', reject); resolve(); });
  });
  fs.chmodSync(sockPath, 0o600);
  return server;
}

module.exports = { aiSocketPath, createAiSocketApp, startAiSocketServer };
```

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/ai-socket-server.test.js`
Expected：PASS

- [ ] **Step 5：`index.js` 啟動接線**（`await require('./lib/context7-auth').loadContext7Key();` 之後插入；失敗只記 log、不擋啟動——開關 off 時沒人用 socket；容器模式下閘道連不上會在 AI 執行時大聲失敗）

```js
    // 子專案 0：AI 容器隔離開關（同步快取，runClaude 讀）。讀不到 DB 時模組內部落到 all（最嚴格）。
    await require('./lib/agent-sandbox-flag').loadAgentSandboxFlag();
    // /ai 的 unix socket 入口：只有出口閘道容器掛得到。起不來只記 log——開關 off 時沒有人用它；
    // 開關開著時，容器內每一次 /ai 查詢都會失敗並在 agent 輸出看到，不會靜默。
    try {
      const { startAiSocketServer, aiSocketPath } = require('./lib/ai-socket-server');
      await startAiSocketServer(aiSocketPath());
      console.log(`[AI-SOCKET] listening ${aiSocketPath()}`);
    } catch (e) { console.error('[AI-SOCKET] 啟動失敗：', e.message); }
```

- [ ] **Step 6：`.gitignore` 加兩行**（檔尾 `/data/backups/` 那段附近）

```
/data/run/
/data/agent-home/
```

- [ ] **Step 7：全跑**

Run: `cd app && npm run test:quiet > /tmp/claude-t18.txt 2>&1; echo "EXITCODE=$?" >> /tmp/claude-t18.txt; grep -E "^Tests:|^Test Suites:|EXITCODE" /tmp/claude-t18.txt`
Expected：無新紅燈

- [ ] **Step 8：Commit**

```bash
git add app/server/lib/ai-socket-server.js app/server/index.js .gitignore app/server/tests/ai-socket-server.test.js
git commit -m "[AgentSandbox]: 平台是 host 網路、從 IP 分不出閘道與外部請求，/ai 另開只有閘道掛得到的 unix socket 入口

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 1.9：`/ai/glossary`——取代 odooGlossary 直連平台 DB

**Files:**
- Create: `app/server/ai-platform-routes.js`
- Modify: `app/server/index.js`（`registerDeployRoutes(app);`（09-15 第 127 行）之後加註冊；檔頭 require 區比照其他 route）
- Modify: `app/server/lib/ai-socket-server.js`（`createAiSocketApp` 內加註冊）
- Test: `app/server/tests/ai-platform-routes.test.js`

**Interfaces:**
- Consumes：`aiEndpointGuard`、`requireAiEndpoint('glossary')`（Task 1.6）
- Produces：`GET /ai/glossary?version=<odoo大版本>&term=<英文精確>` 或 `&q=<英文片段>` 或 `&zh=<中文片段>`（三擇一）→ `{ ok: true, terms: [{ term_en, term_zh, hit_count }] }`，依 `hit_count DESC`，最多 50 筆；缺 version 或三者皆無 → `{ ok:false, error }`（HTTP 200，比照既有 `/ai/*` 回錯方式）。`registerRoutes(app)` 供 Task 1.11 追加 `/ai/platform/query`。

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/ai-platform-routes.test.js
// 意圖：odooGlossary skill 原本借 platformDB 的 query.js 直連平台 DB，容器裡沒有 DATABASE_URL 也不該有。
// 改打 /ai/glossary：術語表是公開的 Odoo 字串，任何 scope 都能查；但它只准查術語，不是通用 SQL 入口。
process.env.APP_SECRET = 'test-ai-platform-routes';
process.env.JWT_SECRET = 'test-ai-platform-routes-jwt';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const { AI_TOKEN_HEADER } = require('../lib/ai-token');
const rt = require('../lib/agent-run-token');

let dbModule, app;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query(`INSERT INTO exam_glossary (odoo_version, term_en, term_zh, hit_count) VALUES
    ('19','Sales Order','銷售訂單',36), ('19','Sales Order','銷售單',2), ('19','Delivery Orders','交貨單',20), ('17','Sales Order','銷售訂單',30)`);
  app = express();
  app.use((req, _res, next) => { req.aidevVia = 'socket'; next(); });
  app.use(express.json());
  require('../ai-platform-routes').registerRoutes(app);
});
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(() => rt._resetRunsForTesting());
const tok = (scope, pid = null) => rt.issueRunToken({ scope, projectId: pid, ttlMs: 60000 }).token;

test('精確查英文，依 hit_count 由高到低、只回指定版本', async () => {
  const res = await request(app).get('/ai/glossary?version=19&term=Sales%20Order').set(AI_TOKEN_HEADER, tok('project-3', 3));
  expect(res.status).toBe(200);
  expect(res.body.terms).toEqual([
    { term_en: 'Sales Order', term_zh: '銷售訂單', hit_count: 36 },
    { term_en: 'Sales Order', term_zh: '銷售單', hit_count: 2 },
  ]);
});

test('模糊查英文不分大小寫', async () => {
  const res = await request(app).get('/ai/glossary?version=19&q=delivery').set(AI_TOKEN_HEADER, tok('internal-fix'));
  expect(res.body.terms.map(t => t.term_zh)).toEqual(['交貨單']);
});

test('反查中文', async () => {
  const res = await request(app).get(`/ai/glossary?version=19&zh=${encodeURIComponent('交貨')}`).set(AI_TOKEN_HEADER, tok('internal-audit'));
  expect(res.body.terms.map(t => t.term_en)).toEqual(['Delivery Orders']);
});

test('缺參數 → ok:false 並說明', async () => {
  const res = await request(app).get('/ai/glossary?version=19').set(AI_TOKEN_HEADER, tok('internal-audit'));
  expect(res.body.ok).toBe(false);
  expect(res.body.error).toMatch(/term|q|zh/);
});

test('none scope（分類器類）查不到 → 403', async () => {
  const res = await request(app).get('/ai/glossary?version=19&q=order').set(AI_TOKEN_HEADER, tok('none'));
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/ai-platform-routes.test.js`
Expected：FAIL，`Cannot find module '../ai-platform-routes'`

- [ ] **Step 3：實作**

```js
// app/server/ai-platform-routes.js
// 子專案 0 §4.4：取代兩個直連平台 DB 的 skill 的唯讀端點。
//   /ai/glossary          odooGlossary 用；術語表是公開的 Odoo 字串，任何有 glossary 群組的 scope 都可查
//   /ai/platform/query    platformDB 用；只給 internal-audit（Task 1.11 加入）
const { query } = require('./db');
const { aiEndpointGuard } = require('./lib/ai-token');
const { requireAiEndpoint } = require('./lib/ai-scope');

const GLOSSARY_LIMIT = 50;

// LOWER+LIKE 而非 ILIKE：pg-mem 相容（比照 wiki-routes /ai/wiki/search）；逸脫 % _ \
const likeOf = s => `%${String(s).toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;

function registerRoutes(app) {
  app.get('/ai/glossary', aiEndpointGuard, requireAiEndpoint('glossary'), async (req, res) => {
    try {
      const version = String(req.query.version || '').trim();
      if (!version) return res.json({ ok: false, error: '缺 version 參數（Odoo 大版本，例：19）' });
      let where; let param;
      if (req.query.term) { where = 'term_en = $2'; param = String(req.query.term); }
      else if (req.query.q) { where = 'LOWER(term_en) LIKE $2'; param = likeOf(req.query.q); }
      else if (req.query.zh) { where = 'term_zh LIKE $2'; param = likeOf(req.query.zh); }
      else return res.json({ ok: false, error: '需要 term（英文精確）、q（英文片段）或 zh（中文片段）其中之一' });
      const { rows } = await query(
        `SELECT term_en, term_zh, hit_count FROM exam_glossary
          WHERE odoo_version = $1 AND ${where}
          ORDER BY hit_count DESC, term_en ASC LIMIT ${GLOSSARY_LIMIT}`, [version, param]);
      res.json({ ok: true, terms: rows });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });
}

module.exports = { registerRoutes };
```

- [ ] **Step 4：註冊到兩個 app**

`app/server/index.js` 檔頭 require 區（`registerDocsRoutes` 那行之後）：
```js
const { registerRoutes: registerAiPlatformRoutes } = require('./ai-platform-routes');
```
`registerDeployRoutes(app);` 之後：
```js
  registerAiPlatformRoutes(app);
```
`app/server/lib/ai-socket-server.js` 的 `require('../ai-task-routes').registerRoutes(app);` 之後：
```js
  require('../ai-platform-routes').registerRoutes(app);
```

- [ ] **Step 5：跑測試確認通過**

Run: `cd app && npx jest server/tests/ai-platform-routes.test.js server/tests/ai-socket-server.test.js`
Expected：PASS

- [ ] **Step 6：Commit**

```bash
git add app/server/ai-platform-routes.js app/server/index.js app/server/lib/ai-socket-server.js app/server/tests/ai-platform-routes.test.js
git commit -m "[AgentSandbox]: 術語表 skill 直連平台 DB，容器裡沒有也不該有 DATABASE_URL，改走 /ai/glossary

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 1.10：`platform-readonly.js`——唯讀 LOGIN 角色與欄位遮蔽（純函式＋可注入）

**前置**：Task M3 判定可行。

**Files:**
- Create: `app/server/lib/platform-readonly.js`
- Test: `app/server/tests/platform-readonly.test.js`

**Interfaces:**
- Consumes：無
- Produces：
  - `RO_ROLE = 'aidev_ai_ro'`、`RO_PASSWORD_LABEL = 'aidev:ai-readonly-db:v1'`、`MAX_ROWS = 500`
  - `isSensitiveColumn(column: string) → boolean`
  - `assertReadOnlySql(sql: string) → string`（回傳去註解後的 SQL；非 SELECT/WITH/EXPLAIN/SHOW、或含第二個語句 → 丟例外帶 `statusCode: 400`）
  - `roPassword() → string`（hex；`APP_SECRET` 未設丟例外）
  - `buildRoleSql(columns: {table_name, column_name}[], password) → string[]`
  - `ensureReadonlyRole(deps?: { query }) → Promise<{ tables: number, denied: string[] }>`
  - `roConnectionString(databaseUrl: string) → string`
  - `runReadonlyQuery(sql, deps?: { Client, databaseUrl }) → Promise<{ columns: string[], rows: object[], row_count: number, truncated: boolean }>`

**09-15 實查的敏感欄位**（`information_schema` 以 `_enc$|pass|secret|token|api_key|pat$|cookie|private|credential|ssh_key` 篩出，排除 token 用量欄後）：`db_connections.{db_password_enc, ssh_key_enc, ssh_key_path, ssh_password_enc, vpn_config_enc, vpn_password_enc}`、`odoo_envs.{e2e_password, sso_secret}`、`projects.{vpn_config_enc, vpn_password_enc}`、`sessions.token_hash`、`teams_settings.{claude_oauth_token_backup_enc, claude_oauth_token_enc, client_secret, context7_api_key_enc, figma_api_key_enc, openai_api_key_enc}`、`users.{github_pat_enc, password_enc, password_hash}`。`token_usage.*_tokens` 與 `finding_fixes.baseline_passed` 是誤中，**必須可讀**（健檢要用）。

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/platform-readonly.test.js
// 意圖：健檢 AI 要能 SELECT 平台 DB，但絕不能讀到密文、密碼雜湊、session token；也不能靠任何 SQL 技巧切回 superuser。
// pg-mem 不支援角色與欄位權限，這裡只驗「產出的 SQL 對不對、連線用的是哪個帳號、擋不擋非唯讀語句」；
// 真正的權限效果由第 3 部的自我檢測在真 PG 上驗（用唯讀角色讀 users.password_hash 必須 permission denied）。
process.env.APP_SECRET = 'test-platform-readonly';
const r = require('../lib/platform-readonly');

describe('isSensitiveColumn：09-15 實查的敏感欄位全部命中，健檢要用的欄位不誤殺', () => {
  test.each(['db_password_enc', 'ssh_key_enc', 'ssh_key_path', 'ssh_password_enc', 'vpn_config_enc', 'vpn_password_enc',
    'e2e_password', 'sso_secret', 'token_hash', 'claude_oauth_token_enc', 'client_secret', 'context7_api_key_enc',
    'figma_api_key_enc', 'openai_api_key_enc', 'github_pat_enc', 'password_enc', 'password_hash'])('%s 是敏感欄位', c => {
    expect(r.isSensitiveColumn(c)).toBe(true);
  });
  test.each(['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_create_tokens', 'baseline_passed',
    'original_text', 'analysis_yaml', 'agent_type', 'status'])('%s 可讀', c => {
    expect(r.isSensitiveColumn(c)).toBe(false);
  });
});

describe('assertReadOnlySql', () => {
  test.each(['SELECT 1', '  with x as (select 1) select * from x', '-- 註解\nSELECT 1', 'EXPLAIN SELECT 1', 'SELECT 1;'])('放行：%s', sql => {
    expect(() => r.assertReadOnlySql(sql)).not.toThrow();
  });
  test.each(['UPDATE users SET role=1', 'SELECT 1; DROP TABLE users', 'SELECT 1; RESET ROLE', '/* x */ DELETE FROM tasks', ''])('擋下：%s', sql => {
    expect(() => r.assertReadOnlySql(sql)).toThrow();
  });
});

test('roPassword 由 APP_SECRET 派生、穩定、不等於 APP_SECRET', () => {
  expect(r.roPassword()).toBe(r.roPassword());
  expect(r.roPassword()).toMatch(/^[a-f0-9]{64}$/);
  expect(r.roPassword()).not.toContain(process.env.APP_SECRET);
});

test('roConnectionString 換成唯讀帳號密碼，其餘不變', () => {
  const u = new URL(r.roConnectionString('postgres://odoo:superpw@127.0.0.1:8772/aidev'));
  expect(u.username).toBe('aidev_ai_ro');
  expect(u.password).toBe(r.roPassword());
  expect(u.host).toBe('127.0.0.1:8772');
  expect(u.pathname).toBe('/aidev');
  expect(u.toString()).not.toContain('superpw');
});

describe('buildRoleSql', () => {
  const cols = [
    { table_name: 'users', column_name: 'id' }, { table_name: 'users', column_name: 'username' },
    { table_name: 'users', column_name: 'password_hash' }, { table_name: 'users', column_name: 'github_pat_enc' },
    { table_name: 'tasks', column_name: 'id' }, { table_name: 'tasks', column_name: 'original_text' },
  ];
  const sql = r.buildRoleSql(cols, 'ab12').join('\n');
  test('LOGIN、非 superuser、預設唯讀交易、有 statement_timeout', () => {
    expect(sql).toMatch(/CREATE ROLE aidev_ai_ro LOGIN/);
    expect(sql).toMatch(/NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/);
    expect(sql).toMatch(/SET default_transaction_read_only = on/);
    expect(sql).toMatch(/SET statement_timeout = '15s'/);
  });
  // 2c 會 REVOKE CONNECT FROM PUBLIC（計畫 X19）：沒有這條，角色建好了卻連不上，端點只會回連線錯誤
  test('明確授權連線到目前的資料庫', () => {
    expect(sql).toMatch(/GRANT CONNECT ON DATABASE %I TO aidev_ai_ro', current_database\(\)/);
  });
  test('先收回整表權限，再逐欄授權非敏感欄位', () => {
    expect(sql).toMatch(/REVOKE ALL ON ALL TABLES IN SCHEMA public FROM aidev_ai_ro/);
    expect(sql).toMatch(/GRANT SELECT \("id", "username"\) ON public\."users" TO aidev_ai_ro/);
    expect(sql).toMatch(/GRANT SELECT \("id", "original_text"\) ON public\."tasks" TO aidev_ai_ro/);
  });
  test('敏感欄位明確 REVOKE，且不出現在任何 GRANT 裡', () => {
    expect(sql).toMatch(/REVOKE SELECT \("password_hash", "github_pat_enc"\) ON public\."users" FROM aidev_ai_ro/);
    for (const line of sql.split('\n').filter(l => l.startsWith('GRANT SELECT'))) {
      expect(line).not.toMatch(/password_hash|github_pat_enc/);
    }
  });
  test('密碼只接受 hex（避免 SQL 字串逸脫問題）', () => {
    expect(() => r.buildRoleSql(cols, "x'; DROP")).toThrow();
  });
});

test('ensureReadonlyRole：先查 information_schema 再依序執行產出的 SQL', async () => {
  const calls = [];
  const query = async (text) => {
    calls.push(text);
    if (/information_schema\.columns/.test(text)) return { rows: [{ table_name: 'users', column_name: 'id' }, { table_name: 'users', column_name: 'password_hash' }] };
    return { rows: [] };
  };
  const out = await r.ensureReadonlyRole({ query });
  expect(calls[0]).toMatch(/information_schema\.columns/);
  expect(calls.some(c => /GRANT SELECT \("id"\) ON public\."users"/.test(c))).toBe(true);
  expect(calls.some(c => /GRANT CONNECT ON DATABASE/.test(c))).toBe(true);
  expect(out).toEqual({ tables: 1, denied: ['users.password_hash'] });
});

describe('runReadonlyQuery', () => {
  function fakeClient(result, seen) {
    return class {
      constructor(cfg) { seen.cfg = cfg; }
      async connect() { seen.connected = true; }
      async query(q) { seen.q = q; return result; }
      async end() { seen.ended = true; }
    };
  }
  test('用唯讀帳號另開連線、以 extended protocol 送出（單一語句）、用完關閉', async () => {
    const seen = {};
    const Client = fakeClient({ fields: [{ name: 'id' }], rows: [{ id: 1 }] }, seen);
    const out = await r.runReadonlyQuery('SELECT id FROM tasks', { Client, databaseUrl: 'postgres://odoo:pw@127.0.0.1:8772/aidev' });
    expect(new URL(seen.cfg.connectionString).username).toBe('aidev_ai_ro');
    expect(seen.q).toEqual({ text: 'SELECT id FROM tasks', queryMode: 'extended' });
    expect(seen.ended).toBe(true);
    expect(out).toEqual({ columns: ['id'], rows: [{ id: 1 }], row_count: 1, truncated: false });
  });
  test(`超過 ${r.MAX_ROWS} 列截斷並標記`, async () => {
    const seen = {};
    const rows = Array.from({ length: r.MAX_ROWS + 3 }, (_, i) => ({ id: i }));
    const out = await r.runReadonlyQuery('SELECT id FROM tasks', { Client: fakeClient({ fields: [{ name: 'id' }], rows }, seen), databaseUrl: 'postgres://odoo:pw@h:1/d' });
    expect(out.rows.length).toBe(r.MAX_ROWS);
    expect(out.truncated).toBe(true);
    expect(out.row_count).toBe(r.MAX_ROWS + 3);
  });
  test('非唯讀語句連線都不開', async () => {
    const seen = {};
    await expect(r.runReadonlyQuery('DELETE FROM tasks', { Client: fakeClient({ rows: [] }, seen), databaseUrl: 'postgres://o:p@h:1/d' })).rejects.toThrow();
    expect(seen.connected).toBeUndefined();
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/platform-readonly.test.js`
Expected：FAIL，`Cannot find module '../lib/platform-readonly'`

- [ ] **Step 3：實作**

```js
// app/server/lib/platform-readonly.js
/**
 * platform-readonly.js — /ai/platform/query 的唯讀 DB 帳號（子專案 0 §4.4；計畫 X13）
 *
 * 為什麼是另一個 LOGIN 角色而不是 SET ROLE：平台 DB 只有 superuser odoo。在 odoo 的連線上 SET ROLE 到唯讀角色，
 * 查詢裡一句 set_config('role','odoo',false) 就切回去（session_user 仍是 superuser）。另開連線、以唯讀角色登入，
 * session_user 本身就沒有權限，沒有東西可以切。
 * 密碼由 APP_SECRET 派生：不另存一份祕密，跨重啟穩定。
 * 欄位級授權：表層 GRANT 會蓋掉欄位層 REVOKE，所以先 REVOKE ALL 再逐欄 GRANT 非敏感欄位；敏感欄位另外明確 REVOKE，
 * 讓「以前授權過、後來規則變嚴」的欄位也收得回來。每次啟動重跑一次：新表、新欄位自動納入規則。
 */
const crypto = require('crypto');

const RO_ROLE = 'aidev_ai_ro';
const RO_PASSWORD_LABEL = 'aidev:ai-readonly-db:v1';
const MAX_ROWS = 500;
const SENSITIVE_RE = /(_enc$|password|passwd|secret|token_hash|ssh_key|private_key|api_key|_pat$)/i;

function isSensitiveColumn(column) { return SENSITIVE_RE.test(String(column)); }

function bad(msg) { return Object.assign(new Error(msg), { statusCode: 400 }); }

function assertReadOnlySql(sql) {
  const stripped = String(sql || '').replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!/^(SELECT|WITH|EXPLAIN|SHOW)\b/i.test(stripped)) throw bad('只允許唯讀查詢（SELECT／WITH／EXPLAIN／SHOW）');
  if (/;\s*\S/.test(stripped)) throw bad('一次只能送一個語句');
  return stripped;
}

function roPassword() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error('APP_SECRET 未設定，無法派生唯讀 DB 帳號密碼');
  return crypto.createHmac('sha256', secret).update(RO_PASSWORD_LABEL).digest('hex');
}

const qi = s => `"${String(s).replace(/"/g, '""')}"`;

function buildRoleSql(columns, password) {
  if (!/^[a-f0-9]+$/.test(String(password))) throw new Error('唯讀帳號密碼格式不正確');
  const byTable = new Map();
  for (const { table_name: t, column_name: c } of columns) {
    if (!byTable.has(t)) byTable.set(t, { allow: [], deny: [] });
    byTable.get(t)[isSensitiveColumn(c) ? 'deny' : 'allow'].push(c);
  }
  const out = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RO_ROLE}') THEN CREATE ROLE ${RO_ROLE} LOGIN; END IF; END $$`,
    `ALTER ROLE ${RO_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`,
    `ALTER ROLE ${RO_ROLE} SET default_transaction_read_only = on`,
    `ALTER ROLE ${RO_ROLE} SET statement_timeout = '15s'`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${RO_ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${RO_ROLE}`,
    // 2c（8ca9913d）啟動時對每個 DB REVOKE CONNECT FROM PUBLIC；唯讀角色要明確授權才連得上（計畫 X19）
    `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${RO_ROLE}', current_database()); END $$`,
  ];
  for (const [t, { allow, deny }] of byTable) {
    if (deny.length) out.push(`REVOKE SELECT (${deny.map(qi).join(', ')}) ON public.${qi(t)} FROM ${RO_ROLE}`);
    if (allow.length) out.push(`GRANT SELECT (${allow.map(qi).join(', ')}) ON public.${qi(t)} TO ${RO_ROLE}`);
  }
  return out;
}

async function ensureReadonlyRole(deps = {}) {
  const query = deps.query || require('../db').query;
  const { rows } = await query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`);
  for (const stmt of buildRoleSql(rows, roPassword())) await query(stmt);
  const tables = new Set(rows.map(x => x.table_name)).size;
  const denied = rows.filter(x => isSensitiveColumn(x.column_name)).map(x => `${x.table_name}.${x.column_name}`);
  return { tables, denied };
}

function roConnectionString(databaseUrl) {
  const u = new URL(databaseUrl);
  u.username = RO_ROLE;
  u.password = roPassword();
  return u.toString();
}

async function runReadonlyQuery(sql, deps = {}) {
  const text = assertReadOnlySql(sql);
  const Client = deps.Client || require('pg').Client;
  const databaseUrl = deps.databaseUrl || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL 未設定');
  const client = new Client({ connectionString: roConnectionString(databaseUrl) });
  await client.connect();
  try {
    // queryMode extended＝走 prepared statement，PG 只接受單一語句（pg 8.22：lib/query.js:19,36）
    const r = await client.query({ text, queryMode: 'extended' });
    const rows = r.rows || [];
    return {
      columns: (r.fields || []).map(f => f.name),
      rows: rows.slice(0, MAX_ROWS),
      row_count: rows.length,
      truncated: rows.length > MAX_ROWS,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = {
  RO_ROLE, RO_PASSWORD_LABEL, MAX_ROWS, isSensitiveColumn, assertReadOnlySql, roPassword,
  buildRoleSql, ensureReadonlyRole, roConnectionString, runReadonlyQuery,
};
```

- [ ] **Step 4：跑測試確認通過**

Run: `cd app && npx jest server/tests/platform-readonly.test.js`
Expected：PASS

- [ ] **Step 5：Commit**

```bash
git add app/server/lib/platform-readonly.js app/server/tests/platform-readonly.test.js
git commit -m "[AgentSandbox]: 健檢 AI 要查平台 DB 但不能讀到密文與密碼雜湊，SET ROLE 又切得回 superuser，改用派生密碼的唯讀登入帳號＋欄位級授權

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 1.11：`/ai/platform/query` 端點＋啟動時建立唯讀角色

**Files:**
- Modify: `app/server/ai-platform-routes.js`
- Modify: `app/server/index.js`（Task 1.8 插入的 `[AI-SOCKET]` 區塊之後）
- Test: `app/server/tests/ai-platform-routes.test.js`（追加）

**Interfaces:**
- Consumes：`runReadonlyQuery`、`ensureReadonlyRole`（Task 1.10）；`requireAiEndpoint('platform')`（Task 1.6）
- Produces：`POST /ai/platform/query` body `{ sql }` → `{ ok: true, columns, rows, row_count, truncated }`；非唯讀 → HTTP 400 `{ ok:false, error }`；查詢錯誤（含 permission denied）→ HTTP 200 `{ ok:false, error }`；非 internal-audit 的 socket 請求 → 403；TCP 舊路徑（互動式）→ 放行。
- 模組層 `_setReadonlyRunnerForTesting(fn)`：測試注入查詢執行器。

- [ ] **Step 1：在 `ai-platform-routes.test.js` 檔尾追加失敗測試**

```js
describe('/ai/platform/query', () => {
  const routes = require('../ai-platform-routes');
  let lastSql;
  beforeAll(() => {
    routes._setReadonlyRunnerForTesting(async (sql) => {
      lastSql = sql;
      if (/password_hash/.test(sql)) throw new Error('permission denied for table users');
      return { columns: ['n'], rows: [{ n: 3 }], row_count: 1, truncated: false };
    });
  });
  afterAll(() => routes._setReadonlyRunnerForTesting(null));

  test('internal-audit 可查', async () => {
    const res = await request(app).post('/ai/platform/query').set(AI_TOKEN_HEADER, tok('internal-audit')).send({ sql: 'SELECT COUNT(*) n FROM tasks' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, columns: ['n'], rows: [{ n: 3 }], row_count: 1, truncated: false });
    expect(lastSql).toBe('SELECT COUNT(*) n FROM tasks');
  });

  test.each([['project-3', 3], ['internal-fix', null], ['none', null]])('%s → 403（R6-A）', async (scope, pid) => {
    lastSql = undefined;
    const res = await request(app).post('/ai/platform/query').set(AI_TOKEN_HEADER, tok(scope, pid)).send({ sql: 'SELECT 1' });
    expect(res.status).toBe(403);
    expect(lastSql).toBeUndefined();
  });

  test('非唯讀語句 → 400，不送進 DB', async () => {
    lastSql = undefined;
    const res = await request(app).post('/ai/platform/query').set(AI_TOKEN_HEADER, tok('internal-audit')).send({ sql: 'UPDATE users SET role=1' });
    expect(res.status).toBe(400);
    expect(lastSql).toBeUndefined();
  });

  test('權限不足的錯誤原樣回給 agent（它才知道那欄不能讀）', async () => {
    const res = await request(app).post('/ai/platform/query').set(AI_TOKEN_HEADER, tok('internal-audit')).send({ sql: 'SELECT password_hash FROM users' });
    expect(res.body).toEqual({ ok: false, error: expect.stringMatching(/permission denied/) });
  });
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/ai-platform-routes.test.js`
Expected：FAIL（`_setReadonlyRunnerForTesting is not a function`）

- [ ] **Step 3：實作**（`ai-platform-routes.js`：檔頭加變數與注入函式，`registerRoutes` 內 `/ai/glossary` 之後加端點，`module.exports` 改寫）

檔頭（`const GLOSSARY_LIMIT = 50;` 之後）：
```js
let _runner = null;   // 測試注入；正式為 lib/platform-readonly 的 runReadonlyQuery
function _setReadonlyRunnerForTesting(fn) { _runner = fn; }
```
`registerRoutes` 內：
```js
  // 只給 internal-audit（R6-A）：改碼／審碼的 AI 能自己查 DB，就能在核准之後讀到新的客戶文字而被注入。
  app.post('/ai/platform/query', aiEndpointGuard, requireAiEndpoint('platform'), async (req, res) => {
    const ro = require('./lib/platform-readonly');
    const sql = (req.body && req.body.sql) || '';
    try { ro.assertReadOnlySql(sql); }
    catch (err) { return res.status(400).json({ ok: false, error: err.message }); }
    try {
      const run = _runner || ro.runReadonlyQuery;
      res.json({ ok: true, ...(await run(sql)) });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });
```
檔尾：
```js
module.exports = { registerRoutes, _setReadonlyRunnerForTesting };
```

- [ ] **Step 4：`index.js` 啟動建角色**（Task 1.8 的 `[AI-SOCKET]` try 區塊之後）

⚠ 位置必須在 `revokePublicConnectAll()`（origin/master `index.js:265`，commit `8ca9913d`）**之後**：那段 REVOKE 只收 PUBLIC，不會收回本角色的明確授權，但排在後面才不必依賴這個細節。執行前先 `grep -n "revokePublicConnectAll\|loadContext7Key" app/server/index.js` 確認兩者的行號順序。

```js
    // /ai/platform/query 的唯讀帳號：每次啟動依現有欄位重新授權（新欄位自動套遮蔽規則）。
    // 失敗只記 log：端點會在查詢時回連線／權限錯誤，健檢 agent 看得到；不因此擋住整個平台啟動。
    try {
      const r = await require('./lib/platform-readonly').ensureReadonlyRole();
      console.log(`[AI-READONLY] 已授權 ${r.tables} 張表，遮蔽 ${r.denied.length} 個欄位：${r.denied.join(', ')}`);
    } catch (e) { console.error('[AI-READONLY] 建立唯讀角色失敗：', e.message); }
```

- [ ] **Step 5：跑測試確認通過**

Run: `cd app && npx jest server/tests/ai-platform-routes.test.js`
Expected：PASS

- [ ] **Step 6：Commit**

```bash
git add app/server/ai-platform-routes.js app/server/index.js app/server/tests/ai-platform-routes.test.js
git commit -m "[AgentSandbox]: platformDB skill 直連平台 DB 會把 DATABASE_URL 帶進容器，改走只給健檢 AI 的唯讀 /ai/platform/query

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
## Task 1.12：平台自己跑 git 時停用 hooks 與 fsmonitor（雙保險）

**為什麼**：規格 §4.2「平台 node 自己跑 git 時一律帶 `-c core.hooksPath=/dev/null`」。平台跑 git 的地方散在 `pipeline/git.js`（`execFileAsync`）、`finding-fix.js:103`（`git()`）、`merge-agent.js`（`execFileP`）、`health-check-runner.js:209` 等多處，逐處加 `-c` 必漏。改用 git 官方的 `GIT_CONFIG_COUNT/KEY_n/VALUE_n` 環境變數，在平台行程啟動時注入 `process.env`，所有繼承 env 的 git 子行程一起生效；`buildGitEnv` 自己也帶 `GIT_CONFIG_*`（會蓋掉 process.env 的同名 key），所以它回傳的值也要套加固。

**09-15 實查**：平台 repo 與 `repos/*/*` 共 17 個 clone，`.git/hooks` 內沒有任何非 `.sample` 檔、`core.hooksPath` 都沒設 ⇒ 停用 hooks 不會改變現有行為。執行當天重跑一次確認：

```bash
cd /home/odoo/odoo-v2 && for r in . repos/*/*; do [ -d "$r/.git" ] || continue; echo "$r hooks=[$(ls "$r/.git/hooks" 2>/dev/null | grep -v '\.sample$' | tr '\n' ',')] hooksPath=[$(git -C "$r" config --get core.hooksPath)]"; done
```
Expected：每列 `hooks=[]`、`hooksPath=[]`；任何一列不是 → 停下來問（有人依賴 hook）。

**Files:**
- Create: `app/server/lib/git-hardening.js`
- Modify: `app/server/lib/git-identity.js:19-43`（`buildGitEnv` 的 return）
- Modify: `app/server/index.js`（`if (require.main === module) {` 區塊內、`process.on('uncaughtException'...)` 那兩行之後）
- Modify: `app/server/tests/git-identity.test.js:50-52`
- Test: `app/server/tests/git-hardening.test.js`

**Interfaces:**
- Consumes：無
- Produces：`HARDEN_PAIRS: [['core.hooksPath','/dev/null'], ['core.fsmonitor','false']]`；`hardenGitEnv(env: object) → object`（在既有 `GIT_CONFIG_COUNT` 之後追加，不覆蓋既有 KEY_n）

- [ ] **Step 1：寫失敗測試**

```js
// app/server/tests/git-hardening.test.js
// 意圖：容器可寫主 clone 的 .git（commit 要寫 objects），唯一擋住「在 hooks 放腳本、等平台在主機跑 git 時執行」
// 的是 config／hooks 唯讀掛載；這裡是第二道：平台自己跑的 git 根本不執行 hook。用真的 git 驗，
// 並先證明「不加固時 hook 確實會跑」，否則這個測試永遠綠也證明不了什麼。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { hardenGitEnv, HARDEN_PAIRS } = require('../lib/git-hardening');

function repoWithHook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-harden-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const marker = path.join(dir, 'hook-ran');
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  execFileSync('git', ['add', 'a.txt'], { cwd: dir });
  return { dir, marker };
}
const commit = (dir, env) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'], { cwd: dir, env });

test('對照組：不加固時 hook 會執行（證明測試有鑑別力）', () => {
  const { dir, marker } = repoWithHook();
  const env = { ...process.env }; delete env.GIT_CONFIG_COUNT;
  commit(dir, env);
  expect(fs.existsSync(marker)).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('加固後 hook 不執行', () => {
  const { dir, marker } = repoWithHook();
  const env = { ...process.env }; delete env.GIT_CONFIG_COUNT;
  commit(dir, hardenGitEnv(env));
  expect(fs.existsSync(marker)).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('保留既有的 GIT_CONFIG_* 設定，接在後面追加', () => {
  const out = hardenGitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' });
  expect(out.GIT_CONFIG_COUNT).toBe(String(1 + HARDEN_PAIRS.length));
  expect(out.GIT_CONFIG_KEY_0).toBe('credential.helper');
  expect(out.GIT_CONFIG_KEY_1).toBe('core.hooksPath');
  expect(out.GIT_CONFIG_VALUE_1).toBe('/dev/null');
  expect(out.GIT_CONFIG_KEY_2).toBe('core.fsmonitor');
  expect(out.GIT_CONFIG_VALUE_2).toBe('false');
});

test('冪等：已加固過的 env 再套一次不重複追加', () => {
  const once = hardenGitEnv({});
  expect(hardenGitEnv(once)).toEqual(once);
});
```

- [ ] **Step 2：跑測試確認失敗**

Run: `cd app && npx jest server/tests/git-hardening.test.js`
Expected：FAIL，`Cannot find module '../lib/git-hardening'`

- [ ] **Step 3：實作**

```js
// app/server/lib/git-hardening.js
/**
 * git-hardening.js — 平台自己跑的 git 一律不執行 hooks、不跑 fsmonitor（子專案 0 §4.2 雙保險）
 * 走 GIT_CONFIG_COUNT/KEY_n/VALUE_n（git 2.31+ 官方機制），啟動時注入 process.env，所有 git 子行程繼承。
 */
const HARDEN_PAIRS = [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false']];

function hardenGitEnv(env) {
  const out = { ...env };
  let n = parseInt(out.GIT_CONFIG_COUNT || '0', 10) || 0;
  const has = (k, v) => { for (let i = 0; i < n; i++) if (out[`GIT_CONFIG_KEY_${i}`] === k && out[`GIT_CONFIG_VALUE_${i}`] === v) return true; return false; };
  for (const [k, v] of HARDEN_PAIRS) {
    if (has(k, v)) continue;
    out[`GIT_CONFIG_KEY_${n}`] = k;
    out[`GIT_CONFIG_VALUE_${n}`] = v;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

module.exports = { HARDEN_PAIRS, hardenGitEnv };
```

- [ ] **Step 4：`buildGitEnv` 回傳值套加固**（`lib/git-identity.js`：檔頭加 require，`return { ... };` 改為 `return hardenGitEnv({ ... });`，物件內容一字不改）

```js
const { hardenGitEnv } = require('./git-hardening');
```
```js
  return hardenGitEnv({
    GIT_ASKPASS: askpassShimPath(),
    // ……原本的欄位原樣保留……
    GIT_TERMINAL_PROMPT: '0',
  });
```

- [ ] **Step 5：更新 `git-identity.test.js:50-52`**（保住原意：credential.helper 仍是第 0 組、值為空；另加加固斷言）

```js
  // credential.helper 清空仍是第 0 組（原意）；之後接子專案 0 的 git 加固兩組（hooksPath、fsmonitor）
  expect(env.GIT_CONFIG_COUNT).toBe('3');
  expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
  expect(env.GIT_CONFIG_VALUE_0).toBe('');
  expect(env.GIT_CONFIG_KEY_1).toBe('core.hooksPath');
  expect(env.GIT_CONFIG_VALUE_1).toBe('/dev/null');
```

- [ ] **Step 6：`index.js` 啟動注入**（`process.on('unhandledRejection', ...)` 那行之後）

```js
  // 子專案 0 §4.2：容器可寫主 clone 的 .git，平台在主機跑的每一個 git 都不得執行 hook／fsmonitor。
  Object.assign(process.env, require('./lib/git-hardening').hardenGitEnv(process.env));
```

- [ ] **Step 7：跑測試與全跑**

Run: `cd app && npx jest server/tests/git-hardening.test.js server/tests/git-identity.test.js`
Expected：PASS
Run: `cd app && npm run test:quiet > /tmp/claude-t112.txt 2>&1; echo "EXITCODE=$?" >> /tmp/claude-t112.txt; grep -E "^Tests:|^Test Suites:|EXITCODE" /tmp/claude-t112.txt`
Expected：無新紅燈

- [ ] **Step 8：Commit**

```bash
git add app/server/lib/git-hardening.js app/server/lib/git-identity.js app/server/index.js app/server/tests/git-hardening.test.js app/server/tests/git-identity.test.js
git commit -m "[AgentSandbox]: 容器寫得進主 clone 的 .git，平台在主機跑 git 時不得執行任何 hook，免得容器埋的指令在容器外被執行

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## 第 1 部完成檢查

- [ ] `cd app && npm run test:quiet`：與 Task 0 基線相比只有新增測試、無新紅燈
- [ ] `git log --oneline origin/master..HEAD` 應有 12 個 `[AgentSandbox]` commit
- [ ] 開關預設 `off`：以 pg-mem 起的 `createApp()` 打 `GET /api/admin/agent-sandbox` 回 `mode: 'off'`（Task 1.3 測試已涵蓋）
- [ ] 規格對照：§4.4（通行證、範圍、兩個新端點、canRun）、§8.1、§8.2 已由本部涵蓋；§4.1、§4.3、§5、§6、§7 在第 2 部；§4.5、§8.3、§8.4、§9 在第 3 部
- [ ] 進入第 2 部：`docs/superpowers/plans/2026-09-15-agent-sandbox-part2-runner.md`
