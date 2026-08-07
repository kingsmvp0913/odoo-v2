# 規格書：任務收件匣（Inbox）

> 目標讀者：在正式機執行本改動的人或 agent
> 前置：**建議在「狀態 Registry」規格（`SPEC-status-registry.md`）階段 3 完成後再做**，理由見 §3.4。未做也能執行，屆時 §3.4 改用手寫名單。

---

## 1. 要解決什麼

目前「輪到你」是 `TaskList.js:144` 的即時篩選：

```js
list = this.tasks.filter(t => NEEDS_ACTION.includes(t.status) && ...)
```

這是**當前狀態的快照**，不是事件流。實際的失效場景：

> 你離開兩小時，回來看到某張任務停在「開發中」——看起來正常。但這兩小時內它可能被 QA 退了一次、重跑、又被部署退一次，現在是第三輪。**畫面上完全看不出來**，除非點進 TaskDetail 翻時間軸。

等到它撞上熔斷變成 `stopped`，token 已經燒完了。收件匣要讓「這張任務在鬼打牆」的察覺時間提前到第二次退回。

---

## 2. 為什麼不用 `task_events`

**`task_events` 存的是整段終端串流**，不是語意事件。寫入點：

- `runner.js:346`、`runner.js:379`
- `deploy-testing.js:204`
- `claude-runner.js:163`（批次 `unnest` 插入整段串流）

專案規則已明載：「`task_events` 不適合當 agent 的輸入資料源——存的是整段終端串流而非失敗片段，噪音大」（`.claude/rules/pipeline.md` 第 96 條）。同理不適合當收件匣來源：一輪 coding 會產生數十到數百筆，全部推進收件匣等於沒有收件匣。

`task_logs` 是時間軸的真相來源（規則 76），但它承載的是對話內容，粒度同樣不對。

**結論：收件匣需要自己的事件寫入點，不複用既有兩張表。**

---

## 3. 設計

### 3.1 兩類事件、兩個掛載點

| 類別 | `kind` | 語意 | 掛載點 | 是否需使用者動作 |
|---|---|---|---|---|
| 要你處理 | `action` | 任務停在需人處理的閘門 | `server/notify.js:38` `_dispatchAction()` | ✅ 是 |
| 鬼打牆訊號 | `bounce` | 被退回／失敗／重試 | `server/pipeline/reentry.js` `bumpReentryOrStop()` | ❌ 資訊性 |

**兩個掛載點都是既有的單一收斂點，不需要散佈埋點：**

- `_dispatchAction` 是「進入需動作狀態」的唯一出口（`notify.js:20` 攔截 `task:updated` 後呼叫）
- `bumpReentryOrStop` 被 `qa-agent.js:290`、`deploy-testing.js:416,465`、`playwright-agent.js:58` 共同呼叫，是所有自動退回的必經之路

> ⚠️ `bumpReentryOrStop` 觸頂時會直接把任務標成 `stopped`，那會另外觸發一筆 `action` 事件。實作時**不要**在觸頂路徑重複寫 `bounce`，否則同一件事在收件匣出現兩次。判斷依據：`bumpReentryOrStop` 的回傳值（`true` = 已觸頂標 stopped）。

### 3.2 新表 `user_inbox`

```sql
CREATE TABLE IF NOT EXISTS user_inbox (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  task_id        INTEGER NOT NULL REFERENCES tasks(id),
  kind           TEXT NOT NULL,              -- 'action' | 'bounce'
  status         TEXT,                       -- 事件當下的任務狀態
  summary        TEXT,                       -- 一行摘要（顯示用）
  read_at        TIMESTAMPTZ,                -- NULL = 未讀
  snoozed_until  TIMESTAMPTZ,                -- NULL = 未 snooze
  created_at     TIMESTAMPTZ DEFAULT NOW()
)
```

**遵循既有 schema 規則**（`.claude/rules/db-schema.md`）：

