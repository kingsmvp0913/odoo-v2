# AI Dev Web Platform — Sub-plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 可安裝的 Node.js 伺服器，含 Express + Socket.io、SQLite schema（WAL）、JWT 認證、首次設定頁，以及 Windows/Linux 一鍵安裝腳本。

**Architecture:** Express app 在 port 3939 提供 `/api/*` REST API 與靜態檔案。better-sqlite3 WAL 模式儲存所有資料。JWT Bearer token 驗證。首次執行偵測（users 表為空）自動導向 `/setup.html`，建立管理員後永久鎖定。

**Tech Stack:** Node.js 20+, Express 4, Socket.io 4, better-sqlite3, bcryptjs, jsonwebtoken, Jest 29, supertest 7

## Global Constraints

- Port: **3939**（非預設，避免衝突）
- 所有任務資料存 SQLite，**禁止**寫入任何中間檔案到磁碟
- DB 路徑由 `DB_PATH` 環境變數控制（測試用獨立 DB）
- JWT secret 由 `JWT_SECRET` 環境變數控制，dev fallback: `aidev-dev-secret`
- 所有 API 路徑以 `/api/` 開頭
- 語言：繁體中文 UI，程式碼英文

---

## File Map

| 路徑 | 職責 |
|---|---|
| `app/package.json` | 相依套件、npm scripts |
| `app/server/index.js` | Express + Socket.io 入口，模組化 createApp() |
| `app/server/db.js` | SQLite 連線、schema migration |
| `app/server/auth.js` | JWT 工具函式、/api/auth/* 路由、verifyToken middleware |
| `app/server/tests/db.test.js` | DB schema 測試 |
| `app/server/tests/auth.test.js` | Auth 端點整合測試 |
| `app/public/setup.html` | 首次設定表單（靜態 HTML） |
| `app/public/index.html` | SPA 入口（本計畫為 stub，Sub-plan 4 補全） |
| `data/config.json` | JWT_SECRET + PORT（安裝時生成） |
| `install.ps1` | Windows 一鍵安裝 |
| `install.sh` | Linux/Mac 一鍵安裝 |
| `start.ps1` | Windows 啟動 |
| `start.sh` | Linux/Mac 啟動 |

---

## Task 1: Package.json + Express 骨架

**Files:**
- Create: `app/package.json`
- Create: `app/server/index.js`
- Create: `app/server/tests/server.test.js`

**Interfaces:**
- Produces: `createApp()` → Express app instance（供測試 import）

- [ ] **Step 1: 建立 app/ 目錄結構**

```bash
mkdir -p app/server/tests app/public data
```

- [ ] **Step 2: 建立 package.json**

建立 `app/package.json`：

```json
{
  "name": "aidev",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node server/index.js",
    "test": "jest --runInBand --forceExit"
  },
  "dependencies": {
    "express": "^4.19.2",
    "socket.io": "^4.7.5",
    "better-sqlite3": "^9.6.0",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^7.0.0"
  },
  "jest": {
    "testEnvironment": "node",
    "testMatch": ["**/tests/**/*.test.js"]
  }
}
```

- [ ] **Step 3: 撰寫失敗的 server test**

建立 `app/server/tests/server.test.js`：

```javascript
const request = require('supertest');
const path = require('path');
process.env.DB_PATH = path.join(__dirname, 'test-server.db');

const { createApp } = require('../index');
const fs = require('fs');
const app = createApp();

afterAll(() => {
  try { fs.unlinkSync(process.env.DB_PATH); } catch {}
});

test('GET / returns 200', async () => {
  const res = await request(app).get('/');
  expect(res.status).toBe(200);
});

