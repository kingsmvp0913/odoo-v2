# AI Dev Web Platform — Sub-plan 2: Sync + Triage Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 實作 Odoo/Service 雙來源任務同步、Triage Agent（Sonnet）分類、User Settings API、Tasks List/Detail API、Socket.io 通知基礎架構、定期 cron 排程。

**Architecture:** `sync.js` 以 Node.js native fetch 呼叫 Odoo JSON-RPC（取代 curl.py + curl_service.py），任務存入 `tasks` table。`triage.js` 以 claude-sonnet-4-6 分類新任務並更新狀態。`cron.js` 每分鐘掃描所有 user 的 `sync_interval`，按需觸發同步 + triage。`notify.js` 持有 Socket.io 實例供全域 emit。

**Tech Stack:** Node.js 20+ native fetch, @anthropic-ai/sdk, node-cron, pg-mem（測試），supertest（測試）

## Global Constraints

- Port: **3939**（不變）
- DB: PostgreSQL（pg pool），tests 用 pg-mem，pattern 同 auth.test.js
- Triage model: `claude-sonnet-4-6`，輸出嚴格 JSON
- `ANTHROPIC_API_KEY` 從 `process.env.ANTHROPIC_API_KEY` 讀取；未設定時 → `triage_blocked` + `blocker_type = 'config'`，不拋錯
- Sync 來源 1 前綴：`task_odoo_`；來源 2 前綴：`task_service_`
- 所有任務資料存 DB，**不寫任何本機檔案**
- 所有 route 模組 export `registerRoutes(app)` 函式，需要 `verifyToken` middleware
- NEEDS_ACTION 狀態：`['confirm_pending', 'final_pending', 'stopped', 'triage_blocked']`

---

## File Map

| 路徑 | 職責 |
|---|---|
| `app/server/settings.js` | User Settings API（GET/PUT /api/settings） |
| `app/server/tasks-routes.js` | Tasks List/Detail API |
| `app/server/notify.js` | Socket.io emit helper（setIo / emitToUser） |
| `app/server/cron.js` | 定期同步排程（node-cron） |
| `app/server/pipeline/sync.js` | Odoo + Service JSON-RPC 同步 |
| `app/server/pipeline/triage.js` | Triage Agent（Sonnet） |
| `app/server/index.js` | 掛載所有新 routes + 啟動 cron（修改） |
| `app/package.json` | 新增 @anthropic-ai/sdk、node-cron（修改） |
| `start.ps1` / `start.sh` | 載入 ANTHROPIC_API_KEY（修改） |
| `app/server/tests/settings.test.js` | Settings 端點測試 |
| `app/server/tests/tasks-routes.test.js` | Tasks API 測試 |
| `app/server/tests/sync.test.js` | Sync engine 測試（mock fetch） |
| `app/server/tests/triage.test.js` | Triage Agent 測試（mock SDK） |
| `app/server/tests/cron.test.js` | Cron + notify 測試 |

---

## Task 1: User Settings API

**Files:**
- Create: `app/server/settings.js`
- Modify: `app/server/index.js`（掛載 settings routes）
- Create: `app/server/tests/settings.test.js`

**Interfaces:**
- Consumes: `verifyToken` from `./auth`; `query` from `./db`
- Produces:
  - `GET /api/settings` → `{ odoo_settings, sync_interval, deploy_cmd }`
  - `PUT /api/settings` → 200 OK
  - `registerRoutes(app)` export

`odoo_settings` JSONB 結構（存在 users.odoo_settings）：
```json
{
  "odoo_url": "",
  "odoo_db": "",
  "odoo_username": "",
  "odoo_password": "",
  "odoo_user_id": 1,
  "service_url": "",
  "service_db": "",
  "service_username": "",
  "service_password": "",
  "service_user_id": 1
}
```

- [ ] **Step 1: 撰寫失敗的 settings test**

建立 `app/server/tests/settings.test.js`：

```javascript
const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-settings-secret';

let app, dbModule, adminToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  // 建立 admin 取得 token
  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'password123', display_name: '管理員'
  });
  adminToken = res.body.token;
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('GET /api/settings → 401 without token', async () => {
  const res = await request(app).get('/api/settings');
  expect(res.status).toBe(401);
});

test('GET /api/settings → returns default settings', async () => {
  const res = await request(app).get('/api/settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('sync_interval');
  expect(res.body).toHaveProperty('odoo_settings');
});

test('PUT /api/settings → updates sync_interval and odoo_settings', async () => {
  const res = await request(app).put('/api/settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ sync_interval: 30, odoo_settings: { odoo_url: 'https://example.com', odoo_db: 'test' } });
  expect(res.status).toBe(200);
});

test('GET /api/settings → reflects updated values', async () => {
  const res = await request(app).get('/api/settings')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.sync_interval).toBe(30);
  expect(res.body.odoo_settings.odoo_url).toBe('https://example.com');
});

test('PUT /api/settings → rejects sync_interval < 5', async () => {
  const res = await request(app).put('/api/settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ sync_interval: 2 });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: 執行確認失敗**

```bash
cd app && npx jest tests/settings.test.js --no-coverage
```

預期：FAIL（Cannot find module or route not found）

- [ ] **Step 3: 建立 settings.js**

建立 `app/server/settings.js`：

```javascript
const { query } = require('./db');
const { verifyToken } = require('./auth');