- 所有時間戳一律 `TIMESTAMPTZ`（第 42 條；`TIMESTAMP` 在台灣時區會產生 8 小時落差，「未讀多久」直接誤判）
- 加進 `db.js` 的 `migrate()` DDL 陣列（第 6 行起的框架，`CREATE TABLE IF NOT EXISTS` 冪等）
- 測試建關聯資料要先建父列（第 24 條）——`user_inbox` 有 `users` 與 `tasks` 兩個 FK

建議索引：`(user_id, read_at, created_at DESC)`，收件匣查詢一律帶 `user_id` 與未讀條件。

### 3.3 後端 API

| 端點 | 用途 | 授權 |
|---|---|---|
| `GET /api/inbox` | 取收件匣（預設未讀＋未 snooze，支援 `?all=1`） | `WHERE user_id = req.userId` |
| `POST /api/inbox/:id/read` | 標記已讀 | 同上 |
| `POST /api/inbox/read-all` | 全部標記已讀 | 同上 |
| `POST /api/inbox/:id/snooze` | 延後（body 帶 `until`） | 同上 |

**授權採「只動自己的資料」模式**：`WHERE user_id = req.userId` 已是真正的防護，不需額外 admin 檢查（規則 92）。找不到列時回 404，不要 abort。

新檔 `server/inbox-routes.js`，在 `index.js` 註冊，與既有 route 檔一致。

> ⚠️ **不要讓 pipeline 程式碼 `require` 這支 route 檔**（規則 89）。`reentry.js` 要寫收件匣，共用邏輯抽到 `server/lib/inbox.js`，route 與 pipeline 都引用它。直接 require route 檔會拖進 `auth`，連帶要求 `JWT_SECRET` 才能載入。

### 3.4 與狀態 Registry 的關聯

`_dispatchAction` 目前靠 `notify.js:6-9` 的 `ACTION_STATUSES` 判斷要不要發通知。Registry 完成後（`SPEC-status-registry.md` 階段 3a），那份 Set 已改為 `new Set(HUMAN_STATUSES)`，**本規格直接沿用，不需再列一份名單**。

未做 Registry 也能執行本規格——屆時 `ACTION_STATUSES` 仍是手寫 Set，行為相同，只是少了「新增閘門狀態自動進收件匣」的保證。

### 3.5 即時推送

`notify.js` 已有 socket 基礎設施：`emitToUser` / `notifyAction`（`notify.js:30-35`），前端 `socket.js:36` 已在監聽 `notify:action`。

**寫入收件匣後沿用既有 `notifyAction` 推播即可**，不新增 socket 事件類型。前端收到後把收件匣未讀數 +1。

> ⚠️ 寫收件匣是 DB 寫入，而 `emitToUser` 被 cron tick 呼叫。規則 65：**cron tick 內通知類副作用一律 fire-and-forget**。收件匣寫入必須 `.catch(() => {})`，不可讓它 block 或拋出——`_dispatchAction` 現有的 `.catch(() => {})`（`notify.js:21`）就是這個模式。

---

## 4. 前端

### 4.1 位置

導覽列既有「輪到你」badge（`TaskList.js:151` 的 `needsActionCount` watcher 驅動）。收件匣是**新的一層**，不取代它：

- **badge**（現有）＝「現在有幾張等你」——狀態快照
- **收件匣**（新增）＝「發生過什麼」——事件流

### 4.2 UI 要求

- 未讀項目視覺區隔；點擊 → 跳該任務詳情並標記已讀
- 「全部標記已讀」
- snooze：提供固定選項（1 小時／今天稍後／明天），不做自訂時間選擇器
- `bounce` 類事件連續同一任務時**收合成一則並顯示次數**（「#42 被退回 3 次」），否則鬼打牆的任務會洗版整個收件匣——這正是要凸顯的訊號，不是要淹沒它

### 4.3 前端硬規則（必讀）

依 `.claude/rules/frontend.md`：

