# Pipeline 重新設計 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重建任務 pipeline：cs 單一入口分類、接回斷點、新增 QA/部署測試區/Playwright/人工審核封存。

**Architecture:** 路徑 A — 就地重構 `app/server/pipeline/runner.js` 狀態機為 handler map，沿用現有 worktree / merge-agent / env-agent / claude-runner 基礎設施，新增 2 個 AI agent（qa、playwright）與 1 個純程式部署步驟。

**Tech Stack:** Node.js、Express、PostgreSQL（pg / pg-mem 測試）、Jest、node-cron、claude CLI subprocess。

## Global Constraints

- 測試：`app/server/tests/` 一檔一測，用 pg-mem 注入 pool（`_setPoolForTesting`），mock `spawnClaude`／`execFile`。指令 `cd app/server && npm test`。
- 禁寫死絕對路徑，用相對路徑或環境變數。
- 狀態字串為 text，無 enum 限制；新增狀態只需更新程式的狀態清單常數。
- Commit 格式：`[Pipeline] Why`。
- Schema 變更一律走 `db.js` 的 `colMigrations` additive 模式，資料遷移冪等。
- 三關卡計數器獨立：`qa_retry_count`、`deploy_retry_count`（複用既有）、`pw_retry_count`，任一滿 3 → `stopped`。

---

## Task 1: Schema 欄位 + 舊狀態遷移

**Files:**
- Modify: `app/server/db.js`（`colMigrations` 陣列 + 一次性資料遷移）
- Test: `app/server/tests/db-migration.test.js`

**Interfaces:**
- Produces: `tasks.qa_retry_count`、`tasks.pw_retry_count`、`tasks.done_at`、`users.password_enc` 欄位；舊狀態任務遷移為 `stopped`。

- [ ] **Step 1: 寫失敗測試** — 在 `db-migration.test.js` 加：migrate 後 `tasks` 有 `qa_retry_count`/`pw_retry_count`/`done_at`、`users` 有 `password_enc`；且插入一筆 `status='final_pending'` 的 task，migrate 後變 `stopped`。
- [ ] **Step 2: 跑測試確認 fail**（欄位不存在）。
- [ ] **Step 3: 實作** — 在 `colMigrations` 加四列：
  ```js
  { table: 'tasks', col: 'qa_retry_count', sql: 'ALTER TABLE tasks ADD COLUMN qa_retry_count INTEGER DEFAULT 0' },
  { table: 'tasks', col: 'pw_retry_count', sql: 'ALTER TABLE tasks ADD COLUMN pw_retry_count INTEGER DEFAULT 0' },
  { table: 'tasks', col: 'done_at', sql: 'ALTER TABLE tasks ADD COLUMN done_at TIMESTAMPTZ' },
  { table: 'users', col: 'password_enc', sql: 'ALTER TABLE users ADD COLUMN password_enc TEXT' },
  ```
  在 colMigrations 迴圈之後加一次性遷移（冪等，用 catch 包住）：
  ```js
  await query(
    `UPDATE tasks SET status='stopped',
       blocker_content = COALESCE(blocker_content, '流程改版，請人工重新確認')
     WHERE status IN ('final_pending','deploy_pending','deploy_fixing','deploy_ready')`
  ).catch(() => {});
  ```
- [ ] **Step 4: 跑測試確認 pass**。
- [ ] **Step 5: Commit** — `[Pipeline] schema：加關卡計數/done_at/password_enc 欄位並遷移舊狀態`

---

## Task 2: cs 單一入口 — 刪 triage、cs 接手 new、無專案 guard

**Files:**
- Delete: `app/server/pipeline/triage.js`、`.claude/agents/triage.md`
- Modify: `app/server/pipeline/cs-agent.js`（無專案 guard；支援 `new` 與 `cs_running`）
- Modify: `app/server/cron.js`（移除 `triageNewTasks`，改由 runner 處理 `new`）
- Test: `app/server/tests/cs-agent.test.js`、`app/server/tests/cron.test.js`

**Interfaces:**
- Consumes: `cs-agent.runCsAgent(taskId, userId, signal)`。
- Produces: cs-agent 對「明確要改且無 `project_id`」→ `stopped`；cron tick 不再呼叫 triage。

