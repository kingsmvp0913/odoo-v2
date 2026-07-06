# Pipeline 重新設計 — Design Spec

- 日期：2026-07-06
- 範圍：`app/server` 任務 pipeline 狀態機、agent、cron、前端按鈕、schema
- 實作路徑：路徑 A（就地重構 `runner.js` 狀態機，沿用現有基礎設施；順手把 `processTask` 整成 handler map）

## 1. 背景與問題

現有 pipeline 的自動流程在 coding 完成後就斷了，斷在兩處：

1. **`confirm_answered` 是孤兒**：使用者在 `confirm_pending` 回答後，狀態設為 `confirm_answered`，但沒有任何地方消費它（triage 只抓 `new`、runner 的 `RUNNABLE_STATUSES` 不含它）→ 任務卡死。
2. **`qa_running` 是死路 stub**：`runner.js` 把所有 `qa_running` 直接打成 `stopped`「QA 功能尚未實作」→ coding 成功後必然撞死，永遠到不了 merge / deploy / wiki。

此外 `merge_running`、`deploy_pending` 在生產環境沒有自動入口（僅測試 fixture 或自我循環），`triage` 與 `cs-agent` 分類職責高度重疊。

本設計依 `.claude/tools/ppt/workflow.mmd`（舊版藍圖）重建完整流程，並依使用者需求把「人工審核」挪到最後、在審核前插入「部署測試區 + Playwright E2E」。

## 2. 目標流程（狀態機）

```
new
 └─(cs-agent 分類)
      ├─ 純操作 ──────────────► cs_reply_pending ──(人工確認)──► done
      ├─ 描述不清 ────────────► cs_data_needed ──(使用者補充)──► cs_running ──(重新分類)─┐
      ├─ 明確要改 + 沒綁專案 ─► stopped                                                  │
      └─ 明確要改 + 有綁專案 ─► analysis_running ◄───────────────────────────────────────┘
                                   │  pull main 失敗 ► stopped
              (pull main→分析→SD)  ├─ 待確認/信心低 ► confirm_pending ─(答)─► confirm_answered ─┐
                                   └─ 產 SD 完成 ► branch_pending                              │
                            (worktree: task/<id> 從 main 長)   重新帶答案分析 ◄────────────────┘
                                          ▼
                                   coding_running ◄────────────────────┐
                                          │                            │ 退回（各關卡計數 +1）
                                    (coding agent)                     │ 任一關卡滿 3 ► stopped
                                          ▼                            │
                                     qa_running ──fail─────────────────┤
                                          │ pass                       │
                                          ▼                            │
                                   merge_running                       │
                              (task/<id> 併入 testing)                 │
                                    │        │衝突解不掉               │
                                    │        ▼                         │
                                    │   merge_conflict ─(人工解)─┐     │
                                    │ 成功                       │     │
                                    ▼◄───────────────────────────┘     │
                               deploy_testing ──升級失敗───────────────┤
                          (env-agent 純程式部署 + odoo-bin -u)          │
                                    │ 升級成功                         │
                                    ▼                                 │
                             playwright_running ──fail─────────────────┘
                          (agent 產測試計畫 + 跑 E2E)
                                    │ pass
                                    ▼
                             review_pending ──(人工按「通過」)──► [ task/<id> 併 main + 刪分支 ]
                                                                          │
                                                                          ▼
                                                                   wiki_updating ──► done
                                                                                       │
                                                                (按封存 / 一個月自動) ──► is_hidden
```

### 2.1 狀態增刪對照

| 動作 | 狀態 |
|------|------|
| 新增 | `deploy_testing`、`playwright_running`、`review_pending` |
| 修好孤兒 | `confirm_answered` → 接回 `analysis_running`（帶答案重跑） |
| 接通死路 | `qa_running` → 真做 QA；pass 走 `merge_running` |
| 移除 | `triage_running`/`triage_blocked`、`final_pending` + approve 前置審核、`deploy_pending`/`deploy_fixing`/`deploy_ready`、deploy-fixer（AI 修部署） |
| 入口改 | `new` 直接由 cs-agent 分類（runner 接手，cron 不再叫 triage） |

