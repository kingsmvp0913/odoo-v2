# AI Dev Web Platform — Sub-plan 5: Terminal + Coding/QA Agents

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 實作 Socket.io JWT 認證、Coding/QA Agent（subprocess 管理＋串流輸出）、xterm.js 終端機 UI，使 pipeline 可完整執行至 done。

**Architecture:** Socket.io 握手時驗證 JWT（io.use 中介層）；Coding/QA Agent 用 child_process.spawn 執行可配置的 shell 命令，透過 Socket.io 即時串流 stdout/stderr；xterm.js v4 本機 vendor 顯示 ANSI 終端機輸出；settings 新增 coding_cmd/qa_cmd 欄位；runner.js 自動呼叫對應 agent。

**Tech Stack:** Node.js child_process.spawn（shell:true）、Socket.io 4 io.use 中介層、xterm.js 4.19.0（本機 vendor）、PostgreSQL ALTER TABLE

## Global Constraints

- Port: **3939**
- JWT secret: `process.env.JWT_SECRET`（同 auth.js，驗證 token 後取 userId）
- coding_cmd / qa_cmd 儲存為 users 表新增的 TEXT 欄位（非 odoo_settings JSONB）
- spawn 使用 `{ shell: true }` 支援跨平台（Windows cmd.exe / Linux sh）
- 串流事件名稱：`terminal:output { taskId, data: string }`、`terminal:done { taskId, exitCode: number }`
- xterm.js vendor：`app/public/js/vendor/xterm.js`、`app/public/css/vendor/xterm.css`（xterm v4.19.0）
- **後端測試**：DB migration 測試須通過；coding/qa agent 測試用 mock spawn；不需要新增 UI 測試
- 現有 70/70 後端測試必須繼續通過
- Socket.io auth：`io.use()` 驗證 JWT；通過後設 `socket.userId`；未通過 → `next(new Error('Unauthorized'))`
- Coding agent 成功（exitCode=0）→ status = `qa_running`；失敗 → status = `stopped`，blocker_type = `tech`
- QA agent 成功（exitCode=0）→ status = `deploy_pending`；失敗 → status = `stopped`，blocker_type = `tech`
- coding_cmd/qa_cmd 未設定 → status = `stopped`，blocker_type = `config`，blocker_content 說明原因
- runner.js 呼叫 coding/qa agent 時：先 `await agent(taskId, userId)` 再 `processed++`（非 fire-and-forget）

---

## Task 1: DB Migration + Socket.io JWT Auth

**Files:**
- Modify: `app/server/db.js` — 加入 ALTER TABLE 步驟
- Modify: `app/server/index.js` — 加入 io.use JWT 中介層，移除不安全的 join handler

**Interfaces:**
- Produces: `users.coding_cmd TEXT`, `users.qa_cmd TEXT`（migrate() 保證存在）
- Produces: `socket.userId` 在所有連線上有效（後續 agent/route 可依賴）

- [ ] **Step 1: 修改 db.js 加入 column migration**

在 `migrate()` 函式末尾（`statements` 陣列之後、`return` 之前）加入：

```javascript
  // Column migrations — idempotent via try/catch (42701 = column already exists)
  const colMigrations = [
    "ALTER TABLE users ADD COLUMN coding_cmd TEXT",
    "ALTER TABLE users ADD COLUMN qa_cmd TEXT"
  ];
  for (const sql of colMigrations) {
    try { await query(sql); } catch (err) { if (err.code !== '42701') throw err; }
  }
```

- [ ] **Step 2: 修改 index.js — Socket.io JWT auth**

在 `if (require.main === module)` 區塊中，在 `io.on('connection', ...)` 之前加入 io.use：

```javascript
  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Unauthorized'));
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.userId = payload.userId;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });
```

同時將 `io.on('connection')` 改為使用 `socket.userId`（server-side），移除不安全的 `join` handler：

```javascript
  io.on('connection', (socket) => {
    console.log('connected:', socket.id, 'userId:', socket.userId);
    socket.join(`user:${socket.userId}`);
  });
```

- [ ] **Step 3: 更新 socket.js client 傳送 JWT**

`app/public/js/socket.js` 的 `initSocket(userId)` 中，把 `io()` 改為：

```javascript
    _socket = io({
      transports: ['websocket', 'polling'],
      auth: { token: Api.getToken() }
    });
```