- [ ] **Step 1: 寫失敗測試** — `cs-agent.test.js`：任務無 `project_id` 且 cs 回傳非 operation/非 vague（明確要改）→ 狀態 `stopped`、blocker 含「綁定專案」。（mock callClaude 回 `{"type":"code_change"}` 之類 else 分支）
- [ ] **Step 2: 跑測試確認 fail**。
- [ ] **Step 3: 實作** — `cs-agent.js` 的 else 分支（原本直接 `analysis_running`）改為：
  ```js
  } else {
    if (!task.project_id) {
      await query(
        "UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1",
        [taskId, '需修改程式的任務必須先綁定專案，請至任務設定綁定專案後重試']
      );
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    } else {
      await query("UPDATE tasks SET status='analysis_running', updated_at=NOW() WHERE id=$1", [taskId]);
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'analysis_running' });
    }
  }
  ```
- [ ] **Step 4: 跑測試確認 pass**。
- [ ] **Step 5: 改 cron** — `cron.js` 移除 `const { triageNewTasks } = require('./pipeline/triage')` 與兩處 `triageNewTasks(...)` 呼叫；`runForUser` 改為 `if (!skipPipeline) await runPipeline(userId)`；else 分支改為只 `runPipeline(user.id)`。刪 `triage.js`、`triage.md`。刪除或跳過 `tests/triage.test.js`。
- [ ] **Step 6: 跑 cron.test.js 確認 pass**（必要時調整 mock）。
- [ ] **Step 7: Commit** — `[Pipeline] cs 當唯一入口：刪 triage、cs 接手 new、無專案任務停止`

---

## Task 3: runner handler map 重構 + 新狀態骨架

**Files:**
- Modify: `app/server/pipeline/runner.js`
- Test: `app/server/tests/runner.test.js`

**Interfaces:**
- Consumes: 現有各 agent runner。
- Produces: `RUNNABLE_STATUSES` 含 `new`,`cs_running`,`confirm_answered`,`deploy_testing`,`playwright_running`；`processTask` 改為 handler map；`confirm_answered`→`analysis_running`；`qa_running` 不再 dead-end（暫接 `merge_running`，Task 5 補真做）；移除 `deploy_pending`/`deploy_fixing` 分支。

- [ ] **Step 1: 寫失敗測試** — `runner.test.js`：
  - `new` 狀態被 runPipeline 處理（呼叫 cs-agent，mock）。
  - `confirm_answered` → runPipeline 後變 `analysis_running`。
  - `review_pending` 不在 RUNNABLE，不被推進。
- [ ] **Step 2: 跑測試確認 fail**。
- [ ] **Step 3: 實作** — 改 `RUNNABLE_STATUSES`：
  ```js
  const RUNNABLE_STATUSES = ['new','cs_running','analysis_running','confirm_answered','branch_pending','coding_running','qa_running','merge_running','deploy_testing','playwright_running','wiki_updating'];
  ```
  把 `processTask` 的 if 鏈改為 handler map（key=status，value=async fn(task, settings)）。新增/改：
  - `new` / `cs_running`：`const { runCsAgent } = require('./cs-agent'); await runCsAgent(taskId, task.user_id, ctrl.signal)`（含 _inFlight 保護）。
  - `confirm_answered`：`await query("UPDATE tasks SET status='analysis_running', updated_at=NOW() WHERE id=$1",[taskId]); notify...`。
  - `qa_running`：暫時 `→ merge_running`（Task 5 換真 QA）。
  - 移除 `deploy_pending`、`deploy_fixing` handler；`deploy_testing`、`playwright_running` 先放 stub（Task 6/8 實作），stub 內容：不動狀態直接 return（避免誤推進）。
- [ ] **Step 4: 跑測試確認 pass**。
- [ ] **Step 5: Commit** — `[Pipeline] runner 改 handler map、接回 confirm_answered、新增狀態骨架`

---

## Task 4: needs_action / notify / teams 狀態同步