### 2.2 needs_action 狀態（UI 標記）
`confirm_pending`、`cs_data_needed`、`cs_reply_pending`、`merge_conflict`、`review_pending`、`stopped`

### 2.3 runnable 狀態（runner 自動推進）
`new`、`cs_running`、`analysis_running`、`confirm_answered`、`branch_pending`、`coding_running`、`qa_running`、`merge_running`、`deploy_testing`、`playwright_running`、`wiki_updating`

（`review_pending`、`merge_conflict`、`cs_*`、`confirm_pending`、`stopped` 為人工觸點，不在 runnable。）

## 3. Git 流程

三層分支各司其職：

| 分支 | 角色 |
|------|------|
| `main`/`master` | 生產主線，也是每個 task 的乾淨起點 |
| `testing` | 共用整合測試區，測試 env 跑這條（混合多任務是本職） |
| `task/<task_id>` | 單任務隔離分支，**從 `main` 長出** |

流程：

1. **分析前**：各 repo `git checkout main && git pull origin main`；pull 失敗（origin 不通 / 本地髒 / 衝突）→ `stopped` 等人工。
2. **開分支**：`branch_pending` 為每個 repo 建 worktree，`task/<id>` **從 main 長出**（現有 `runner.js` 寫死 `addWorktree(..., 'testing')` 改為 `main`/`master`，用 `getMainBranch()` 判定）。
3. **coding**：各 repo worktree 內 commit，不 push（沿用 `coding-project` agent）。
4. **QA 通過**：`merge_running` 把 `task/<id>` 逐 repo 併入 `testing`（沿用 `merge-agent`，含自動解衝突）；解不掉 → `merge_conflict` 人工。
5. **部署測試區**：`deploy_testing` 純程式，測試 env 跑 `testing` + `odoo-bin -u`。
6. **審核通過**：`task/<id>` 併入 `main` + 刪分支（沿用 `mergeToMain` + `deleteBranchLocal`）。

## 4. 各階段介面

粗體＝新增；其餘沿用/微調。

### 4.1 cs 分類（現有 `cs-agent.js`，微調）
- 輸入：title / original_text / wiki
- 輸出 4 分類：`operation`→`cs_reply_pending`；`code_change_vague`→`cs_data_needed`；明確要改 → 判斷 `project_id`：**有** → `analysis_running`；**無** → `stopped`（blocker：「需修改程式的任務必須先綁定專案」）
- 由 runner 接手 `new` 與 `cs_running`（`cs_data` 補充後 re-classify）

### 4.2 分析（現有 `runTaskAnalysis`，改）
- 前置：各 repo pull main（§3.1），失敗 → `stopped`
- `confirm_answered` 重入時：把 `task_logs` 最近的澄清 Q&A 併入 prompt（`buildAnalysisPrompt` 增 `clarification` 欄位），重跑分析
- 輸出：待確認/信心低 → `confirm_pending`；產 SD → `branch_pending`

### 4.3 開分支（現有純程式，改）
- worktree base 從 `testing` 改為 `main`/`master`（§3.2）

### 4.4 coding（現有 `coding-project`，不改）
- 輸出 `{"status":"qa_running"}` 或 `{"status":"stopped","error":...}`

### 4.5 **QA agent（新增 `pipeline/qa-agent.js` + `.claude/agents/qa.md`）**
- 型態：AI subprocess（`spawnClaude`，cwd = 任務 worktree），model: sonnet
- 輸入：`analysis_yaml`（SD）+ `git diff main...task/<id>` + odoo_version
- 職責：對照 SD 逐條檢查實作正確性、漏做、Odoo 規則違反（禁 `round()`、view 繼承規範等）
- 輸出契約：
  ```
  ---RESULT-JSON---
  {"verdict":"pass"}
  或 {"verdict":"fail","issues":["…"],"summary":"給 coding 的修正指引"}
  ---END-RESULT---
  ```
- 轉移：pass → `merge_running`；fail → `coding_running`（`qa_retry_count`+1，issues 寫入 task_logs）；無 RESULT-JSON / crash → `stopped`