function registerRoutes(app) {
  app.get('/api/settings', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT odoo_settings, sync_interval, deploy_cmd FROM users WHERE id = $1',
        [req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/settings', verifyToken, async (req, res) => {
    try {
      const { odoo_settings, sync_interval, deploy_cmd } = req.body;
      if (sync_interval !== undefined && sync_interval < 5) {
        return res.status(400).json({ error: 'sync_interval 最小為 5 分鐘' });
      }
      await query(
        `UPDATE users SET
           odoo_settings = COALESCE($2, odoo_settings),
           sync_interval = COALESCE($3, sync_interval),
           deploy_cmd    = COALESCE($4, deploy_cmd)
         WHERE id = $1`,
        [req.userId, odoo_settings ? JSON.stringify(odoo_settings) : null, sync_interval ?? null, deploy_cmd ?? null]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
```

- [ ] **Step 4: 掛載到 index.js**

修改 `app/server/index.js`，在 `registerAuthRoutes(app)` 之後加入：

```javascript
const { registerRoutes: registerSettingsRoutes } = require('./settings');
// 在 createApp() 內，registerAuthRoutes(app) 之後：
registerSettingsRoutes(app);
```

完整 createApp() 區段（取代原本）：

```javascript
const { registerRoutes: registerAuthRoutes } = require('./auth');
const { registerRoutes: registerSettingsRoutes } = require('./settings');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  registerAuthRoutes(app);
  registerSettingsRoutes(app);
  app.use('/api/', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
  return app;
}
```

- [ ] **Step 5: 執行確認通過**

```bash
cd app && npx jest tests/settings.test.js --no-coverage
```

預期：PASS（5 tests）

- [ ] **Step 6: 執行全部 tests**

```bash
cd app && npx jest --no-coverage
```

預期：PASS（全部，目前 16 + 5 = 21 tests）

- [ ] **Step 7: Commit**

```bash
git add app/server/settings.js app/server/index.js app/server/tests/settings.test.js
git commit -m "feat: user settings API (GET/PUT /api/settings)"
```

---

## Task 2: Tasks List/Detail API

**Files:**
- Create: `app/server/tasks-routes.js`
- Modify: `app/server/index.js`（掛載 tasks routes）
- Create: `app/server/tests/tasks-routes.test.js`

**Interfaces:**
- Consumes: `verifyToken` from `./auth`; `query` from `./db`
- Produces:
  - `GET /api/tasks` → task list（支援 query params: `needs_action`, `source`, `status`）
  - `GET /api/tasks/:id` → task detail + 最新 5 筆 logs
  - `GET /api/tasks/:id/logs?offset=0&limit=20` → 分頁 logs
  - `POST /api/tasks/:id/answer` → 寫入用戶回覆，status → `confirm_answered`
  - `registerRoutes(app)` export

NEEDS_ACTION_STATUSES（constant in module）：`['confirm_pending', 'final_pending', 'stopped', 'triage_blocked']`

- [ ] **Step 1: 撰寫失敗的 tasks-routes test**

建立 `app/server/tests/tasks-routes.test.js`：

```javascript
const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-tasks-secret';

let app, dbModule, adminToken, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'password123', display_name: '管理員'
  });
  adminToken = res.body.token;

  // Get userId
  const me = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  userId = me.body.id;

  // Insert test tasks directly
  await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1, 'task_odoo_1', 'odoo', 'Odoo Task 1', 'content 1', 'new'),
            ($1, 'task_odoo_2', 'odoo', 'Odoo Task 2', 'content 2', 'confirm_pending'),
            ($1, 'task_service_1', 'service', 'Service Task 1', 'content 3', 'analysis_running')`,
    [userId]
  );
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('GET /api/tasks → 401 without token', async () => {
  const res = await request(app).get('/api/tasks');
  expect(res.status).toBe(401);
});

test('GET /api/tasks → returns all 3 tasks', async () => {
  const res = await request(app).get('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body.length).toBe(3);
});

test('GET /api/tasks?needs_action=true → returns only confirm_pending task', async () => {
  const res = await request(app).get('/api/tasks?needs_action=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBe(1);
  expect(res.body[0].status).toBe('confirm_pending');
});

test('GET /api/tasks?source=service → returns only service task', async () => {
  const res = await request(app).get('/api/tasks?source=service')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBe(1);
  expect(res.body[0].source).toBe('service');
});

test('GET /api/tasks/:id → returns task detail with logs array', async () => {
  const listRes = await request(app).get('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`);
  const taskId = listRes.body[0].id;

  const res = await request(app).get(`/api/tasks/${taskId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('task');
  expect(res.body).toHaveProperty('logs');
  expect(Array.isArray(res.body.logs)).toBe(true);
});

test('GET /api/tasks/:id → 404 for non-existent task', async () => {
  const res = await request(app).get('/api/tasks/999999')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
});

test('POST /api/tasks/:id/answer → 400 for non-confirm_pending task', async () => {
  const listRes = await request(app).get('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`);
  const task = listRes.body.find(t => t.status === 'new');

  const res = await request(app).post(`/api/tasks/${task.id}/answer`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ user_answer: 'my answer' });
  expect(res.status).toBe(400);
});