同時移除 `connect` event 裡的 `_socket.emit('join', userId)` — server 現在自動 join。

```javascript
    _socket.on('connect', () => {
      console.log('[Socket] connected');
    });
```

- [ ] **Step 4: 撰寫測試**

建立 `app/server/tests/db-migration.test.js`：

```javascript
const { newDb } = require('pg-mem');

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('migrate adds coding_cmd column to users', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='coding_cmd'"
  );
  expect(rows.length).toBe(1);
});

test('migrate adds qa_cmd column to users', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='qa_cmd'"
  );
  expect(rows.length).toBe(1);
});

test('migrate is idempotent — calling twice does not throw', async () => {
  await expect(dbModule.migrate()).resolves.not.toThrow();
});
```

- [ ] **Step 5: 執行測試**

```bash
cd app && npx jest tests/db-migration.test.js --no-coverage
```

預期：3/3 PASS

- [ ] **Step 6: 執行全部測試**

```bash
npx jest --no-coverage
```

預期：73/73 PASS（原 70 + 新 3）

- [ ] **Step 7: Commit**

```bash
git add app/server/db.js app/server/index.js app/public/js/socket.js app/server/tests/db-migration.test.js
git commit -m "feat: socket.io JWT auth, DB columns for coding_cmd/qa_cmd"
```

---

## Task 2: Coding Agent

**Files:**
- Create: `app/server/pipeline/coding-agent.js`
- Modify: `app/server/pipeline/runner.js` — 呼叫 coding agent for `coding_running`
- Create: `app/server/tests/coding-agent.test.js`

**Interfaces:**
- Consumes: `users.coding_cmd TEXT`（Task 1）
- Produces: `runCodingAgent(taskId, userId): Promise<void>`
- Produces: runner.js 中 `coding_running` 呼叫 `runCodingAgent`

**coding-agent.js 實作：**

```javascript
const { spawn } = require('child_process');
const { query } = require('../db');
const notify = require('../notify');

async function runCodingAgent(taskId, userId) {
  const { rows: taskRows } = await query(
    'SELECT task_id, analysis_yaml, git_branch FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!taskRows.length) return;
  const task = taskRows[0];

  const { rows: userRows } = await query(
    'SELECT coding_cmd, odoo_settings FROM users WHERE id = $1',
    [userId]
  );
  if (!userRows.length) return;
  const { coding_cmd, odoo_settings } = userRows[0];

  if (!coding_cmd) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_type='config',
       blocker_content='未設定 coding_cmd，請至設定頁填寫', updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  const repoPath = odoo_settings?.git_repo_path || process.cwd();
  const env = {
    ...process.env,
    TASK_ID: task.task_id,
    GIT_BRANCH: task.git_branch || '',
    REPO_PATH: repoPath,
    ANALYSIS_YAML: task.analysis_yaml || ''
  };

  const proc = spawn(coding_cmd, [], { shell: true, cwd: repoPath, env });

  await new Promise((resolve) => {
    proc.stdout?.on('data', (data) => {
      notify.emitToUser(userId, 'terminal:output', { taskId, data: data.toString() });
    });
    proc.stderr?.on('data', (data) => {
      notify.emitToUser(userId, 'terminal:output', { taskId, data: data.toString() });
    });

    proc.on('close', async (code) => {
      if (code === 0) {
        await query(
          "UPDATE tasks SET status='qa_running', updated_at=NOW() WHERE id=$1",
          [taskId]
        );
        notify.emitToUser(userId, 'task:updated', { taskId, status: 'qa_running' });
      } else {
        await query(
          `UPDATE tasks SET status='stopped', blocker_type='tech',
           blocker_content=$2, updated_at=NOW() WHERE id=$1`,
          [taskId, `Coding agent exited with code ${code}`]
        );
        notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      }
      notify.emitToUser(userId, 'terminal:done', { taskId, exitCode: code });
      resolve();
    });
  });
}

module.exports = { runCodingAgent };
```

**runner.js 新增 coding_running 處理**（在 `processTask` 函式中 `deploy_pending` block 之前）：

```javascript
  const { runCodingAgent } = require('./coding-agent');
  // 在 RUNNABLE_STATUSES 加入 'coding_running':
  const RUNNABLE_STATUSES = ['analysis_running', 'branch_pending', 'coding_running', 'deploy_pending'];

  // 在 processTask 裡加入:
  if (status === 'coding_running') {
    await runCodingAgent(taskId, task.user_id);
    return;
  }
```

