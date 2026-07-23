---
name: debugTask
description: Use when debugging a failed, stuck, or bounced pipeline task by taskId — one-shot gathers task status, retry counters, task_events tail, deploy/E2E logs, Odoo runtime log, and env setup_log; includes a symptom-to-log routing table and odoo-envs lifecycle notes.
---

# debugTask — 任務失敗一站式除錯

## Overview
任務在 pipeline 卡住／失敗／反覆彈跳時，除錯資訊散在 DB 三張表＋三種檔案 log。這個 skill 一道指令拉齊全部，再依「症狀→看哪裡」表定位。**路徑真相來源是 CLAUDE.md §6**——本 skill 只固化「怎麼查」的流程，路徑規則若有變動以 §6 為準。

## 一鍵拉齊

```bash
node .claude/skills/debugTask/gather.js <taskId>            # tasks.id 整數或業務 task_id 皆可
node .claude/skills/debugTask/gather.js <taskId> --events 60 # task_events 多看幾筆
```

輸出依序：任務狀態與彈跳計數 → 專案/環境（含 `setup_log` 尾端）→ 各關最近執行（`token_usage`）→ `task_events` 尾端 → deploy log → e2e log → `odoo.log` 尾端。唯讀，單一來源缺漏不影響其餘區塊。

## 症狀 → 看哪裡

| 症狀 | 先看 | 說明 |
|---|---|---|
| deploy 關失敗／`deploy_retry_count` 升 | deploy log（`data/logs/deploy-task<id>-<n>.log`） | 含 exitCode／stderr／stdout；語法錯、invalid field、view 繼承錯、缺 depends 都在這裡把關 |
| E2E 關失敗／`pw_retry_count` 升 | e2e log ＋ `odoo.log` | tour 斷言失敗看 e2e log；tour 還沒跑就掛看 odoo.log |
| asset bundle 503／頁面白畫面／process 崩潰 | **只有 `odoo.log` 有** | `odoo-envs/<folder>/odoo.log`；每次啟動清空、只留當次執行 |
| 環境建不起來（clone/venv/pip/init/seed） | `odoo_envs.setup_log`（gather 已附尾端） | 專案環境頁「查看建立記錄」同源 |
| 任務停住／`status=stopped`／等人工 | `tasks.blocker_content` ＋ `task_events` 尾端 | agent 的停手原因寫在這 |
| QA 反覆退回（`qa_retry_count` 升） | `task_events` 中 QA 回饋 ＋ `task_rejections`（用 platformDB 查） | 同一問題退多輪＝coding 在整包重寫，看 agentPrompt skill 的契約說明 |
| 某關逾時／aborted | `token_usage.status`（gather 已列） | timeout/aborted/error 與耗時一目了然 |
| 任務附件內容 | `app/uploads/task_<taskId>/`（env `UPLOAD_DIR`） | DB 只存相對路徑 |

深入 SQL 分析（彈跳率、跨任務統計）→ 用 `platformDB` skill。

## odoo-envs 生命週期（環境類問題背景知識）

- **建置流程**：`ensure-env.js` 負責 clone → venv → pip → `odoo-bin -i base` 初始化 `test_<folder>` DB → seed 使用者（`seed_odoo_users.py`）；全程寫入 `odoo_envs.setup_log`。
- **port**：`port-alloc.js` 配發，記在 `odoo_envs.port`；`url` 為完整測試網址。
- **狀態**：`odoo_envs.status`（idle/…）＋ `pid`；常駐 server 崩潰時 `odoo.log` 是唯一 traceback 來源。
- **重啟／重建**：走專案環境頁操作（或 env-routes API）；不要手動去砍 process 或改 DB 狀態欄位。
- `<folder>` = `projects.folder_name`（缺則 `name`），Odoo DB 名固定 `test_<folder>`。

## Common Mistakes
- 拿 `tasks.id`（整數）去查 `token_usage.task_id`（業務 TEXT id）→ 永遠 0 筆。gather.js 已各用對的 key。
- 在 e2e log 找 server 崩潰原因 → 找不到；asset/process 層級的 traceback 只在 `odoo.log`。
- `odoo.log` 每次啟動清空——重啟環境後才去看，上一輪的錯誤已經沒了；先收 log 再重啟。
- 忘了 log 目錄可被 env var 覆寫（`DEPLOY_LOG_DIR`/`E2E_LOG_DIR`/`ODOO_ENV_BASE`）就寫死路徑去找。