### 4.6 merge → testing（現有 `merge-agent.js`，不改邏輯）
- 成功 → `deploy_testing`（原本 `deploy_ready`）；衝突解不掉 → `merge_conflict`
- `POST /api/tasks/:id/mark-conflict-resolved`（人工解完）：目標狀態由 `deploy_ready` 改為 `deploy_testing`

### 4.7 **部署測試區（新增 `pipeline/deploy-testing.js`，純程式，不用 AI）**
- per-project 序列鎖（比照 `withProjectMergeLock`）
- 步驟：① 確保測試 env 已啟動（未啟動則 `runEnvSetup`）② 各 repo 主 clone `checkout testing`（已含本任務）③ `odoo-bin -u <SD.module> -d <db> --stop-after-init --addons-path …`
- 判定：exit 0 → `playwright_running`；升級/載入非 0（程式錯）→ `coding_running`（`deploy_retry_count`+1，錯誤進 task_logs）；env 起不來（infra 錯）→ `stopped`

### 4.8 **Playwright agent（新增 `pipeline/playwright-agent.js` + `.claude/agents/playwright.md`）**
- 型態：AI subprocess，model: sonnet
- 輸入：`analysis_yaml`（SD）+ 測試區 URL（`odoo_envs.url`）+ 登入帳密（§6）
- 職責：依 SD 產 E2E 測試計畫 → 寫 Playwright script → 打測試區實跑 → 收結果
- 輸出契約：
  ```
  ---RESULT-JSON---
  {"verdict":"pass","plan":"…","report":"…"}
  或 {"verdict":"fail","plan":"…","report":"哪步失敗、預期 vs 實際"}
  ---END-RESULT---
  ```
- 轉移：pass → `review_pending`；fail → `coding_running`（`pw_retry_count`+1）；無憑證 → `stopped`；無 RESULT-JSON / crash → `stopped`

### 4.9 人工審核（`pipeline-routes.js`，改）
- `POST /api/tasks/:id/approve`：狀態改吃 `review_pending`（原吃 `final_pending`）→ 同步 `mergeToMain(task/<id>→main)` + `deleteBranchLocal` → `wiki_updating`
- 舊的 `deploy_ready` → `merge-to-main` 端點移除（合併時機改到 review 通過）

### 4.10 wiki 更新（現有 `library-agent.js`，不改）
- 更新 wiki → `done`（進 done 時寫 `done_at = NOW()`）

### 4.11 封存
- `POST /api/tasks/:id/archive`（現有，`is_hidden=true`）供「封存」按鈕
- cron 每日掃 `status='done' AND done_at < NOW() - INTERVAL '30 days'` → `is_hidden=true`（冪等）

## 5. Schema 變更（`db.js` colMigrations，全 additive）

| 表 | 欄位 | 用途 |
|----|------|------|
| `tasks` | `qa_retry_count INT DEFAULT 0` | QA 關卡計數 |
| `tasks` | `pw_retry_count INT DEFAULT 0` | Playwright 關卡計數 |
| `tasks` | （複用既有 `deploy_retry_count`） | deploy 關卡計數 |
| `tasks` | `done_at TIMESTAMPTZ` | 進 done 時間，供自動封存 |
| `users` | `password_enc TEXT` | E2E 明文密碼（AES-GCM，§6） |

- 三個關卡計數器**獨立**：任一滿 3 → `stopped`（blocker 註明關卡＋最後失敗原因）。
- `resolve-blocker` 時三計數器全歸 0（現有已重設 `reentry_count`，改為重設三者）。

## 6. E2E 登入憑證機制

問題：`seedOdooUsers` 把使用者灌進測試 Odoo（密碼 hash 互通），但本系統只存 `password_hash`、無明文；Playwright 登入頁需明文。

方案：新增 `users.password_enc`，存 `lib/crypto.encrypt(明文)`（AES-256-GCM，吃 `APP_SECRET`）。

寫入點（所有產生 `password_hash` 之處同步寫 `password_enc`）：

