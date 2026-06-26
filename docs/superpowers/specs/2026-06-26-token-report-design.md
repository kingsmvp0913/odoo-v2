# Token 用量報表 + 專案綁定 + 任務列表強化 — 設計文件

**日期**：2026-06-26
**狀態**：已核准

---

## 目標

1. 在 odoo-v2 web app 新增 Token 用量報表頁面
2. 實作任務同步時自動綁定專案（`tasks.project_id`）
3. 強化任務列表：來源 badge、專案 tag（可點擊）、搜尋加入專案名稱
4. 移除未使用的 `coding_cmd` / `qa_cmd` pipeline 指令功能

---

## 一、專案自動綁定

### 現況

- `tasks.project_id` 欄位存在，但同步時不會自動填入
- `projects` 表無對應 Odoo/Service 專案名稱欄位
- `project_maps` 表孤立（有 API 無前端、無 sync 整合），維持原樣不動

### 新增欄位（column migration）

```sql
ALTER TABLE projects ADD COLUMN odoo_project_name TEXT;
ALTER TABLE projects ADD COLUMN service_respondent_name TEXT;
```

- `odoo_project_name`：對應 Odoo ERP 的 `project_id[1]`（如「鴻久正式」）
- `service_respondent_name`：對應 Service 的 `respondent[1]`（如「ABC 公司」）

### sync.js 自動比對

`syncOdooUser()` 每筆任務插入後：
1. 取出 `task.project_id[1]`
2. `SELECT id FROM projects WHERE odoo_project_name = $1 LIMIT 1`
3. 命中 → `UPDATE tasks SET project_id = $projectId WHERE user_id = $u AND task_id = $key`
4. 未命中 → `project_id` 維持 NULL

`syncServiceUser()` 同理，比對 `service_respondent_name`。

已存在任務（`ON CONFLICT DO NOTHING`）不重新比對；若後來在專案設定新增了對應，需手動觸發或重新同步才生效。

### 刪除專案時同步刪除對應任務

`DELETE /api/projects/:id` 在刪除專案前，先刪除所有 `tasks.project_id = id` 的任務（包含其 task_logs）。

執行順序：
1. `DELETE FROM task_logs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)`
2. `DELETE FROM tasks WHERE project_id = $1`
3. `DELETE FROM projects WHERE id = $1`

全部在同一 transaction 內執行。

### ProjectDetail.js 新增欄位

專案詳細頁「設定」區塊，新增兩個可編輯欄位：
- Odoo 專案名稱（`odoo_project_name`）
- 客服來源名稱（`service_respondent_name`）

`PATCH /api/projects/:id` 接受這兩個欄位。

---

## 二、任務列表強化（TaskList.js）

### 來源 badge 化

目前 `source` 以文字 + 超連結顯示。改為 badge 樣式：

```
[Odoo]      → 藍色 badge（有連結時可點開 ERP 頁）
[eService]  → 紫色 badge
```

### 專案 tag

每張任務卡片，在來源 badge 後顯示專案 tag（僅 `project_id` 不為 NULL 時顯示）：

```
[Odoo] [鴻久] → 點擊 tag → router.push('/projects/:project_id')
```

`@click.stop` 防止觸發任務卡片的 openTask。

### 搜尋加入專案名稱

`filteredTasks` computed 的搜尋比對加入 `t.project_name`：

```js
(t.project_name || '').toLowerCase().includes(q)
```

### API 更新

`GET /api/tasks` 的 SQL 加 LEFT JOIN：

```sql
SELECT t.*, p.name AS project_name
FROM tasks t
LEFT JOIN projects p ON p.id = t.project_id
WHERE t.user_id = $1 AND ...
```

---

## 三、移除 coding_cmd / qa_cmd

### 移除範圍