- [ ] **Step 1: 建立 coding-agent.js**

依照上方 coding-agent.js 實作建立檔案。

- [ ] **Step 2: 撰寫測試**

建立 `app/server/tests/coding-agent.test.js`：

```javascript
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../notify', () => ({
  emitToUser: jest.fn(),
  emitAll: jest.fn(),
  setIo: jest.fn()
}));

const spawnEvents = {};
const mockProc = {
  stdout: { on: jest.fn((event, cb) => { spawnEvents['stdout_' + event] = cb; }) },
  stderr: { on: jest.fn((event, cb) => { spawnEvents['stderr_' + event] = cb; }) },
  on: jest.fn((event, cb) => { spawnEvents[event] = cb; })
};

jest.mock('child_process', () => ({
  spawn: jest.fn(() => mockProc)
}));

let dbModule, agentModule, userId, taskId;

beforeAll(async () => {
  const db = require('pg-mem').newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: uRows } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, role, odoo_settings, coding_cmd)
     VALUES ('coder', $1, 'C', 'user', $2, 'echo done')
     RETURNING id`,
    [hash, JSON.stringify({ git_repo_path: '/repo' })]
  );
  userId = uRows[0].id;

  const { rows: tRows } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, git_branch)
     VALUES ($1, 'task_code_1', 'odoo', 'Test', 'coding_running', 'task/task_code_1')
     RETURNING id`,
    [userId]
  );
  taskId = tRows[0].id;

  agentModule = require('../pipeline/coding-agent');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  require('../notify').emitToUser.mockReset();
  Object.keys(spawnEvents).forEach(k => delete spawnEvents[k]);
  require('child_process').spawn.mockClear();
});

test('runCodingAgent streams stdout and sets qa_running on exit 0', async () => {
  const promise = agentModule.runCodingAgent(taskId, userId);

  // Simulate output and success exit
  spawnEvents['stdout_data']?.(Buffer.from('hello\n'));
  spawnEvents['close']?.(0);
  await promise;

  const { emitToUser } = require('../notify');
  const outputCalls = emitToUser.mock.calls.filter(c => c[1] === 'terminal:output');
  expect(outputCalls.length).toBeGreaterThan(0);
  expect(outputCalls[0][2].data).toContain('hello');

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('qa_running');

  const doneCalls = emitToUser.mock.calls.filter(c => c[1] === 'terminal:done');
  expect(doneCalls[0][2].exitCode).toBe(0);
});

test('runCodingAgent sets stopped on exit code non-zero', async () => {
  await dbModule.query("UPDATE tasks SET status='coding_running' WHERE id=$1", [taskId]);

  const promise = agentModule.runCodingAgent(taskId, userId);
  spawnEvents['close']?.(1);
  await promise;

  const { rows } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');
  expect(rows[0].blocker_type).toBe('tech');
});

test('runCodingAgent sets stopped + config blocker when coding_cmd not set', async () => {
  await dbModule.query("UPDATE users SET coding_cmd=NULL WHERE id=$1", [userId]);
  await dbModule.query("UPDATE tasks SET status='coding_running' WHERE id=$1", [taskId]);

  const require_child_process = require('child_process');
  await agentModule.runCodingAgent(taskId, userId);
  expect(require_child_process.spawn).not.toHaveBeenCalled();

  const { rows } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');
  expect(rows[0].blocker_type).toBe('config');

  // Restore
  await dbModule.query("UPDATE users SET coding_cmd='echo done' WHERE id=$1", [userId]);
});
```

- [ ] **Step 3: 執行 coding-agent tests**

```bash
cd app && npx jest tests/coding-agent.test.js --no-coverage
```

預期：3/3 PASS

- [ ] **Step 4: 修改 runner.js**

在 runner.js 中：
1. 將 `RUNNABLE_STATUSES` 加入 `'coding_running'`
2. 在 `processTask` 加入 coding_running block
3. require coding-agent（lazy require，避免循環依賴問題可在函式頂部 require）

完整 RUNNABLE_STATUSES：
```javascript
const RUNNABLE_STATUSES = ['analysis_running', 'branch_pending', 'coding_running', 'deploy_pending'];
```

