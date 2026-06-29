# Chat 歸屬 + 未讀機制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 chat 綁定建立者，並在使用者「送出後離開畫面」時，於專案列表與 chat 按鈕即時顯示未讀 AI 回覆的統計數字。

**Architecture:** 維持同步 chat 流程。`project_chats` 加 `user_id`（owner）與 `last_read_message_id`（已讀進度）。未讀數由「`role='ai'` 且 `id > last_read_message_id`」計算。AI 回覆存檔後 server 以 `notify.emitToUser` 推送 `chat:reply`；前端用一個 `Vue.reactive` store 即時更新徽章。開啟 chat 時呼叫 `read` endpoint 標記已讀並取回權威未讀總數。

**Tech Stack:** Node + Express、PostgreSQL（測試用 pg-mem）、socket.io、Vue 3（global build，無打包）、Jest + supertest。

## Global Constraints

- 不修改 core Odoo 檔案；本功能全在 `app/` 內。
- migration 一律走 `app/server/db.js` 的 `columnMigrations` 陣列（`ALTER TABLE ... ADD COLUMN`），勿改 `CREATE TABLE` 區塊。
- `user_id` 為 nullable（`REFERENCES users(id)`，不加 NOT NULL），既有舊 chat 維持 NULL。
- 讀取範圍 per-user：所有未讀統計與 chat 列表一律以 `user_id = req.userId` 過濾。
- 越權存取他人 chat → 回 404（不可洩漏存在性差異）。
- Server 端 socket 用 `notify.emitToUser(req.userId, ...)`，勿用 `emitAll`。
- 測試指令：`npx jest <檔案路徑>`。
- commit 訊息結尾加上：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## File Structure

- `app/server/db.js` — 加兩筆 column migration。
- `app/server/chat-routes.js` — user 綁定、歸屬檢查、GET chats 帶 unread、新增 read endpoint、socket emit。
- `app/server/project-routes.js` — GET 列表與單一專案 response 帶 `unread_count`。
- `app/server/tests/chat-routes.test.js` — 既有 direct insert 補 `user_id`；新增歸屬/未讀/read 測試。
- `app/server/tests/project-routes.test.js` — 新增 `unread_count` 測試。
- `app/public/js/store.js` — 新增 `window.UnreadStore`。
- `app/public/index.html` — 載入 `store.js`。
- `app/public/js/socket.js` — 監聽 `chat:reply`。
- `app/public/js/views/ProjectList.js` — 初始化 store + 徽章。
- `app/public/js/views/ProjectDetail.js` — 初始化 store + 徽章。
- `app/public/js/views/ProjectChat.js` — markRead + `beforeUnmount` 保護 + 側欄 per-chat 徽章。

---

## Task 1: DB migration — 加 user_id 與 last_read_message_id

**Files:**
- Modify: `app/server/db.js`（`columnMigrations` 陣列，約 257-258 行後）
- Test: `app/server/tests/db-migration.test.js`（新增一個 test）

**Interfaces:**
- Produces: `project_chats.user_id INTEGER (nullable, FK users)`、`project_chats.last_read_message_id INTEGER NOT NULL DEFAULT 0`。

- [ ] **Step 1: 寫失敗測試**

在 `app/server/tests/db-migration.test.js` 末尾新增（若該檔已有 migrate 後的 db setup，沿用其既有 helper；以下為自含寫法，可依檔案現況調整變數名）：

```js
test('project_chats 具有 user_id 與 last_read_message_id 欄位', async () => {
  const { newDb } = require('pg-mem');
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const dbm = require('../db');
  dbm._setPoolForTesting(new Pool());
  await dbm.migrate();

  const { rows: [u] } = await dbm.query(
    "INSERT INTO users (username, password_hash) VALUES ('m1','x') RETURNING id"
  );
  const { rows: [p] } = await dbm.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('P','17.0') RETURNING id"
  );
  const { rows: [c] } = await dbm.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'t',$2) RETURNING id, user_id, last_read_message_id",
    [p.id, u.id]
  );
  expect(c.user_id).toBe(u.id);
  expect(c.last_read_message_id).toBe(0);
  dbm._setPoolForTesting(null);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx jest app/server/tests/db-migration.test.js -t "user_id 與 last_read_message_id"`