test('GET /api/unknown returns 404', async () => {
  const res = await request(app).get('/api/unknown');
  expect(res.status).toBe(404);
});
```

- [ ] **Step 4: 執行測試確認失敗**

```bash
cd app && npm install && npx jest tests/server.test.js --no-coverage
```

預期：FAIL（`Cannot find module '../index'`）

- [ ] **Step 5: 建立 index.js**

建立 `app/server/index.js`：

```javascript
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const PORT = process.env.PORT || 3939;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  // API 404
  app.use('/api/', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    console.log('connected:', socket.id);
  });

  httpServer.listen(PORT, () => {
    console.log(`AI Dev http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
```

建立 `app/public/index.html`（stub）：

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <title>AI Dev</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  </style>
</head>
<body>
  <div id="app">載入中...</div>
  <script>
    const token = localStorage.getItem('token');
    if (!token) {
      fetch('/api/setup/status').then(r => r.json()).then(d => {
        window.location.href = d.needsSetup ? '/setup.html' : '/login.html';
      });
    } else {
      fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => { if (!r.ok) { localStorage.removeItem('token'); window.location.href = '/login.html'; } return r.json(); })
        .then(u => { document.getElementById('app').textContent = `歡迎，${u.display_name}（UI 開發中）`; });
    }
  </script>
</body>
</html>
```

- [ ] **Step 6: 執行測試確認通過**

```bash
cd app && npx jest tests/server.test.js --no-coverage
```

預期：PASS（2 tests）

- [ ] **Step 7: Commit**

```bash
cd app && git add package.json server/index.js public/index.html server/tests/server.test.js
cd .. && git commit -m "feat: Express + Socket.io skeleton on port 3939"
```

---

## Task 2: SQLite Schema + Migration

**Files:**
- Create: `app/server/db.js`
- Create: `app/server/tests/db.test.js`

**Interfaces:**
- Produces: `getDb()` → better-sqlite3 Database instance（單例）

- [ ] **Step 1: 撰寫失敗的 DB test**

建立 `app/server/tests/db.test.js`：

```javascript
const path = require('path');
process.env.DB_PATH = path.join(__dirname, 'test-db.db');

const { getDb } = require('../db');
const fs = require('fs');

afterAll(() => {
  try { fs.unlinkSync(process.env.DB_PATH); } catch {}
});

test('creates all required tables', () => {
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all().map(r => r.name);
  ['users', 'tasks', 'task_logs', 'loop_counter', 'sessions'].forEach(t => {
    expect(tables).toContain(t);
  });
});

test('WAL mode enabled', () => {
  const db = getDb();
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
});

test('foreign keys enforced', () => {
  const db = getDb();
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
});

test('getDb() returns same instance (singleton)', () => {
  const a = getDb();
  const b = getDb();
  expect(a).toBe(b);
});
```

- [ ] **Step 2: 執行確認失敗**

```bash
cd app && npx jest tests/db.test.js --no-coverage
```

預期：FAIL（`Cannot find module '../db'`）

- [ ] **Step 3: 建立 db.js**

建立 `app/server/db.js`：

```javascript
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/app.db');

let _db;

function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      odoo_settings TEXT,
      sync_interval INTEGER DEFAULT 15,
      deploy_cmd    TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      task_id         TEXT NOT NULL,
      source          TEXT NOT NULL,
      title           TEXT,
      original_text   TEXT,
      analysis_yaml   TEXT,
      status          TEXT NOT NULL DEFAULT 'new',
      git_branch      TEXT,
      reentry_count   INTEGER DEFAULT 0,
      blocker_type    TEXT,
      blocker_content TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES tasks(id),
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS loop_counter (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id),
      run_started_at TEXT,
      loop_count     INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      token_hash  TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    );
  `);
}

// 供測試重置用
function _resetForTesting() { _db = undefined; }

module.exports = { getDb, _resetForTesting };
```

- [ ] **Step 4: 執行確認通過**

```bash
cd app && npx jest tests/db.test.js --no-coverage
```

預期：PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add app/server/db.js app/server/tests/db.test.js
git commit -m "feat: SQLite schema with WAL, all 5 tables"
```

---

## Task 3: Auth 端點 + JWT Middleware

**Files:**
- Create: `app/server/auth.js`
- Modify: `app/server/index.js`（掛載 auth routes）
- Create: `app/server/tests/auth.test.js`

**Interfaces:**
- Consumes: `getDb()` from `./db`
- Produces:
  - `verifyToken(req, res, next)` middleware
  - `registerRoutes(app)` → 掛載 `/api/auth/*` 與 `/api/setup/*`

- [ ] **Step 1: 撰寫失敗的 auth test**

建立 `app/server/tests/auth.test.js`：

```javascript
const request = require('supertest');
const path = require('path');
process.env.DB_PATH = path.join(__dirname, 'test-auth.db');

const { createApp } = require('../index');
const { _resetForTesting } = require('../db');
const fs = require('fs');

const app = createApp();
let adminToken;

afterAll(() => {
  _resetForTesting();
  try { fs.unlinkSync(process.env.DB_PATH); } catch {}
});

test('GET /api/setup/status → needsSetup: true initially', async () => {
  const res = await request(app).get('/api/setup/status');
  expect(res.status).toBe(200);
  expect(res.body.needsSetup).toBe(true);
});

test('POST /api/auth/setup → creates admin, returns token', async () => {
  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'password123', display_name: '管理員'
  });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeDefined();
  adminToken = res.body.token;
});

test('POST /api/auth/setup → 403 after first admin', async () => {
  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin2', password: 'password123', display_name: '管理員2'
  });
  expect(res.status).toBe(403);
});

test('GET /api/setup/status → needsSetup: false after setup', async () => {
  const res = await request(app).get('/api/setup/status');
  expect(res.body.needsSetup).toBe(false);
});

test('POST /api/auth/login → valid credentials return token + user', async () => {
  const res = await request(app).post('/api/auth/login').send({
    username: 'admin', password: 'password123'
  });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeDefined();
  expect(res.body.user.role).toBe('admin');
  expect(res.body.user.password_hash).toBeUndefined();
});

test('POST /api/auth/login → 401 on wrong password', async () => {
  const res = await request(app).post('/api/auth/login').send({
    username: 'admin', password: 'wrong'
  });
  expect(res.status).toBe(401);
});

test('GET /api/auth/me → returns user with valid token', async () => {
  const res = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.username).toBe('admin');
  expect(res.body.password_hash).toBeUndefined();
});

test('GET /api/auth/me → 401 without token', async () => {
  const res = await request(app).get('/api/auth/me');
  expect(res.status).toBe(401);
});

test('GET /api/auth/me → 401 with invalid token', async () => {
  const res = await request(app).get('/api/auth/me')
    .set('Authorization', 'Bearer invalid.token.here');
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: 執行確認失敗**

```bash
cd app && npx jest tests/auth.test.js --no-coverage
```

預期：FAIL（routes not registered）

- [ ] **Step 3: 建立 auth.js**

建立 `app/server/auth.js`：

```javascript
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'aidev-dev-secret';
const JWT_EXPIRES = '7d';

function hashPassword(pw) { return bcrypt.hashSync(pw, 12); }
function checkPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }
function signToken(userId) { return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES }); }

function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function registerRoutes(app) {
  app.get('/api/setup/status', (req, res) => {
    const n = getDb().prepare('SELECT COUNT(*) as n FROM users').get().n;
    res.json({ needsSetup: n === 0 });
  });

  app.post('/api/auth/setup', (req, res) => {
    const db = getDb();
    if (db.prepare('SELECT COUNT(*) as n FROM users').get().n > 0)
      return res.status(403).json({ error: 'Setup already completed' });
    const { username, password, display_name } = req.body;
    if (!username || !password || !display_name)
      return res.status(400).json({ error: 'username, password, display_name required' });
    if (password.length < 8)
      return res.status(400).json({ error: '密碼至少 8 個字元' });
    const r = db.prepare(
      'INSERT INTO users (username, password_hash, display_name, role) VALUES (?,?,?,?)'
    ).run(username, hashPassword(password), display_name, 'admin');
    res.json({ token: signToken(r.lastInsertRowid) });
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const user = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !checkPassword(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    const { password_hash, ...safeUser } = user;
    res.json({ token: signToken(user.id), user: safeUser });
  });

  app.get('/api/auth/me', verifyToken, (req, res) => {
    const user = getDb().prepare(
      'SELECT id, username, display_name, role, odoo_settings, sync_interval FROM users WHERE id = ?'
    ).get(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });
}

module.exports = { verifyToken, registerRoutes };
```

- [ ] **Step 4: 掛載 auth routes 到 index.js**

修改 `app/server/index.js`，在 `express.json()` 之後加入：

```javascript
const { registerRoutes: registerAuthRoutes } = require('./auth');
// ... 在 app.use(express.json()) 之後：
registerAuthRoutes(app);
```

完整 index.js（取代原檔）：

```javascript
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { registerRoutes: registerAuthRoutes } = require('./auth');

const PORT = process.env.PORT || 3939;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  registerAuthRoutes(app);

  app.use('/api/', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (req, res) =>
    res.sendFile(path.join(__dirname, '../public/index.html')));

  return app;
}

if (require.main === module) {
  const app = createApp();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });
  io.on('connection', socket => console.log('connected:', socket.id));
  httpServer.listen(PORT, () => console.log(`AI Dev http://localhost:${PORT}`));
}

module.exports = { createApp };
```

- [ ] **Step 5: 執行確認通過**

```bash
cd app && npx jest tests/auth.test.js --no-coverage
```

預期：PASS（9 tests）

- [ ] **Step 6: 執行全部 tests**

```bash
cd app && npx jest --no-coverage
```

預期：PASS（全部 tests，共 14 個）

- [ ] **Step 7: Commit**

```bash
git add app/server/auth.js app/server/index.js app/server/tests/auth.test.js
git commit -m "feat: JWT auth, setup/login/me endpoints, verifyToken middleware"
```

---

## Task 4: 首次設定頁面（setup.html）

**Files:**
- Create: `app/public/setup.html`

**Interfaces:**
- Consumes: `GET /api/setup/status`、`POST /api/auth/setup`
- Produces: 管理員 token 存入 `localStorage('token')`，導向 `/`

- [ ] **Step 1: 建立 setup.html**

建立 `app/public/setup.html`：

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Dev — 初始設定</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a; color: #e2e8f0;
      display: flex; align-items: center; justify-content: center; min-height: 100vh;
    }
    .card {
      background: #1e293b; border-radius: 12px; padding: 2rem;
      width: 100%; max-width: 400px; box-shadow: 0 4px 24px rgba(0,0,0,.4);
    }
    h1 { font-size: 1.375rem; margin-bottom: .375rem; }
    .subtitle { color: #94a3b8; font-size: .8125rem; margin-bottom: 1.5rem; line-height: 1.5; }
    label { display: block; font-size: .8125rem; color: #cbd5e1; margin-bottom: .25rem; }
    input {
      width: 100%; padding: .625rem .75rem;
      background: #0f172a; border: 1px solid #334155; border-radius: 6px;
      color: #e2e8f0; font-size: .875rem; margin-bottom: 1rem;
      transition: border-color .15s;
    }
    input:focus { outline: none; border-color: #3b82f6; }
    button {
      width: 100%; padding: .75rem; background: #3b82f6; color: #fff;
      border: none; border-radius: 6px; font-size: .875rem; cursor: pointer;
      transition: background .15s;
    }
    button:hover { background: #2563eb; }
    button:disabled { background: #334155; cursor: not-allowed; }
    .error {
      color: #f87171; font-size: .8125rem; margin-bottom: .75rem;
      padding: .5rem .75rem; background: rgba(248,113,113,.1);
      border-radius: 6px; display: none;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>AI Dev 初始設定</h1>
    <p class="subtitle">建立管理員帳號後即可開始使用。此頁面設定完成後將永久關閉。</p>
    <div class="error" id="error"></div>
    <label for="username">帳號</label>
    <input type="text" id="username" placeholder="admin" autocomplete="username">
    <label for="password">密碼（至少 8 個字元）</label>
    <input type="password" id="password" autocomplete="new-password">
    <label for="display_name">顯示名稱</label>
    <input type="text" id="display_name" placeholder="系統管理員">
    <button id="btn" onclick="setup()">完成設定</button>
  </div>
  <script>
    fetch('/api/setup/status').then(r => r.json()).then(d => {
      if (!d.needsSetup) window.location.replace('/');
    });

    async function setup() {
      const errorEl = document.getElementById('error');
      const btn = document.getElementById('btn');
      errorEl.style.display = 'none';

      const body = {
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
        display_name: document.getElementById('display_name').value.trim()
      };
      if (!body.username || !body.password || !body.display_name) {
        errorEl.textContent = '請填寫所有欄位'; errorEl.style.display = 'block'; return;
      }
      if (body.password.length < 8) {
        errorEl.textContent = '密碼至少需要 8 個字元'; errorEl.style.display = 'block'; return;
      }

      btn.disabled = true; btn.textContent = '設定中...';
      const res = await fetch('/api/auth/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error; errorEl.style.display = 'block';
        btn.disabled = false; btn.textContent = '完成設定'; return;
      }
      localStorage.setItem('token', data.token);
      window.location.replace('/');
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: 手動驗證（需伺服器跑起來）**

```bash
cd app && node server/index.js
# 瀏覽器開 http://localhost:3939/setup.html
# 1. 填寫欄位後送出 → 應導向 /
# 2. 重新開 /setup.html → 應立刻導向 /（needsSetup: false）
# 3. 空白欄位送出 → 顯示錯誤訊息
```

- [ ] **Step 3: Commit**

```bash
git add app/public/setup.html
git commit -m "feat: first-run setup page, auto-redirect when already configured"
```

---

## Task 5: 安裝腳本與啟動腳本

**Files:**
- Create: `install.ps1`
- Create: `install.sh`
- Create: `start.ps1`
- Create: `start.sh`

**Interfaces:**
- `install.*` 執行後：Node.js 已安裝、npm install 完成、`data/config.json` 存在、瀏覽器自動開啟 `http://localhost:3939/setup.html`
- `start.*` 執行後：載入 config.json 中的 JWT_SECRET 與 PORT，啟動伺服器

- [ ] **Step 1: 建立 install.ps1**

建立 `install.ps1`（專案根目錄）：

```powershell
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

Write-Host "=== AI Dev 安裝程式 ===" -ForegroundColor Cyan

# 1. 檢查 Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "安裝 Node.js 20 LTS..." -ForegroundColor Yellow
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    # 重整 PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "Node.js 安裝失敗，請手動安裝後重試：https://nodejs.org" -ForegroundColor Red
        exit 1
    }
}
Write-Host "Node.js $(node --version)" -ForegroundColor Green

# 2. 安裝相依套件
Write-Host "安裝套件..." -ForegroundColor Yellow
Set-Location (Join-Path $Root "app")
npm install --prefer-offline
Set-Location $Root

# 3. 建立 data 目錄與 config
$dataDir = Join-Path $Root "data"
New-Item -ItemType Directory -Force $dataDir | Out-Null

$configPath = Join-Path $dataDir "config.json"
if (-not (Test-Path $configPath)) {
    $secret = [Convert]::ToBase64String(
        [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    )
    @{ JWT_SECRET = $secret; PORT = 3939 } | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
    Write-Host "設定檔已產生" -ForegroundColor Green
}

# 4. 啟動並開瀏覽器
Write-Host "啟動 AI Dev 於 http://localhost:3939 ..." -ForegroundColor Cyan
Start-Process "http://localhost:3939/setup.html"
$config = Get-Content $configPath | ConvertFrom-Json
$env:JWT_SECRET = $config.JWT_SECRET
$env:PORT       = $config.PORT
node (Join-Path $Root "app\server\index.js")
```

- [ ] **Step 2: 建立 install.sh**

建立 `install.sh`（專案根目錄）：

```bash
#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "=== AI Dev 安裝程式 ==="

# 1. 檢查 Node.js
if ! command -v node &>/dev/null; then
    echo "安裝 Node.js..."
    if command -v nvm &>/dev/null; then
        nvm install 20 && nvm use 20
    elif command -v brew &>/dev/null; then
        brew install node@20
    elif command -v apt-get &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    else
        echo "無法自動安裝 Node.js，請手動安裝：https://nodejs.org" && exit 1
    fi
fi
echo "Node.js $(node --version)"

# 2. 安裝相依套件
cd "$ROOT/app" && npm install --prefer-offline && cd "$ROOT"

# 3. data 目錄與 config
mkdir -p "$ROOT/data"
CONFIG="$ROOT/data/config.json"
if [ ! -f "$CONFIG" ]; then
    SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")
    printf '{"JWT_SECRET":"%s","PORT":3939}' "$SECRET" > "$CONFIG"
    echo "設定檔已產生"
fi

# 4. 啟動並開瀏覽器
echo "啟動 AI Dev 於 http://localhost:3939 ..."
if command -v xdg-open &>/dev/null; then xdg-open "http://localhost:3939/setup.html" &
elif command -v open &>/dev/null; then open "http://localhost:3939/setup.html"; fi

JWT_SECRET=$(node -p "require('$CONFIG').JWT_SECRET")
PORT=$(node -p "require('$CONFIG').PORT")
export JWT_SECRET PORT
node "$ROOT/app/server/index.js"
```

- [ ] **Step 3: 建立 start.ps1**

建立 `start.ps1`（專案根目錄）：

```powershell
#Requires -Version 5.1
$Root = $PSScriptRoot
$config = Get-Content (Join-Path $Root "data\config.json") | ConvertFrom-Json
$env:JWT_SECRET = $config.JWT_SECRET
$env:PORT       = $config.PORT
node (Join-Path $Root "app\server\index.js")
```

- [ ] **Step 4: 建立 start.sh**

建立 `start.sh`（專案根目錄）：

```bash
#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
export JWT_SECRET=$(node -p "require('$ROOT/data/config.json').JWT_SECRET")
export PORT=$(node -p "require('$ROOT/data/config.json').PORT")
node "$ROOT/app/server/index.js"
```

- [ ] **Step 5: 設定執行權限（Linux/Mac）**

```bash
chmod +x install.sh start.sh
```

- [ ] **Step 6: 手動驗證（Windows）**

```powershell
# 在 C:\odoo-v2 執行
.\install.ps1
# 確認：
# - 瀏覽器自動開啟 http://localhost:3939/setup.html
# - data/config.json 已建立
# - 伺服器正常啟動（ctrl+c 停止）
# 之後執行：
.\start.ps1
# 確認伺服器正常啟動
```

- [ ] **Step 7: Commit**

```bash
git add install.ps1 install.sh start.ps1 start.sh
chmod +x install.sh start.sh
git commit -m "feat: one-click install scripts for Windows and Linux/Mac"
```

---

## Self-Review

**Spec coverage check:**

| Spec 要求 | 計畫中的任務 |
|---|---|
| Node.js + Express + Socket.io | Task 1 |
| SQLite WAL，5 個 table | Task 2 |
| 首次設定頁（建立 admin）| Task 3 + Task 4 |
| JWT + bcrypt 認證 | Task 3 |
| Port 3939（非預設）| Task 1、Task 5 |
| Windows 一鍵安裝（install.ps1）| Task 5 |
| Linux/Mac 一鍵安裝（install.sh）| Task 5 |
| data/config.json（JWT_SECRET 生成）| Task 5 |
| blocker_type / blocker_content 欄位 | Task 2（schema）|
| 設定完成後 setup 頁永久鎖定 | Task 3（/api/auth/setup 403 guard）|

**Placeholder scan:** 無 TBD / TODO。所有步驟含完整程式碼。

**Type consistency:** `getDb()` 在 Task 2 定義，Task 3 的 auth.js 使用相同名稱。`createApp()` 在 Task 1 定義，Task 3 的 auth.test.js 使用相同 import。`_resetForTesting()` 在 Task 2 定義，Task 3 的 auth.test.js 使用相同名稱。

---

## 下一步：Sub-plan 2

完成本計畫後，繼續 `2026-06-24-aidev-02-sync-triage.md`（Odoo/Service 同步 + Triage Agent）。
