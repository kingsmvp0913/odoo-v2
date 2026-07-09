# 任務內容編輯 ＋ 外部溝通紀錄拆分 — 設計文件

日期：2026-07-09
狀態：已核准

## 背景與目標

現況兩個缺口：

1. **任務詳情頁看不到、也改不了需求內容**——`original_text`（sync 匯入或手動建立時填的需求描述）從未在 `TaskDetail.js` 顯示，也沒有任何 API 可以修改它。
2. **同步進來的聊天紀錄是一坨死文字**——`sync.js` 把 Odoo/eService 該單的 `mail.message` 聊天記錄全部 strip HTML 後串成一行一條，塞進 `original_text` 的 `---message---` 區塊，跟 `---id---`/`---title---`/`---description---` 等欄位混在同一個 TEXT 欄位裡。這造成三個問題：
   - 前端沒地方拆開顯示，永遠是一坨。
   - 只有**首次同步**時寫入（`INSERT ... ON CONFLICT DO NOTHING`），之後該單有新留言也不會再拉近來。
   - 使用者無法在系統內針對該單補充留言，更別說回寫到 Odoo。

目標：
1. 任務在 `new` 狀態（尚未進 pipeline）時，使用者可編輯需求內容。
2. 外部聊天紀錄拆成獨立資料表、逐筆存，前端獨立區塊顯示（新在上），並可透過輸入框追加留言（任何狀態都能加）。
3. 追加的留言可選擇回寫 Odoo/eService 原單據（管理者開關控制，寫「記錄備註」，非公開訊息）。
4. AI 分析／CS 分類等 prompt 組裝時，需求描述＋聊天紀錄動態組回（時間正序），維持現有 agent 看到的上下文不變。
5. 已結束的任務不再增量拉聊天紀錄。

## 元件

### A. 任務內容編輯（`new` 狀態限定）

`PUT /api/tasks/:id`（verifyToken，擁有者限定，比照現有路由用 `user_id = req.userId` 過濾）：
- 任務不存在 → 404。
- `status !== 'new'` → 400（`任務已進入處理流程，無法修改內容`）——一旦進 pipeline，分析／開發已依原內容展開，事後改內容會讓分析結果與實際需求脫節。
- `original_text` 空白 → 400。
- 更新 `original_text`、`updated_at`。

前端 `TaskDetail.js`：新增「需求內容」區塊（放在 detail-meta 下方、blocker 區塊上方）：
- 唯讀時：純文字顯示 `task.original_text || '（無內容）'`。
- `task.status === 'new'` 時顯示「✎ 編輯」按鈕 → 切換成 textarea + 儲存/取消。
- 儲存呼叫 `PUT /api/tasks/:id`，成功後 reload。

**（本節已實作完成，見 `tasks-routes.js` / `TaskDetail.js` / `tasks-routes.test.js`）**

### B. `task_messages` 資料表

```sql
CREATE TABLE IF NOT EXISTS task_messages (
  id             SERIAL PRIMARY KEY,
  task_id        INTEGER NOT NULL REFERENCES tasks(id),
  source         TEXT NOT NULL DEFAULT 'manual',  -- 'sync' | 'manual'
  external_id    TEXT,                             -- Odoo mail.message id（字串化），sync 來源必填，manual 來源 NULL
  author         TEXT,                             -- sync：Odoo 留言顯示不出作者細節，先留 NULL；manual：使用者 display_name
  content        TEXT NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL,              -- sync：mail.message.date；manual：NOW()
  synced_to_odoo BOOLEAN NOT NULL DEFAULT false,     -- manual 留言回寫 Odoo 成功後設 true
  created_at     TIMESTAMPTZ DEFAULT NOW()
)
```

- `CREATE UNIQUE INDEX task_messages_task_external_uq ON task_messages(task_id, external_id) WHERE external_id IS NOT NULL`——同一任務同一 Odoo message 只存一筆，是 sync 增量拉取的 dedup 依據；`external_id IS NULL`（manual 留言）不受此限制，可以有多筆。
- 索引：`task_messages(task_id, occurred_at)` 供列表排序。

`original_text` 之後**只存 ticket 靜態欄位**（`---id---`/`---title---`/`---project---`/`---stage---`/`---description---`，service 來源多一個 `---classification---`），**不再包含 `---message---` 區塊**。

### C. `sync.js` 改動

