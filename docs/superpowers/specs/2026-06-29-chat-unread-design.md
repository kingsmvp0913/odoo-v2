# Chat 歸屬 + 未讀機制 設計

日期：2026-06-29
分支：feat/wiki-hierarchy

## 目標

讓使用者「送出問題後離開畫面」時，AI 回覆若尚未被閱讀，能在以下兩處即時顯示未讀統計數字：

1. 專案列表（`ProjectList`）的專案卡片與 `💬 Chat` 按鈕。
2. 專案詳情（`ProjectDetail`）的 `💬 開啟 Chat` 按鈕。

同時把 chat 綁定建立者，讓使用者只看到自己建立的對話。

## 現況

- Chat 為同步流程：`POST /api/projects/:projectId/chats/:id/messages` → `chatReply()` 同步呼叫 Claude → 回覆於同一 response 回傳並顯示於當前畫面。使用者與 AI 訊息皆存入 `project_chat_messages`。
- `project_chats` **無 `user_id`**，`GET .../chats` 以 `WHERE project_id=$1` 列出，未依使用者過濾——任何使用者看到該專案下所有人建立的 chat。
- 無任何已讀/未讀狀態欄位。
- Socket 基礎建設已存在：`notify.emitToUser(userId, event, data)` / `notify.emitAll(event, data)`；每個連線於 `io.on('connection')` 時 `socket.join('user:'+userId)`。
- Migration 透過 `db.js` 的 `columnMigrations` 陣列以 `ALTER TABLE ... ADD COLUMN` 方式新增欄位（既有模式）。

## 設計決策（已與使用者確認）

1. **未讀觸發**：維持同步流程不變。AI 回覆一律存進 `project_chat_messages`；若使用者送出後離開畫面，回覆未被標記已讀 → 算未讀。
2. **徽章更新**：AI 回覆存檔後，server 透過 socket 即時推送，徽章立即跳出（不需重整頁面）。
3. **讀取範圍**：chat 綁定建立者後，未讀天然 per-user。以 chat 為單位記錄已讀進度。

## 資料模型

`project_chats` 新增兩欄（加入 `db.js` 的 `columnMigrations` 陣列）：

```
user_id              INTEGER REFERENCES users(id)   -- 建立者（owner）
last_read_message_id INTEGER NOT NULL DEFAULT 0     -- 已讀進度
```

- 某 chat 未讀數 = `project_chat_messages` 中 `role='ai' AND id > last_read_message_id` 的數量。
- 專案未讀總數 = 該專案中「目前使用者擁有」之 chat 的未讀數加總。
- **既有舊 chat**：`user_id` 為 NULL，於 per-user 過濾下不再顯示（視為孤兒）。屬 dev 資料，本次不做回填；若需歸屬可另行處理。

## Server 端變更

### chat-routes.js

- `POST .../chats`：建立時寫入 `user_id = req.userId`。
- `GET .../chats`：`WHERE project_id=$1 AND user_id=$2`；每筆 chat 多回 `unread` 欄位（子查詢計算）。
- `GET .../messages`、`POST .../messages`、`DELETE .../chats/:id`：加歸屬檢查——chat 必須屬於 `req.userId`，否則回 404，避免越權存取他人對話。
- 新增 `POST /api/projects/:projectId/chats/:id/read`：
  - 歸屬檢查後，`UPDATE project_chats SET last_read_message_id = (SELECT COALESCE(MAX(id),0) FROM project_chat_messages WHERE chat_id=$1) WHERE id=$1`。
  - 回傳 `{ projectUnread: N }`（該專案目前使用者的未讀總數），作為前端權威值，自我修正 socket 與 mark-read 的競態。
- `POST .../messages` 內，`chatReply` 完成（AI 回覆已存）後：`notify.emitToUser(req.userId, 'chat:reply', { projectId, chatId })`——只推給 owner。

### project-routes.js

- `GET /api/projects`（列表）與單一專案查詢：response 多帶 `unread_count`，以子查詢加總「目前使用者擁有」之 chat 的未讀 AI 訊息數。供列表與詳情頁初始化徽章。

## Frontend 端變更

### 反應式 store（新增，極小）

`window.UnreadStore = Vue.reactive({ byProject: {} })`
- `byProject[projectId]` = 該專案未讀數。

### socket.js

- 監聽 `chat:reply` 事件 → `UnreadStore.byProject[projectId] = (UnreadStore.byProject[projectId]||0) + 1`。

### ProjectList.js

- `load()` 時以 response 的 `unread_count` 初始化 `UnreadStore.byProject`。
- 卡片與 `💬 Chat` 按鈕顯示 `UnreadStore.byProject[p.id]` 徽章（>0 才顯示）。

### ProjectDetail.js

- `💬 開啟 Chat` 按鈕顯示徽章，初始值來自專案的 `unread_count`，讀取自 `UnreadStore`。

### ProjectChat.js

- 開啟某 chat（`selectChat` / `loadMessages` / 帶 chatId 進入）→ 呼叫 `POST .../read` → 以回傳 `projectUnread` 覆寫 `UnreadStore.byProject[pid]`。
- `send()` 收到回覆顯示後也呼叫 `read`，但以 `beforeUnmount` 設置的旗標保護：若使用者已離開畫面（元件已 unmount）就不標記已讀——這正是未讀產生的關鍵路徑。
- 側欄每筆 chat 顯示 per-chat `unread` 徽章。

## 關鍵流程驗證

- **留在畫面讀完**：`send()` 後 mark-read → 未讀 0。
- **送出後離開**：元件 unmount → 旗標阻止 mark-read → server 仍存回覆 → `emitToUser('chat:reply')` 推送 → 本人列表/按鈕徽章 +1。✅
- **競態自癒**：mark-read 回傳權威 `projectUnread`，覆寫 store，修正 socket 與標記的時序飄移。

## 不做（YAGNI）

- 不改成非同步背景生成（維持現有同步流程）。
- 不做跨使用者共享 chat 的已讀（chat 已綁 owner，未讀天然 per-user）。
- 不回填既有 NULL-owner 舊 chat。
- 不動 token / wiki 等無關邏輯。

## 測試（Rule 9：驗證意圖）

- chat 建立後 `user_id` 正確寫入；他人 `GET .../chats` 看不到。
- 越權存取他人 chat 的 messages / read 回 404。
- AI 回覆後未呼叫 read → `GET /api/projects` 的 `unread_count` = 1；呼叫 read 後 = 0。
- `unread` 子查詢只計 `role='ai'` 且 `id > last_read_message_id`。
