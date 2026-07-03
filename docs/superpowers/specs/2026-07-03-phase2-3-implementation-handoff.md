# Phase 2 + 3 實作接手指引（重開 session 用）

> 給下一個乾淨 session：讀完這份就能直接實作。
> **⚠️ 重要：Phase 1 的程式碼在 2026-07-03 一次 git reset/clean 中被還原、已從 working tree 消失（設計 spec 仍完整）。所以新 session 要「先重做 Phase 1，再做 Phase 2/3」。**

## 0. 開場提示詞（貼給新 session）

```
延續多 repo worktree pipeline 專案。設計已定案但 Phase 1 程式碼被 git reset 還原、需重做。
依序實作 Phase 1 → Phase 2（AI Playwright E2E 測試）→ Phase 3（人工審核 gate + 封存 backup）。
spec 在：
- docs/superpowers/specs/2026-07-03-multi-repo-worktree-phase1-design.md（先做，注意 §6 後那段 ⚠️ mergeInto stdout bug）
- docs/superpowers/specs/2026-07-03-ai-e2e-testing-phase2-design.md
- docs/superpowers/specs/2026-07-03-review-archive-phase3-design.md
- 接手指引：docs/superpowers/specs/2026-07-03-phase2-3-implementation-handoff.md
請先讀這四份，照 Phase 1 spec 重做 Phase 1（每步附 jest mock 測試、跑 npx jest 全綠），再照本指引 §4/§5 做 Phase 2/3，最後用現有測試環境驗證 Playwright。
```

## 1. 現況（⚠️ Phase 1 需重做）

**Phase 1 程式碼已不在 working tree**（被 git reset 還原）。設計完整保留在 `2026-07-03-multi-repo-worktree-phase1-design.md`，照它重做即可。要改的檔與重點：`git.js`（新增 ensureTestingBranch/addWorktree/removeWorktree/mergeInto，**且 execFileAsync 要掛回 stdout/stderr — 見 Phase 1 spec §6 後的 ⚠️ 區塊**）、`runner.js`（branch_pending 建 worktree + rollback）、`task-agent.js`（getProjectInfo 回專案根+repo清單、cwd 改 worktree 父目錄、buildCodingPrompt 注入 {{repo_list}}）、`project-routes.js`（triggerClone 後 ensureTestingBranch）、`merge-agent.js`（多 repo 併 testing + 專案 merge 鎖）、`env-agent.js`（部署前 ensureTestingBranch）、`coding-project.md`（多 repo commit + {{repo_list}}）。測試：`git.test.js`、`runner.test.js`、`merge-agent.test.js`（此檔還在，untracked）。目標全套 jest 綠。

**⚠️ 這次教訓**：Phase 1 全程未 commit，被一次 reset 清光。**這次重做完 Phase 1 就先 commit**（開 feature 分支），別再累積大量未提交變更。

## 2. 關鍵事實（實作前必知）

- **測試環境已由使用者建立**（每專案一個長期 Odoo）。URL 在 `odoo_envs.url`（`http://localhost:<port>`），`odoo_envs.status='running'`。已 seed 系統使用者到 Odoo（密碼互通、admin 權限）→ Playwright 用系統 admin 帳密登入。
- **分支模型**：主 clone 常駐 `testing`；任務 worktree 在 `.worktrees/<task_id>/<repo>` 跑 `task/<id>`；併 testing 在主 clone。
- **agent subprocess 契約**：agent 結尾輸出 `---RESULT-JSON---\n{...}\n---END-RESULT---`，由 `task-agent.js` 的 `parseResult` 解析。agent 定義在 `.claude/agents/<name>.md`，`agent-loader.loadAgent(name).render(vars)` 以 `{{placeholder}}` 注入。
- **狀態機**在 `runner.js` `processTask`（各 stage 一個 if 區塊，`_inFlight` 防重入）；runnable 狀態列在 `RUNNABLE_STATUSES`。
- **needs-action（人工）狀態**：加進 `tasks-routes.js` `NEEDS_ACTION_STATUSES` + 前端 `TaskList.js`/`TaskDetail.js`/`socket.js` 標籤。
- **db migration**：`db.js` 的 `colMigrations` 陣列加一列（idempotent，查 information_schema）。

## 3. ⚠️ 已知介面缺口（先解）

`claude-runner.callClaude(prompt, signal, opts)` **不支援 cwd**。`task-agent.js` 的私有 `spawnClaude` 支援 cwd（`spawn('claude', args, { cwd })`）。Phase 2 的 e2e-agent 需在測試工作區（cwd）跑 agent。
→ **先把 `task-agent.js` 的 `spawnClaude` 抽成共用模組**（例如 `pipeline/claude-spawn.js`），task-agent 與 e2e-agent 共用。抽取時不改行為，跑 `task-agent` 相關測試確認無回歸。