`syncOdooUser` / `syncServiceUser` 現有邏輯：查詢來源系統「還開著」的單（domain 已過濾 `stage_id.fold=false` / `state in ['draft','open']`——**來源系統已結束的單本來就不會出現在這個列表，不用額外處理**）。

改動：
1. `odooSearchRead` 撈 `mail.message` 時，`fields` 加上 `'id'`（原本只有 `date`/`body`），供 `external_id` 使用。
2. 新單（`existing.rows.length === 0`）：
   - `original_text` 組裝拿掉 `---message---` 區塊。
   - INSERT task 後，把該單所有 `mail.message` 逐筆寫入 `task_messages`（`source='sync'`, `external_id=String(m.id)`, `occurred_at=m.date`, `content=stripHtml(m.body)`）。
3. 既有單（`existing.rows.length > 0`）：
   - 讀出該任務 `status`、`is_hidden`。**`status === 'done'` 或 `is_hidden === true` → 整段跳過**（已結束的任務不再增量拉聊天紀錄，避免無謂 API 呼叫、也避免已完成任務被新訊息重新攪動）。
   - 否則：查詢該任務目前 `task_messages` 裡已有的 `external_id` 集合，把來源新抓到的 `mail.message` 中尚未存在的部分，逐筆 INSERT（`source='sync'`）。
   - 專案自動綁定邏輯（`findProjectBySourceName`）維持不變。
4. `stripHtml` 沿用既有函式，不變。

### D. AI prompt 動態組裝

新增共用函式 `assembleTaskContext(taskId)`，放在 `sync.js` 並 export（與訊息組裝格式的定義權綁在同一檔案，避免格式定義分散兩處）：
- 讀 `tasks.original_text`（此時只有靜態欄位）。
- 讀 `task_messages WHERE task_id = $1 ORDER BY occurred_at ASC`（**時間正序**——維持現有 agent 看到的「先後順序」語意，跟畫面顯示的新到舊倒序是兩回事，不可混用）。
- 組回 `${original_text}\n---message---\n${messages.map(m => \`[${m.occurred_at}] ${m.content}\`).join('\n') || '無訊息內容'}`，格式與現有 `sync.js` 產出的舊格式一致，agent template（`{{original_text}}` placeholder）不需要改。
- `analysis.js`、`pipeline/task-agent.js`（`buildAnalysisPrompt`）、`pipeline/cs-agent.js` 三處原本直接讀 `task.original_text` 餵給 agent 的地方，改呼叫 `assembleTaskContext(taskId)`。**這三處都要改，缺一處就是該 agent 突然看不到聊天紀錄的隱性回歸。**

### E. API：外部溝通紀錄

`GET /api/tasks/:id/messages`（verifyToken，擁有者限定）：
- 回傳 `task_messages WHERE task_id = $1 ORDER BY occurred_at DESC`（新在上，畫面顯示用）。

`POST /api/tasks/:id/messages`（verifyToken，擁有者限定，body `{ content }`）：
- 任務不存在 → 404；`content` 空白 → 400。**不限任務狀態**——溝通紀錄是逐步累積的補充資訊，不影響已存在的內容，跟「編輯需求內容」的鎖定邏輯不同。
- INSERT `task_messages`（`source='manual'`, `author=<目前使用者 display_name>`, `occurred_at=NOW()`）。
- 若 `teams_settings.writeback_odoo_notes = true` 且任務 `source` 為 `odoo`/`service` 且能解出來源數值 id（`task_id` 欄位 regex `/(\d+)$/`）：
  - 憑證解析比照 `sync.js` 現有 `syncUser()` 的 settings 合併邏輯（全域 URL/DB 來自 `teams_settings`，帳密來自該使用者 `users.odoo_settings`）；缺憑證視同回寫失敗（best-effort，不擋本地儲存）。
  - best-effort 呼叫 Odoo `call_kw`：`method: 'message_post'`, `model: 'project.task'`（或 `service.question.feedback`）, `args: [sourceNumId]`, `kwargs: { body: content, subtype_xmlid: 'mail.mt_note' }`（= Odoo「記錄備註」，不發送給客戶／不建活動）。
  - 成功：回傳值是新 mail.message 的數值 id → `UPDATE task_messages SET external_id = $1, synced_to_odoo = true WHERE id = $2`。**這一步是關鍵**：把回寫產生的 message 標記回 `external_id`，下次增量同步比對 `external_id` 時就會跳過它，不會被當成「來源新訊息」重複拉回來造成前端出現兩筆一樣的內容。
  - 失敗：忽略錯誤（catch），本地訊息已存不受影響；回應中帶 `writeback_ok: false` 供前端 toast 提示（非阻斷）。