完整 processTask `coding_running` block（加在 `branch_pending` 之後、`deploy_pending` 之前）：
```javascript
  if (status === 'coding_running') {
    const { runCodingAgent } = require('./coding-agent');
    await runCodingAgent(taskId, task.user_id);
    return;
  }
```

- [ ] **Step 5: 確認現有 runner tests 未因 RUNNABLE_STATUSES 改變而失效**

```bash
cd app && npx jest tests/runner.test.js --no-coverage
```

預期：仍 6/6 PASS

- [ ] **Step 6: 執行全部測試**

```bash
npx jest --no-coverage
```

預期：76/76 PASS（73 + 3 新）

- [ ] **Step 7: Commit**

```bash
git add app/server/pipeline/coding-agent.js app/server/pipeline/runner.js app/server/tests/coding-agent.test.js
git commit -m "feat: coding agent — subprocess management, stdout streaming, task status advance"
```

---

## Task 3: QA Agent

**Files:**
- Create: `app/server/pipeline/qa-agent.js`
- Modify: `app/server/pipeline/runner.js` — 呼叫 qa agent for `qa_running`
- Create: `app/server/tests/qa-agent.test.js`

**Interfaces:**
- Consumes: `users.qa_cmd TEXT`（Task 1）
- Produces: `runQaAgent(taskId, userId): Promise<void>`

**qa-agent.js 實作**（與 coding-agent.js 邏輯相同，差異僅在欄位名稱和狀態轉換）：

```javascript
const { spawn } = require('child_process');
const { query } = require('../db');
const notify = require('../notify');

async function runQaAgent(taskId, userId) {
  const { rows: taskRows } = await query(
    'SELECT task_id, git_branch FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!taskRows.length) return;
  const task = taskRows[0];

  const { rows: userRows } = await query(
    'SELECT qa_cmd, odoo_settings FROM users WHERE id = $1',
    [userId]
  );
  if (!userRows.length) return;
  const { qa_cmd, odoo_settings } = userRows[0];

  if (!qa_cmd) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_type='config',
       blocker_content='未設定 qa_cmd，請至設定頁填寫', updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }

  const repoPath = odoo_settings?.git_repo_path || process.cwd();
  const env = {
    ...process.env,
    TASK_ID: task.task_id,
    GIT_BRANCH: task.git_branch || '',
    REPO_PATH: repoPath
  };

  const proc = spawn(qa_cmd, [], { shell: true, cwd: repoPath, env });

  await new Promise((resolve) => {
    proc.stdout?.on('data', (data) => {
      notify.emitToUser(userId, 'terminal:output', { taskId, data: data.toString() });
    });
    proc.stderr?.on('data', (data) => {
      notify.emitToUser(userId, 'terminal:output', { taskId, data: data.toString() });
    });

    proc.on('close', async (code) => {
      if (code === 0) {
        await query(
          "UPDATE tasks SET status='deploy_pending', updated_at=NOW() WHERE id=$1",
          [taskId]
        );
        notify.emitToUser(userId, 'task:updated', { taskId, status: 'deploy_pending' });
      } else {
        await query(
          `UPDATE tasks SET status='stopped', blocker_type='tech',
           blocker_content=$2, updated_at=NOW() WHERE id=$1`,
          [taskId, `QA agent exited with code ${code}`]
        );
        notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
      }
      notify.emitToUser(userId, 'terminal:done', { taskId, exitCode: code });
      resolve();
    });
  });
}

module.exports = { runQaAgent };
```

**runner.js 更新 RUNNABLE_STATUSES 及 processTask**（加在 `coding_running` 之後）：

```javascript
  const RUNNABLE_STATUSES = ['analysis_running', 'branch_pending', 'coding_running', 'qa_running', 'deploy_pending'];

  // qa_running block in processTask:
  if (status === 'qa_running') {
    const { runQaAgent } = require('./qa-agent');
    await runQaAgent(taskId, task.user_id);
    return;
  }
```

- [ ] **Step 1: 建立 qa-agent.js**

依照上方實作建立檔案。

- [ ] **Step 2: 撰寫測試**

建立 `app/server/tests/qa-agent.test.js`（與 coding-agent.test.js 結構相同，差異在欄位 `qa_cmd`，成功結果 `deploy_pending`）：