| 項目 | 動作 |
|---|---|
| `users` 表 `coding_cmd`、`qa_cmd` 欄位 | 保留欄位（不做 DROP，避免 migration 風險），僅移除前端顯示與 API 寫入 |
| `pipeline/coding-agent.js` | 刪除檔案 |
| `pipeline/qa-agent.js` | 刪除檔案 |
| `pipeline/runner.js` | 移除 `coding-agent`、`qa-agent` 的 require 與呼叫，`coding_running` 改全走 `task-agent.js` |
| 設定頁前端（Settings.js） | 移除 coding_cmd / qa_cmd 的表單欄位 |
| `PATCH /api/users/:id/settings` 或同等 API | 不再接受 coding_cmd / qa_cmd |

### runner.js 調整後的 coding_running 邏輯

```js
if (status === 'coding_running') {
  const { runTaskCoding } = require('./task-agent');
  const handled = await runTaskCoding(taskId, task.user_id, ctrl.signal);
  if (!handled) {
    // project_id 未設定的任務無法執行 coding，設為 stopped
    await query(
      "UPDATE tasks SET status='stopped', blocker_content='任務未綁定專案，無法執行開發', updated_at=NOW() WHERE id=$1",
      [taskId]
    );
    notify.emitToUser(task.user_id, 'task:updated', { taskId, status: 'stopped' });
  }
}
```

`qa_running` 同樣邏輯，全走 `task-agent.runTaskQa()`（若存在）或停止。

---

## 四、Token 用量追蹤

### 資料流（兩條路徑）

```
路徑 A（Node.js 伺服器端 agent）
  callClaude() / spawnClaude() → result event → usage + durationMs
  → logTokenUsage(taskId/projectId, userId, agentType, usage, durationMs)
  → INSERT token_usage

路徑 B（PS1 pipeline agent，kingsmvpsplan）
  <usage>subagent_tokens: X> in Agent tool result
  → 主 Claude append kingsmvpsplan/log/token_usage.jsonl
  → cron.js 每分鐘 ingest → INSERT token_usage

兩路徑 → token_usage 表 → GET /api/token-report → TokenReport.js
```

### 涵蓋的 agent 類型

| agent_type | 觸發 / 來源 | 追蹤路徑 |
|---|---|---|
| `cs` | cs_running → cs-agent.js | A（callClaude）|
| `triage` | new → triage.js | A（callClaude）|
| `analysis` | analysis_running → analysis.js | A（callClaude）|
| `coding` | task-agent.js（project 任務）| A（spawnClaude 改 stream-json）|
| `qa` | task-agent.js（project 任務）| A（spawnClaude 改 stream-json）|
| `merge` | merge_running → merge-agent.js | A（callClaude）|
| `deploy_fix` | deploy_fixing → deploy-fixer.js | A（callClaude）|
| `wiki` | wiki_updating → library-agent.js | A（callClaude）|
| `chat` | chat-routes → chat-agent.js | A（callClaude）|
| `analysis` / `coding` / `qa` | kingsmvpsplan PS1 pipeline | B（JSONL）|

### DB Schema

```sql
CREATE TABLE token_usage (
  id                   SERIAL PRIMARY KEY,
  task_id              TEXT,                    -- pipeline 任務（可 NULL）
  project_id           INTEGER REFERENCES projects(id) ON DELETE SET NULL,  -- chat 時使用
  user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  agent_type           TEXT NOT NULL,
  input_tokens         INTEGER DEFAULT 0,
  output_tokens        INTEGER DEFAULT 0,
  cache_read_tokens    INTEGER DEFAULT 0,
  cache_create_tokens  INTEGER DEFAULT 0,
  total_tokens         INTEGER GENERATED ALWAYS AS
                         (input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) STORED,
  duration_ms          INTEGER,
  source               TEXT DEFAULT 'server' CHECK (source IN ('server', 'ps1')),
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_token_usage_recorded_at ON token_usage (recorded_at DESC);
CREATE INDEX idx_token_usage_task_id     ON token_usage (task_id);
CREATE INDEX idx_token_usage_user_id     ON token_usage (user_id);
CREATE INDEX idx_token_usage_project_id  ON token_usage (project_id);
```

