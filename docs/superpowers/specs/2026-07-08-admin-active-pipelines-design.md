# 管理者「進行中 Pipeline 監控」頁面 — 設計文件

日期：2026-07-08
狀態：待實作

## 目標

給**管理者（admin）**一個唯讀為主的監控頁，跨所有使用者列出**當下真正在執行中**的 pipeline task，可依執行時間排序，並可對單一 task 執行「暫停」以 kill 掉正在跑的 agent process。

## 核心決策：什麼叫「真正進行中」

`tasks.status` 顯示 `*_running` **不代表**當下有活著的 process。本系統 pipeline 是 fire-and-forget 派工模型：status 設成 `coding_running` 後，實際執行要靠 cron（每分鐘）或手動觸發 `runPipeline` 才會 dispatch。因此 `*_running` 可能是殘留狀態（等下一次派工、或 server crash 後的孤兒）。

**唯一可靠訊號 = `runner.js` 的 `_inFlight` Map**（`app/server/pipeline/runner.js:28`）。它記錄「已 dispatch、Promise 尚未 finally 回收」的 task，本來就跨所有使用者。本頁一律以 `_inFlight` 為資料來源，**不撈 `status='*_running'`**。

**假設**：pipeline 為單一 Node server process（cron 與 HTTP 同 process），故 `_inFlight` 即全域真相。若日後拆多 process，此機制需改為共享狀態（out of scope）。

## 範圍

**做**：
- Admin-gated 端點：列出真正在跑的 task（含專案、任務、使用者、階段、已執行時間）。
- Admin-gated 端點：暫停並 kill 指定 task 的行程（不綁 owner）。
- 前端 `/admin/pipelines` 頁，簡單表格，依執行時間排序，每列一個「暫停」按鈕，自動刷新。

**不做（YAGNI）**：
- 不顯示殘留 / 卡住（status=`*_running` 但不在 `_inFlight`）的 task。
- 不做歷史紀錄、不做圖表、不做恢復（resume）按鈕。
- 不改 DB schema（`_inFlight` 開始時間存記憶體即可）。
- 不抽共用 status 中文對照（沿用既有「每 view 自帶一份」慣例）。

## 後端設計

### 1. runner.js：記錄 dispatch 開始時間並可查詢

`_inFlight` 目前存 `{ ctrl, userId, promise }`。新增 `startedAt`（`Date.now()`），供計算「這一輪已跑多久」——這是最準的執行時間（`tasks.updated_at` 執行中不更新，不可靠）。

- `dispatchTask`（`runner.js:238-247`）登記 entry 時加入 `startedAt: Date.now()`。
- 新增並 export `getInflightInfo()`，回傳陣列 `[{ taskId, userId, startedAt }, ...]`。
- 既有 `getInflightTaskIds()`、`abortTask(taskId)` 沿用不動。

### 2. 新端點 `GET /api/admin/pipeline/active`

- 權限：`[verifyToken, requireAdmin]`，與既有 `/api/admin/*` 一致（`admin-routes.js`）。
- 邏輯：
  1. `const info = getInflightInfo()`；若空陣列直接回 `[]`。
  2. 以 `info` 的 taskId 陣列查詢：
     ```sql
     SELECT t.id, t.task_id, t.title, t.status,
            t.project_id, p.name AS project_name,
            t.user_id, u.username, u.display_name
     FROM tasks t
     LEFT JOIN projects p ON p.id = t.project_id
     LEFT JOIN users u ON u.id = t.user_id
     WHERE t.id = ANY($1::int[])
     ```
  3. 合併 `startedAt`，計算 `elapsed_ms = Date.now() - startedAt`。
  4. 回傳（依 `elapsed_ms` 由大到小排序，最久的在最上面）：
     ```json
     [{ "id": 12, "task_id": "ODOO-123", "title": "修訂單備註",
        "project_id": 3, "project_name": "ProjA",
        "user_id": 5, "username": "alice", "display_name": "Alice",
        "status": "coding_running", "elapsed_ms": 252000 }]
     ```
- 註：以 `getInflightInfo()` 為準，即使某 task 剛好在查 DB 前被回收，也只是不出現在列表，不會誤報。

### 3. 新端點 `POST /api/admin/pipeline/tasks/:id/pause`

Admin 版的「暫停並 kill」，語意等同既有 `PUT /api/tasks/:id/pause` 的暫停方向，但**不綁 owner**、且為單向（只暫停不 toggle，因為監控頁的目的就是止血）。

