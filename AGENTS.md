# AGENTS.md

<!-- platform-only -->
> 註：舊的 PS1「開工」pipeline 已退役，全部改走網頁模式（`app/` 內的 Node pipeline）。
> 本檔僅保留仍適用的通用開發規則。

## Skills（本專案的參考文件）

⚠ **本檔（AGENTS.md）沒有任何程式在讀**，它只給互動式 Codex 看。pipeline 各關收到的規則是 `agent-loader.js` 的 `loadPipelineRules()` 從 **`.claude/CLAUDE.md`** 讀進去的（會先濾掉 `<!-- platform-only -->` 段落）。**想影響 pipeline 就得改 `.claude/CLAUDE.md`；改本檔對 pipeline 零效果，而且不會有任何警訊。**

下列是這個 repo 累積的排障／開發知識，放在 `.agents/skills/`。**符合情境時直接讀對應的 `SKILL.md`，不必等使用者開口**；使用者打 `/<名稱>` 就是要你讀那一份。

| Skill | 什麼時候讀 |
|---|---|
| `.agents/skills/agentPrompt/SKILL.md` | **改 `.claude/agents/*.md`、`app/server/pipeline/*.md` 共用片段、或 agent-loader 注入設定之前必讀**——那些檔掛著機器契約（placeholder／`<result>`／側通道），改壞是靜默失敗：解析不到就整輪報廢 |
| `.agents/skills/platformDev/SKILL.md` | **動 `app/server`／`app/public` 之前必讀**——jest／pg-mem／supertest 慣例、測試配對規則、前端結構與配色 dark-mode 硬規則 |
| `.agents/skills/healthCheck/SKILL.md` | 跑健檢、看健檢結果、或判斷某關要不要改 prompt 之前必讀——指標怎麼讀、證據門檻、什麼才配列入修改、已知盲區 |
| `.agents/skills/pipelineFlow/SKILL.md` | 要搞懂或修改任務 pipeline：有哪些關、怎麼接、進出各關的東西、重試上限、哪支 agent 跑哪關 |
| `.agents/skills/platformDB/SKILL.md` | 查平台自己的本地 Postgres（DB 名 `claude`／port 5416）：tasks、token_usage、彈跳計數、pipeline 指標、wiki 漂移觀測 |
| `.agents/skills/debugTask/SKILL.md` | 依 taskId 一鍵拉齊失敗任務的全部除錯資訊（狀態、彈跳計數、task_events、deploy／E2E／odoo log、setup_log）＋「症狀→看哪裡」判讀表 |
| `.agents/skills/getSQL/SKILL.md` | 查客戶遠端 Odoo 專案的 PostgreSQL（透過 SSH-SQLM API）。**不是平台 DB**——那個用 platformDB |
| `.agents/skills/getLog/SKILL.md` | 讀客戶正式機的 Odoo 應用 log 追某個回報的錯誤（需要事發時間） |
| `.agents/skills/odooDev/SKILL.md` | 改 Odoo 模組（model／view／權限／報表）、或判讀「這是 bug 還是原生行為」之前 |
| `.agents/skills/wikiQuery/SKILL.md` | 查專案 wiki 知識庫：頁面清單／內容、troubleshooting 排障結論、漂移修正流向 |
| `.agents/skills/pushRepo/SKILL.md` | 要 push 這個平台 repo 或使用者 PAT repo 到 GitHub 之前 |

> 這 11 支是 `.claude/skills/` 的副本，由 `node scripts/sync-skills.js` 產生：內容逐字一致，唯一的自動差異是執行指令的路徑（`node .agents/skills/...`）。**不要手改本目錄**——下次同步會覆蓋掉；要改請改 `.claude/skills/` 再跑同步。漂移由 `app/server/tests/skills-sync.test.js` 把關。
<!-- /platform-only -->