Expected: FAIL（`column "user_id" of relation "project_chats" does not exist`）

- [ ] **Step 3: 加 migration**

在 `app/server/db.js` 的 `columnMigrations` 陣列（`wiki_pages.node_type` 那筆之後）加入：

```js
    { table: 'project_chats', col: 'user_id', sql: 'ALTER TABLE project_chats ADD COLUMN user_id INTEGER REFERENCES users(id)' },
    { table: 'project_chats', col: 'last_read_message_id', sql: 'ALTER TABLE project_chats ADD COLUMN last_read_message_id INTEGER NOT NULL DEFAULT 0' }
```

注意：上一筆 `node_type` 結尾需補逗號。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx jest app/server/tests/db-migration.test.js -t "user_id 與 last_read_message_id"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/server/db.js app/server/tests/db-migration.test.js
git commit -m "feat(db): add user_id and last_read_message_id to project_chats

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: chat-routes — user 綁定、歸屬檢查、unread、read endpoint、socket

**Files:**
- Modify: `app/server/chat-routes.js`
- Test: `app/server/tests/chat-routes.test.js`

**Interfaces:**
- Consumes: `project_chats.user_id` / `last_read_message_id`（Task 1）；`verifyToken`（設 `req.userId`）；`notify.emitToUser`。
- Produces:
  - `GET /api/projects/:projectId/chats` → 每筆含 `{ id, title, created_at, unread:number }`，僅回 `user_id=req.userId` 的 chat。
  - `POST /api/projects/:projectId/chats/:id/read` → `{ projectUnread:number }`。
  - 他人/不存在 chat 的 `GET messages` / `POST messages` / `POST read` → 404。
  - `POST .../messages` 成功後 emit `chat:reply` `{ projectId:number, chatId:number }` 給 owner。

- [ ] **Step 1: 更新既有測試的 direct insert 加 user_id（先讓既有測試符合新行為）**

在 `app/server/tests/chat-routes.test.js` 中，將所有 `INSERT INTO project_chats (project_id, title) VALUES ($1, '...')` 改為含 `user_id`：

```js
// 例（每處 direct insert 都比照加 user_id）
const { rows: [chat] } = await dbModule.query(
  "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, '空對話', $2) RETURNING id",
  [projectId, userId]
);
```

涉及測試：`GET messages → empty for new chat`、`POST messages → calls chatReply...`、`POST messages → 400 if content empty`、`DELETE chat → removes it`。

- [ ] **Step 2: 新增歸屬與未讀測試（失敗）**

在 `chat-routes.test.js` 末尾新增：

```js
test('GET chats → 只回自己的 chat', async () => {
  const { rows: [other] } = await dbModule.query(
    "INSERT INTO users (username, password_hash) VALUES ('other','x') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'別人的',$2)",
    [projectId, other.id]
  );
  const res = await request(app).get(`/api/projects/${projectId}/chats`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body.every(c => c.title !== '別人的')).toBe(true);
});

test('GET messages → 他人 chat 回 404', async () => {
  const { rows: [other] } = await dbModule.query(
    "INSERT INTO users (username, password_hash) VALUES ('other2','x') RETURNING id"
  );
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'X',$2) RETURNING id",
    [projectId, other.id]
  );
  const res = await request(app)
    .get(`/api/projects/${projectId}/chats/${chat.id}/messages`).set(auth());
  expect(res.status).toBe(404);
});

test('unread：AI 訊息未讀計入，read 後歸零', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'U',$2) RETURNING id",
    [projectId, userId]
  );
  await dbModule.query(
    "INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1,'user','hi'),($1,'ai','yo')",
    [chat.id]
  );
  let res = await request(app).get(`/api/projects/${projectId}/chats`).set(auth());
  const found = res.body.find(c => c.id === chat.id);
  expect(Number(found.unread)).toBe(1);

  res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/read`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body.projectUnread).toBe(0);

  res = await request(app).get(`/api/projects/${projectId}/chats`).set(auth());
  expect(Number(res.body.find(c => c.id === chat.id).unread)).toBe(0);
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx jest app/server/tests/chat-routes.test.js`
Expected: 新測試 FAIL（`/read` 404 或 `unread` undefined）

- [ ] **Step 4: 改寫 chat-routes.js**

將 `app/server/chat-routes.js` 全檔改為：

```js
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { emitToUser } = require('./notify');