**Files:**
- Modify: `app/server/tasks-routes.js`（`NEEDS_ACTION_STATUSES`、resolve 歸零三計數器）
- Modify: `app/server/notify.js`（`ACTION_STATUSES`）
- Modify: `app/server/teams.js`（狀態標籤）
- Test: `app/server/tests/tasks-routes.test.js`、`app/server/tests/notify.test.js`

**Interfaces:**
- Produces: needs_action 含 `review_pending`，不含 `final_pending`；resolve-blocker 歸零 `qa_retry_count`/`deploy_retry_count`/`pw_retry_count`。

- [ ] **Step 1: 寫失敗測試** — `notify.test.js`：`ACTION_STATUSES.has('review_pending')` true、`has('deploy_ready')` false。`tasks-routes.test.js`：resolve-blocker 後三計數器歸 0。
- [ ] **Step 2: 跑測試確認 fail**。
- [ ] **Step 3: 實作** — 
  - `tasks-routes.js`：`NEEDS_ACTION_STATUSES = ['confirm_pending','cs_data_needed','cs_reply_pending','merge_conflict','review_pending','stopped']`；resolve-blocker 的 UPDATE 改 `qa_retry_count=0, deploy_retry_count=0, pw_retry_count=0`（取代 `reentry_count=0`）。
  - `notify.js`：`ACTION_STATUSES` 加 `review_pending`，移除 `deploy_ready`。
  - `teams.js`：標籤加 `deploy_testing`/`playwright_running`/`review_pending`，移除已刪狀態。
- [ ] **Step 4: 跑測試確認 pass**。
- [ ] **Step 5: Commit** — `[Pipeline] 同步 needs_action/notify/teams 狀態清單`

---

## Task 5: QA agent

**Files:**
- Create: `.claude/agents/qa.md`、`app/server/pipeline/qa-agent.js`
- Modify: `app/server/pipeline/runner.js`（`qa_running` handler 改呼叫 qa-agent）
- Test: `app/server/tests/qa-agent.test.js`

**Interfaces:**
- Consumes: `spawnClaude`（由 task-agent 匯出或複製到 qa-agent）、`getProjectInfo`、`parseResult`。
- Produces: `runQaAgent(taskId, userId, signal)`：pass→`merge_running`；fail→`coding_running`＋`qa_retry_count`+1（滿 3→`stopped`）。

- [ ] **Step 1: 建 agent 定義** — `.claude/agents/qa.md`：frontmatter `name: qa, role: qa, label: QA, model: sonnet, stage: qa`；prompt 要求讀 `git diff main...<branch>` 對照 SD 檢查，輸出 `---RESULT-JSON---{"verdict":"pass|fail","issues":[...],"summary":"..."}---END-RESULT---`。
- [ ] **Step 2: 寫失敗測試** — `qa-agent.test.js`（mock spawnClaude 回不同 RESULT-JSON）：
  - verdict pass → `merge_running`。
  - verdict fail 且 qa_retry_count<2 → `coding_running` 且 qa_retry_count+1、issues 進 task_logs。
  - verdict fail 且 qa_retry_count=2（第 3 次）→ `stopped`。
  - 無 RESULT-JSON → `stopped`。
- [ ] **Step 3: 跑測試確認 fail**。
- [ ] **Step 4: 實作 `qa-agent.js`** — 讀 task（含 git_branch, project_id, analysis_yaml, qa_retry_count）；`getProjectInfo`；`spawnClaude(prompt,{cwd: worktreeParent, ...})`；`parseResult`；依 verdict 轉移；fail 時 `qa_retry_count = qa_retry_count+1`，若達 3 → stopped 附「QA 連續 3 次未通過」。把 `spawnClaude`/`worktreeParent`/`getProjectInfo`/`parseResult` 從 task-agent.js 匯出共用（改 `module.exports`）。
- [ ] **Step 5: 接 runner** — `qa_running` handler 改 `const { runQaAgent } = require('./qa-agent'); await runQaAgent(taskId, task.user_id, ctrl.signal)`（含 _inFlight）。
- [ ] **Step 6: 跑測試確認 pass**。
- [ ] **Step 7: Commit** — `[Pipeline] 新增 QA agent：對照 SD 審 diff，fail 退 coding 計數`