- **第 30 條：前端沒有任何自動化測試，改動一律需瀏覽器人工實測，含深色模式**
- **第 31 條**：一律從 `app/public/styleguide.html` 挑 token／共用 class，禁目測填 px、禁寫死顏色
- **第 32 條**：寫死的淺色系顏色在深色模式會維持亮底；語意色走 `app.css` 共用 class（`.pill-danger`／`var(--danger)`）
- **第 33 條**：`app.css` 從未定義 `.btn-secondary`，用它等於裸按鈕
- **第 34 條**：Vue 3 Options API 放在 `computed` 的東西，呼叫端不能加括號（加了直接 TypeError 白畫面）
- **第 35 條**：全域元件仿 `showToast` 模式（全域函式＋reactive state＋App template 渲染 host），載入序須在 `store.js` 後、`app.js` 前
- **第 36 條**：引用前端 helper 前先讀 `api.js`／`dialog.js` 核實（`Api.del` 實際只有 `delete`；`confirmDialog` 只吃物件不吃字串）

動 `app/public` 前先載入 **platformDev** skill。

---

## 5. 實作步驟

| 階段 | 內容 | 驗證 |
|---|---|---|
| 1 | `db.js` 加 `user_inbox` DDL ＋ 索引 | 全跑測試綠 |
| 2 | `server/lib/inbox.js`（寫入邏輯單一來源） | 新增單元測試 |
| 3 | 掛載點 A：`notify.js` `_dispatchAction` 寫 `action` 事件 | 測試：進入 human 狀態產生一筆 |
| 4 | 掛載點 B：`reentry.js` `bumpReentryOrStop` 寫 `bounce` 事件（**排除觸頂路徑**） | 測試：退回產生 `bounce`；觸頂只產生 `action` 不重複 |
| 5 | `server/inbox-routes.js` ＋ `index.js` 註冊 | supertest 覆蓋四個端點與授權邊界 |
| 6 | 前端收件匣 UI | **瀏覽器人工實測，含深色模式** |

階段 1–5 每步都要全跑測試綠再往下。階段 6 無自動測試，靠人工。

**改 `app/server/**.js` 後必須重啟 server**（規則 3）——常駐進程載的是舊碼，不重啟會誤判修法無效。

---

## 6. 測試指令

```bash
cd app && npm run test:quiet 2>&1 | grep -vE '^PASS |^$'
```

不要用 `npm test`（輸出 127K）或 `npx jest`（平行 worker 下 pg-mem 假紅）。

**pg-mem 已知限制**（`.claude/rules/testing.md`，寫測試時會踩到）：

- 第 12 條：`WHERE <serial_pk> = ANY($1::int[])` 永遠查不到既有列——若收件匣批次操作用到，該測試跳過並註解
- 第 17 條：**表在測試間不清空**，寫新測試要假設有殘留資料
- 第 24 條：建關聯資料先建父列（`user_inbox` 有兩個 FK）

**既有紅燈**（乾淨 HEAD 也紅，不要 debug）：`git-integration.test.js` 的 `ensureWorktreeAtMain` 兩支（CRLF）、`vpn-gateway-run.test.js` 的容器那支。其餘紅燈先假設 flaky，單跑複驗才算數。

---

## 7. 風險與回滾

| 風險 | 對策 |
|---|---|
| 收件匣寫入失敗連帶影響通知 | 全部 fire-and-forget `.catch(() => {})`，比照 `notify.js:21` |
| `bounce` 事件洗版 | §4.2 的同任務收合；必要時後端限制同任務同 kind 每 N 分鐘一筆 |
| 觸頂時 `action` 與 `bounce` 重複 | §3.1 的回傳值判斷，階段 4 測試明確覆蓋 |
| 新表無法回滾 | 專案**沒有 drop column／table 機制**（規則 41）。回滾是「程式不再讀寫、表保留」——`git revert` 程式碼即可，空表無害 |

---

## 8. 明確不做

- **不改 `task_events`／`task_logs` 的任何寫入** —— 收件匣是獨立事件流
- **不取代導覽列的「輪到你」badge** —— 兩者語意不同（§4.1）
- **不做 email／推播通知** —— 既有 `registerChannel` 機制（`notify.js:13`）已預留，本規格不動
- **不做跨使用者的收件匣** —— 一律 `WHERE user_id = req.userId`
- **不做自訂 snooze 時間** —— 固定選項即可
