# 工作流程健檢 agent — 設計文件

日期：2026-07-08
狀態：已核准（brainstorm）
定位：「工作流程健檢 agent」願景的**子專案 2（分析／呈現層）**。子專案 1（退回原因表＋分類 agent，見 `2026-07-08-rejection-tracking-design.md`）提供資料基礎，本專案消費之。

## 背景與目標

現況：平台已累積各 pipeline agent 的執行訊號——`token_usage`（呼叫數/tokens/失敗/duration）、`tasks`（stopped/reentry）、`task_events`（失敗片段）、`rejection_items`（人工退回分類）——但**沒有把這些回饋成「各 agent 表現診斷＋改進建議」的能力**。要看某個 agent 是否常失敗、prompt 該怎麼調，只能人工翻表。

目標：admin 一鍵「健檢」，對每個 pipeline agent 跨全平台聚合近 30 天訊號，各出一份 `{診斷, 嚴重度, 建議 prompt, 理由}`；建議**不自動套用**，admin 審後一鍵帶入現有 agent 編輯器，走既有 `updateAgent` 校驗才生效。

設計定調（使用者拍板）：
- **錨點＝全平台 × 每 agent**：跨所有專案聚合，對每個 pipeline agent 各出一份診斷，不做單一專案 drill-down。
- **落地＝提建議、人工審後套用**：健檢輸出建議 prompt，admin 一鍵帶入 agent 編輯器，經 `PUT /api/admin/agents/:name`（`updateAgent` 契約校驗）才生效，不自動寫檔。
- **model＝opus**：健檢分析強度需求高、每次僅約 10 次呼叫、非常態觸發，成本可接受。
- **存歷史**：`health_check_runs` 多筆保留，可看某 agent severity 隨時間趨勢。
- **UI＝Admin 區新頁**：獨立頁，與用量報表分開。

## 元件

### A. 資料聚合層 `pipeline/health-data.js`

匯出 `buildAgentSummary(agent, { windowDays = 30 })` → 回精簡 JSON 摘要（**餵給 agent 的原料，先在 JS 端聚合壓縮，避免整張表塞進 prompt 燒 token**）。`agent` 為 `listAgents()` 的一筆（含 `name/stage/label/model`）。以 `agent.stage` 對 `token_usage.agent_type` 過濾。

摘要內容（單一 agent、近 `windowDays` 天）：
- **token**（`token_usage WHERE agent_type = stage AND recorded_at >= now()-window`）：`calls`、`total_input/output_tokens`、`avg_duration_ms`、`cache_hit_rate`、`failed_calls`（`output_tokens=0 AND input_tokens=0` 視為失敗記帳，比照 `logFailedUsage` 落帳形態）。
- **tasks**（僅對有對應任務階段的 agent，如 analysis/coding/qa/playwright/merge/deploy-fix）：近窗內經該階段的任務 `stopped` 率、`reentry_count` 分布（min/max/avg）、`blocker_content` 樣本（截斷、取樣 ≤5 筆）、失敗 `task_events.content` 片段（截斷 ≤500 字、取樣 ≤5 筆）。
- **rejections**（僅對 coding/analysis 有意義）：近窗內 `rejection_items` 的 category 分布＋樣本 `description`（≤5 筆）。

單一函式、可獨立單測（mock `query`）。無資料時各欄回 0／空陣列，不丟例外。

### B. 健檢 agent `.claude/agents/workflow-health.md`

frontmatter：`name: workflow-health`、`role: analyzer`、`label: 工作流程健檢`、`model: opus`、`stage: workflow_health`。

輸入 placeholder：
- `{{agent_label}}`：被診斷 agent 的中文 label。
- `{{agent_role}}`：其角色。
- `{{agent_prompt}}`：其**現有 prompt body**（讓健檢 agent 看到現況才能提改進）。
- `{{summary}}`：A 產出的 JSON 摘要字串。

輸出契約（`<result>` 內單一 JSON 物件，走 `parseAgentResult(text, { parse: JSON.parse })`）：
```
<result>
{"diagnosis":"<一段診斷>","severity":"ok|low|medium|high","suggested_prompt":"<完整建議 prompt 或 null>","rationale":"<為何這樣改>"}
</result>
```
- `severity`：`ok`（表現正常無需動）/`low`/`medium`/`high`。
- `suggested_prompt`：若無需改則 `null`；有建議時給**完整可直接帶入編輯器的 prompt body**（非 diff），且必須沿用原 prompt 的 `<result>` 契約與 `{{placeholder}}`（否則帶入後 `updateAgent` 會擋下）。
- `rationale`：對照摘要中哪些訊號得出此建議（Rule 9：可追溯）。

### C. 執行 runner `pipeline/health-check-runner.js`

