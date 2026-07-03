# AI E2E 測試（Playwright）— Phase 2 設計

- **日期**：2026-07-03
- **狀態**：設計已通過，待實作
- **前置**：Phase 1（多 repo worktree + testing 分支流）已完成。
- **範圍**：Phase 2（AI 自動測試）。Phase 3（人工審核 gate + 封存 backup）另立 spec。

---

## 1. 目標

任務併進 `testing` 後，pipeline 自動：**依 analysis.yaml 產生 Playwright 測試（模擬使用者操作）→ 對部署好的測試環境執行 → 產報告 → 標註「AI 測試完成」**。測試失敗自動退回 coding 重修（有上限），超過上限交人工。

**非目標（Phase 3）**：人工審核 gate、併 main、封存按鈕、backup 歸檔。

## 2. 現況銜接

- Phase 1 後：coding 完成 → `merge_running`（併進 testing）→ 主 clone 常駐 testing。
- 測試環境（`env-agent.js`）：每專案一個長期 Odoo，掛全 repo 主 clone（在 testing），`odoo_envs.url` = `http://localhost:<port>`，已 seed 系統使用者（密碼互通、admin）。
- Playwright 尚未安裝。`qa-analyst.md` 是**檔案式 pipeline 的靜態程式碼審查**，與本動態 E2E 測試無關，不沿用。

## 3. 狀態機

```
coding_running ──成功──▶ merge_running（併進 testing）
   ▲                        │
   │(fail, <上限)     ┌──────┴───────┐
   │               自動解衝突       無法自動解
   │                  │              │
   │           自動重部署 env     merge_conflict ──▶ 🧑 人工解衝突
   │           (testing, -u 升級)    │(pipeline-routes 解完)
   │                  │              └──────┐
   │             ai_testing ◀───────────────┘（解完 → 重部署 → 測）
   │              │ 產 .spec → npx playwright test → 報告
   │        ┌─────┴─────┐
   │      PASS         FAIL
   │  標註 ai_tested     退回 coding_running（帶測試報告）
   │       │            超過上限 → stopped + blocker 給人工
   │       ▼
   └─  review_pending（Phase 3 掛勾；本 Phase 先停在 ai_tested/deploy_ready）
```

**新狀態**：`ai_testing`（執行中）。PASS 後 Phase 2 先停在既有 `deploy_ready`（Phase 3 會改為 `review_pending`）；`ai_tested` 以旗標/欄位標註「AI 測試完成」。

**merge_conflict re-entry 調整**：現行 `pipeline-routes.js:150` 人工解完把狀態設回 `deploy_ready`；改為導向「重部署 → ai_testing」路徑。

## 4. 元件

### 4.1 test-e2e agent（新增 `.claude/agents/test-e2e.md`）
- **輸入**（由 pipeline render 注入）：analysis.yaml（規格）、env base URL（`odoo_envs.url`）、登入帳密（系統 admin，env 已 seed）、測試工作區路徑、是否為重試輪 + 上一輪失敗報告。
- **動作**：在測試工作區寫 Playwright `.spec.ts`（依規格模擬使用者操作流程）→ 執行 `npx playwright test --reporter=json` → 讀 JSON 結果。
- **輸出契約**：結尾輸出 `---RESULT-JSON---`，含 `status: passed|failed|error`、`report_path`、`failures: [...]`（比照現有 agent subprocess 契約，`task-agent.js` 解析）。

### 4.2 pipeline 執行（新檔 `pipeline/e2e-agent.js`，比照 `task-agent.js`）
- `runE2ETesting(taskId, userId, signal)`：取 env URL/帳密 → spawn test-e2e agent（cwd = 測試工作區）→ 解析結果 → 依 pass/fail 轉狀態。
- 在 `runner.js` `ai_testing` case 呼叫（比照 merge/coding 的 `_inFlight` 保護）。

### 4.3 env 自動重部署（擴充 `env-agent.js`）
- 新增 `redeployEnv(projectId)`：env 已存在時做**模組 `-u <變更模組>` 升級 + 重啟**（非完整 clone/venv/pip 重建），拉最新 testing。
- merge 成功後由 pipeline 觸發（`merge_running` → 重部署 → `ai_testing`）。

### 4.4 測試工作區與報告
- 位置：`odoo-envs/<專案>/tests/<task_id>/`（存 `.spec.ts` + `playwright-report/` + `results.json`）。
- 供 Phase 3 封存搬進 `backup/<年月>/<task_id>/`。

## 5. 失敗迴圈

- FAIL → 退回 `coding_running`，把測試報告（失敗項）注入 coding agent（`coding-project.md` 加「若為修正輪，依失敗報告修正」段 + `{{test_failures}}` placeholder）。
- 每任務計數：新欄位 `tasks.e2e_retry_count`（`db.js` migration 加，預設 0）；每次 FAIL 退回 coding 時 +1。**預設上限 3 次**（常數，可調）。
- 超過上限 → `stopped` + blocker（`blocker.tech` 類），交人工。

## 6. 基礎設施

- `app/package.json` 加 `@playwright/test` devDependency。
- 一次性 `npx playwright install chromium`（系統層；文件註記，非 pipeline 執行時做）。
- CI/測試環境需有 Chromium；缺少時 e2e-agent 回 `error` 並 blocker，不誤判為測試失敗。

## 7. 錯誤處理與邊界

- env URL 不存在 / env 未 running → e2e-agent 回 `error`，任務 `stopped` + blocker「測試環境未就緒」，不進失敗迴圈。
- Playwright 執行超時 → 視為 `error`（環境問題），非測試 FAIL。
- test-e2e agent 未回有效 RESULT-JSON → `stopped` + blocker，比照現有 agent 解析失敗處理。
- 重部署 `-u` 失敗（模組載入錯誤）→ `stopped` + blocker（回饋模組載入錯誤），不進 ai_testing。

## 8. 測試策略（沿用 jest.mock）

驗**意圖**（Rule 9）：
- `e2e-agent`：mock spawn → 解析 passed/failed/error → 對應狀態（`deploy_ready`/`coding_running`/`stopped`）。
- 失敗迴圈：fail 且未達上限 → `coding_running` 且 retry_count+1；達上限 → `stopped`。
- `redeployEnv`：mock execFile → 正確組出 `-u` 升級指令。
- `runner` `ai_testing` case → 呼叫 `runE2ETesting`。
- Playwright 本身不進單元測試（用真 env 手動驗）。

## 9. Phase 3 掛勾（本 Phase 不實作）

- PASS 後由 `deploy_ready` 改為 `review_pending`（人工審核 gate）→ 通過後併 `task/<id>` 進 main → `archive_pending`（封存按鈕）→ backup 歸檔（含本 Phase 產的測試工作區）+ worktree 清理。