test('POST /api/tasks/:id/answer → updates status to confirm_answered', async () => {
  const listRes = await request(app).get('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`);
  const task = listRes.body.find(t => t.status === 'confirm_pending');

  const res = await request(app).post(`/api/tasks/${task.id}/answer`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ user_answer: 'my answer' });
  expect(res.status).toBe(200);

  // Verify status updated
  const detail = await request(app).get(`/api/tasks/${task.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(detail.body.task.status).toBe('confirm_answered');
});
```

- [ ] **Step 2: 執行確認失敗**

```bash
cd app && npx jest tests/tasks-routes.test.js --no-coverage
```

預期：FAIL（routes not registered）

- [ ] **Step 3: 建立 tasks-routes.js**

建立 `app/server/tasks-routes.js`：

```javascript
const { query } = require('./db');
const { verifyToken } = require('./auth');

const NEEDS_ACTION_STATUSES = ['confirm_pending', 'final_pending', 'stopped', 'triage_blocked'];
const ANSWER_ALLOWED_STATUSES = ['confirm_pending', 'final_pending'];

function registerRoutes(app) {
  // List tasks with optional filters
  app.get('/api/tasks', verifyToken, async (req, res) => {
    try {
      const { needs_action, source, status } = req.query;
      const conditions = ['user_id = $1'];
      const params = [req.userId];

      if (needs_action === 'true') {
        conditions.push(`status = ANY($${params.length + 1}::text[])`);
        params.push(NEEDS_ACTION_STATUSES);
      } else if (status) {
        conditions.push(`status = $${params.length + 1}`);
        params.push(status);
      }
      if (source) {
        conditions.push(`source = $${params.length + 1}`);
        params.push(source);
      }

      const sql = `SELECT id, task_id, source, title, status, blocker_type, git_branch, reentry_count, created_at, updated_at
                   FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`;
      const { rows } = await query(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Task detail + last 5 logs
  app.get('/api/tasks/:id', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT * FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });

      const { rows: logs } = await query(
        'SELECT id, role, content, created_at FROM task_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 5',
        [req.params.id]
      );
      res.json({ task: tasks[0], logs: logs.reverse() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Paginated logs
  app.get('/api/tasks/:id/logs', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });

      const offset = parseInt(req.query.offset) || 0;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const { rows } = await query(
        'SELECT id, role, content, created_at FROM task_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [req.params.id, limit, offset]
      );
      res.json(rows.reverse());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // User answer to clarification question
  app.post('/api/tasks/:id/answer', verifyToken, async (req, res) => {
    try {
      const { rows: tasks } = await query(
        'SELECT id, status FROM tasks WHERE id = $1 AND user_id = $2',
        [req.params.id, req.userId]
      );
      if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
      if (!ANSWER_ALLOWED_STATUSES.includes(tasks[0].status)) {
        return res.status(400).json({ error: `Task status '${tasks[0].status}' does not accept answers` });
      }

      const { user_answer } = req.body;
      if (!user_answer) return res.status(400).json({ error: 'user_answer required' });

      await query(
        "UPDATE tasks SET status = 'confirm_answered', updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      await query(
        "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'user', $2)",
        [req.params.id, user_answer]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes, NEEDS_ACTION_STATUSES };
```

- [ ] **Step 4: 掛載到 index.js**

修改 `app/server/index.js`，加入 tasks routes：

```javascript
const { registerRoutes: registerAuthRoutes } = require('./auth');
const { registerRoutes: registerSettingsRoutes } = require('./settings');
const { registerRoutes: registerTasksRoutes } = require('./tasks-routes');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  registerAuthRoutes(app);
  registerSettingsRoutes(app);
  registerTasksRoutes(app);
  app.use('/api/', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
  return app;
}
```

- [ ] **Step 5: 執行確認通過**

```bash
cd app && npx jest tests/tasks-routes.test.js --no-coverage
```

預期：PASS（8 tests）

- [ ] **Step 6: 執行全部 tests**

```bash
cd app && npx jest --no-coverage
```

預期：PASS（全部，21 + 8 = 29 tests）

- [ ] **Step 7: Commit**

```bash
git add app/server/tasks-routes.js app/server/index.js app/server/tests/tasks-routes.test.js
git commit -m "feat: tasks list/detail/answer API endpoints"
```

---

## Task 3: Sync Engine

**Files:**
- Create: `app/server/pipeline/sync.js`
- Create: `app/server/tests/sync.test.js`

**Interfaces:**
- Consumes: `query` from `../db`
- Produces:
  - `syncUser(userId)` → `Promise<{ odoo: { added: number }, service: { added: number } }>`
  - 讀 `users.odoo_settings` JSONB 取得連線資訊
  - 若 `odoo_url` 未設定則 skip（回傳 `{ added: 0 }`）

Odoo JSON-RPC 流程（來源 1：project.task）：
1. POST `{odoo_url}/web/session/authenticate`（取得 Set-Cookie）
2. POST `{odoo_url}/web/dataset/call_kw`（project.task search_read）
3. 對每筆 task：POST call_kw（mail.message search_read）
4. 組裝 original_text，INSERT INTO tasks（ON CONFLICT DO NOTHING）

Service JSON-RPC 流程（來源 2：service.question.feedback）：
1. 同 auth 流程
2. service.question.feedback search_read，domain: `[["processing_staff","in",[user_id]],["state","in",["draft","open"]]]`
3. mail.message search_read
4. 組裝 original_text，INSERT INTO tasks（ON CONFLICT DO NOTHING）

HTML 清理（内建函式 `stripHtml`）：
- 移除所有 HTML 標籤
- 解碼 `&nbsp;`, `&amp;`, `&lt;`, `&gt;`, `&quot;`

- [ ] **Step 1: 建立 pipeline 目錄**

```bash
mkdir -p app/server/pipeline
```

- [ ] **Step 2: 撰寫失敗的 sync test**

建立 `app/server/tests/sync.test.js`：

```javascript
const { newDb } = require('pg-mem');

let dbModule, syncModule;
let userId;

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeFetchResponse(body, cookieHeader = '') {
  return Promise.resolve({
    ok: true,
    headers: { get: (h) => h === 'set-cookie' ? cookieHeader : null },
    json: () => Promise.resolve(body)
  });
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  // Insert test user with odoo_settings
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password123', 4);
  const { rows } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, role, odoo_settings, sync_interval)
     VALUES ('testuser', $1, '測試員', 'user', $2, 15) RETURNING id`,
    [hash, JSON.stringify({
      odoo_url: 'https://odoo.example.com',
      odoo_db: 'mydb',
      odoo_username: 'admin',
      odoo_password: 'pass',
      odoo_user_id: 1,
      service_url: 'https://service.example.com',
      service_db: 'servicedb',
      service_username: 'svc',
      service_password: 'svcpass',
      service_user_id: 2
    })]
  );
  userId = rows[0].id;

  syncModule = require('../pipeline/sync');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => { mockFetch.mockReset(); });

function setupOdooMocks({ tasks = [], messages = [] } = {}) {
  mockFetch
    // auth
    .mockImplementationOnce(() => makeFetchResponse(
      { jsonrpc: '2.0', result: { uid: 1 } }, 'session_id=abc123'
    ))
    // task search_read
    .mockImplementationOnce(() => makeFetchResponse({
      jsonrpc: '2.0',
      result: tasks
    }));
  // message search_read for each task
  tasks.forEach(() => {
    mockFetch.mockImplementationOnce(() => makeFetchResponse({
      jsonrpc: '2.0',
      result: messages
    }));
  });
}

function setupServiceMocks({ tasks = [], messages = [] } = {}) {
  mockFetch
    .mockImplementationOnce(() => makeFetchResponse(
      { jsonrpc: '2.0', result: { uid: 2 } }, 'session_id=svc123'
    ))
    .mockImplementationOnce(() => makeFetchResponse({
      jsonrpc: '2.0',
      result: tasks
    }));
  tasks.forEach(() => {
    mockFetch.mockImplementationOnce(() => makeFetchResponse({
      jsonrpc: '2.0',
      result: messages
    }));
  });
}

test('syncUser with no tasks → returns { added: 0 } for both sources', async () => {
  setupOdooMocks({ tasks: [] });
  setupServiceMocks({ tasks: [] });

  const result = await syncModule.syncUser(userId);
  expect(result.odoo.added).toBe(0);
  expect(result.service.added).toBe(0);
});

test('syncUser adds new Odoo task to DB', async () => {
  setupOdooMocks({
    tasks: [{
      id: 9001,
      name: 'Test Task A',
      project_id: [1, 'My Project'],
      stage_id: [2, 'In Progress'],
      description: '<p>Task description</p>'
    }],
    messages: [{ date: '2026-06-25 10:00:00', body: '<p>First comment</p>' }]
  });
  setupServiceMocks({ tasks: [] });

  const result = await syncModule.syncUser(userId);
  expect(result.odoo.added).toBe(1);

  const { rows } = await dbModule.query(
    "SELECT * FROM tasks WHERE task_id = 'task_odoo_9001' AND user_id = $1",
    [userId]
  );
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe('Test Task A');
  expect(rows[0].source).toBe('odoo');
  expect(rows[0].status).toBe('new');
  expect(rows[0].original_text).toContain('Test Task A');
});

test('syncUser skips duplicate tasks (ON CONFLICT DO NOTHING)', async () => {
  setupOdooMocks({
    tasks: [{
      id: 9001,
      name: 'Test Task A (duplicate)',
      project_id: [1, 'My Project'],
      stage_id: [2, 'In Progress'],
      description: '<p>Dup</p>'
    }],
    messages: []
  });
  setupServiceMocks({ tasks: [] });

  const result = await syncModule.syncUser(userId);
  expect(result.odoo.added).toBe(0); // already exists
});

test('syncUser adds new Service task to DB', async () => {
  setupOdooMocks({ tasks: [] });
  setupServiceMocks({
    tasks: [{
      id: 3001,
      name_seq: 'SQ-3001',
      subject: '系統問題回報',
      system: [1, 'CRM'],
      respondent: [5, '王小明'],
      state: 'open',
      question_description: '<p>詳細說明</p>',
      classification: [2, '技術問題'],
      file: []
    }],
    messages: [{ date: '2026-06-25 11:00:00', body: '<p>補充說明</p>', attachment_ids: [] }]
  });

  const result = await syncModule.syncUser(userId);
  expect(result.service.added).toBe(1);

  const { rows } = await dbModule.query(
    "SELECT * FROM tasks WHERE task_id = 'task_service_3001' AND user_id = $1",
    [userId]
  );
  expect(rows.length).toBe(1);
  expect(rows[0].title).toContain('SQ-3001');
  expect(rows[0].source).toBe('service');
});

test('syncUser skips when odoo_url not configured', async () => {
  const { rows: users } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('noconfig', 'x', 'No Config', 'user') RETURNING id"
  );
  const noConfigUserId = users[0].id;

  const result = await syncModule.syncUser(noConfigUserId);
  expect(result.odoo.added).toBe(0);
  expect(result.service.added).toBe(0);
  expect(mockFetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: 執行確認失敗**

```bash
cd app && npx jest tests/sync.test.js --no-coverage
```

預期：FAIL（Cannot find module pipeline/sync）

- [ ] **Step 4: 建立 sync.js**

建立 `app/server/pipeline/sync.js`：

```javascript
const { query } = require('../db');

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function odooAuth(baseUrl, db, login, password) {
  const res = await fetch(`${baseUrl}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params: { db, login, password }
    })
  });
  const cookies = res.headers.get('set-cookie') || '';
  const data = await res.json();
  if (data.error) throw new Error(`Odoo auth failed: ${JSON.stringify(data.error)}`);
  return cookies;
}