### claude-runner.js 修改

```js
// result event 處理
if (ev.type === 'result') {
  resultText = ev.result || resultText;
  usage     = ev.usage      || null;   // 新增
  durationMs = ev.duration_ms || null;  // 新增
}
// resolve 改為
resolve({ text: resultText.trim(), usage, durationMs });
```

### task-agent.js 修改

`spawnClaude()` 改用 `--output-format stream-json`，解析 result event 取 usage。

### token-logger.js（新增）

```js
const { query } = require('../db');

async function logTokenUsage(ref, userId, agentType, usage, durationMs) {
  // ref: { taskId } 或 { projectId }
  await query(
    `INSERT INTO token_usage
       (task_id, project_id, user_id, agent_type,
        input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
        duration_ms, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'server')`,
    [ref.taskId || null, ref.projectId || null, userId, agentType,
     usage?.input_tokens || 0, usage?.output_tokens || 0,
     usage?.cache_read_input_tokens || 0, usage?.cache_creation_input_tokens || 0,
     durationMs || null]
  );
}

module.exports = { logTokenUsage };
```

### cron.js 新增 ingest（路徑 B）

```js
async function ingestTokenUsageJSONL() {
  const jsonlPath = path.join(PLAN_DIR, 'log', 'token_usage.jsonl');
  if (!fs.existsSync(jsonlPath)) return;
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return;
  for (const line of lines) {
    try {
      const { task_id, agent_type, tokens, duration_ms, ts } = JSON.parse(line);
      const { rows: [task] } = await query(
        'SELECT user_id FROM tasks WHERE task_id = $1 LIMIT 1', [task_id]
      );
      await query(
        `INSERT INTO token_usage
           (task_id, user_id, agent_type, input_tokens, duration_ms, source, recorded_at)
         VALUES ($1,$2,$3,$4,$5,'ps1',$6)`,
        [task_id, task?.user_id || null, agent_type, tokens,
         duration_ms || null, ts ? new Date(ts) : new Date()]
      );
    } catch {}
  }
  fs.writeFileSync(jsonlPath, '');  // 全部處理後清空
}
```

### CLAUDE.md 新增規則（路徑 B）

在 `## 7. Pipeline` 段落後新增 token 記錄規則：

每次 `[CLAUDE-ACTION-REQUIRED]` 所有 agent 完成後，從每個 agent result 的 `<usage>` 區塊提取資料，append 到 `kingsmvpsplan/log/token_usage.jsonl`：

```json
{"task_id":"task_odoo_4060","agent_type":"coding","tokens":18474,"duration_ms":2898,"ts":"2026-06-26T12:00:00.000Z"}
```

- 若 agent result 無 `<usage>` 區塊則略過
- `agent_type`：對應 stage（analysis / final / coding / qa）

---

## 五、Token 報表 API

### `GET /api/token-report`

Auth：`verifyToken`（所有登入用戶）
權限：一般用戶只看自己；admin 可加 `all=true` 看全部

Query params：
- `start`（預設 30 天前）、`end`（預設今天）
- `project_id`（INTEGER，對應 `projects.id`）
- `task_id`（TEXT，精確比對）

回傳：
```json
{
  "summary": { "total_tokens": 0, "total_tasks": 0, "avg_tokens_per_task": 0 },
  "by_agent":   [{ "agent_type": "cs", "tokens": 0 }],
  "by_project": [{ "project_id": 1, "project_name": "鴻久", "tokens": 0 }],
  "daily":      [{ "date": "2026-06-01", "tokens": 0 }],
  "tasks": [{
    "task_id": "task_odoo_4060",
    "title": "任務標題",
    "project_id": 1,
    "project_name": "鴻久",
    "user_id": 1,
    "username": "alice",
    "total_tokens": 0,
    "agents": [{ "agent_type": "cs", "tokens": 0, "duration_ms": 0 }],
    "last_recorded_at": "2026-06-26T12:00:00Z"
  }]
}
```

---

