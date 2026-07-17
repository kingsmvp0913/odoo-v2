---
name: platformDB
description: Use when inspecting or querying the aidev pipeline platform's OWN Postgres database — tasks, token_usage (per-stage cost/duration), task_events, bounce/retry counters, prompt_logs, rejections, health checks. For pipeline metrics like bounce rate, per-stage wall-clock, token spend. NOT for remote Odoo project DBs (use getSQL for those).
---

# platformDB — 查平台自己的資料庫

## Overview
平台（`app/`，DB 名 `claude`）把所有 pipeline 執行資料存在自己的 Postgres。要問「彈跳率多高、每關花多久、燒多少 token、任務卡在哪關」都查這裡。**這不是遠端 Odoo 專案 DB**——那個用 `getSQL`。

## 連線（別再重挖）
- 連線字串在 **`data/config.json` 的 `DATABASE_URL`**（目前 `postgres://odoo:***@localhost:5416/claude`，port 5416 不是 5432）。
- **`psql` 不在 PATH**——用隨附的 Node 工具（借 `app/node_modules/pg`）。

```bash
node .claude/skills/platformDB/query.js "SELECT status, COUNT(*) FROM tasks GROUP BY status"
node .claude/skills/platformDB/query.js --json "SELECT ..."      # JSON 輸出
node .claude/skills/platformDB/query.js --file q.sql             # 從檔讀 SQL
```
工具預設**唯讀護欄**（只准 SELECT/WITH/EXPLAIN/SHOW）；這是正式資料，勿寫入。

## 關鍵表（能回答什麼）
| 表 | 用途 / 關鍵欄位 |
|---|---|
| `tasks` | 任務主表。`status`；彈跳計數 `qa_retry_count` / `pw_retry_count`(E2E) / `deploy_retry_count` / `reentry_count`；`coding_session_id` / `coding_resume_count`；`analysis_yaml`、`git_branch`、`is_paused`、`blocker_content` |
| `token_usage` | **每關每次執行一筆**。`agent_type`(analysis/coding/qa/playwright/merge/…)、`model`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_create_tokens`、`duration_ms`、`status`(completed/timeout/aborted/error)、`source`(server/ps1)。⚠ `task_id` 是**業務字串 id（TEXT）**，跨表 join 用它、非 `tasks.id` |
| `task_events` | 終端輸出回放（含階段 marker、失敗原因）。依 `task_id`(整數 FK)、`id` 排序 |
| `prompt_logs` | 最近 100 筆實際送給 claude 的 prompt（稽核用） |
| `task_rejections` / `rejection_items` | 人工審核退回原因與其分類拆解 |
| `classify_samples` | failure-classifier regex 判不出、交 haiku 的樣本 |
| `health_check_runs` / `health_check_findings` | 工作流程健檢執行與診斷 |

完整 schema 見 `app/server/db.js` 的 `migrate()`。

## 常用查詢
```sql
-- 每關耗時與 output 量（float 要 ::numeric 再 ROUND，見下）
SELECT agent_type, COUNT(*) runs,
       ROUND((AVG(duration_ms)/1000.0)::numeric,1) avg_sec,
       ROUND(AVG(output_tokens)) avg_out
FROM token_usage WHERE source='server' AND status='completed'
GROUP BY agent_type ORDER BY runs DESC;

-- 彈跳率：有被退回重跑的任務比例
SELECT COUNT(*) FILTER (WHERE qa_retry_count>0) qa_bounced,
       COUNT(*) FILTER (WHERE pw_retry_count>0) e2e_bounced,
       COUNT(*) total FROM tasks;

-- coding 每任務被跑幾次（彈跳的直接證據）
SELECT task_id, COUNT(*) runs FROM token_usage
WHERE agent_type='coding' AND source='server'
GROUP BY task_id ORDER BY runs DESC;
```

## Common Mistakes
- **`function round(double precision, integer) does not exist`** → Postgres 的 `ROUND(x, n)` 只吃 `numeric`。任何 `AVG()/除法` 結果要先 `::numeric`：`ROUND((AVG(duration_ms)/1000.0)::numeric, 1)`。
- 用 `tasks.id`（整數）去 join `token_usage.task_id`（業務 TEXT id）→ 永遠 0 筆。用業務 `task_id`。
- 連 5432 → 那不是平台 DB。平台在 **5416/claude**。
- 只算 `status='completed'` 會漏掉最貴的情境（失敗重跑）；問成本/牆鐘要含所有 status。
