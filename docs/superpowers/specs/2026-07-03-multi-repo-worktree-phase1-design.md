# 多 Repo Worktree 隔離與 testing 分支流 — Phase 1 設計

- **日期**：2026-07-03
- **狀態**：設計已通過，待寫實作計畫
- **範圍**：Phase 1（結構層）。Phase 2（AI 自動測試）、Phase 3（人工審核 gate + 封存 backup）另立 spec。

---

## 1. 背景與問題

專案（`projects`）底下可掛多個 repo（`project_repos`，同結構 clone 在 `repos/<專案>/<repo-label>/`）。使用者的心智模型是：**掛在專案上的所有 repo 都是任務的處理範圍**，且**同一專案的多個需求要能並行**。

但現有 pipeline 與此不符：

1. **只碰主要 repo**：`getProjectInfo`（`task-agent.js:32`）只 JOIN `is_primary = true` 取單一 `local_path`；analysis / coding agent 的 `cwd` 就是那一個 repo 目錄（`task-agent.js:149`、`:210`）。coding agent prompt 明寫「只能修改當前目錄內的檔案」（`coding-project.md:22`），`git add -A && git commit` 也只在該 cwd 執行。→ 非主要 repo 雖被 clone，但整條 pipeline 不會進去操作。
2. **無法並行**：每個 repo 只有一份共用 working tree。`branch_pending` 對主 clone 做 `checkout master` + `checkout -b task/<id>`（`runner.js:95-96`）。一個 working tree 同時只能停在一個分支，兩個任務會互相把對方的 checkout 抽走 → 同專案並行不可能。

## 2. 目標

- coding agent 的工作範圍＝專案**所有** repo（cwd 改為包含全部 repo 的父目錄）。
- 同專案多任務**並行**、互不干擾。
- 導入 **GitLab Flow（環境分支型）** 分支模型：`task/<id>` → `testing`（整合/測試區）→ `main`。
- `merge`、`env`（測試環境）改為多 repo 感知。

**非目標（Phase 2/3）**：AI 自動測試 stage、人工審核 gate、封存按鈕與 backup 歸檔。本 Phase 只在狀態機留掛勾。

## 3. 採用模式與理由

使用者描述的流程對應成熟的 **GitLab Flow（環境分支）**：feature 分支 → 環境分支（staging）→ main。`testing` 分支＝環境分支，對應單一測試環境 Odoo（現有 `test_<專案>` DB）。並行隔離用 **git worktree**（多個工作副本共用同一 `.git` 物件庫），為業界標準解，不需重複 clone。

## 4. 架構

### 4.1 磁碟結構

```
repos/<專案>/
  odoo-main/                    ← 主 clone，常駐 testing 分支（＝測試環境 addons 來源）
  plugin-hr/                    ← 主 clone，常駐 testing 分支
  .worktrees/
    task_4058/                  ← 任務 4058 父目錄 = coding agent cwd
      odoo-main/                ← worktree，branch = task/4058
      plugin-hr/                ← worktree，branch = task/4058
    task_4059/                  ← 任務 4059，完全隔離
      odoo-main/
      plugin-hr/
```

三種角色：

- **主 clone**（`repos/<專案>/<repo>/`）：常駐 `testing` 分支，永不切走。測試環境 `--addons-path` 掛的就是它（`env-agent.js:59-65` 已掛全 repo，只是目前未鎖分支）。
- **worktree**（`.worktrees/<task_id>/<repo>/`）：每任務每 repo 一個，跑 `task/<id>` 分支，coding agent 在此讀寫。
- **分支**：`task/<id>`（任務）、`testing`（共用整合/測試區）、`main`（正式）。

路徑推導（沿用現有慣例，不寫死絕對路徑）：

- `REPOS_BASE`＝`process.env.REPOS_BASE_DIR || <app>/../repos`（`project-routes.js:8`）。
- 專案根＝`path.dirname(repo.local_path)`（因 `local_path = REPOS_BASE/slug(folder)/slug(label)`）。
- worktree 父目錄＝`path.join(專案根, '.worktrees', task_id)`。