```javascript
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../notify', () => ({
  emitToUser: jest.fn(),
  emitAll: jest.fn(),
  setIo: jest.fn()
}));

const qaSpawnEvents = {};
const mockQaProc = {
  stdout: { on: jest.fn((event, cb) => { qaSpawnEvents['stdout_' + event] = cb; }) },
  stderr: { on: jest.fn((event, cb) => { qaSpawnEvents['stderr_' + event] = cb; }) },
  on: jest.fn((event, cb) => { qaSpawnEvents[event] = cb; })
};

jest.mock('child_process', () => ({
  spawn: jest.fn(() => mockQaProc)
}));

let dbModule, agentModule, userId, taskId;

beforeAll(async () => {
  const db = require('pg-mem').newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: uRows } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, role, odoo_settings, qa_cmd)
     VALUES ('qa_user', $1, 'Q', 'user', $2, 'npm test')
     RETURNING id`,
    [hash, JSON.stringify({ git_repo_path: '/repo' })]
  );
  userId = uRows[0].id;

  const { rows: tRows } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, git_branch)
     VALUES ($1, 'task_qa_1', 'odoo', 'Test', 'qa_running', 'task/task_qa_1')
     RETURNING id`,
    [userId]
  );
  taskId = tRows[0].id;

  agentModule = require('../pipeline/qa-agent');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => {
  require('../notify').emitToUser.mockReset();
  Object.keys(qaSpawnEvents).forEach(k => delete qaSpawnEvents[k]);
  require('child_process').spawn.mockClear();
});

test('runQaAgent sets deploy_pending on exit 0', async () => {
  const promise = agentModule.runQaAgent(taskId, userId);
  qaSpawnEvents['stdout_data']?.(Buffer.from('tests passed\n'));
  qaSpawnEvents['close']?.(0);
  await promise;

  const { rows } = await dbModule.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('deploy_pending');

  const { emitToUser } = require('../notify');
  const doneCalls = emitToUser.mock.calls.filter(c => c[1] === 'terminal:done');
  expect(doneCalls[0][2].exitCode).toBe(0);
});

test('runQaAgent sets stopped on exit code non-zero', async () => {
  await dbModule.query("UPDATE tasks SET status='qa_running' WHERE id=$1", [taskId]);

  const promise = agentModule.runQaAgent(taskId, userId);
  qaSpawnEvents['close']?.(2);
  await promise;

  const { rows } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');
  expect(rows[0].blocker_type).toBe('tech');
});

test('runQaAgent sets stopped + config blocker when qa_cmd not set', async () => {
  await dbModule.query("UPDATE users SET qa_cmd=NULL WHERE id=$1", [userId]);
  await dbModule.query("UPDATE tasks SET status='qa_running' WHERE id=$1", [taskId]);

  const { spawn } = require('child_process');
  await agentModule.runQaAgent(taskId, userId);
  expect(spawn).not.toHaveBeenCalled();

  const { rows } = await dbModule.query('SELECT status, blocker_type FROM tasks WHERE id = $1', [taskId]);
  expect(rows[0].status).toBe('stopped');
  expect(rows[0].blocker_type).toBe('config');

  await dbModule.query("UPDATE users SET qa_cmd='npm test' WHERE id=$1", [userId]);
});
```

- [ ] **Step 3: 執行 qa-agent tests**

```bash
cd app && npx jest tests/qa-agent.test.js --no-coverage
```

預期：3/3 PASS

- [ ] **Step 4: 修改 runner.js — 加入 qa_running**

```javascript
const RUNNABLE_STATUSES = ['analysis_running', 'branch_pending', 'coding_running', 'qa_running', 'deploy_pending'];
```

在 `processTask` 中 `coding_running` block 之後加入：
```javascript
  if (status === 'qa_running') {
    const { runQaAgent } = require('./qa-agent');
    await runQaAgent(taskId, task.user_id);
    return;
  }
```

- [ ] **Step 5: 執行全部測試**

```bash
npx jest --no-coverage
```

預期：79/79 PASS（76 + 3 新）

- [ ] **Step 6: Commit**

```bash
git add app/server/pipeline/qa-agent.js app/server/pipeline/runner.js app/server/tests/qa-agent.test.js
git commit -m "feat: QA agent — subprocess streaming, task advance to deploy_pending"
```

---

## Task 4: Terminal UI (xterm.js)