---

## Task 6: 部署測試區（純程式）

**Files:**
- Create: `app/server/pipeline/deploy-testing.js`
- Modify: `app/server/pipeline/env-agent.js`（匯出可複用的升級函式，或在 deploy-testing 內組指令）
- Modify: `app/server/pipeline/runner.js`（`deploy_testing` handler）
- Test: `app/server/tests/deploy-testing.test.js`

**Interfaces:**
- Consumes: `odoo_envs`（url/status/port）、`projectAddonsPaths`、`ensureTestingBranch`。
- Produces: `runDeployTesting(taskId, userId, signal)`：升級 exit0→`playwright_running`；exit≠0→`coding_running`＋`deploy_retry_count`+1（滿 3→`stopped`）；env 起不來→`stopped`。

- [ ] **Step 1: 寫失敗測試** — `deploy-testing.test.js`（mock execFile / env 查詢）：
  - 升級成功 → `playwright_running`。
  - 升級失敗（exit≠0）且 deploy_retry_count<2 → `coding_running`＋計數+1。
  - deploy_retry_count=2 → `stopped`。
  - env 無法啟動 → `stopped`（不退 coding）。
- [ ] **Step 2: 跑測試確認 fail**。
- [ ] **Step 3: 實作 `deploy-testing.js`** — per-project 序列鎖（複製 `withProjectMergeLock` 樣式）；確保 env running（否則 `runEnvSetup`，失敗→stopped）；各 repo `ensureTestingBranch`；組 `odoo-bin -u <module> -d <db> --stop-after-init --addons-path ... + odooDbArgs()` 執行；依 exit code 轉移。module 取自 `analysis_yaml` 的 `module`。
- [ ] **Step 4: 接 runner** — `deploy_testing` handler 呼叫 `runDeployTesting`（含 _inFlight）。
- [ ] **Step 5: 跑測試確認 pass**。
- [ ] **Step 6: Commit** — `[Pipeline] 新增部署測試區步驟：純程式升級測試 env，失敗退 coding`

---

## Task 7: E2E 憑證 password_enc 寫入點

**Files:**
- Modify: `app/server/auth.js`（setup、PUT /me、login 補寫）
- Modify: `app/server/admin-routes.js`（POST users）
- Test: `app/server/tests/auth.test.js`、`app/server/tests/admin-routes.test.js`

**Interfaces:**
- Consumes: `lib/crypto.encrypt/decrypt`。
- Produces: 上述接點寫 `users.password_enc = encrypt(明文)`；login 成功且 null 時補寫。

- [ ] **Step 1: 寫失敗測試** — `auth.test.js`：setup 後該 user `password_enc` 可 `decrypt` 回原密碼；改密碼後更新；一個 `password_enc IS NULL` 的既有 user 登入成功後被補寫。`admin-routes.test.js`：POST users 後有 `password_enc`。（測試需設 `APP_SECRET`）
- [ ] **Step 2: 跑測試確認 fail**。
- [ ] **Step 3: 實作** — `require('./lib/crypto')`；
  - setup：INSERT 加 `password_enc`＝`encrypt(password)`。
  - PUT /me：`new_password` 分支同時 `fields.password_enc = encrypt(new_password)`。
  - login：驗證成功後 `if (user.password_enc == null) await query('UPDATE users SET password_enc=$2 WHERE id=$1',[user.id, encrypt(password)])`。
  - admin POST users：INSERT 加 `password_enc`＝`encrypt(password)`。
- [ ] **Step 4: 跑測試確認 pass**。
- [ ] **Step 5: Commit** — `[Pipeline] E2E 憑證：各密碼接點寫入可逆加密 password_enc`

---

## Task 8: Playwright agent

**Files:**
- Create: `.claude/agents/playwright.md`、`app/server/pipeline/playwright-agent.js`
- Modify: `app/server/pipeline/runner.js`（`playwright_running` handler）
- Test: `app/server/tests/playwright-agent.test.js`