## 4. Phase 2 實作順序（每步附測試）

1. **db**：`db.js` colMigrations 加 `tasks.e2e_retry_count INTEGER DEFAULT 0`。
2. **抽 spawnClaude**（見 §3）。
3. **`.claude/agents/test-e2e.md`**：輸入 analysis.yaml / env URL / admin 帳密 / 測試工作區 / 重試失敗報告；動作＝寫 `.spec.ts` → `npx playwright test --reporter=json` → 讀結果；輸出 RESULT-JSON（`status: passed|failed|error`, `report_path`, `failures`）。
4. **`env-agent.js` `redeployEnv(projectId)`**：env 已存在 → 模組 `-u` 升級 + 重啟（非完整重建）；組指令參考現有 `runEnvSetup` 的 addonsPath/odooDbArgs。
5. **`pipeline/e2e-agent.js` `runE2ETesting(taskId, userId, signal)`**：取 env URL/帳密 → 確保測試工作區 `odoo-envs/<專案>/tests/<task_id>/` → spawn test-e2e（cwd=工作區）→ 解析：
   - passed → `deploy_ready`（Phase 3 會改 review_pending），reset e2e_retry_count。
   - failed → e2e_retry_count < 3 → `coding_running` + count+1 + 存失敗報告；≥3 → `stopped` + blocker。
   - error → `stopped` + blocker「測試環境/執行錯誤」（不進失敗迴圈）。
6. **`runner.js`**：`ai_testing` case 呼叫 `runE2ETesting`（比照 merge 的 `_inFlight`）；`merge_running` 成功後改導向「redeployEnv → ai_testing」而非直接 deploy_ready；coding 成功轉態改走 merge（現為 `qa_running`）。
7. **`coding-project.md`**：加「若為修正輪，依 `{{test_failures}}` 修正」段 + placeholder；`buildCodingPrompt` 注入失敗報告。
8. **`pipeline-routes.js`**：merge_conflict 人工解完 re-entry 從 `deploy_ready` 改導向 redeploy→ai_testing。
9. **infra**：`app/package.json` 加 `@playwright/test`；文件註記一次性 `npx playwright install chromium`。
10. **驗證**：用已建好的專案測試環境，實跑一次 ai_testing，觀察 .spec 產生、playwright 執行、報告與狀態轉換。

## 5. Phase 3 實作順序（每步附測試）

1. **狀態/標籤**：新增 `review_pending`、`archive_pending`、`archived`；加進 NEEDS_ACTION 與前端標籤。
2. **Phase 2 落點改**：ai_testing PASS 由 `deploy_ready` 改 `review_pending`。
3. **後端路由**：
   - `POST /api/tasks/:id/approve-review`（驗 review_pending）→ 逐 repo `mergeToMain(mainRepo, task/<id>)` → checkout 回 testing → `archive_pending`。
   - `POST /api/tasks/:id/archive`（驗 archive_pending）→ 封存動作 → `archived`。
4. **封存動作**（`pipeline/archive-agent.js` 或 route 函式）：產物複製到 `backup/<YYYY-MM>/<task_id>/`（analysis.yaml + 測試工作區 + log）；逐 repo `removeWorktree` + `deleteBranchLocal`（存在才做）；`UPDATE tasks SET status='archived'`（其他不動）。`BACKUP_BASE = process.env.BACKUP_BASE_DIR || <app>/../backup`。
5. **前端**：`TaskDetail.js` 加「人工審核通過」「封存」按鈕。
6. **併 main 細節**：`getMainBranch` 判 main/master → checkout → `merge --no-ff task/<id>` → **checkout 回 testing**；衝突不自動解、留 review_pending 交人工。
7. **驗證**：真環境跑完整條 coding→testing→ai_testing→審核→併main→封存，確認 backup 生成、worktree 清除、main 有該 task commit。

## 6. 測試與慣例

- 單元測試：`jest.mock('../pipeline/git')`、pg-mem（`db._setPoolForTesting`）、`jest.mock('../notify')`。參考 `runner.test.js`、`merge-agent.test.js`。
- Rule 9：測意圖（例：失敗迴圈達上限才 stopped；封存後 DB 只改 status）。
- Playwright 本體不進單元測試；用真環境手動驗（環境已存在）。
- 每完成一段跑 `npx jest`（app 目錄），保持全綠。
