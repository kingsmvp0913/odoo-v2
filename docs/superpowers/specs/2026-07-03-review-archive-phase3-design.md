# 人工審核 gate + 併 main + 封存歸檔 — Phase 3 設計

- **日期**：2026-07-03
- **狀態**：設計已通過，待實作
- **前置**：Phase 1（worktree + testing 分支流）已完成；Phase 2（AI E2E 測試）spec 已定。
- **範圍**：Phase 3（人工審核 gate、併 main、封存按鈕、backup 歸檔）。

---

## 1. 目標

AI 測試通過後，導入**兩道人工 gate**與**封存歸檔**：

1. **人工審核 gate**：`review_pending` 狀態 + 前端「人工審核通過」按鈕。通過才可併 main。
2. **併 main**：審核通過 → 把 `task/<id>` 逐 repo 併進 `main`（在主 clone）。
3. **封存 gate**：`archive_pending` 狀態 + 前端「封存」按鈕。
4. **封存動作**：移除 worktree + 刪 `task/<id>` 分支 + 任務產物歸檔到 `backup/<年月>/<task_id>/`；**DB 僅改狀態，其他資料不動**。

## 2. 現況銜接

- Phase 2 後：ai_testing PASS → 目前落在 `deploy_ready`。Phase 3 改為 PASS → `review_pending`。
- 既有 needs-action 機制（`tasks-routes.js` `NEEDS_ACTION_STATUSES`、前端 `TaskList`/`TaskDetail`）可直接掛新狀態與按鈕。
- git.js 已有 `mergeToMain`、`getMainBranch`、`removeWorktree`、`deleteBranchLocal`（Phase 1 新增）。
- 主 clone 常駐 `testing`；併 main 後須切回 testing（測試環境來源）。

## 3. 狀態機

```
ai_testing PASS
   │
   ▼
review_pending ──🧑「人工審核通過」按鈕──▶ merge_to_main（逐 repo: task/<id> → main）
   │                                          │
 (人工可退回/駁回 → 視需求，本 Phase 先只做通過)  │成功
                                              ▼
                                        archive_pending ──🧑「封存」按鈕──▶ archived
                                                                              │
                                              worktree remove + 刪 task 分支
                                              + 產物搬 backup/<年月>/<task_id>/
                                              + DB status='archived'（其他不動）
```

**新狀態**：`review_pending`、`archive_pending`（皆 NEEDS_ACTION，按鈕驅動）、`archived`（終態）。

## 4. 元件

### 4.1 前端（`TaskDetail.js`）
- `review_pending`：顯示「人工審核通過」按鈕（可附審核備註）→ `POST /api/tasks/:id/approve-review`。
- `archive_pending`：顯示「封存」按鈕 → `POST /api/tasks/:id/archive`。
- 兩狀態加進 `NEEDS_ACTION`（`TaskList.js`、`tasks-routes.js`）與狀態中文標籤（`socket.js`、`TaskDetail.js`、`TaskList.js`）。

### 4.2 後端路由（`pipeline-routes.js` 或 `tasks-routes.js`）
- `approve-review`：驗 `status === 'review_pending'` → 逐 repo `mergeToMain(mainRepo, task/<id>)` 後 checkout 回 testing → `status='archive_pending'`。任一 repo 併 main 失敗 → 回報錯誤、狀態不變（人工重試）。
- `archive`：驗 `status === 'archive_pending'` → 執行封存動作（見 4.3）→ `status='archived'`。

### 4.3 封存動作（新 `pipeline/archive-agent.js` 或 routes 內函式）
- **產物歸檔**：把任務產物複製到 `backup/<YYYY-MM>/<task_id>/`：
  - `analysis.yaml`（來自 `tasks.analysis_yaml`）
  - 測試工作區 `odoo-envs/<專案>/tests/<task_id>/`（Phase 2 產的 .spec + 報告）
  - 任務 log（terminal / pipeline log，若有落地）
- **清理**：對每個 repo `removeWorktree(mainRepo, .worktrees/<task_id>/<repo>)` + `deleteBranchLocal(mainRepo, task/<id>)`。
- **DB**：僅 `UPDATE tasks SET status='archived'`；不刪 row、不動其他欄位、不動 repos/main/testing。
- `BACKUP_BASE = process.env.BACKUP_BASE_DIR || <app>/../backup`（比照 REPOS_BASE / ENV_BASE 慣例）。

## 5. 併 main 細節

- 主 clone 目前在 `testing`。併 main：`getMainBranch` 判定 main/master → checkout 該分支 → `merge --no-ff task/<id>` → **checkout 回 testing**（維持測試環境來源）。
- 併 main 衝突（理論上少見，因已在 testing 驗過）→ 回報錯誤，狀態留 `review_pending`，交人工；不自動解（此為正式線，保守）。
- 只併「該 task 分支」進 main（非整個 testing），符合 Phase 1 決策（避免拖其他未驗證任務上 main）。

## 6. 錯誤處理與邊界

- worktree 已被手動移除 / 分支已刪 → 清理步驟以「存在才做」容錯，不因殘缺報錯。
- backup 目標已存在（重複封存）→ 目標帶時間戳或先檢查 `status`，已 archived 則 no-op。
- 測試工作區不存在（Phase 2 未產或已清）→ 略過該項，記 log，不擋封存。
- 併 main 成功但封存前中斷 → 任務停在 `archive_pending`，可重按封存（冪等）。

## 7. 測試策略（沿用 jest.mock）

- `approve-review`：mock git → 逐 repo `mergeToMain` 呼叫 + checkout 回 testing + 狀態轉 `archive_pending`；非 review_pending → 400。
- `archive`：mock fs/git → 產物複製到 `backup/<年月>/<task_id>/`、worktree/分支清理呼叫、`status='archived'`、DB 其他欄位不動；非 archive_pending → 400。
- 冪等：重複 archive → no-op / 不報錯。

## 8. 依賴關係

- 依賴 Phase 1（worktree/分支）與 Phase 2（`ai_testing` PASS → `review_pending`、測試工作區產物）。
- Phase 2 的「PASS 後落點」需從 `deploy_ready` 改為 `review_pending`（此改動屬 Phase 3 開頭）。