**Interfaces:**
- Consumes: `spawnClaude`、`odoo_envs.url`、`users.password_enc`（`decrypt`）。
- Produces: `runPlaywrightAgent(taskId, userId, signal)`：pass→`review_pending`；fail→`coding_running`＋`pw_retry_count`+1（滿 3→`stopped`）；無憑證/無 env→`stopped`。

- [ ] **Step 1: 建 agent 定義** — `.claude/agents/playwright.md`：`model: sonnet, stage: playwright`；prompt 給 SD＋測試區 URL＋登入帳密，要求產計畫、寫並跑 Playwright，輸出 `---RESULT-JSON---{"verdict":"pass|fail","plan":"...","report":"..."}---END-RESULT---`。
- [ ] **Step 2: 寫失敗測試** — `playwright-agent.test.js`（mock spawnClaude、env、user）：
  - verdict pass → `review_pending`。
  - verdict fail 且 pw_retry_count<2 → `coding_running`＋計數+1。
  - pw_retry_count=2 → `stopped`。
  - `password_enc` 為 null → `stopped`（訊息含「重新登入」）。
- [ ] **Step 3: 跑測試確認 fail**。
- [ ] **Step 4: 實作 `playwright-agent.js`** — 讀 task＋user password_enc＋env url；null 憑證或無 running env → stopped；`decrypt` 得明文；`spawnClaude(prompt)`；依 verdict 轉移＋計數。
- [ ] **Step 5: 接 runner** — `playwright_running` handler 呼叫 `runPlaywrightAgent`（含 _inFlight）。
- [ ] **Step 6: 跑測試確認 pass**。
- [ ] **Step 7: Commit** — `[Pipeline] 新增 Playwright agent：依 SD 產計畫跑 E2E，fail 退 coding`

---

## Task 9: 人工審核通過流 + 封存 + done_at

**Files:**
- Modify: `app/server/pipeline-routes.js`（approve 改吃 `review_pending`→併 main+wiki；mark-conflict-resolved→`deploy_testing`；移除 merge-to-main 端點）
- Modify: `app/server/pipeline/library-agent.js`（進 done 寫 `done_at`）
- Modify: `app/server/cron.js`（每日自動封存掃描）
- Test: `app/server/tests/pipeline-routes.test.js`、`app/server/tests/cron.test.js`、`app/server/tests/library-agent.test.js`

**Interfaces:**
- Produces: `review_pending` 按通過→`mergeToMain`+`deleteBranchLocal`→`wiki_updating`；library-agent 進 done 時 `done_at=NOW()`；cron 掃 done 滿 30 天→`is_hidden`。

- [ ] **Step 1: 寫失敗測試** — `pipeline-routes.test.js`：approve 一個 `review_pending` task（mock git）→ 呼叫 mergeToMain、狀態 `wiki_updating`；mark-conflict-resolved → `deploy_testing`。`library-agent.test.js`：完成後 `done_at` 非 null。`cron.test.js`：一筆 `done` 且 `done_at` 為 31 天前 → 掃描後 `is_hidden=true`。
- [ ] **Step 2: 跑測試確認 fail**。
- [ ] **Step 3: 實作** — 
  - `pipeline-routes.js`：`approve` 檢查改 `!== 'review_pending'`；成功後取 primary repo，`mergeToMain(path, git_branch)`＋`deleteBranchLocal`，狀態→`wiki_updating`。`mark-conflict-resolved` 目標改 `deploy_testing`。刪 `merge-to-main` 端點（合併已併入 approve）。
  - `library-agent.js`：兩處 `status='done'` UPDATE 改為同時 `done_at=NOW()`。
  - `cron.js`：tick 尾端加 `await query("UPDATE tasks SET is_hidden=true, updated_at=NOW() WHERE status='done' AND is_hidden=false AND done_at < NOW() - INTERVAL '30 days'").catch(()=>{})`。
- [ ] **Step 4: 跑測試確認 pass**。
- [ ] **Step 5: Commit** — `[Pipeline] 審核通過併 main+wiki、conflict→deploy_testing、done 滿月自動封存`

---

## Task 10: 前端按鈕與狀態標籤