## 0. Hard Rules
- NEVER modify core Odoo files or `custom_addons/`. 自訂程式一律寫在「當前任務所在的 repo／addons 目錄」內——實際路徑由執行時的 agent prompt 指定；不得寫死或存取工作目錄以外的絕對路徑（如 `online_addons`）。
- 實作前明確列出核心假設。需求有歧義或存在多種合理解法時，停止實作，提出 2–3 種解讀或方案及其利弊，取得使用者確認後再決定；不得默默猜測。
- Stop when confused. Name what's unclear before continuing.
- NEVER add fields/models/logic beyond the task's agreed spec.
- 寫入專案檔案時一律使用相對路徑或環境變數，**禁止寫死任何絕對路徑**（包括 `C:\` 或 `/home/...`）。
- Think in English. Output Traditional Chinese (Taiwan). No preambles.
- Challenge proposals that violate Odoo best practices, security, or performance.
- 不得在未經使用者明確同意下修改工作流程設定（hook、`settings.json`、CI、本檔）。

## 1. Odoo Constraints
- Models: `_inherit`. Views: `inherit_id` + `xpath`. Controllers: `super()`.
- 無法透過標準 Odoo 擴充達成 → 明確向使用者說明，不要硬幹或繞過。
- Views XML 命名：`<model>_views.xml`；同一 Model 只能有一個 view 檔案。
- View 繼承：同一 addons 若已繼承某原生 view，新增內容直接寫入該繼承 view，禁止另建第二個繼承。
- 新建 module（addon）命名一律以 `idx_` 開頭（例：`idx_sale_note`）；沿用既有 module 時不改名。
- 新建 module 的 `__manifest__.py` 欄位慣例：`name` 以小寫 `idx` 直接接中文顯示名（無空格、無底線，例：資料夾 `idx_hj` → `name = 'idx維修'`）；`summary`、`description` 一律中文；`author` 固定 `'IDX'`。沿用既有 module 時不改。
- Models 命名：一個 Model 一個 `.py` 檔；單頭＋明細單據（如 `sale.order` + `sale.order.line`）合併，以單頭為檔名（`sale_order.py`）。
- View 放置：依 view 所屬的 Model 放入對應 XML。例：銷售訂單頁的 product tree view → `product_template_views.xml`。
- 樣板文件（xls/docx）一律放 `<module>/static/<type>/`。例：`hr/static/xls/abc-test.xlsx`。
- 原生 SQL 執行前呼叫 `flush_model()`，執行後呼叫 `invalidate_model()`，避免 ORM cache 導致畫面不更新。

### 權限（ir.model.access / res.groups）
權限一律由「錨點」推導，不得自由心證；推不出來就問，不准猜。

- **P0 先認體系**：動任何權限前，先讀本專案 `security/*.xml` 的 `res.groups` 與 `ir.model.access.csv`，判定這專案用哪一種權限體系（標準 user/manager 兩層／四拆能力群組／角色群組），再談個別功能。不得套用通用假設，特別是不得假設存在「App 級群組」。
- **P1 `_inherit` 既有 Model → 不新增 access 列**。加欄位不需要新 ACL。唯一例外：任務本身就是要改該 Model 的權限——此時必須同時以 `active=False` 停用被取代的原生列。
- **P2 新 Model → 比照它的錨**：有主人（Many2one 指向某單據）就比照主人的 groups 與 rwcu；獨立主檔則比照同層級的鄰居主檔。
- **P3 選單／報表的 `groups` → 用「能看到它所操作的那個 Model」的那個群組**。在四拆體系是 `group_*_search`；在標準兩層體系是該模組的 user 群組。掛在「設定」子樹底下的則不寫 `groups`，繼承 parent。
- **P4 這三種一律停下來問（寫進 `clarification_channel.questions`），不准自己決定**：
  - (a) 推導結果與同專案中同類 Model 的既有寫法不一致（例：主檔權限四拆、旁邊的明細卻全開）
  - (b) 需要新增 `res.groups`
  - (c) 推導結果是 admin-only（`base.group_system`／`base.group_no_one`）
- **P5 `unlink` 單獨確認**：規格沒明說「要能刪」，就不准填 `perm_unlink=1`。
- **P6 規格必須攤開**：分析關要在 `analysis.yaml` 的 `permissions` 區塊，用畫面上的名詞寫出「誰能用、能做什麼」。開發關不得產出規格沒寫的權限；QA 關要比對實作與 `permissions` 是否一致。規格**沒有** `permissions` 欄位、或該欄留空時（本規則上線前產出的舊規格，或 P1 情境本就不需寫）→ 依 P0~P5 推導照常實作，QA 不得僅以「規格沒寫權限」為由退回。

## 2. Python Constraints
- 禁用原生 `round()`（銀行家捨入，30.5→30，非台灣四捨五入）；改用 `Decimal` + `ROUND_HALF_UP`。

## 3. Edit Protocol
- Commit: `[Module]: Why (not what)`. File edit: `@Path | Anchor | Action`.
- **只寫解決需求且可驗證的最少程式碼。** 不做投機性功能，不為未提出的彈性、擴充性或假設性錯誤情境建立抽象。（檢驗：資深工程師會不會覺得這過度設計？）
- 只動你必須動的地方；不得順手清理相鄰、無關的程式、註解或格式。每一項修改都必須直接對應需求。
- 完全比照既有程式碼風格。零順手重構。
- Before adding code, read exports, immediate callers, and shared utilities. "Looks orthogonal" is dangerous — if unsure why code is structured a certain way, ask.
- Conformance > personal taste inside the codebase. Follow conventions even when you disagree.
- If a codebase convention seems harmful, surface it explicitly. Don't fork silently.
<!-- platform-only -->
- 動 `app/public`／`app/server` 前先載入 **platformDev** skill（前端配色 dark-mode 硬規則與測試慣例已固化在該處）。
<!-- /platform-only -->
- 驗證統一在 deploy 關「安裝／升級模組」時進行（語法錯、invalid field、view 繼承錯、缺 depends 一併把關）；pipeline 各關**不自行**跑 py_compile／xmllint／odoo-bin 或建 DB 做本地驗證，寫對程式碼靠 Context7＋讀既有碼。

<!-- platform-only -->
### 平台 Jest 測試輸出

全套先落檔，只顯示紅燈檔名與摘要；紅了才單獨重跑該檔看完整輸出。2026-09-02 實測即使加上 Jest 靜音參數，原始輸出仍有 20,266 bytes，以下摘要輸出可避免讀入失敗 diff／stack：

```powershell
cd app
$testLog = Join-Path $env:TEMP 'odoo-v2-full-test.log'
rtk proxy npm test -- --silent --noStackTrace --no-color *> $testLog
$testExit = $LASTEXITCODE
rtk rg -n '^(FAIL|Test Suites:|Tests:|Snapshots:|Time:)' $testLog
exit $testExit
```

目前 Windows 基線紅燈（與前端修改無關，對應檔案未變更）：

- `server/tests/enterprise-sources.test.js`：3 項本地企業版目錄判定失敗。
- `server/tests/vpn-gateway-run.test.js`：1 項測試寫死 POSIX `APP_DIR` 路徑，在 Windows 判定失敗。
- `server/tests/cron.test.js`：1 項 weekly health check 假時間案例未建立 running row。
- 全套曾連帶讓 `task-agent.test.js`、`vpn-migrate.test.js` 紅燈，但兩檔單獨重跑皆全綠，屬跨 suite／時序性紅燈；遇到時先單檔複驗。
<!-- /platform-only -->

## 4. Output Style
繁中術語：專案/資料庫/佈署/模組. Keep English: Variable/Function/Hook/Class/Field/Model/Method/Controller.

## 5. General Engineering Rules

**Rule 4 — Goal-Driven Execution**：開始前將需求轉為可驗證的成功條件與驗證方式，迭代至驗證通過。修復 Bug 時，優先以能重現問題的測試或步驟建立基線，再修正並驗證相關行為未受影響；不要機械式照步驟走。

**Rule 6 — Token Budgets (not advisory)**: If approaching context limits, summarize and start fresh. Surface the breach explicitly — do not silently overrun.

**Rule 7 — Surface Conflicts, Don't Average Them**: If two patterns contradict, pick one (more recent / more tested). Explain why. Flag the other for cleanup. Don't blend conflicting patterns.

**Rule 9 — Tests Verify Intent**: Tests must encode WHY behavior matters, not just WHAT it does. A test that can't fail when business logic changes is wrong.

**Rule 10 — Checkpoint After Every Significant Step**: Summarize what was done, what's verified, and what's left. Don't continue from a state you can't describe back. If you lose track, stop and restate.

**Rule 12 — Fail Loud**: "Completed" is wrong if anything was skipped silently. "Tests pass" is wrong if any were skipped. Default to surfacing uncertainty, not hiding it.

<!-- platform-only -->
## 6. 測試環境 log／附件路徑（除錯查詢用）
> 皆為平台自身路徑；一律相對 repo 根 `odoo-v2/`，可用對應 env var 覆寫（勿寫死絕對路徑）。`<folder>` = `projects.folder_name`（缺則 `name`），對應 Odoo DB 名為 `test_<folder>`。

- **Odoo runtime log（常駐 server）**：`odoo-envs/<folder>/odoo.log`（env `ODOO_ENV_BASE` 覆寫 base）。每次啟動清空、只留當次執行；專案環境頁「📄 查看 log」看尾端 256KB。asset bundle 503／process 崩潰的 traceback 只在此可見。
- **建置 log（clone/venv/pip/init/seed）**：存 DB `odoo_envs.setup_log` 欄；專案環境頁「查看建立記錄」展開。
- **Deploy 升級失敗 log**：`data/logs/deploy-task<taskId>-<n>.log`（env `DEPLOY_LOG_DIR`）。含 exitCode／stderr／stdout。
- **E2E tour 失敗 log**：`data/logs/e2e-task<taskId>-<timestamp>.log`（env `E2E_LOG_DIR`）。
- **任務附件（平台內上傳）**：`app/uploads/task_<taskId>/<timestamp>_<檔名>`（env `UPLOAD_DIR`）；DB 只存相對 uploadRoot 的路徑。
- **Odoo 內部 filestore（ir.attachment 二進位，如 asset bundle）**：`%LOCALAPPDATA%\OpenERP S.A\Odoo\filestore\test_<folder>\`（未指定 `--data-dir` 時 Odoo 的預設 data_dir）。
<!-- /platform-only -->