### 4.2 分支流（GitLab Flow）

```
task/<id> ──merge──▶ testing ──部署──▶ 測試環境跑起來
   │                                         │
   │                                  [Phase 2/3 掛勾]
   │
   └── merge task/<id> ──▶ main   （Phase 3，本 Phase 不做）
```

Phase 1 終點：任務併進 `testing`、測試環境部署完成，停在 `deploy_ready` / 部署完成後的掛勾狀態，等 Phase 2 接手。

**併 main 語意（Phase 3 才實作，此處記錄決策）**：測試通過後併進 main 的是 **`task/<id>` 分支本身**，非整個 `testing`。理由：`testing` 是共用整合區，可能含其他尚未驗證完成的任務；只併 task 分支可避免污染 main、讓任務真正獨立上線。

## 5. 狀態機改動

| 狀態 | 現況 | Phase 1 改成 |
|------|------|-------------|
| clone（`triggerClone`）| 只 `git clone` | clone 完後確保 `testing` 分支存在並 checkout（主 clone 常駐 testing）|
| `branch_pending` | 主 clone `checkoutDefault` + `createBranch task/<id>`（`runner.js:95-96`）| 對每個 repo `git worktree add .worktrees/<id>/<label> -b task/<id> testing` |
| `coding_running` | agent cwd = 主 clone（`task-agent.js:210`）| cwd = worktree 父目錄；跨 repo 讀寫；逐 repo commit |
| `merge_running` | `syncWithMain`＝把 main 併進 task 分支（`merge-agent.js:62`）| **改寫**：在主 clone（testing 上）逐 repo `git merge task/<id>`；衝突逐 repo 回報 |
| 部署 | env 掛主 clone（已多 repo）| 不變；主 clone 在 testing → 部署即反映 testing |

## 6. 模組層改動

| # | 檔案 | 改動 |
|---|------|------|
| A | `project-routes.js` `triggerClone`（:53）| clone 成功後：`git checkout testing`，不存在則 `git checkout -b testing`。放在寫 `clone_status='done'` 前。 |
| B | `task-agent.js` `getProjectInfo`（:32）| 回傳專案根（`path.dirname(local_path)`）＋ repo 清單（label + 子目錄名）；不再只取 primary 單一路徑。 |
| C | `git.js`（:99 exports）| 新增 `addWorktree(mainRepoPath, worktreePath, branchName, baseBranch)`＝`git worktree add <wt> -b <branch> <base>`；`ensureTestingBranch(repoPath)`；`mergeInto(mainRepoPath, targetBranch, sourceBranch)`。舊函式保留。 |
| D | `runner.js` `branch_pending`（:86-108）| 取代 checkoutDefault+createBranch：讀專案所有 `clone_status='done'` repo，對每個 `addWorktree(.../<label>, task/<id>, 'testing')`。任一失敗 → 任務 `stopped` + blocker，回滾已建 worktree。 |
| E | `task-agent.js` coding + `coding-project.md` | cwd 改 worktree 父目錄；`buildCodingPrompt` 注入 repo 子目錄清單；prompt commit 步驟改「逐個有變更的 repo 子目錄各自 `git add -A && git commit`（同一 commit message）」；放寬「只能改當前目錄」為「可改本專案任一 repo 子目錄，仍禁 Odoo 原生 / custom_addons」。 |
| F | `merge-agent.js` `runMergeAgent`（:44）| 改多 repo：對每個 repo 在主 clone（testing 上）`git merge task/<id>`。衝突沿用 `resolveConflict` 自動解，失敗進 `merge_conflict`（`merge_conflict_data` 需記錄「哪個 repo 的哪些檔」）。 |
| G | `env-agent.js` | 幾乎不動（已掛全 repo）。防呆：部署前確保主 clone 在 `testing`。 |

