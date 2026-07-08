# 退回原因表 ＋ 分類 agent — 設計文件

日期：2026-07-08
狀態：已核准
定位：「工作流程健檢 agent」願景的**子專案 1（資料基礎）**。健檢 agent（子專案 2）待本專案上線、資料累積後另開 spec。

## 背景與目標

現況：`review_pending` 只有「審核通過」（`POST /api/tasks/:id/approve`），**沒有結構化的「退回」管道**——審核者想退回只能手動 stop，退回原因不落地、無法回饋 coding、無法統計。

目標：
1. 補上退回動作：審核者可填原因退回，任務自動回 coding 依原因修正。
2. 把退回原因結構化累積，作為未來健檢 agent 分析「各 agent 表現、常見錯誤類型」的資料基礎。

設計原則（依使用者定調）：退回**即時輕量**（自由文字，不卡 reviewer）；分類**另一條線 async**（cron 慢慢整理，一段文本可含多個錯誤，由分類 agent 拆解歸類）。

## 元件

### A. 退回動作（即時）

`POST /api/tasks/:id/reject { reason }`（verifyToken）：
- 驗證 `status === 'review_pending'`，否則 400（比照 approve 的狀態守衛）。
- `reason` 必填、trim 後非空，否則 400。
- 交易性更新任務：
  - `status = 'coding_running'`；
  - `retry_feedback = '[人工退回]\n<reason>'`（比照 QA/E2E fail，coding 重跑據此修正）；
  - `reentry_count = reentry_count + 1`（**只累加做統計，不強制 stopped**——人在迴圈、刻意動作，不套自動 runaway 上限）。
- `INSERT INTO task_rejections (task_id, project_id, user_id, reason, status)`，`status='new'`；`task_id` 存**業務 task_id**（穩定）、`project_id` 取自任務。
- `notify.emitToUser(... status:'coding_running')`。
- 前端 `TaskDetail.js`：`review_pending` 時於「審核通過」旁加「退回」按鈕 → 原因輸入 modal → 呼叫 reject。

### B. 分類 agent（cron 慢慢整理到 B 表）

- `cron.js` 每 tick 呼叫 `classifyPendingRejections()`（best-effort，錯誤不影響其他 cron 工作）：
  - `SELECT ... FROM task_rejections WHERE status='new' ORDER BY id LIMIT N`（小批量，預設 N=3，自我節流；無列即早退，成本近零）。
  - 逐筆跑 `reject-classifier` agent（見下）→ 解析 → 寫 `rejection_items` → `UPDATE task_rejections SET status='classified'`。
  - 單筆解析失敗 → `status='error'`（留痕、不無限重試，避免壞資料每 tick 重跑燒 token）。
- 新 agent `.claude/agents/reject-classifier.md`（`model: haiku`）：
  - 輸入 `{{reason}}`（raw 退回全文）。
  - 輸出：把全文拆成**多個獨立錯誤項**，每項一個物件，包在 `<result>` 內的 JSON 陣列：
    `<result>[{"description":"...","category":"實作錯誤"}, ...]</result>`
  - `category` 僅能是固定集合之一：**實作錯誤 / 規格誤解 / 需求變更 / UI體驗 / 效能 / 其他**。
  - 解析走 F 的 `parseAgentResult(raw, { parse: JSON.parse })`；非陣列或空 → 視為解析失敗。
- token 記帳：分類呼叫以 `logTokenUsage({ taskId, projectId }, ..., 'reject_classify', ...)` 落帳（沿用既有記帳、無成本盲區）。

### C. 資料表

`db.js` migrate 新增兩張表（`CREATE TABLE IF NOT EXISTS`，冪等）：

```
task_rejections
  id          SERIAL PK
  task_id     TEXT                         -- 業務 task_id（穩定，硬刪/重置任務不失真，比照 token_usage）
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL   -- 退回的審核者
  reason      TEXT NOT NULL
  status      TEXT NOT NULL DEFAULT 'new'  -- new | classified | error
  created_at  TIMESTAMPTZ DEFAULT NOW()

rejection_items
  id            SERIAL PK
  rejection_id  INTEGER NOT NULL REFERENCES task_rejections(id) ON DELETE CASCADE
  description   TEXT NOT NULL
  category      TEXT NOT NULL
  created_at    TIMESTAMPTZ DEFAULT NOW()
```

索引：`task_rejections(status)`（cron 撈 new）、`task_rejections(project_id)`、`rejection_items(rejection_id)`。

**刪除/保存政策**：以業務 task_id 為 key、無 FK 到 tasks → 硬刪/重置任務不影響退回統計（與 token_usage 一致，健檢 agent 分析不失真）。

## 測試計畫（Rule 9 驗證意圖）

A 退回動作：
1. review_pending reject → status='coding_running'、retry_feedback 含原因、reentry_count +1、**不為 stopped**。
2. 非 review_pending reject → 400，任務狀態不變。
3. reason 空白 → 400。
4. reject 後 task_rejections 落一列（業務 task_id、project_id、status='new'）。

B 分類（cron／函式層，mock runClaude）：
5. classifyPendingRejections：status='new' 的退回 → 呼叫 classifier → rejection_items 依回傳陣列逐項落地 → task_rejections.status='classified'。
6. classifier 輸出無法解析 → status='error'，不寫 items、不無限重試（下一 tick 不再撈到它）。
7. 無 new 退回 → 不呼叫 runClaude（早退、零成本）。

C：migrate 冪等，兩表與索引建立。

## 範圍與非目標

- **不含**健檢 agent 本身（子專案 2）：本專案只到「結構化累積退回原因」為止。
- 不做月彙總報表 UI／md 生成（屬子專案 2 的分析/呈現層）。
- 分類 category 為固定集合，不做動態自訂（YAGNI）。
- 退回只回 coding_running（不提供退回 analysis／直接 stopped 的分支，YAGNI；最常見情境）。