async function odooSearchRead(baseUrl, model, domain, fields, cookies, limit = 30) {
  const res = await fetch(`${baseUrl}/web/dataset/call_kw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookies },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params: {
        model, method: 'search_read',
        args: [],
        kwargs: { domain, fields, limit }
      }
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`search_read ${model} failed: ${JSON.stringify(data.error)}`);
  return data.result || [];
}

async function syncOdooUser(userId, settings) {
  const { odoo_url, odoo_db, odoo_username, odoo_password, odoo_user_id } = settings;
  if (!odoo_url || !odoo_db || !odoo_username || !odoo_password) return { added: 0 };

  const cookies = await odooAuth(odoo_url, odoo_db, odoo_username, odoo_password);
  const tasks = await odooSearchRead(
    odoo_url, 'project.task',
    [['user_id', '=', odoo_user_id || 1]],
    ['id', 'name', 'project_id', 'stage_id', 'description'],
    cookies
  );

  let added = 0;
  for (const task of tasks) {
    const messages = await odooSearchRead(
      odoo_url, 'mail.message',
      [['model', '=', 'project.task'], ['res_id', '=', task.id]],
      ['date', 'body'],
      cookies, 20
    );

    const msgLines = messages
      .map(m => { const t = stripHtml(m.body); return t ? `[${m.date}] ${t}` : null; })
      .filter(Boolean).join('\n');

    const original_text = [
      `---id---\n${task.id}`,
      `---title---\n${task.name}`,
      `---project---\n${task.project_id ? task.project_id[1] : '未知專案'}`,
      `---stage---\n${task.stage_id ? task.stage_id[1] : '未知階段'}`,
      `---description---\n${stripHtml(task.description)}`,
      `---message---\n${msgLines || '無訊息內容'}`
    ].join('\n');

    const result = await query(
      `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
       VALUES ($1, $2, 'odoo', $3, $4, 'new')
       ON CONFLICT (user_id, task_id) DO NOTHING`,
      [userId, `task_odoo_${task.id}`, task.name, original_text]
    );
    if (result.rowCount > 0) added++;
  }
  return { added };
}

async function syncServiceUser(userId, settings) {
  const { service_url, service_db, service_username, service_password, service_user_id } = settings;
  if (!service_url || !service_db || !service_username || !service_password) return { added: 0 };

  const cookies = await odooAuth(service_url, service_db, service_username, service_password);
  const tasks = await odooSearchRead(
    service_url, 'service.question.feedback',
    [['processing_staff', 'in', [service_user_id || 1]], ['state', 'in', ['draft', 'open']]],
    ['id', 'name_seq', 'subject', 'system', 'state', 'question_description', 'classification', 'respondent', 'file'],
    cookies
  );

  let added = 0;
  for (const task of tasks) {
    const messages = await odooSearchRead(
      service_url, 'mail.message',
      [['model', '=', 'service.question.feedback'], ['res_id', '=', task.id]],
      ['date', 'body', 'attachment_ids'],
      cookies, 20
    );

    const msgLines = messages
      .map(m => { const t = stripHtml(m.body); return t ? `[${m.date}] ${t}` : null; })
      .filter(Boolean).join('\n');

    const title = task.name_seq ? `${task.name_seq}: ${task.subject}` : task.subject;
    const original_text = [
      `---id---\n${task.id}`,
      `---title---\n${title}`,
      `---project---\n${task.respondent ? task.respondent[1] : '未知帳號'}`,
      `---stage---\n${task.state === 'draft' ? '未處理' : '處理中'}`,
      `---classification---\n${task.classification ? task.classification[1] : '未分類'}`,
      `---description---\n${stripHtml(task.question_description)}`,
      `---message---\n${msgLines || '無訊息內容'}`
    ].join('\n');

    const result = await query(
      `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
       VALUES ($1, $2, 'service', $3, $4, 'new')
       ON CONFLICT (user_id, task_id) DO NOTHING`,
      [userId, `task_service_${task.id}`, title, original_text]
    );
    if (result.rowCount > 0) added++;
  }
  return { added };
}

async function syncUser(userId) {
  const { rows } = await query(
    'SELECT odoo_settings FROM users WHERE id = $1',
    [userId]
  );
  if (!rows.length) return { odoo: { added: 0 }, service: { added: 0 } };

  const settings = rows[0].odoo_settings || {};
  const [odoo, service] = await Promise.all([
    syncOdooUser(userId, settings).catch(err => {
      console.error(`[SYNC] Odoo user ${userId}:`, err.message);
      return { added: 0 };
    }),
    syncServiceUser(userId, settings).catch(err => {
      console.error(`[SYNC] Service user ${userId}:`, err.message);
      return { added: 0 };
    })
  ]);
  return { odoo, service };
}

module.exports = { syncUser, stripHtml };
```

- [ ] **Step 5: 執行確認通過**

```bash
cd app && npx jest tests/sync.test.js --no-coverage
```

預期：PASS（5 tests）

- [ ] **Step 6: 執行全部 tests**

```bash
cd app && npx jest --no-coverage
```

預期：PASS（全部，29 + 5 = 34 tests）

- [ ] **Step 7: Commit**

```bash
git add app/server/pipeline/sync.js app/server/tests/sync.test.js
git commit -m "feat: Odoo + Service sync engine (Node.js, replaces curl.py)"
```

---

## Task 4: Triage Agent

**Files:**
- Create: `app/server/pipeline/triage.js`
- Modify: `app/package.json`（新增 @anthropic-ai/sdk, node-cron）
- Modify: `start.ps1`（載入 ANTHROPIC_API_KEY）
- Modify: `start.sh`（載入 ANTHROPIC_API_KEY）
- Create: `app/server/tests/triage.test.js`

**Interfaces:**
- Consumes: `query` from `../db`; `@anthropic-ai/sdk`
- Produces:
  - `triageTask(taskId)` → `Promise<{ outcome, content, clarification_questions? }>`
  - `triageNewTasks(userId)` → `Promise<void>`（批次處理該 user 所有 status='new' 的 task）

4 種 outcome 對應狀態：

| outcome | tasks.status | tasks.blocker_type |
|---|---|---|
| `answered` | `answered` | null |
| `triage_blocked` | `triage_blocked` | `'triage'` |
| `confirm_pending` | `confirm_pending` | null |
| `analysis_running` | `analysis_running` | null |

Triage 系統 prompt（常數 `TRIAGE_SYSTEM_PROMPT`）：

```
你是 AI 開發工作流程的 Triage Agent，負責分析 Odoo/Service 任務並分類。
輸出必須是嚴格合法的 JSON，禁止包含任何其他文字（不得有 markdown code block）。

輸出格式：
{
  "outcome": "answered|triage_blocked|confirm_pending|analysis_running",
  "content": "回覆內容、阻塞原因、或確認事項說明",
  "clarification_questions": []
}

判斷規則：
- answered：純諮詢/問題類，直接給出回覆即可，完全不需要修改任何程式碼
- triage_blocked：需求在技術上無法透過標準 Odoo 模組擴展實現，或需求極度不清楚無法繼續
- confirm_pending：可以實作，但有具體細節需在開始前確認（在 clarification_questions 列出 1-3 個問題）
- analysis_running：需求清晰可直接開始技術分析

content 填寫原則：
- answered：直接回覆問題
- triage_blocked：說明無法實作的具體原因
- confirm_pending：整體說明，具體問題列在 clarification_questions
- analysis_running：一句話確認理解
```

- [ ] **Step 1: 更新 package.json**

修改 `app/package.json`，在 `dependencies` 加入：

```json
"@anthropic-ai/sdk": "^0.30.0",
"node-cron": "^3.0.3"
```

完整 dependencies 區段：

```json
"dependencies": {
  "@anthropic-ai/sdk": "^0.30.0",
  "bcryptjs": "^2.4.3",
  "express": "^4.19.2",
  "jsonwebtoken": "^9.0.2",
  "node-cron": "^3.0.3",
  "pg": "^8.22.0",
  "socket.io": "^4.7.5"
}
```

```bash
cd app && npm install
```

- [ ] **Step 2: 更新 start.ps1 載入 ANTHROPIC_API_KEY**

修改 `start.ps1`（取代整個檔案）：

```powershell
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

$configPath = Join-Path $Root "data\config.json"
if (-not (Test-Path $configPath)) {
    Write-Host "Error: data/config.json not found. Please run install.ps1 first." -ForegroundColor Red
    exit 1
}

try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
} catch {
    Write-Host "Error: data/config.json is corrupt. Please run install.ps1 again." -ForegroundColor Red
    exit 1
}

if (-not $config.JWT_SECRET) {
    Write-Host "Error: JWT_SECRET missing from config.json." -ForegroundColor Red
    exit 1
}

$env:JWT_SECRET    = $config.JWT_SECRET
$env:PORT          = if ($config.PORT) { $config.PORT } else { 3939 }
if ($config.DATABASE_URL)     { $env:DATABASE_URL     = $config.DATABASE_URL }
if ($config.ANTHROPIC_API_KEY) { $env:ANTHROPIC_API_KEY = $config.ANTHROPIC_API_KEY }

node (Join-Path $Root "app\server\index.js")
```

- [ ] **Step 3: 更新 start.sh 載入 ANTHROPIC_API_KEY**

修改 `start.sh`（取代整個檔案）：

```bash
#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
CONFIG="$ROOT/data/config.json"

if [ ! -f "$CONFIG" ]; then
  echo "Error: data/config.json not found. Please run install.sh first." >&2
  exit 1
fi

# Shell-injection-safe: pass config path as argv, never shell-expand values
read_config() {
  node -e "
    try {
      const c = require(process.argv[1]);
      process.stdout.write(c[process.argv[2]] || '');
    } catch(e) { process.exit(1); }
  " "$CONFIG" "$1"
}

JWT_SECRET="$(read_config JWT_SECRET)"
if [ -z "$JWT_SECRET" ]; then
  echo "Error: JWT_SECRET missing from config.json." >&2
  exit 1
fi

export JWT_SECRET
export PORT="$(read_config PORT)"
export DATABASE_URL="$(read_config DATABASE_URL)"

ANTHROPIC_KEY="$(read_config ANTHROPIC_API_KEY)"
if [ -n "$ANTHROPIC_KEY" ]; then export ANTHROPIC_API_KEY="$ANTHROPIC_KEY"; fi

node "$ROOT/app/server/index.js"
```

- [ ] **Step 4: 撰寫失敗的 triage test**

建立 `app/server/tests/triage.test.js`：

```javascript
const { newDb } = require('pg-mem');

// Mock @anthropic-ai/sdk BEFORE any require
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn()
    }
  }));
});

let dbModule, triageModule, Anthropic, mockCreate;
let userId, taskId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  // Insert test user
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: users } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('triagetest', $1, '測試', 'user') RETURNING id",
    [hash]
  );
  userId = users[0].id;

  Anthropic = require('@anthropic-ai/sdk');
  mockCreate = Anthropic.mock.results[0].value.messages.create;

  triageModule = require('../pipeline/triage');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  // Insert fresh task
  const { rows } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, original_text, status) VALUES ($1, $2, 'odoo', 'Test Task', 'task content', 'new') RETURNING id",
    [userId, `task_odoo_triage_${Date.now()}`]
  );
  taskId = rows[0].id;
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'sk-test-key';
});

afterEach(async () => {
  await dbModule.query('DELETE FROM task_logs WHERE task_id = $1', [taskId]);
  await dbModule.query('DELETE FROM tasks WHERE id = $1', [taskId]);
});

test('triageTask → analysis_running when triage says so', async () => {
  mockCreate.mockResolvedValue({
    content: [{ text: JSON.stringify({ outcome: 'analysis_running', content: '需求清晰，開始分析' }) }]
  });

  const result = await triageModule.triageTask(taskId);
  expect(result.outcome).toBe('analysis_running');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('analysis_running');
});

test('triageTask → answered when triage says so', async () => {
  mockCreate.mockResolvedValue({
    content: [{ text: JSON.stringify({ outcome: 'answered', content: '這個問題的答案是...' }) }]
  });

  const result = await triageModule.triageTask(taskId);
  expect(result.outcome).toBe('answered');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('answered');
});

test('triageTask → triage_blocked when triage says so', async () => {
  mockCreate.mockResolvedValue({
    content: [{ text: JSON.stringify({ outcome: 'triage_blocked', content: '無法透過標準方式實現' }) }]
  });

  const result = await triageModule.triageTask(taskId);
  expect(result.outcome).toBe('triage_blocked');

  const { rows } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('triage_blocked');
  expect(rows[0].blocker_type).toBe('triage');
});

test('triageTask → confirm_pending with clarification questions', async () => {
  mockCreate.mockResolvedValue({
    content: [{ text: JSON.stringify({
      outcome: 'confirm_pending',
      content: '有幾個細節需要確認',
      clarification_questions: ['這個欄位要顯示什麼格式？', '是否要影響報表？']
    }) }]
  });

  const result = await triageModule.triageTask(taskId);
  expect(result.outcome).toBe('confirm_pending');
  expect(result.clarification_questions).toHaveLength(2);

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('confirm_pending');
});

test('triageTask → triage_blocked when ANTHROPIC_API_KEY not set', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const result = await triageModule.triageTask(taskId);
  expect(result.outcome).toBe('triage_blocked');
  expect(result.content).toMatch(/ANTHROPIC_API_KEY/);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('triageTask → triage_blocked when SDK returns invalid JSON', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-key';
  mockCreate.mockResolvedValue({
    content: [{ text: 'this is not valid JSON' }]
  });

  const result = await triageModule.triageTask(taskId);
  expect(result.outcome).toBe('triage_blocked');
});

test('triageNewTasks processes all new tasks for user', async () => {
  mockCreate.mockResolvedValue({
    content: [{ text: JSON.stringify({ outcome: 'analysis_running', content: 'ok' }) }]
  });

  // Insert another new task
  await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1, 'task_odoo_batch_2', 'odoo', 'Batch Task', 'new')",
    [userId]
  );

  await triageModule.triageNewTasks(userId);

  const { rows } = await dbModule.query(
    "SELECT status FROM tasks WHERE user_id = $1 AND task_id LIKE '%batch%'",
    [userId]
  );
  expect(rows[0].status).toBe('analysis_running');

  // cleanup
  await dbModule.query("DELETE FROM tasks WHERE task_id LIKE '%batch%'");
});
```

- [ ] **Step 5: 執行確認失敗**

```bash
cd app && npx jest tests/triage.test.js --no-coverage
```

預期：FAIL（Cannot find module pipeline/triage）

- [ ] **Step 6: 建立 triage.js**

建立 `app/server/pipeline/triage.js`：

```javascript
const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../db');

const TRIAGE_SYSTEM_PROMPT = `你是 AI 開發工作流程的 Triage Agent，負責分析 Odoo/Service 任務並分類。
輸出必須是嚴格合法的 JSON，禁止包含任何其他文字（不得有 markdown code block）。

輸出格式：
{
  "outcome": "answered|triage_blocked|confirm_pending|analysis_running",
  "content": "回覆內容、阻塞原因、或確認事項說明",
  "clarification_questions": []
}

判斷規則：
- answered：純諮詢/問題類，直接給出回覆即可，完全不需要修改任何程式碼
- triage_blocked：需求在技術上無法透過標準 Odoo 模組擴展實現，或需求極度不清楚無法繼續
- confirm_pending：可以實作，但有具體細節需在開始前確認（在 clarification_questions 列出 1-3 個問題）
- analysis_running：需求清晰可直接開始技術分析

content 填寫原則：
- answered：直接回覆問題
- triage_blocked：說明無法實作的具體原因
- confirm_pending：整體說明，具體問題列在 clarification_questions
- analysis_running：一句話確認理解`;

async function triageTask(taskId) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const msg = 'ANTHROPIC_API_KEY not configured';
    await query(
      `UPDATE tasks SET status = 'triage_blocked', blocker_type = 'config', blocker_content = $2, updated_at = NOW() WHERE id = $1`,
      [taskId, msg]
    );
    return { outcome: 'triage_blocked', content: msg };
  }

  await query(
    "UPDATE tasks SET status = 'triage_running', updated_at = NOW() WHERE id = $1",
    [taskId]
  );

  const { rows } = await query('SELECT original_text FROM tasks WHERE id = $1', [taskId]);
  const task = rows[0];
  if (!task) throw new Error(`Task ${taskId} not found`);

  let parsed;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: TRIAGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: task.original_text || '（無內容）' }]
    });
    parsed = JSON.parse(response.content[0].text);
  } catch (err) {
    parsed = { outcome: 'triage_blocked', content: `Triage error: ${err.message}` };
  }

  const outcome = parsed.outcome || 'triage_blocked';
  const content = parsed.content || '';
  const clarification_questions = parsed.clarification_questions || [];

  await query(
    `UPDATE tasks SET
       status = $2,
       blocker_type = $3,
       blocker_content = $4,
       updated_at = NOW()
     WHERE id = $1`,
    [
      taskId,
      outcome,
      outcome === 'triage_blocked' ? 'triage' : null,
      outcome === 'triage_blocked' ? content : null
    ]
  );

  if (content) {
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [taskId, content]
    );
  }

  return { outcome, content, clarification_questions };
}

async function triageNewTasks(userId) {
  const { rows: tasks } = await query(
    "SELECT id FROM tasks WHERE user_id = $1 AND status = 'new'",
    [userId]
  );
  for (const task of tasks) {
    try {
      await triageTask(task.id);
    } catch (err) {
      console.error(`[TRIAGE] task ${task.id}:`, err.message);
    }
  }
}

module.exports = { triageTask, triageNewTasks };
```

- [ ] **Step 7: 執行確認通過**

```bash
cd app && npx jest tests/triage.test.js --no-coverage
```

預期：PASS（7 tests）

- [ ] **Step 8: 執行全部 tests**

```bash
cd app && npx jest --no-coverage
```

預期：PASS（全部，34 + 7 = 41 tests）

- [ ] **Step 9: Commit**

```bash
git add app/server/pipeline/triage.js app/server/tests/triage.test.js app/package.json app/package-lock.json start.ps1 start.sh
git commit -m "feat: Triage Agent (Sonnet), 4-way classification, @anthropic-ai/sdk"
```

---

## Task 5: Cron + Notify + Wire

**Files:**
- Create: `app/server/notify.js`
- Create: `app/server/cron.js`
- Modify: `app/server/index.js`（完整整合）
- Create: `app/server/tests/cron.test.js`

**Interfaces:**
- `notify.js` exports: `setIo(io)`, `emitToUser(userId, event, data)`, `emitAll(event, data)`
- `cron.js` exports: `startCron()`, `stopCron()`（供測試）
- Socket.io room 命名：`user:{userId}`（Sub-plan 5 實作 client 端 join room）

Socket.io event 表（server → client）：
| Event | Payload | 觸發時機 |
|---|---|---|
| `task:updated` | `{ taskId, status }` | 任何狀態變化 |
| `task:synced` | `{ count }` | sync 完成有新任務 |
| `notify:toast` | `{ level, message }` | 通用通知 |

cron 邏輯：
- 每分鐘掃描全部 users
- 比對 `now - lastSyncMap[userId] >= sync_interval * 60 * 1000`
- fire-and-forget：`syncUser(userId)` → 若有新任務 emit `task:synced` → `triageNewTasks(userId)`

- [ ] **Step 1: 撰寫失敗的 cron test**

建立 `app/server/tests/cron.test.js`：

```javascript
const { newDb } = require('pg-mem');
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));

// Mock sync and triage to avoid real HTTP/API calls
jest.mock('../pipeline/sync', () => ({
  syncUser: jest.fn().mockResolvedValue({ odoo: { added: 2 }, service: { added: 0 } })
}));
jest.mock('../pipeline/triage', () => ({
  triageNewTasks: jest.fn().mockResolvedValue(undefined)
}));

let dbModule, cronModule, notifyModule;
let userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, sync_interval) VALUES ('crontest', $1, '測試', 'user', 1) RETURNING id",
    [hash]
  );
  userId = rows[0].id;

  notifyModule = require('../notify');
  cronModule = require('../cron');
});

afterAll(() => {
  cronModule.stopCron();
  dbModule._setPoolForTesting(null);
});

test('notify.emitToUser does not throw when io is not set', () => {
  expect(() => notifyModule.emitToUser(1, 'task:synced', { count: 3 })).not.toThrow();
});

test('notify.emitToUser calls io.to().emit() when io is set', () => {
  const mockEmit = jest.fn();
  const mockTo = jest.fn(() => ({ emit: mockEmit }));
  const mockIo = { to: mockTo, emit: jest.fn() };

  notifyModule.setIo(mockIo);
  notifyModule.emitToUser(42, 'task:updated', { taskId: 1, status: 'new' });

  expect(mockTo).toHaveBeenCalledWith('user:42');
  expect(mockEmit).toHaveBeenCalledWith('task:updated', { taskId: 1, status: 'new' });

  notifyModule.setIo(null);
});

test('notify.emitAll calls io.emit()', () => {
  const mockEmit = jest.fn();
  notifyModule.setIo({ to: jest.fn(() => ({ emit: jest.fn() })), emit: mockEmit });
  notifyModule.emitAll('notify:toast', { level: 'info', message: 'test' });
  expect(mockEmit).toHaveBeenCalledWith('notify:toast', { level: 'info', message: 'test' });
  notifyModule.setIo(null);
});

test('startCron returns a task object (cron job started)', () => {
  const job = cronModule.startCron();
  expect(job).toBeDefined();
  expect(typeof job.stop).toBe('function');
  cronModule.stopCron();
});
```

- [ ] **Step 2: 執行確認失敗**

```bash
cd app && npx jest tests/cron.test.js --no-coverage
```

預期：FAIL（Cannot find module notify or cron）

- [ ] **Step 3: 建立 notify.js**

建立 `app/server/notify.js`：

```javascript
let _io = null;

function setIo(io) { _io = io; }

function emitToUser(userId, event, data) {
  if (_io) _io.to(`user:${userId}`).emit(event, data);
}

function emitAll(event, data) {
  if (_io) _io.emit(event, data);
}

module.exports = { setIo, emitToUser, emitAll };
```

- [ ] **Step 4: 建立 cron.js**

建立 `app/server/cron.js`：

```javascript
const cron = require('node-cron');
const { query } = require('./db');
const { syncUser } = require('./pipeline/sync');
const { triageNewTasks } = require('./pipeline/triage');
const notify = require('./notify');

const lastSync = new Map();
let _job = null;

async function runForUser(userId, syncInterval) {
  try {
    const result = await syncUser(userId);
    const total = result.odoo.added + result.service.added;
    if (total > 0) {
      notify.emitToUser(userId, 'task:synced', { count: total });
    }
    await triageNewTasks(userId);
  } catch (err) {
    console.error(`[CRON] user ${userId}:`, err.message);
  }
}

function startCron() {
  _job = cron.schedule('* * * * *', async () => {
    try {
      const { rows: users } = await query(
        'SELECT id, sync_interval FROM users WHERE sync_interval > 0'
      );
      const now = Date.now();
      for (const user of users) {
        const last = lastSync.get(user.id) || 0;
        const interval = (user.sync_interval || 15) * 60 * 1000;
        if (now - last >= interval) {
          lastSync.set(user.id, now);
          runForUser(user.id);
        }
      }
    } catch (err) {
      console.error('[CRON] tick error:', err.message);
    }
  });
  return _job;
}

function stopCron() {
  if (_job) { _job.stop(); _job = null; }
}

module.exports = { startCron, stopCron };
```

- [ ] **Step 5: 更新 index.js（完整整合）**

取代 `app/server/index.js` 全文：

```javascript
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { registerRoutes: registerAuthRoutes } = require('./auth');
const { registerRoutes: registerSettingsRoutes } = require('./settings');
const { registerRoutes: registerTasksRoutes } = require('./tasks-routes');

const PORT = process.env.PORT || 3939;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  registerAuthRoutes(app);
  registerSettingsRoutes(app);
  registerTasksRoutes(app);
  app.use('/api/', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
  return app;
}

if (require.main === module) {
  const { migrate } = require('./db');
  const { setIo } = require('./notify');
  const { startCron } = require('./cron');

  const app = createApp();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    console.log('connected:', socket.id);
    // Room join is handled in Sub-plan 5 (Terminal + Auth)
  });

  migrate().then(() => {
    setIo(io);
    startCron();
    httpServer.listen(PORT, () => console.log(`AI Dev http://localhost:${PORT}`));
  }).catch(err => {
    console.error('DB migration failed:', err);
    process.exit(1);
  });
}