- 權限：`[verifyToken, requireAdmin]`。
- 邏輯：
  1. `UPDATE tasks SET is_paused=true, updated_at=NOW() WHERE id=$1`（不加 `user_id` 條件，可跨使用者）。若 `rowCount=0` 回 404。
  2. `abortTask(id)`：觸發 `ctrl.abort()` → `claude-runner.js:108-113` 送 `SIGTERM` 給 child process。
  3. 回傳 `{ ok: true }`。
- 效果：正在跑的行程被 kill；`is_paused=true` 使 `runPipeline` 之後不再派此 task（`runner.js:261` 已過濾 `is_paused=false`）。恢復由任務擁有者循既有 UI（再 toggle 一次 pause）處理，本頁不負責恢復。

## 前端設計

新增一頁，遵循既有「新增 view」四步慣例。

### 檔案

- **新增** `app/public/js/views/AdminPipelines.js`：`window.AdminPipelinesView`。
- **`app/public/index.html`**：依既有順序加 `<script src="/js/views/AdminPipelines.js"></script>`。
- **`app/public/js/app.js`**：
  - routes 加 `{ path: '/admin/pipelines', component: window.AdminPipelinesView, meta: { requiresAuth: true, requiresAdmin: true } }`。
  - 側邊欄在既有 admin 連結區塊（僅 admin 顯示）加 `🚦 進行中 Pipeline` → `/admin/pipelines`。

### AdminPipelinesView 行為

- `data`：`rows: []`、`loading`、`timer`。
- 本地 `STATUS_LABELS`（沿用 `TaskList.js:2-21` 內容的 running 子集即可，含 `coding_running:'開發中'` 等），`statusLabel(s)` 回傳中文，未知則原樣。
- `load()`：`Api.get('admin/pipeline/active')` → `rows`（後端已排序；前端保險起見再依 `elapsed_ms` 由大到小排一次）。
- `mounted`：`load()` 後 `setInterval(load, 3000)`（每 3 秒刷新，監控看板性質）。
- `unmounted`：`clearInterval`。
- `pause(row)`：確認後 `Api.post('admin/pipeline/tasks/' + row.id + '/pause')` → 成功後 `load()`。按鈕加 loading/disabled 防連點。
- 表格欄位：**專案 | 任務 | 使用者 | 目前階段（中文）| 已執行時間 | 操作**。
  - 已執行時間：由 `elapsed_ms` 格式化為 `Xm Ys`（或 `Xh Ym`）。
  - 使用者：優先顯示 `display_name`，無則 `username`。
  - 操作：「暫停」按鈕（呼叫 `pause`）。
- 空狀態：無資料時顯示「目前沒有執行中的 pipeline」。

## 錯誤處理

- `getInflightInfo()` 空 → 端點回 `[]`，前端顯示空狀態。
- 暫停端點 `id` 不存在 → 404；前端跳提示並 `load()` 重整。
- `abortTask` 對已回收的 task 呼叫 → no-op（`_inFlight.get` 回 undefined），安全。
- 非 admin 存取端點 → 403（`requireAdmin`）；前端路由 `requiresAdmin` 亦會先擋並導回首頁。
- 輪詢期間單次 `load()` 失敗 → 保留上一批 `rows`，不清空（避免閃爍），下次輪詢自動恢復。

## 測試

依既有測試慣例（`app/server/tests/*.test.js`）：

- **`GET /api/admin/pipeline/active`**
  - 非 admin → 403。
  - `_inFlight` 為空 → `[]`。
  - `_inFlight` 有跨兩個使用者的 task → 回傳兩列，含各自 `project_name`、`username`、`status`、`elapsed_ms`，且依 `elapsed_ms` 由大到小。
- **`POST /api/admin/pipeline/tasks/:id/pause`**
  - 非 admin → 403。
  - 對他人的 in-flight task 呼叫 → `is_paused` 變 true 且 `abortTask` 被呼叫（以 spy/mock 驗證 `ctrl.abort` 或 `abortTask` 被觸發）。
  - 不存在的 id → 404。
- 測試需編碼「WHY」：admin 版暫停**不受 owner 限制**、且**確實觸發 abort**（不是只改旗標）——這是本功能與既有 `/api/tasks/:id/pause` 的關鍵差異。

## 影響檔案彙整

| 檔案 | 動作 |
|---|---|
| `app/server/pipeline/runner.js` | `dispatchTask` 加 `startedAt`；export `getInflightInfo()` |
| `app/server/admin-routes.js`（或既有 admin 端點所在檔） | 新增 `GET /api/admin/pipeline/active`、`POST /api/admin/pipeline/tasks/:id/pause` |
| `app/public/js/views/AdminPipelines.js` | 新增 view |
| `app/public/index.html` | 載入新 view script |
| `app/public/js/app.js` | 註冊 route + admin 側邊欄連結 |
| `app/server/tests/*.test.js` | 新增上述端點測試 |