async function getOwnedChat(chatId, projectId, userId) {
  const { rows } = await query(
    'SELECT id, last_read_message_id FROM project_chats WHERE id = $1 AND project_id = $2 AND user_id = $3',
    [chatId, projectId, userId]
  );
  return rows[0] || null;
}

async function projectUnread(projectId, userId) {
  const { rows: [{ unread }] } = await query(
    `SELECT COALESCE(SUM(x), 0) AS unread FROM (
       SELECT (SELECT COUNT(*) FROM project_chat_messages m
                 WHERE m.chat_id = c.id AND m.role = 'ai' AND m.id > c.last_read_message_id) AS x
       FROM project_chats c
       WHERE c.project_id = $1 AND c.user_id = $2
     ) t`,
    [projectId, userId]
  );
  return Number(unread);
}

function registerRoutes(app) {
  app.get('/api/projects/:projectId/chats', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT c.id, c.title, c.created_at,
                (SELECT COUNT(*) FROM project_chat_messages m
                   WHERE m.chat_id = c.id AND m.role = 'ai' AND m.id > c.last_read_message_id) AS unread
         FROM project_chats c
         WHERE c.project_id = $1 AND c.user_id = $2
         ORDER BY c.created_at DESC`,
        [req.params.projectId, req.userId]
      );
      res.json(rows.map(r => ({ ...r, unread: Number(r.unread) })));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:projectId/chats', verifyToken, async (req, res) => {
    try {
      const title = (req.body.title || '').trim() || '新對話';
      const { rows: [chat] } = await query(
        'INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, $2, $3) RETURNING id, title, created_at',
        [req.params.projectId, title, req.userId]
      );
      res.status(201).json(chat);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:projectId/chats/:id', verifyToken, async (req, res) => {
    try {
      await query(
        'DELETE FROM project_chats WHERE id = $1 AND project_id = $2 AND user_id = $3',
        [req.params.id, req.params.projectId, req.userId]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/projects/:projectId/chats/:id/messages', verifyToken, async (req, res) => {
    try {
      const chat = await getOwnedChat(req.params.id, req.params.projectId, req.userId);
      if (!chat) return res.status(404).json({ error: 'Not found' });
      const { rows } = await query(
        'SELECT id, role, content, created_at FROM project_chat_messages WHERE chat_id = $1 ORDER BY created_at ASC',
        [req.params.id]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:projectId/chats/:id/messages', verifyToken, async (req, res) => {
    try {
      const content = (req.body.content || '').trim();
      if (!content) return res.status(400).json({ error: 'content required' });
      const chat = await getOwnedChat(req.params.id, req.params.projectId, req.userId);
      if (!chat) return res.status(404).json({ error: 'Not found' });
      const { chatReply } = require('./pipeline/chat-agent');
      const reply = await chatReply(req.params.projectId, req.params.id, content, req.userId);
      emitToUser(req.userId, 'chat:reply', {
        projectId: Number(req.params.projectId),
        chatId: Number(req.params.id)
      });
      res.json({ reply });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:projectId/chats/:id/read', verifyToken, async (req, res) => {
    try {
      const chat = await getOwnedChat(req.params.id, req.params.projectId, req.userId);
      if (!chat) return res.status(404).json({ error: 'Not found' });
      await query(
        `UPDATE project_chats
         SET last_read_message_id = COALESCE((SELECT MAX(id) FROM project_chat_messages WHERE chat_id = $1), 0)
         WHERE id = $1`,
        [req.params.id]
      );
      res.json({ projectUnread: await projectUnread(req.params.projectId, req.userId) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx jest app/server/tests/chat-routes.test.js`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add app/server/chat-routes.js app/server/tests/chat-routes.test.js
git commit -m "feat(chat): bind chats to owner, add unread + read endpoint + socket emit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: project-routes — response 帶 unread_count

**Files:**
- Modify: `app/server/project-routes.js`（`GET /api/projects` 約 91-99；`GET /api/projects/:id` 約 116-125）
- Test: `app/server/tests/project-routes.test.js`

**Interfaces:**
- Consumes: `project_chats.user_id` / `last_read_message_id`。
- Produces: `GET /api/projects` 每筆與 `GET /api/projects/:id` 皆含 `unread_count:number`（僅計 `req.userId` 擁有的 chat）。

- [ ] **Step 1: 寫失敗測試**

在 `app/server/tests/project-routes.test.js` 末尾新增（沿用該檔既有的 `app` / `token` / `auth` / `dbModule` / `userId` / `projectId` helper；若名稱不同請對應調整）：

```js
test('GET /api/projects → 含 unread_count', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'C',$2) RETURNING id",
    [projectId, userId]
  );
  await dbModule.query(
    "INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1,'ai','r')",
    [chat.id]
  );
  const res = await request(app).get('/api/projects').set(auth());
  const p = res.body.find(x => x.id === projectId);
  expect(p.unread_count).toBe(1);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx jest app/server/tests/project-routes.test.js -t "unread_count"`
Expected: FAIL（`unread_count` undefined）

- [ ] **Step 3: 改 GET /api/projects**

將 `app/server/project-routes.js` 的 `GET /api/projects` handler body 改為：

```js
      const { rows: projects } = await query('SELECT * FROM projects ORDER BY name ASC');
      const { rows: counts } = await query('SELECT project_id, COUNT(*) AS cnt FROM project_repos GROUP BY project_id');
      const countMap = {};
      for (const c of counts) countMap[String(c.project_id)] = Number(c.cnt);
      const { rows: unreadRows } = await query(
        `SELECT c.project_id, COALESCE(SUM(
           (SELECT COUNT(*) FROM project_chat_messages m
              WHERE m.chat_id = c.id AND m.role = 'ai' AND m.id > c.last_read_message_id)
         ), 0) AS unread
         FROM project_chats c
         WHERE c.user_id = $1
         GROUP BY c.project_id`,
        [req.userId]
      );
      const unreadMap = {};
      for (const u of unreadRows) unreadMap[String(u.project_id)] = Number(u.unread);
      res.json(projects.map(p => ({
        ...p,
        repo_count: countMap[String(p.id)] || 0,
        unread_count: unreadMap[String(p.id)] || 0
      })));
```

- [ ] **Step 4: 改 GET /api/projects/:id**

將該 handler 內 `res.json({ ...project, repos });` 之前加入未讀查詢，並改 response：

```js
      const { rows: [{ unread }] } = await query(
        `SELECT COALESCE(SUM(
           (SELECT COUNT(*) FROM project_chat_messages m
              WHERE m.chat_id = c.id AND m.role = 'ai' AND m.id > c.last_read_message_id)
         ), 0) AS unread
         FROM project_chats c
         WHERE c.project_id = $1 AND c.user_id = $2`,
        [req.params.id, req.userId]
      );
      res.json({ ...project, repos, unread_count: Number(unread) });
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx jest app/server/tests/project-routes.test.js`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add app/server/project-routes.js app/server/tests/project-routes.test.js
git commit -m "feat(projects): include per-user unread_count in project responses

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 前端未讀 store + socket 監聽

**Files:**
- Create: `app/public/js/store.js`
- Modify: `app/public/index.html`（在 `api.js` 之後載入 `store.js`）
- Modify: `app/public/js/socket.js`

**Interfaces:**
- Produces: `window.UnreadStore`（`Vue.reactive({ byProject: {} })`）；socket `chat:reply` 事件會將 `byProject[projectId]` +1。

- [ ] **Step 1: 建立 store.js**

`app/public/js/store.js`：

```js
window.UnreadStore = Vue.reactive({ byProject: {} });
```

- [ ] **Step 2: index.html 載入 store.js**

在 `app/public/index.html` 第 22 行 `<script src="/js/api.js"></script>` 之後新增一行：

```html
  <script src="/js/store.js"></script>
```

- [ ] **Step 3: socket.js 監聽 chat:reply**

在 `app/public/js/socket.js` 的 `_socket.on('notify:toast', ...)` 區塊之後（`initSocket` 內）新增：

```js
    _socket.on('chat:reply', (data) => {
      const pid = String(data.projectId);
      window.UnreadStore.byProject[pid] = (window.UnreadStore.byProject[pid] || 0) + 1;
    });
```

- [ ] **Step 4: 手動驗證載入無誤**

Run: `node -e "require('./app/server/index.js'); setTimeout(()=>process.exit(0), 500)"`（確認 server 可啟動，靜態檔不影響）
另以瀏覽器開首頁 → DevTools Console 輸入 `window.UnreadStore` 應為 `{ byProject: {} }` 的 reactive 物件，且無載入錯誤。

- [ ] **Step 5: Commit**

```bash
git add app/public/js/store.js app/public/index.html app/public/js/socket.js
git commit -m "feat(frontend): add UnreadStore and chat:reply socket handler

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 前端徽章 — ProjectList 與 ProjectDetail

**Files:**
- Modify: `app/public/js/views/ProjectList.js`
- Modify: `app/public/js/views/ProjectDetail.js`

**Interfaces:**
- Consumes: `window.UnreadStore`；`GET /api/projects` 的 `unread_count`；`GET /api/projects/:id` 的 `unread_count`。

- [ ] **Step 1: ProjectList — load() 初始化 store**

在 `app/public/js/views/ProjectList.js` 的 `load()` 內，`this.projects = await Api.get('projects');` 之後加入：

```js
        for (const p of this.projects) {
          UnreadStore.byProject[String(p.id)] = p.unread_count || 0;
        }
```

- [ ] **Step 2: ProjectList — 加 unread method**

在 `methods` 內加入：

```js
    unread(id) { return UnreadStore.byProject[String(id)] || 0; },
```

- [ ] **Step 3: ProjectList — Chat 按鈕加徽章**

將 `💬 Chat` 按鈕（約 107 行）改為：

```html
            <button class="btn btn-outline btn-sm" @click="goChat(p.id)">💬 Chat
              <span v-if="unread(p.id)" style="display:inline-block;min-width:16px;padding:0 5px;margin-left:4px;border-radius:8px;background:var(--error,#e5484d);color:#fff;font-size:11px;line-height:16px;text-align:center">{{ unread(p.id) }}</span>
            </button>
```

- [ ] **Step 4: ProjectDetail — load 後初始化 store**

在 `app/public/js/views/ProjectDetail.js` 取得 project 的載入流程中（取得 `this.project` 後），加入：

```js
        UnreadStore.byProject[String(this.project.id)] = this.project.unread_count || 0;
```

（若 load 邏輯在某 method 內，請放在 `this.project = ...` 賦值之後。）

- [ ] **Step 5: ProjectDetail — 加 unread computed/method 與按鈕徽章**

在 `methods` 加入：

```js
    unreadCount() { return this.project ? (UnreadStore.byProject[String(this.project.id)] || 0) : 0; },
```

將 `💬 開啟 Chat` 按鈕（約 201 行）改為：

```html
            <button class="btn btn-outline btn-sm" @click="goChat">💬 開啟 Chat
              <span v-if="unreadCount()" style="display:inline-block;min-width:16px;padding:0 5px;margin-left:4px;border-radius:8px;background:var(--error,#e5484d);color:#fff;font-size:11px;line-height:16px;text-align:center">{{ unreadCount() }}</span>
            </button>
```

- [ ] **Step 6: 手動驗證**

啟動 server，登入後在某 chat 送出訊息 → 不開該 chat 直接回專案列表 → 該專案 Chat 按鈕應出現紅色未讀數字；進入專案詳情，「開啟 Chat」按鈕同樣有數字。

- [ ] **Step 7: Commit**

```bash
git add app/public/js/views/ProjectList.js app/public/js/views/ProjectDetail.js
git commit -m "feat(frontend): show unread chat badge on project list and detail

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 前端 ProjectChat — 標記已讀 + 離開保護 + 側欄徽章

**Files:**
- Modify: `app/public/js/views/ProjectChat.js`

**Interfaces:**
- Consumes: `window.UnreadStore`；`POST /api/projects/:projectId/chats/:id/read`（回 `{ projectUnread }`）；`GET .../chats` 每筆的 `unread`。

- [ ] **Step 1: 加 beforeUnmount 旗標**

在 `app/public/js/views/ProjectChat.js` 的 component 物件加入（與 `created` 同層）：

```js
  beforeUnmount() { this._gone = true; },
```

- [ ] **Step 2: 加 markRead method**

在 `methods` 內加入：

```js
    async markRead(chat) {
      if (!chat) return;
      const pid = this.$route.params.id;
      try {
        const { projectUnread } = await Api.post(`projects/${pid}/chats/${chat.id}/read`, {});
        UnreadStore.byProject[String(pid)] = projectUnread;
        chat.unread = 0;
      } catch (e) { /* 標記已讀失敗不影響閱讀 */ }
    },
```

- [ ] **Step 3: 開啟 chat 時標記已讀**

在 `loadMessages()` 結尾（`finally` 之後、method 結束前的成功路徑）呼叫 markRead。具體：把 `loadMessages` 改為載入訊息成功後標記：

```js
    async loadMessages() {
      if (!this.activeChat) return;
      this.loadingMsgs = true;
      try {
        this.messages = await Api.get(`projects/${this.$route.params.id}/chats/${this.activeChat.id}/messages`);
        await this.markRead(this.activeChat);
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loadingMsgs = false; }
    },
```

- [ ] **Step 4: 送出回覆後標記已讀（離開則不標記）**

在 `send()` 的成功區塊，`this.messages.push({ ... role: 'ai' ... })` 與 `scrollToBottom` 之後加入：

```js
        if (!this._gone) await this.markRead(this.activeChat);
```

- [ ] **Step 5: 側欄每筆 chat 顯示 unread 徽章**

在側欄 chat 列表項（約 102-110 行）的標題 `<span>` 之後、刪除按鈕之前插入：

```html
            <span v-if="c.unread" style="display:inline-block;min-width:16px;padding:0 5px;margin-left:4px;border-radius:8px;background:var(--error,#e5484d);color:#fff;font-size:11px;line-height:16px;text-align:center;flex-shrink:0">{{ c.unread }}</span>
```

- [ ] **Step 6: 手動驗證**

1. 開一個 chat 送訊息並停留 → 回專案列表 → 該專案無未讀（已讀清除）。
2. 送訊息後立刻按「← 返回專案」→ 列表/按鈕出現未讀 +1；重新進入該 chat → 未讀清除，側欄徽章消失。
3. 另一帳號看不到此 chat，也不受未讀影響。

- [ ] **Step 7: Commit**

```bash
git add app/public/js/views/ProjectChat.js
git commit -m "feat(frontend): mark chat read on open/reply with leave guard + sidebar badge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 收尾驗證（全部任務完成後）

- [ ] 跑後端相關測試全綠：

Run: `npx jest app/server/tests/db-migration.test.js app/server/tests/chat-routes.test.js app/server/tests/project-routes.test.js`
Expected: 全 PASS

- [ ] 端到端手動驗證「送出後離開 → 未讀徽章即時出現 → 重進清除」三個情境（見 Task 6 Step 6）。