> **⚠️ 實作必知（驗證時抓到的真 bug，重做務必包含）**：`git.js` 的 `execFileAsync` 在 reject 時**只丟 err、把 stdout/stderr 丟棄**，導致 `err.stdout`/`err.stderr` 為 undefined。而 `git merge` 的衝突訊息（"CONFLICT / Automatic merge failed"）寫在 **stdout**（非 stderr）。→ 必須改 `execFileAsync`：reject 前 `err.stdout = stdout; err.stderr = stderr;`。`mergeInto` 判斷衝突時三者都要看（`err.stdout` + `err.stderr` + `err.message`）。單元測試要把衝突文字放 stdout 才能守住此路徑（放 stderr 會 false pass）。既有 `syncWithMain` 也有同缺陷，此 helper 修正順帶修好它。

## 7. 並行與鎖

- **coding 完全可並行**：各任務獨立 worktree，不共用 working tree。
- **merge 進 testing 必須同專案序列化**：`merge_running` 寫入共用的主 clone（testing working tree），同專案兩任務同時 merge 會撞同一 working tree。→ 以「專案層 serial lock」放行，一次一個。沿用現有 module serial lock 概念（CLAUDE.md 提及 qa/coding 共用序列鎖）。此為 Phase 1 唯一序列化點，且只在 merge 瞬間，不影響 coding 並行。

## 8. 錯誤處理與邊界

- `git worktree add` 失敗（分支已存在 / 目錄殘留）→ 任務 `stopped` + blocker，回滾已建 worktree，不留半殘狀態。
- merge 進 testing 衝突 → 現有 `merge_conflict` 狀態，逐 repo 列衝突檔。
- `testing` 分支不存在 → `triggerClone` clone 完成時已 `ensureTestingBranch` 保證建立。`branch_pending` **不**再對主 clone `checkout testing`（避免並行建 worktree 時動到共用 HEAD）；若 `testing` 真的缺失，`addWorktree` 以 `testing` 為 base 會失敗 → 任務 `stopped` 並回滾，即為安全網。`env-agent` 部署前另做一次 `ensureTestingBranch` 防呆（`checkout` 到已在的 testing 為 no-op，對進行中的 merge 安全）。
- 失敗 / stopped 任務的 worktree 暫不清（Phase 3 封存才清）；Phase 1 接受 `.worktrees/` 累積。
- **相容性**：平台開發中，無舊資料需遷移（greenfield），不寫遷移邏輯。

## 9. 測試策略（沿用 `jest.mock('../pipeline/git')`）

驗**意圖**（CLAUDE.md Rule 9），非只驗呼叫：

- `git.js`：`addWorktree` / `mergeInto` / `ensureTestingBranch` 參數正確（mock execFile）。
- `getProjectInfo`：回傳專案根 + repo 清單（非單一 primary）。
- `runner` `branch_pending`：對每個 repo 呼叫 `addWorktree`，branch 名 `task/<id>`，base = `testing`；**兩任務的 worktree 路徑相異**（斷言並行隔離）。
- `merge-agent`：多 repo 逐一 merge 進 testing；某 repo 衝突 → `merge_conflict` 且 `merge_conflict_data` 標明 repo。
- `branch_pending` worktree add 失敗 → 任務 `stopped` 且無殘留。

## 10. Phase 2/3 掛勾（本 Phase 不實作，僅留接點）

- **Phase 2（AI 自動測試）**：部署完成後新增 `ai_testing` 狀態——AI 依 `analysis.yaml` 產測試計畫 → 對測試環境執行 → 產報告 → 標註「AI 測試完成」。**測試型態＝模擬使用者的 E2E/UI 測試，用 Playwright** 對部署好的測試環境 Odoo 網頁（`http://localhost:<port>`）實際操作驗證，非 odoo-bin unit test。
- **Phase 3（人工 gate + 封存）**：`review_pending`（人工審核按鈕）→ 通過後 merge `task/<id>` → main → `archive_pending`（封存按鈕）→ worktree remove + 刪 task 分支 + 任務產物（spec + 測試計畫 + 測試報告 + log）搬到 `backup/<年月>/<task_id>/`；封存時 DB 僅改狀態，其他資料不動。