**Files:**
- Create: `app/public/js/vendor/xterm.js` — 下載 xterm v4.19.0
- Create: `app/public/css/vendor/xterm.css` — 下載 xterm v4.19.0 CSS
- Create: `app/public/js/views/Terminal.js` — xterm.js 終端機 view
- Modify: `app/public/index.html` — 加入 xterm vendor scripts
- Modify: `app/public/js/app.js` — 加入 `/task/:id/terminal` route

**Interfaces:**
- Consumes: `terminal:output { taskId, data }` socket 事件（Task 2, 3）
- Consumes: `terminal:done { taskId, exitCode }` socket 事件
- Produces: `/task/:id/terminal` 路由，顯示即時終端機輸出

- [ ] **Step 1: 下載 xterm.js vendor 檔案**

使用 Node.js script 下載（在 `app/` 目錄執行）：

```javascript
// 一次性下載，不需存入 codebase 作為 script
const https = require('https');
const fs = require('fs');
const path = require('path');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    function get(url) {
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    }
    get(url);
  });
}

const vendorJs = path.join(__dirname, '../app/public/js/vendor/xterm.js');
const vendorCss = path.join(__dirname, '../app/public/css/vendor/xterm.css');
fs.mkdirSync(path.dirname(vendorCss), { recursive: true });

Promise.all([
  download('https://unpkg.com/xterm@4.19.0/lib/xterm.js', vendorJs),
  download('https://unpkg.com/xterm@4.19.0/css/xterm.css', vendorCss)
]).then(() => console.log('Downloaded xterm vendor files'));
```

執行：`node -e "<上方 script>"` 或直接用 Node.js `https.get` 指令下載。

確認下載成功：
```bash
# 確認 xterm.js 存在且大小 > 100KB
ls -la app/public/js/vendor/xterm.js
ls -la app/public/css/vendor/xterm.css
```

- [ ] **Step 2: 修改 index.html — 加入 xterm vendor**

在 `</head>` 之前加入 CSS：

```html
    <link rel="stylesheet" href="/css/vendor/xterm.css">
```

在 `socket.io.js` 之前加入 JS：

```html
    <script src="/js/vendor/xterm.js"></script>
```

- [ ] **Step 3: 建立 Terminal.js view**