module.exports = { createApp };
```

- [ ] **Step 6: 執行確認通過**

```bash
cd app && npx jest tests/cron.test.js --no-coverage
```

預期：PASS（4 tests）

- [ ] **Step 7: 執行全部 tests**

```bash
cd app && npx jest --no-coverage
```

預期：PASS（全部，41 + 4 = 45 tests）

- [ ] **Step 8: Commit**

```bash
git add app/server/notify.js app/server/cron.js app/server/index.js app/server/tests/cron.test.js
git commit -m "feat: Socket.io notify, node-cron scheduler, wire all modules into index"
```

---

## Self-Review

**Spec coverage check：**

| 設計規格需求 | 計畫中的 Task |
|---|---|
| Odoo sync（project.task）| Task 3 sync.js |
| Service sync（service.question.feedback）| Task 3 sync.js |
| Triage Agent（Sonnet，4 種 outcome）| Task 4 triage.js |
| user.odoo_settings JSONB 儲存連線設定 | Task 1 settings.js |
| GET/PUT /api/settings | Task 1 |
| GET /api/tasks（含 needs_action、source、status filter）| Task 2 |
| GET /api/tasks/:id（含 5 筆 logs）| Task 2 |
| GET /api/tasks/:id/logs（分頁）| Task 2 |
| POST /api/tasks/:id/answer → confirm_answered | Task 2 |
| Socket.io notify（task:synced、notify:toast）| Task 5 notify.js |
| 定期 cron 同步（per-user sync_interval）| Task 5 cron.js |
| NEEDS_ACTION 篩選條件（4 種狀態）| Task 2 constant |
| 所有 pipeline 操作不寫本機檔案 | 全程 DB only |
| sync 出錯 catch 並繼續（不中斷其他 user）| Task 3 Promise.all + catch |
| ANTHROPIC_API_KEY 未設定時 graceful fallback | Task 4 |

**Placeholder scan：** 無 TBD / TODO。全部步驟含完整程式碼。

**Type consistency：**
- `syncUser(userId)` → Task 3 定義，Task 5 cron.js 呼叫相同簽名
- `triageNewTasks(userId)` → Task 4 定義，Task 5 cron.js 呼叫相同簽名
- `emitToUser(userId, event, data)` → Task 5 notify.js 定義，Task 5 cron.js 呼叫相同簽名
- `setIo(io)` → Task 5 notify.js 定義，index.js 呼叫相同簽名

---

## 下一步：Sub-plan 3

完成本計畫後，繼續 `2026-06-25-aidev-03-pipeline-engine.md`（Analysis/Coding/QA Agent 調度、Git 流程、Stage 狀態機）。