**Files:**
- Modify: 前端任務詳情 view（找 `app/public/js/views/` 內顯示任務狀態/操作按鈕者）
- Test: 手動（前端無 jest；以載入不報錯 + 按鈕呼叫既有 API 為準）

**Interfaces:**
- Consumes: `POST /api/tasks/:id/approve`（review_pending）、`POST /api/tasks/:id/archive`。
- Produces: `review_pending` 顯示「通過」按鈕（呼叫 approve）；`done` 顯示「封存」按鈕（呼叫 archive）；新狀態中文標籤。

- [ ] **Step 1: 定位** — Grep `final_pending`/`approve`/狀態標籤對照表 於 `app/public/js/`，找到任務狀態渲染處。
- [ ] **Step 2: 實作** — 狀態標籤加 `deploy_testing`（部署測試中）、`playwright_running`（E2E 測試中）、`review_pending`（等待審核）；`review_pending` 顯「通過」按鈕→呼叫 approve；`done` 顯「封存」按鈕→呼叫 archive；移除 `final_pending`/`deploy_ready` 相關 UI。
- [ ] **Step 3: 驗證** — 前端載入無 console error；按鈕觸發對應 API（手動或既有 e2e 略）。
- [ ] **Step 4: Commit** — `[Pipeline] 前端：審核通過/封存按鈕與新狀態標籤`

---

## Task 11: git 微調 — 分析前 pull main、worktree 從 main

**Files:**
- Modify: `app/server/pipeline/task-agent.js`（分析前 pull main、回帶 Q&A）
- Modify: `app/server/pipeline/runner.js`（`branch_pending` worktree base 改 main）
- Modify: `app/server/pipeline/git.js`（如需 `pullBranch` helper）
- Test: `app/server/tests/task-agent.test.js`（若存在）、`app/server/tests/runner.test.js`、`app/server/tests/git.test.js`

**Interfaces:**
- Consumes: `getMainBranch`、`addWorktree`。
- Produces: `runTaskAnalysis` 前置各 repo checkout+pull main，失敗→`stopped`；worktree 從 `main`/`master` 長；分析 prompt 含 confirm 答案。

- [ ] **Step 1: 寫失敗測試** — `git.test.js`：新增 `pullBranch(repo, branch)` 呼叫 `git checkout <branch>` + `git pull origin <branch>`。`runner.test.js`：`branch_pending` 建 worktree 時 base 為 main（mock addWorktree 斷言第 4 參數）。
- [ ] **Step 2: 跑測試確認 fail**。
- [ ] **Step 3: 實作** — 
  - `git.js`：加 `pullBranch(repoPath, branch)`（checkout + `pull origin branch`；拋錯上傳）。
  - `task-agent.js` `runTaskAnalysis`：`getProjectInfo` 後、spawn 前，對每個 repo `await pullBranch(repo.local_path, mainBranch)`，catch→`stopped`（blocker：pull main 失敗）。`buildAnalysisPrompt` 加 `clarification`（讀 task_logs 最近 user 澄清）欄位並在 `analysis-project.md` 引用。
  - `runner.js` `branch_pending`：`addWorktree(repo.local_path, wtPath, branchName, mainBranch)`，`mainBranch = await getMainBranch(repo.local_path)`（取代寫死 `'testing'`）。
- [ ] **Step 4: 跑測試確認 pass**。
- [ ] **Step 5: 全套測試** — `cd app/server && npm test` 全綠。
- [ ] **Step 6: Commit** — `[Pipeline] 分析前 pull main、task 分支改從 main 長出、回帶澄清答案`

---

## Self-Review 結果

- **Spec 覆蓋**：§2 狀態機→Task 2/3/5/6/8/9；§3 git→Task 11；§4 介面→Task 5/6/8/9；§5 schema→Task 1；§6 憑證→Task 7；§7 錯誤處理→散於各 agent task；§8 檔案地圖→全覆蓋；§9 測試→每 task 內含。無遺漏。
- **計數器命名一致**：`qa_retry_count`／`deploy_retry_count`（複用）／`pw_retry_count` 全文一致。
- **狀態命名一致**：`deploy_testing`／`playwright_running`／`review_pending` 全文一致。