| 接點 | 檔案 |
|------|------|
| 首次建管理員 | `auth.js` `POST /auth/setup` |
| 改密碼 | `auth.js` `PUT /auth/me`（`new_password`） |
| 管理員建用戶 | `admin-routes.js` `POST /api/admin/users` |
| **登入補寫**（既有使用者） | `auth.js` `POST /auth/login`：成功且 `password_enc IS NULL` → 用當下明文補寫 |

取用：任務 `user_id` → `decrypt(password_enc)` + `username` 登入測試區（該 user 已 seed 成 Odoo admin）。
防呆：`password_enc` 仍為 null → Playwright 步驟 `stopped`，訊息「使用者尚未建立 E2E 憑證，請重新登入一次系統」。

## 7. 錯誤處理與邊界

- **退回 vs 停止**：QA fail / 升級非 0 / Playwright fail → 退 `coding_running` 並各自計數；pull 失敗、cs 無專案、agent crash/無 RESULT-JSON、env infra 起不來、無 E2E 憑證 → `stopped`（不退 coding）。
- **中斷**：`qa_running`、`deploy_testing`、`playwright_running` 都註冊進 `_inFlight`（AbortController）並吃 signal；同一任務防重入。
- **同專案序列化**：`deploy_testing` per-project 鎖（不能對同一 testing DB／env 同時升級）。
- **舊狀態遷移**：`db.js` 一次性資料遷移，把卡在 `final_pending`/`deploy_pending`/`deploy_fixing`/`deploy_ready` 的任務改為 `stopped`，blocker 註「流程改版，請人工重新確認」（不猜測自動接續）。

## 8. 檔案異動地圖

| 動作 | 檔案 |
|------|------|
| 刪除 | `pipeline/triage.js`、`.claude/agents/triage.md` |
| 新增 | `pipeline/qa-agent.js`、`pipeline/playwright-agent.js`、`pipeline/deploy-testing.js`、`.claude/agents/qa.md`、`.claude/agents/playwright.md` |
| 修改 | `cron.js`、`runner.js`、`task-agent.js`、`pipeline-routes.js`、`tasks-routes.js`、`db.js`、`notify.js`、`teams.js`、`env-agent.js`、前端任務頁（通過/封存按鈕、狀態標籤） |

## 9. 測試策略（Rule 9：測試編碼「為什麼」）

沿用 `app/server/tests/` 一檔一測、mock `spawnClaude`／`execFile`（git、odoo-bin）慣例：

| 測試 | 驗證意圖 |
|------|---------|
| `qa-agent.test.js`（新） | pass→merge_running；fail→coding+`qa_retry_count`；滿 3→stopped |
| `playwright-agent.test.js`（新） | pass→review_pending；fail→coding+`pw_retry_count`；無憑證→stopped |
| `deploy-testing.test.js`（新） | 升級 exit0→playwright；exit≠0→coding+`deploy_retry_count`；env 起不來→stopped |
| `runner.test.js`（改） | 新轉移、handler map、三計數器獨立、review_pending 不可跑 |
| cs entry（改） | cs 接手 `new`、無專案→stopped |
| `analysis`/`task-agent`（改） | 分析前 pull main、pull 失敗→stopped、confirm_answered 帶 Q&A 重跑 |
| 憑證（新） | setup/改密碼/admin 建戶/登入補寫都寫 `password_enc`；decrypt round-trip；缺→stopped |
| `pipeline-routes`（改） | review_pending 通過→併 main+刪分支+wiki；封存端點；cron 自動封存 |
| 遷移（新） | 舊狀態安全遷移為 stopped |

## 10. 分階段實作順序

1. **骨架**：schema 欄位 + 狀態遷移 + runner handler map + 刪 triage（cs 接 `new`）+ confirm_answered→analysis + 移除 final_pending/deploy-fixer
2. **QA**：qa-agent + qa.md + qa_running 真做
3. **部署測試區**：deploy-testing.js（純程式）
4. **Playwright**：playwright-agent + playwright.md + 憑證機制（password_enc）
5. **審核封存**：review_pending 審核流 + 通過/封存按鈕 + cron 自動封存
6. **git 微調**：pull main、worktree 從 main

每階段 `[Step] → [Verify]`：`npm test`（對應測試）+ 影響檔 `node -c`。