- 回傳新建的 message row（含最終 `synced_to_odoo` 狀態）。

### F. 管理者開關

`teams_settings` 新增欄位：`writeback_odoo_notes BOOLEAN DEFAULT false`（比照 `test_mode` 的 migration 模式，`db.js` 加一行 `ALTER TABLE ... ADD COLUMN`）。

- `teams-routes.js` 的設定 PUT 路由比照 `test_mode` 一起收/存。
- `Admin.js` 設定頁比照 `test_mode` 加一個 switch：「留言回寫 Odoo/eService（記錄備註）」。

### G. 前端 `TaskDetail.js`：外部溝通紀錄區塊

放在「需求內容」區塊下方，獨立卡片：
- 進頁時呼叫 `GET tasks/:id/messages` 載入列表（新在上）。
- 每筆顯示：`author || '（同步）'`、`occurred_at` 格式化時間、`content`；`source==='sync'` 與 `source==='manual'` 可用小標籤區分（比照現有 `roleLabel` 的 emoji 標籤風格）。
- 底部 textarea + 送出按鈕 → `POST tasks/:id/messages` → 成功後把新訊息插入列表最上方（樂觀更新或直接 reload，比照現有 `submitAnswer` 模式用 reload 即可，不需額外做樂觀更新的複雜度）。
- 不限任務狀態顯示／可用。

## 測試計畫（Rule 9 驗證意圖）

A（已完成，見現有 commit）：PUT /api/tasks/:id 的 new/非 new/缺內容三案例。

B `task_messages` 與 sync 增量：
1. 新單同步 → `original_text` 不含 `---message---`，`task_messages` 依 mail.message 逐筆落地，`external_id` 對應 Odoo message id。
2. 既有單（非 done、非 hidden）再次同步、來源多了一則新留言 → 只新增那一筆，既有筆不重複。
3. 既有單但本地 `status='done'` → 再次同步不新增任何 `task_messages`（即使來源有新留言）。
4. 既有單但本地 `is_hidden=true` → 同上，不新增。

C `assembleTaskContext`：
5. 有 `task_messages` 時，組出的文字含正確 `---message---` 區塊、時間正序排列。
6. 無 `task_messages` 時，組出文字為 `無訊息內容`（維持現有 fallback 語意）。

D API：
7. `GET tasks/:id/messages` 回傳新到舊排序。
8. `POST tasks/:id/messages` 缺 content → 400；成功時本地落地一筆 `source='manual'`。
9. `writeback_odoo_notes=false` 時，POST 不觸發任何對外呼叫（mock 驗證未呼叫）。
10. `writeback_odoo_notes=true` 且回寫成功（mock）→ 本地筆 `external_id`/`synced_to_odoo` 依回傳值更新。
11. `writeback_odoo_notes=true` 但回寫失敗（mock 拋錯）→ 本地筆仍成功建立，`synced_to_odoo=false`，API 仍回 200。

E agent 消費點（`analysis.js`／`task-agent.js`／`cs-agent.js`）：
12. 三處呼叫改用 `assembleTaskContext` 後單元測試仍綠（既有 mock 資料補上 task_messages 或維持空陣列驗證 fallback 不壞）。

## 範圍與非目標

- **不做**訊息摘要（AI 先摘要再組進 prompt）——YAGNI，先求正確組裝，摘要留待後續有實際 token 成本壓力再做。
- **不做**回寫 Odoo「發送訊息」（會通知客戶）或「安排活動」——僅「記錄備註」（`mail.mt_note`），符合使用者原始需求。
- **不做**反向把 Odoo 單據狀態（`stage_id`/`state`）同步回本地或由本地改變來源狀態——使用者明確表示「後續會考慮修改 odoo 狀態，但目前先不要」。
- **不做**訊息編輯／刪除——`task_messages` 只增不改（sync 是唯一資料源、manual 是使用者留言，比照 `task_logs` 現有模式不可編輯）。
- **不做**樂觀 UI 更新——送出後直接 reload 列表，比照現有 `submitAnswer`/`csDataSubmit` 模式，簡單一致。