```javascript
window.TerminalView = Vue.defineComponent({
  name: 'TerminalView',
  data() {
    return {
      taskId: null,
      taskTitle: '',
      exitCode: null,
      running: false,
      error: ''
    };
  },
  async created() {
    this.taskId = parseInt(this.$route.params.id, 10);
    try {
      const data = await Api.get(`tasks/${this.taskId}`);
      this.taskTitle = data.task?.title || data.task?.task_id || `Task ${this.taskId}`;
      const status = data.task?.status;
      this.running = ['coding_running', 'qa_running'].includes(status);
    } catch (e) {
      this.error = e.message;
    }
  },
  mounted() {
    const term = new Terminal({
      theme: { background: '#1a1a1a', foreground: '#f0f0f0' },
      fontSize: 13,
      fontFamily: 'Consolas, monospace',
      convertEol: true,
      scrollback: 5000
    });
    term.open(this.$refs.termContainer);
    this._term = term;

    const taskId = this.taskId;
    this._outputHandler = (data) => {
      if (data.taskId === taskId) term.write(data.data);
    };
    this._doneHandler = (data) => {
      if (data.taskId === taskId) {
        this.exitCode = data.exitCode;
        this.running = false;
        term.writeln(`\r\n\x1b[${data.exitCode === 0 ? '32' : '31'}m[Process exited with code ${data.exitCode}]\x1b[0m`);
      }
    };

    if (window._socket) {
      window._socket.on('terminal:output', this._outputHandler);
      window._socket.on('terminal:done', this._doneHandler);
    }
  },
  beforeUnmount() {
    if (window._socket) {
      window._socket.off?.('terminal:output', this._outputHandler);
      window._socket.off?.('terminal:done', this._doneHandler);
    }
    this._term?.dispose();
  },
  methods: {
    goBack() { this.$router.push(`/task/${this.taskId}`); }
  },
  template: `
    <div class="topbar">
      <h1>終端機 <span style="font-weight:400;font-size:14px">{{ taskTitle }}</span></h1>
      <button class="btn btn-outline btn-sm" @click="goBack">← 返回</button>
    </div>
    <div class="content" style="padding:0">
      <div v-if="error" style="padding:16px;color:var(--error)">{{ error }}</div>
      <div v-else>
        <div style="padding:8px 16px;background:var(--sidebar-bg);font-size:12px;color:var(--text-muted);display:flex;gap:16px">
          <span>{{ running ? '⏳ 執行中...' : (exitCode === 0 ? '✅ 成功' : exitCode !== null ? '❌ 失敗 (code ' + exitCode + ')' : '⏸ 待機') }}</span>
          <span v-if="!running && exitCode === null" style="color:var(--text-muted)">等待 pipeline 啟動...</span>
        </div>
        <div ref="termContainer" style="height:calc(100vh - 120px);padding:8px"></div>
      </div>
    </div>
  `
});
```

**注意：** Terminal.js 依賴 `window._socket` 來監聽事件。為此，需在 socket.js 中重新暴露 `_socket`——但只讀（非完整 raw handle）。改法：在 socket.js 的 `initSocket` 函式末尾加：
```javascript
    Object.defineProperty(window, '_socket', { get: () => _socket, configurable: true });
```
這樣 `window._socket` 是只讀的 getter，不能被外部直接重設。

- [ ] **Step 4: 修改 app.js — 加入 Terminal route**

在 `routes` 陣列中加入（在 `'/task/:id'` 之後）：

```javascript
    { path: '/task/:id/terminal', component: window.TerminalView, meta: { requiresAuth: true } },
```

在 `index.html` 的 `<script>` 標籤中加入 Terminal.js（在 app.js 之前）：

```html
    <script src="/js/views/Terminal.js"></script>
```

同時在 TaskDetail.js 中，若 `status` 為 `coding_running` 或 `qa_running`，顯示「查看終端機」連結：

在 TaskDetail 的 template 加入（在 `blocker` display 之後）：

```html
    <div v-if="task.status === 'coding_running' || task.status === 'qa_running'"
         style="margin-top:16px">
      <router-link :to="'/task/' + task.id + '/terminal'" class="btn btn-outline btn-sm">
        🖥️ 查看終端機輸出
      </router-link>
    </div>
```

- [ ] **Step 5: 執行全部後端測試確認未破壞**

```bash
cd app && npx jest --no-coverage
```

預期：79/79 PASS（UI 變更不影響後端測試）

- [ ] **Step 6: Commit**

```bash
git add app/public/js/vendor/xterm.js app/public/css/vendor/xterm.css \
        app/public/js/views/Terminal.js app/public/index.html \
        app/public/js/app.js app/public/js/views/TaskDetail.js \
        app/public/js/socket.js
git commit -m "feat: terminal UI (xterm.js v4), live task output streaming"
```

---

## Task 5: Settings UI + 整合驗證

**Files:**
- Modify: `app/server/settings.js` — 加入 coding_cmd/qa_cmd 讀寫
- Modify: `app/public/js/views/Settings.js` — 加入 coding_cmd/qa_cmd 欄位
- Create: `app/server/tests/settings-sp5.test.js` — 驗證新欄位的 GET/PUT

**Interfaces:**
- Consumes: `users.coding_cmd`, `users.qa_cmd`（Task 1）
- Produces: Settings API 回傳並接受 `coding_cmd`, `qa_cmd`

**settings.js 更新：**

GET 改為：
```javascript
      const { rows } = await query(
        'SELECT odoo_settings, sync_interval, deploy_cmd, coding_cmd, qa_cmd FROM users WHERE id = $1',
        [req.userId]
      );
```

PUT 改為（新增 coding_cmd, qa_cmd 參數）：
```javascript
      const { odoo_settings, sync_interval, deploy_cmd, coding_cmd, qa_cmd } = req.body;
      // ... validation ...
      await query(
        `UPDATE users SET
           odoo_settings = COALESCE($2, odoo_settings),
           sync_interval = COALESCE($3, sync_interval),
           deploy_cmd    = COALESCE($4, deploy_cmd),
           coding_cmd    = COALESCE($5, coding_cmd),
           qa_cmd        = COALESCE($6, qa_cmd)
         WHERE id = $1`,
        [req.userId,
         odoo_settings ? JSON.stringify(odoo_settings) : null,
         sync_interval ?? null,
         deploy_cmd ?? null,
         coding_cmd ?? null,
         qa_cmd ?? null]
      );
```

**Settings.js UI 更新**（在 `deploy_cmd` 欄位之後加入）：

```javascript
// 在 form data 中加入:
coding_cmd: '',
qa_cmd: '',

// 在 loadSettings 中加入:
this.form.coding_cmd = data.coding_cmd || '';
this.form.qa_cmd = data.qa_cmd || '';

// 在 saveSettings 的 body 中加入:
coding_cmd: this.form.coding_cmd || null,
qa_cmd: this.form.qa_cmd || null,
```

Template 加入（在 deploy_cmd 欄位之後）：
```html
      <div class="form-group">
        <label>Coding Agent 命令</label>
        <input v-model="form.coding_cmd" class="form-control" placeholder="例：claude --dangerously-skip-permissions 或空白跳過" />
        <div class="form-hint">coding_running 時執行的命令，可用環境變數 $TASK_ID $GIT_BRANCH $REPO_PATH $ANALYSIS_YAML</div>
      </div>
      <div class="form-group">
        <label>QA Agent 命令</label>
        <input v-model="form.qa_cmd" class="form-control" placeholder="例：npm test 或空白跳過" />
        <div class="form-hint">qa_running 時執行的命令</div>
      </div>
```

- [ ] **Step 1: 修改 settings.js（GET + PUT）**

依照上方更新 settings.js。

- [ ] **Step 2: 修改 Settings.js UI**

依照上方更新 Settings.js。

- [ ] **Step 3: 撰寫後端測試**

建立 `app/server/tests/settings-sp5.test.js`：

```javascript
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() }
})));
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn().mockResolvedValue({ processed: 0 }),
  resetLoopCounter: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
jest.mock('../pipeline/git', () => ({
  createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn()
}));

process.env.JWT_SECRET = 'test-sp5';

let app, dbModule, token;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  const res = await request(app).post('/api/auth/setup').send({
    username: 'sp5user', password: 'pass1234', display_name: 'SP5'
  });
  token = res.body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('GET /api/settings returns coding_cmd and qa_cmd', async () => {
  const res = await request(app).get('/api/settings')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('coding_cmd');
  expect(res.body).toHaveProperty('qa_cmd');
});

test('PUT /api/settings saves coding_cmd and qa_cmd', async () => {
  const res = await request(app).put('/api/settings')
    .set('Authorization', `Bearer ${token}`)
    .send({ coding_cmd: 'echo hello', qa_cmd: 'echo test' });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

test('GET /api/settings returns updated coding_cmd and qa_cmd', async () => {
  const res = await request(app).get('/api/settings')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.coding_cmd).toBe('echo hello');
  expect(res.body.qa_cmd).toBe('echo test');
});
```

- [ ] **Step 4: 執行測試**

```bash
cd app && npx jest tests/settings-sp5.test.js --no-coverage
```

預期：3/3 PASS

- [ ] **Step 5: 執行全部測試**

```bash
npx jest --no-coverage
```

預期：82/82 PASS（79 + 3 新）

- [ ] **Step 6: Commit**

```bash
git add app/server/settings.js app/public/js/views/Settings.js \
        app/server/tests/settings-sp5.test.js
git commit -m "feat: settings coding_cmd/qa_cmd API and UI fields"
```

---

## Self-Review

**Spec coverage:**

| 需求 | Task |
|---|---|
| Socket.io JWT auth（server-side）| Task 1 |
| coding_cmd / qa_cmd DB 欄位 | Task 1 |
| Coding Agent subprocess + stream | Task 2 |
| QA Agent subprocess + stream | Task 3 |
| xterm.js 終端機 UI | Task 4 |
| Terminal route /task/:id/terminal | Task 4 |
| TaskDetail 連結到終端機 | Task 4 |
| Settings UI coding_cmd/qa_cmd | Task 5 |
| Settings API GET/PUT 新欄位 | Task 5 |

**Placeholder scan:** 無 TBD/TODO。所有實作程式碼已完整列出。

**Type consistency:** `runCodingAgent(taskId, userId)` / `runQaAgent(taskId, userId)` 介面一致。

**Known deferred items (to Sub-plan 6):**
- xterm.js FitAddon（自動調整終端機寬度）
- 終端機歷史記錄（儲存到 task_logs）
- Multiple concurrent agent process management
- Graceful shutdown of running processes on server restart