## 六、Token 報表前端（TokenReport.js）

路由：`/token-report`（`requiresAuth: true`）
Sidebar：「📊 用量報表」

**篩選列**：時間快選（7天 / 30天 / 自訂）、專案下拉（從 `by_project` 動態生成）、任務 ID

**卡片列**（3 張）：總 Token 數 / 任務數 / 平均每任務

**圖表區**（全部 SVG 原生，不引入第三方套件）：
- 圓餅圖 A：Agent 類型分布
- 圓餅圖 B：專案分布
- 折線圖：每日 token 趨勢

**明細表**：任務標題 / 專案 / 用戶 / 總 Token / 最後記錄時間，可展開顯示各 agent 細項，依時間倒序

---

## 七、完整修改清單

### 後端

| 檔案 | 類型 | 說明 |
|---|---|---|
| `app/server/db.js` | 修改 | 新增 token_usage 表 + projects 欄位 migration |
| `app/server/pipeline/token-logger.js` | 新增 | 共用 logTokenUsage |
| `app/server/pipeline/claude-runner.js` | 修改 | callClaude 回傳 `{ text, usage, durationMs }` |
| `app/server/pipeline/task-agent.js` | 修改 | spawnClaude 改 stream-json + logTokenUsage |
| `app/server/pipeline/cs-agent.js` | 修改 | logTokenUsage |
| `app/server/pipeline/analysis.js` | 修改 | logTokenUsage |
| `app/server/pipeline/triage.js` | 修改 | logTokenUsage |
| `app/server/pipeline/merge-agent.js` | 修改 | logTokenUsage |
| `app/server/pipeline/deploy-fixer.js` | 修改 | logTokenUsage |
| `app/server/pipeline/library-agent.js` | 修改 | logTokenUsage |
| `app/server/pipeline/chat-agent.js` | 修改 | logTokenUsage（ref.projectId）|
| `app/server/pipeline/coding-agent.js` | **刪除** | coding_cmd 功能下線 |
| `app/server/pipeline/qa-agent.js` | **刪除** | qa_cmd 功能下線 |
| `app/server/pipeline/runner.js` | 修改 | 移除 coding/qa-agent，coding_running 全走 task-agent |
| `app/server/pipeline/sync.js` | 修改 | 同步時自動比對並填 project_id |
| `app/server/project-routes.js` | 修改 | PATCH 接受 odoo_project_name / service_respondent_name；DELETE 先刪對應任務（transaction）|
| `app/server/token-report-routes.js` | 新增 | GET /api/token-report |
| `app/server/index.js` | 修改 | 註冊 token-report-routes |
| `app/server/cron.js` | 修改 | 新增 ingestTokenUsageJSONL |
| `app/server/task-routes.js`（或同等） | 修改 | tasks 查詢 LEFT JOIN projects，回傳 project_name |

### 前端

| 檔案 | 類型 | 說明 |
|---|---|---|
| `app/public/js/views/TaskList.js` | 修改 | 來源 badge 化 + 專案 tag + 搜尋加專案 |
| `app/public/js/views/ProjectDetail.js` | 修改 | 新增 odoo_project_name / service_respondent_name 編輯欄位 |
| `app/public/js/views/Settings.js` | 修改 | 移除 coding_cmd / qa_cmd 欄位 |
| `app/public/js/views/TokenReport.js` | 新增 | 報表頁面 |
| `app/public/index.html` | 修改 | 引入 TokenReport.js |
| `app/public/js/app.js` | 修改 | 路由 + sidebar 連結 |

### CLAUDE.md

| 檔案 | 說明 |
|---|---|
| `.claude/CLAUDE.md` | 新增路徑 B token 記錄規則（§7 Pipeline 後）|

---

## 不在範圍內

- 歷史資料回補（只記錄規則生效後）
- Token 費用換算
- 匯出 CSV
- `project_maps` 表清理（保留原樣）
- 已同步任務的 `project_id` 回填（需手動重新同步或單獨腳本）