`runHealthCheck(runId, { windowDays = 30 })`（async、fire-and-forget，由 route 觸發後背景跑）：
- `agents = listAgents().filter(a => a.stage && a.stage !== 'workflow_health')`（動態列舉、排除自己；不寫死清單）。
- 逐一（序列，避免 opus 併發爆量）：
  - `summary = await buildAgentSummary(agent, { windowDays })`。
  - `const ha = loadAgent('workflow-health')`；`runClaude(ha.render({ agent_label, agent_role, agent_prompt, summary: JSON.stringify(summary) }), { model: ha.model })`。
  - `logTokenUsage({ taskId: null, projectId: null }, startedBy, 'workflow_health', usage, durationMs)`。
  - `parseAgentResult` → 驗 `severity ∈ {ok,low,medium,high}`、`diagnosis` 非空 → `INSERT INTO health_check_findings`。
  - 單一 agent 解析/呼叫失敗 → `logFailedUsage(...)` ＋落一筆 `severity='error'`、`diagnosis='健檢失敗：<err>'` 的 finding，**不中斷其他 agent**（best-effort）。
- 全部跑完 → `UPDATE health_check_runs SET status='done', finished_at=now()`。整體例外 → `status='error'`。

### D. API `admin-routes.js`

沿用既有 admin 路由與 fire-and-forget 形態（比照現有 `/api/admin/*` 用 `auth` middleware）：
- `POST /api/admin/health-check { windowDays? }`：建 `health_check_runs`（status='running', started_by=req.user.id, window_days）→ **不 await** `runHealthCheck(runId,...)`（背景跑，錯誤自行落 status='error'）→ 回 `{ runId }`。
- `GET /api/admin/health-check`：回近 N 筆 run 摘要（id/status/window_days/started_by/created_at/finished_at＋findings 數），供歷史列表。
- `GET /api/admin/health-check/:runId`：回該 run ＋其所有 findings（含 suggested_prompt）。

### E. 資料表（`db.js` migrate，冪等）

```
health_check_runs
  id           SERIAL PK
  status       TEXT NOT NULL DEFAULT 'running'  -- running | done | error
  window_days  INTEGER NOT NULL DEFAULT 30
  started_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  finished_at  TIMESTAMPTZ

health_check_findings
  id                SERIAL PK
  run_id            INTEGER NOT NULL REFERENCES health_check_runs(id) ON DELETE CASCADE
  agent_name        TEXT NOT NULL      -- 對應 .claude/agents/<name>.md
  agent_label       TEXT               -- 顯示用快照
  diagnosis         TEXT NOT NULL
  severity          TEXT NOT NULL      -- ok | low | medium | high | error
  suggested_prompt  TEXT               -- nullable，null=無需改
  rationale         TEXT
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
```
索引：`health_check_findings(run_id)`。

### F. 前端 Admin 新頁 `AdminHealthCheck.js`

- 頂部「開始健檢」按鈕（可選視窗天數，預設 30）→ `POST /api/admin/health-check` → 拿 `runId` → 輪詢 `GET /api/admin/health-check/:runId` 直到 status！=running。
- 進行中顯示進度（已完成 findings 數 / agent 總數）。
- 完成後每個 agent 一張卡：`label` ＋ severity badge（配色走 `app.css` CSS 變數／dark-aware，禁寫死淺色底）＋ diagnosis ＋ rationale ＋（若 `suggested_prompt` 非 null）「帶入編輯器」按鈕。
- **帶入編輯器**：導到既有 agent 編輯器（現於 Admin 的 agents 編輯區，`GET/PUT /api/admin/agents/:name`），將 `suggested_prompt` 預填入編輯框；admin 檢視後按儲存 → 走 `updateAgent` 契約校驗（保留 `<result>`／`{{placeholder}}`）才生效。健檢端不直接寫 agent 檔。
- 下方歷史列表：`GET /api/admin/health-check` 列出過往 run（時間／視窗／各 severity 計數），可點開看該次 findings（看趨勢）。

## 測試計畫（Rule 9 驗證意圖）

A `health-data`（mock `query`）：
1. `buildAgentSummary`：給定 token_usage/tasks/rejection_items 假資料，摘要各欄聚合正確（calls/avg_duration/failed_calls/category 分布）。
2. 空資料 → 各欄 0／空陣列，不丟例外。
3. 只聚合視窗內（`recorded_at` 早於窗的列不計）。

C `health-check-runner`（mock `runClaude`／`query`／`loadAgent`）：
4. `runHealthCheck`：遍歷有 stage 的 agents（排除 workflow_health），每個落一筆 finding，最後 run status='done'。
5. 某 agent 解析失敗 → 落 severity='error' finding、`logFailedUsage` 呼叫、**其他 agent 照跑**、run 仍 done。
6. token 以 agent_type='workflow_health' 記帳。

D `route`：
7. `POST /api/admin/health-check` → 建 run（status='running'）、回 runId、背景觸發。
8. `GET /:runId` → 回 run＋findings。
9. 非 admin／未登入 → 401（比照既有 admin 路由守衛）。

E `db.js`：migrate 冪等，兩表與索引建立。

## 範圍與非目標

- **不自動套用**建議：一律經 agent 編輯器 ＋ `updateAgent` 校驗（YAGNI＋安全）。
- **不做單一專案 drill-down**：全平台聚合（使用者定調）。
- **不做排程／cron 自動健檢**：僅 admin 手動按鈕觸發（非常態、opus 成本）。
- **不改 `updateAgent`／agent 編輯器**：帶入編輯器沿用既有 F 契約校驗，本專案只做「預填」。
- 新 agent_type `workflow_health` 需在 `TokenReport` 配色票補一色（小改，附帶）。
