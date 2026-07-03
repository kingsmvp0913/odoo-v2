# 專案級資料庫查詢 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面 SSH-SQLM 的唯讀查詢能力併入 v2，連線設定改成專案級 UI 管理，人用 web、AI 用 skill 共用同一引擎。

**Architecture:** 新 `lib/crypto.js`（AES 對稱加解密）與 `lib/ssh-sql.js`（SELECT 驗證 + psql 指令組裝 + ssh2 執行 + CSV 解析）為純引擎；`db-query-routes.js` 提供人用 CRUD/查詢（需登入）與 AI endpoint（僅 loopback）；前端新增 `ProjectDbQuery.js` 分頁並把專案頁改成分頁式 topbar。

**Tech Stack:** Node + Express、pg（pg-mem 測試）、ssh2、Node crypto（AES-256-GCM）、Vue 3（全域 CDN 版）、Jest + supertest。

## Global Constraints

- 只允許唯讀查詢（SELECT / WITH）。不移植原服務的 file_read/file_write/exec_command。
- SSH 密碼一律 AES-256-GCM 加密後存 DB；回傳前端一律不含密碼欄位。
- `APP_SECRET` 環境變數為加密金鑰來源；未設時凡呼叫加解密即丟錯。
- 連線一律專案級，`ON DELETE CASCADE` 隨專案刪除。
- AI endpoint（`/ai/db/*`）僅接受 loopback（127.0.0.1/::1）來源，免登入；人用 route 需 `verifyToken`。
- v2 server port 為 3939；getSQL skill 呼叫 `http://localhost:3939/ai/db/*`。
- 繁體中文錯誤訊息；保留英文技術識別字。

---

### Task 1: DB migration + ssh2 依賴

**Files:**
- Modify: `app/server/db.js`（migrate() 表清單末端新增 db_connections）
- Modify: `app/package.json`（新增 ssh2 依賴，透過 npm install）
- Test: `app/server/tests/db-connections-schema.test.js`

**Interfaces:**
- Produces: 資料表 `db_connections`（欄位見下），供後續所有 task 使用。

- [ ] **Step 1: 安裝 ssh2**

Run: `cd app && npm install ssh2`
Expected: package.json 出現 `"ssh2"`，node_modules 有 ssh2。

- [ ] **Step 2: Write the failing test**

Create `app/server/tests/db-connections-schema.test.js`:

```js
const { newDb } = require('pg-mem');
let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});
afterAll(() => dbModule._setPoolForTesting(null));

test('db_connections 表可插入與級聯', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('P','17.0') RETURNING id"
  );
  await dbModule.query(
    `INSERT INTO db_connections (project_id, name, ssh_host, ssh_user, db_name)
     VALUES ($1,'conn1','1.2.3.4','root','odoo_prd')`, [p.id]
  );
  const { rows } = await dbModule.query('SELECT * FROM db_connections WHERE project_id=$1', [p.id]);
  expect(rows.length).toBe(1);
  expect(rows[0].connect_mode).toBe('docker');
  expect(rows[0].ssh_port).toBe(22);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd app && npx jest server/tests/db-connections-schema.test.js`
Expected: FAIL（relation "db_connections" does not exist）

- [ ] **Step 4: Add table to migrate()**

在 `app/server/db.js` 的 migrate() 表建立清單中，緊接在 `odoo_envs` 之後加入：

```js
    `CREATE TABLE IF NOT EXISTS db_connections (
      id                SERIAL PRIMARY KEY,
      project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      ssh_host          TEXT NOT NULL,
      ssh_port          INTEGER NOT NULL DEFAULT 22,
      ssh_user          TEXT NOT NULL,
      auth_type         TEXT NOT NULL DEFAULT 'password',
      ssh_password_enc  TEXT,
      ssh_key_path      TEXT,
      connect_mode      TEXT NOT NULL DEFAULT 'docker',
      docker_container  TEXT,
      db_user           TEXT,
      sudo_user         TEXT,
      db_name           TEXT NOT NULL,
      description       TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(project_id, name)
    )`,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd app && npx jest server/tests/db-connections-schema.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/server/db.js app/package.json app/package-lock.json app/server/tests/db-connections-schema.test.js
git commit -m "feat(db-query): add db_connections table and ssh2 dep"
```

---

### Task 2: 加解密 helper `lib/crypto.js`

**Files:**
- Create: `app/server/lib/crypto.js`
- Test: `app/server/tests/crypto.test.js`

**Interfaces:**
- Produces: `encrypt(text) -> string`、`decrypt(blob) -> string`（AES-256-GCM，格式 `iv:tag:cipher`，皆 base64）。金鑰由 `process.env.APP_SECRET` 經 scrypt 衍生。

- [ ] **Step 1: Write the failing test**

Create `app/server/tests/crypto.test.js`:

```js
process.env.APP_SECRET = 'test-secret-key';
const { encrypt, decrypt } = require('../lib/crypto');

test('加密後可解回原文', () => {
  const plain = 'my-ssh-password-中文';
  const blob = encrypt(plain);
  expect(blob).not.toContain(plain);
  expect(blob.split(':').length).toBe(3);
  expect(decrypt(blob)).toBe(plain);
});

test('APP_SECRET 未設時丟錯', () => {
  const saved = process.env.APP_SECRET;
  delete process.env.APP_SECRET;
  jest.resetModules();
  const c = require('../lib/crypto');
  expect(() => c.encrypt('x')).toThrow(/APP_SECRET/);
  process.env.APP_SECRET = saved;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx jest server/tests/crypto.test.js`
Expected: FAIL（Cannot find module '../lib/crypto'）

- [ ] **Step 3: Implement `app/server/lib/crypto.js`**

```js
const crypto = require('crypto');

function getKey() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error('APP_SECRET environment variable is required');
  return crypto.scryptSync(secret, 'db-conn-salt', 32);
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(blob) {
  const [ivB, tagB, encB] = String(blob).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx jest server/tests/crypto.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/server/lib/crypto.js app/server/tests/crypto.test.js
git commit -m "feat(db-query): AES-256-GCM encrypt/decrypt helper"
```

---

### Task 3: `validateSelectOnly`（SELECT-only 驗證）

**Files:**
- Create: `app/server/lib/ssh-sql.js`（本 task 只放 validateSelectOnly 與 stripSqlLiterals）
- Test: `app/server/tests/ssh-sql-validate.test.js`

**Interfaces:**
- Produces: `validateSelectOnly(sql) -> string|null`（null=通過，否則回繁中錯誤訊息）。

- [ ] **Step 1: Write the failing test**

Create `app/server/tests/ssh-sql-validate.test.js`:

```js
const { validateSelectOnly } = require('../lib/ssh-sql');

test('SELECT 與 WITH 通過', () => {
  expect(validateSelectOnly('SELECT id FROM res_users')).toBeNull();
  expect(validateSelectOnly('WITH a AS (SELECT 1) SELECT * FROM a')).toBeNull();
  expect(validateSelectOnly('SELECT 1;')).toBeNull(); // 允許結尾分號
});

test('DML/DDL 被擋', () => {
  expect(validateSelectOnly('DELETE FROM t')).toMatch(/不允許/);
  expect(validateSelectOnly('UPDATE t SET a=1')).toMatch(/不允許/);
  expect(validateSelectOnly('SELECT * INTO x FROM t')).toMatch(/SELECT INTO/);
});

test('多語句被擋', () => {
  expect(validateSelectOnly('SELECT 1; DROP TABLE t')).toMatch(/多語句/);
});

test('字串常量內的關鍵字不誤判', () => {
  expect(validateSelectOnly("SELECT * FROM t WHERE name = 'please DELETE me'")).toBeNull();
});

test('空字串被擋', () => {
  expect(validateSelectOnly('')).toMatch(/不能為空/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx jest server/tests/ssh-sql-validate.test.js`
Expected: FAIL（Cannot find module '../lib/ssh-sql'）

- [ ] **Step 3: Implement（建立 `app/server/lib/ssh-sql.js`）**

```js
function stripSqlLiterals(sql) {
  let result = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
    } else if (sql[i] === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") { i++; break; }
        else i++;
      }
      result += "''";
    } else if (sql[i] === '$') {
      const m = /^\$([^$]*)\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end !== -1 ? end + tag.length : n;
        result += "''";
      } else { result += sql[i]; i++; }
    } else { result += sql[i]; i++; }
  }
  return result;
}

function validateSelectOnly(sql) {
  if (!sql) return 'SQL 不能為空';
  const cleaned = sql.trim().replace(/;+$/, '').trim();
  if (!cleaned) return 'SQL 不能為空';
  if (cleaned.includes(';')) return '不允許多語句查詢（SQL 中不可包含分號）';
  const firstWord = cleaned.split(/\s+/)[0].toUpperCase();
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') return `只允許 SELECT 查詢，不允許 ${firstWord}`;
  const stripped = stripSqlLiterals(cleaned);
  const dangerous = [
    ['INSERT', 'INSERT'], ['UPDATE', 'UPDATE'], ['DELETE', 'DELETE'], ['DROP', 'DROP'],
    ['ALTER', 'ALTER'], ['TRUNCATE', 'TRUNCATE'], ['CREATE', 'CREATE'], ['GRANT', 'GRANT'],
    ['REVOKE', 'REVOKE'], ['COPY', 'COPY'], ['EXECUTE', 'EXECUTE'], ['CALL', 'CALL'], ['INTO', 'SELECT INTO'],
  ];
  for (const [kw, label] of dangerous) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(stripped)) return `不允許 ${label} 操作`;
  }
  return null;
}

module.exports = { validateSelectOnly, stripSqlLiterals };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx jest server/tests/ssh-sql-validate.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/server/lib/ssh-sql.js app/server/tests/ssh-sql-validate.test.js
git commit -m "feat(db-query): SELECT-only SQL validation"
```

---

### Task 4: `buildPsqlCmd`（psql 指令組裝）

**Files:**
- Modify: `app/server/lib/ssh-sql.js`（新增 buildPsqlCmd 並 export）
- Test: `app/server/tests/ssh-sql-buildcmd.test.js`

**Interfaces:**
- Consumes: 無（conn 為純物件）
- Produces: `buildPsqlCmd(conn, sql) -> string`。conn 欄位：`connect_mode`、`ssh_password`（已解密明文，可空）、`docker_container`、`db_user`、`sudo_user`、`db_name`。

- [ ] **Step 1: Write the failing test**

Create `app/server/tests/ssh-sql-buildcmd.test.js`:

```js
const { buildPsqlCmd } = require('../lib/ssh-sql');

const base = { db_name: 'odoo_prd' };

test('docker mode 有密碼', () => {
  const cmd = buildPsqlCmd({ ...base, connect_mode: 'docker', ssh_password: 'pw', docker_container: 'odoo-db', db_user: 'odoo' }, 'SELECT 1');
  expect(cmd).toContain('sudo -S');
  expect(cmd).toContain('docker exec -i odoo-db');
  expect(cmd).toContain('psql -U odoo -d odoo_prd --csv');
  expect(cmd).toContain('base64 -d');
});

test('docker mode 無密碼', () => {
  const cmd = buildPsqlCmd({ ...base, connect_mode: 'docker', ssh_password: '', docker_container: 'c', db_user: 'u' }, 'SELECT 1');
  expect(cmd).toContain('sudo docker exec -i c');
  expect(cmd).not.toContain('sudo -S');
});

test('local mode 有密碼', () => {
  const cmd = buildPsqlCmd({ ...base, connect_mode: 'local', ssh_password: 'pw', sudo_user: 'odoo' }, 'SELECT 1');
  expect(cmd).toContain('sudo -S -u odoo');
  expect(cmd).toContain('psql -d odoo_prd --csv');
});

test('SQL 以 base64 編碼帶入', () => {
  const cmd = buildPsqlCmd({ ...base, connect_mode: 'docker', ssh_password: '', docker_container: 'c', db_user: 'u' }, 'SELECT 42');
  expect(cmd).toContain(Buffer.from('SELECT 42', 'utf8').toString('base64'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx jest server/tests/ssh-sql-buildcmd.test.js`
Expected: FAIL（buildPsqlCmd is not a function）

- [ ] **Step 3: Add buildPsqlCmd to `lib/ssh-sql.js`**

在 `module.exports` 之前加入，並把 buildPsqlCmd 併入 exports：

```js
function buildPsqlCmd(conn, sql) {
  const password = conn.ssh_password || '';
  const mode = conn.connect_mode || 'docker';
  const dbName = conn.db_name || 'odoo_prd';
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  if (mode === 'docker') {
    const container = conn.docker_container || 'odoo-db';
    const dbUser = conn.db_user || 'odoo';
    if (password) {
      const safePw = password.replace(/'/g, "'\\''");
      return `echo '${safePw}' | sudo -S bash -c 'echo ${encoded} | base64 -d | docker exec -i ${container} psql -U ${dbUser} -d ${dbName} --csv'`;
    }
    return `echo ${encoded} | base64 -d | sudo docker exec -i ${container} psql -U ${dbUser} -d ${dbName} --csv`;
  }
  const sudoUser = conn.sudo_user || 'odoo';
  if (password) {
    const safePw = password.replace(/'/g, "'\\''");
    return `echo '${safePw}' | sudo -S -u ${sudoUser} bash -c 'echo ${encoded} | base64 -d | psql -d ${dbName} --csv'`;
  }
  return `echo ${encoded} | base64 -d | sudo -u ${sudoUser} psql -d ${dbName} --csv`;
}
```

exports 改為：`module.exports = { validateSelectOnly, stripSqlLiterals, buildPsqlCmd };`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx jest server/tests/ssh-sql-buildcmd.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/server/lib/ssh-sql.js app/server/tests/ssh-sql-buildcmd.test.js
git commit -m "feat(db-query): build psql command per connect mode"
```

---

### Task 5: `runSelect`（ssh2 執行 + CSV 解析）

**Files:**
- Modify: `app/server/lib/ssh-sql.js`（新增 parseCsv、sshExec、runSelect）
- Test: `app/server/tests/ssh-sql-parse.test.js`（純 parseCsv 單元測）

**Interfaces:**
- Consumes: `validateSelectOnly`、`buildPsqlCmd`
- Produces: `runSelect(conn, sql) -> Promise<{ok, columns, rows, row_count} | {ok:false, error}>`；`parseCsv(text) -> string[][]`。conn 另需 `ssh_host/ssh_port/ssh_user/auth_type/ssh_password/ssh_key_path`。

- [ ] **Step 1: Write the failing test（parseCsv 純函式）**

Create `app/server/tests/ssh-sql-parse.test.js`:

```js
const { parseCsv } = require('../lib/ssh-sql');

test('解析基本 CSV', () => {
  expect(parseCsv('id,login\n2,admin\n6,user1')).toEqual([['id','login'],['2','admin'],['6','user1']]);
});

test('欄位內含逗號與換行（引號包圍）', () => {
  expect(parseCsv('a,b\n"x,y","line1\nline2"')).toEqual([['a','b'],['x,y','line1\nline2']]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx jest server/tests/ssh-sql-parse.test.js`
Expected: FAIL（parseCsv is not a function）

- [ ] **Step 3: Implement parseCsv + sshExec + runSelect in `lib/ssh-sql.js`**

在檔案頂端加 `const { Client } = require('ssh2');` 與 `const fs = require('fs');`，並加入：

```js
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* skip */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function sshExec(conn, command) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let stdout = '', stderr = '';
    c.on('ready', () => {
      c.exec(command, (err, stream) => {
        if (err) { c.end(); return reject(err); }
        stream.on('close', (code) => { c.end(); resolve({ stdout, stderr, code }); })
          .on('data', d => { stdout += d; })
          .stderr.on('data', d => { stderr += d; });
      });
    }).on('error', reject);
    const cfg = { host: conn.ssh_host, port: conn.ssh_port || 22, username: conn.ssh_user, readyTimeout: 15000 };
    if (conn.auth_type === 'key' && conn.ssh_key_path) cfg.privateKey = fs.readFileSync(conn.ssh_key_path);
    else cfg.password = conn.ssh_password;
    c.connect(cfg);
  });
}

async function runSelect(conn, sql) {
  const err = validateSelectOnly(sql);
  if (err) return { ok: false, error: err };
  const cmd = buildPsqlCmd(conn, sql);
  let res;
  try { res = await sshExec(conn, cmd); }
  catch (e) { return { ok: false, error: `[SSH] ${e.message}` }; }
  const cleanErr = res.stderr.split('\n').filter(l => !l.trim().startsWith('[sudo]')).join('\n');
  if (res.code !== 0) return { ok: false, error: cleanErr.trim() || res.stdout.trim() || `exit ${res.code}` };
  if (!res.stdout.trim()) return { ok: true, columns: [], rows: [], row_count: 0 };
  const parsed = parseCsv(res.stdout.trim());
  return { ok: true, columns: parsed[0] || [], rows: parsed.slice(1), row_count: Math.max(0, parsed.length - 1) };
}
```

exports 改為：`module.exports = { validateSelectOnly, stripSqlLiterals, buildPsqlCmd, parseCsv, runSelect };`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx jest server/tests/ssh-sql-parse.test.js`
Expected: PASS

- [ ] **Step 5: 整合驗證（真實連線，手動）**

以一筆真實連線設定寫臨時腳本呼叫 `runSelect`，確認查得到資料（例：`SELECT id, login FROM res_users LIMIT 3`）。用桌面 `connections/*.json` 的其中一筆參數。驗證後刪除臨時腳本。此步驟不進版控，僅確認 ssh2 路徑可用。

- [ ] **Step 6: Commit**

```bash
git add app/server/lib/ssh-sql.js app/server/tests/ssh-sql-parse.test.js
git commit -m "feat(db-query): runSelect over ssh2 with CSV parsing"
```

---

### Task 6: 人用 route（連線 CRUD + 查詢）

**Files:**
- Create: `app/server/db-query-routes.js`
- Modify: `app/server/index.js`（require + registerRoutes）
- Test: `app/server/tests/db-query-routes.test.js`

**Interfaces:**
- Consumes: `lib/crypto`（encrypt/decrypt）、`lib/ssh-sql`（runSelect）、`auth`（verifyToken）
- Produces: 路由 `GET/POST/PUT/DELETE /api/projects/:id/db-connections[/:cid]`、`POST /api/projects/:id/db-connections/:cid/query`。`registerRoutes(app)`。

- [ ] **Step 1: Write the failing test**

Create `app/server/tests/db-query-routes.test.js`:

```js
process.env.APP_SECRET = 'test-secret';
process.env.JWT_SECRET = 'test-dbq';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const mockRunSelect = jest.fn();
jest.mock('../lib/ssh-sql', () => ({ runSelect: (...a) => mockRunSelect(...a) }));

let dbModule, app, token, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name) VALUES ('u','h','U') RETURNING id");
  token = jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,odoo_version) VALUES ('P','17.0') RETURNING id");
  projectId = p.id;
  const a = express(); a.use(express.json());
  require('../db-query-routes').registerRoutes(a);
  app = a;
});
afterAll(() => dbModule._setPoolForTesting(null));
const auth = () => ({ Authorization: `Bearer ${token}` });

let cid;
test('POST 建立連線（回傳不含密碼）', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/db-connections`).set(auth()).send({
    name: 'c1', ssh_host: '1.2.3.4', ssh_user: 'root', auth_type: 'password', ssh_password: 'secret',
    connect_mode: 'docker', docker_container: 'odoo-db', db_user: 'odoo', db_name: 'odoo_prd'
  });
  expect(res.status).toBe(201);
  expect(res.body.ssh_password_enc).toBeUndefined();
  cid = res.body.id;
});

test('GET 列出（不含密碼）', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/db-connections`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body[0].ssh_password_enc).toBeUndefined();
  expect(res.body[0].name).toBe('c1');
});

test('POST query 呼叫 runSelect 並回結果', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, columns: ['id'], rows: [['1']], row_count: 1 });
  const res = await request(app).post(`/api/projects/${projectId}/db-connections/${cid}/query`).set(auth()).send({ sql: 'SELECT 1' });
  expect(res.status).toBe(200);
  expect(res.body.row_count).toBe(1);
  // runSelect 收到的 conn 應含解密後的明文密碼
  expect(mockRunSelect.mock.calls[0][0].ssh_password).toBe('secret');
});

test('DELETE 移除連線', async () => {
  const res = await request(app).delete(`/api/projects/${projectId}/db-connections/${cid}`).set(auth());
  expect(res.status).toBe(200);
});

test('401 無 token', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/db-connections`);
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx jest server/tests/db-query-routes.test.js`
Expected: FAIL（Cannot find module '../db-query-routes'）

- [ ] **Step 3: Implement `app/server/db-query-routes.js`**

```js
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { encrypt, decrypt } = require('./lib/crypto');
const { runSelect } = require('./lib/ssh-sql');

const PUBLIC_COLS = 'id, project_id, name, ssh_host, ssh_port, ssh_user, auth_type, ssh_key_path, connect_mode, docker_container, db_user, sudo_user, db_name, description, created_at';

function registerRoutes(app) {
  app.get('/api/projects/:id/db-connections', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(`SELECT ${PUBLIC_COLS} FROM db_connections WHERE project_id=$1 ORDER BY name`, [req.params.id]);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/db-connections', verifyToken, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.name || !b.ssh_host || !b.ssh_user || !b.db_name) return res.status(400).json({ error: 'name/ssh_host/ssh_user/db_name 必填' });
      const enc = b.auth_type === 'key' ? null : (b.ssh_password ? encrypt(b.ssh_password) : null);
      const { rows } = await query(
        `INSERT INTO db_connections (project_id,name,ssh_host,ssh_port,ssh_user,auth_type,ssh_password_enc,ssh_key_path,connect_mode,docker_container,db_user,sudo_user,db_name,description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${PUBLIC_COLS}`,
        [req.params.id, b.name, b.ssh_host, b.ssh_port || 22, b.ssh_user, b.auth_type || 'password', enc, b.ssh_key_path || null,
         b.connect_mode || 'docker', b.docker_container || null, b.db_user || null, b.sudo_user || null, b.db_name, b.description || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '連線名稱已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/projects/:id/db-connections/:cid', verifyToken, async (req, res) => {
    try {
      const b = req.body || {};
      // 密碼空白＝保留舊值；有填才重新加密
      let encClause = '', params = [], idx = 1;
      const set = [];
      for (const [col, val] of Object.entries({
        name: b.name, ssh_host: b.ssh_host, ssh_port: b.ssh_port, ssh_user: b.ssh_user, auth_type: b.auth_type,
        ssh_key_path: b.ssh_key_path, connect_mode: b.connect_mode, docker_container: b.docker_container,
        db_user: b.db_user, sudo_user: b.sudo_user, db_name: b.db_name, description: b.description
      })) {
        if (val !== undefined) { set.push(`${col}=$${idx++}`); params.push(val); }
      }
      if (b.ssh_password) { set.push(`ssh_password_enc=$${idx++}`); params.push(encrypt(b.ssh_password)); }
      if (!set.length) return res.status(400).json({ error: '無可更新欄位' });
      params.push(req.params.cid, req.params.id);
      const { rows } = await query(
        `UPDATE db_connections SET ${set.join(', ')} WHERE id=$${idx++} AND project_id=$${idx} RETURNING ${PUBLIC_COLS}`, params
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '連線名稱已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/projects/:id/db-connections/:cid', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('DELETE FROM db_connections WHERE id=$1 AND project_id=$2 RETURNING id', [req.params.cid, req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/db-connections/:cid/query', verifyToken, async (req, res) => {
    try {
      const conn = await loadDecryptedConn(req.params.cid, req.params.id);
      if (!conn) return res.status(404).json({ error: 'Not found' });
      const result = await runSelect(conn, (req.body && req.body.sql) || '');
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

async function loadDecryptedConn(cid, projectId) {
  const { rows: [c] } = await query('SELECT * FROM db_connections WHERE id=$1 AND project_id=$2', [cid, projectId]);
  if (!c) return null;
  c.ssh_password = c.ssh_password_enc ? decrypt(c.ssh_password_enc) : '';
  return c;
}

module.exports = { registerRoutes, loadDecryptedConn };
```

在 `app/server/index.js` 加入（比照其他 registerRoutes）：

```js
const { registerRoutes: registerDbQueryRoutes } = require('./db-query-routes');
// ...在其他 registerXxxRoutes(app) 附近：
registerDbQueryRoutes(app);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx jest server/tests/db-query-routes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/server/db-query-routes.js app/server/index.js app/server/tests/db-query-routes.test.js
git commit -m "feat(db-query): connection CRUD + query routes"
```

---

### Task 7: AI endpoint（loopback-only）

**Files:**
- Modify: `app/server/db-query-routes.js`（新增 loopbackOnly 中介 + /ai/db 路由）
- Test: `app/server/tests/db-query-ai.test.js`

**Interfaces:**
- Consumes: `loadDecryptedConn`、`runSelect`
- Produces: `GET /ai/db/connections?project=<name>`、`POST /ai/db/query`（body `{connection_id, sql}`）。非 loopback 一律 403。

- [ ] **Step 1: Write the failing test**

Create `app/server/tests/db-query-ai.test.js`:

```js
process.env.APP_SECRET = 'test-secret';
process.env.JWT_SECRET = 'test-dbq-ai';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');

const mockRunSelect = jest.fn();
jest.mock('../lib/ssh-sql', () => ({ runSelect: (...a) => mockRunSelect(...a) }));

let dbModule, app, projectId;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,folder_name,odoo_version) VALUES ('鴻久','hungjou','17.0') RETURNING id");
  projectId = p.id;
  await dbModule.query("INSERT INTO db_connections (project_id,name,ssh_host,ssh_user,db_name) VALUES ($1,'hj','1.2.3.4','root','odoo_prd')", [projectId]);
  const a = express(); a.use(express.json());
  require('../db-query-routes').registerRoutes(a);
  app = a;
});
afterAll(() => dbModule._setPoolForTesting(null));

test('GET /ai/db/connections 依專案名過濾（loopback）', async () => {
  const res = await request(app).get('/ai/db/connections?project=hungjou');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.connections[0].name).toBe('hj');
  expect(res.body.connections[0].ssh_password_enc).toBeUndefined();
});

test('POST /ai/db/query 執行 SELECT（loopback）', async () => {
  mockRunSelect.mockResolvedValueOnce({ ok: true, columns: ['id'], rows: [['1']], row_count: 1 });
  const { rows: [c] } = await dbModule.query('SELECT id FROM db_connections LIMIT 1');
  const res = await request(app).post('/ai/db/query').send({ connection_id: c.id, sql: 'SELECT 1' });
  expect(res.status).toBe(200);
  expect(res.body.row_count).toBe(1);
});

test('loopbackOnly 擋非本機來源', () => {
  const { loopbackOnly } = require('../db-query-routes');
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  loopbackOnly({ socket: { remoteAddress: '8.8.8.8' } }, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});

test('loopbackOnly 放行本機來源', () => {
  const { loopbackOnly } = require('../db-query-routes');
  const next = jest.fn();
  loopbackOnly({ socket: { remoteAddress: '127.0.0.1' } }, {}, next);
  expect(next).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx jest server/tests/db-query-ai.test.js`
Expected: FAIL（404 / route 不存在）

- [ ] **Step 3: Implement**

在 `db-query-routes.js` **模組頂層**（registerRoutes 外）定義並在 exports 導出，避免信任任何可偽造的 header：

```js
function loopbackOnly(req, res, next) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  return res.status(403).json({ ok: false, error: 'AI endpoint 僅限本機' });
}
```

`module.exports` 改為：`module.exports = { registerRoutes, loadDecryptedConn, loopbackOnly };`

在 registerRoutes 內追加 AI 路由（使用上面的 loopbackOnly）：

```js
  app.get('/ai/db/connections', loopbackOnly, async (req, res) => {
    try {
      const project = req.query.project;
      let rows;
      if (project) {
        ({ rows } = await query(
          `SELECT c.id, c.name, p.name AS project FROM db_connections c JOIN projects p ON p.id=c.project_id
           WHERE p.folder_name=$1 OR p.name=$1 ORDER BY c.name`, [project]));
      } else {
        ({ rows } = await query(
          `SELECT c.id, c.name, p.name AS project FROM db_connections c JOIN projects p ON p.id=c.project_id ORDER BY p.name, c.name`));
      }
      res.json({ ok: true, connections: rows });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });

  app.post('/ai/db/query', loopbackOnly, async (req, res) => {
    try {
      const { connection_id, sql } = req.body || {};
      const { rows: [c] } = await query('SELECT project_id FROM db_connections WHERE id=$1', [connection_id]);
      if (!c) return res.json({ ok: false, error: '找不到連線' });
      const conn = await loadDecryptedConn(connection_id, c.project_id);
      res.json(await runSelect(conn, sql || ''));
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });
```

註：來源判定只依 `req.socket.remoteAddress`（TCP 連線層，不可由 client header 偽造）。supertest 整合測試預設來源即 127.0.0.1，故 loopback 路由可直接測；非本機情境以 loopbackOnly 單元測覆蓋。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx jest server/tests/db-query-ai.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/server/db-query-routes.js app/server/tests/db-query-ai.test.js
git commit -m "feat(db-query): loopback-only AI endpoints"
```

---

### Task 8: 前端查詢分頁 `ProjectDbQuery.js`

**Files:**
- Create: `app/public/js/views/ProjectDbQuery.js`
- Modify: `app/public/index.html`（新增 script 標籤）
- Modify: `app/public/js/app.js`（新增路由 `/projects/:id/db`）

**Interfaces:**
- Consumes: 後端 `/api/projects/:id/db-connections[/:cid][/query]`；全域 `Api`、`showToast`、`Vue`。
- Produces: `window.ProjectDbQueryView`。

- [ ] **Step 1: 建立 view（無自動化測試，語法檢查即可）**

Create `app/public/js/views/ProjectDbQuery.js`：

```js
window.ProjectDbQueryView = Vue.defineComponent({
  name: 'ProjectDbQueryView',
  data() {
    return {
      conns: [], loading: true, saving: false, running: false,
      form: { id: null, name: '', ssh_host: '', ssh_port: 22, ssh_user: '', auth_type: 'password', ssh_password: '', ssh_key_path: '', connect_mode: 'docker', docker_container: 'odoo-db', db_user: 'odoo', sudo_user: 'odoo', db_name: 'odoo_prd', description: '' },
      selectedId: '', sql: '', result: null, error: ''
    };
  },
  async created() { await this.load(); },
  methods: {
    pid() { return this.$route.params.id; },
    async load() {
      this.loading = true;
      try { this.conns = await Api.get(`projects/${this.pid()}/db-connections`); }
      catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    resetForm() { this.form = { id: null, name: '', ssh_host: '', ssh_port: 22, ssh_user: '', auth_type: 'password', ssh_password: '', ssh_key_path: '', connect_mode: 'docker', docker_container: 'odoo-db', db_user: 'odoo', sudo_user: 'odoo', db_name: 'odoo_prd', description: '' }; },
    editConn(c) { this.form = { ...c, ssh_password: '' }; },
    async saveConn() {
      if (!this.form.name || !this.form.ssh_host || !this.form.ssh_user || !this.form.db_name) return showToast('名稱/主機/使用者/資料庫 必填', 'error');
      this.saving = true;
      try {
        if (this.form.id) await Api.put(`projects/${this.pid()}/db-connections/${this.form.id}`, this.form);
        else await Api.post(`projects/${this.pid()}/db-connections`, this.form);
        this.resetForm(); await this.load(); showToast('已儲存連線', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.saving = false; }
    },
    async deleteConn(c) {
      if (!confirm(`刪除連線「${c.name}」？`)) return;
      try { await Api.delete(`projects/${this.pid()}/db-connections/${c.id}`); await this.load(); showToast('已刪除', 'success'); }
      catch (e) { showToast(e.message, 'error'); }
    },
    async runQuery() {
      if (!this.selectedId) return showToast('請先選連線', 'error');
      if (!this.sql.trim()) return showToast('請輸入 SQL', 'error');
      this.running = true; this.result = null; this.error = '';
      try {
        const r = await Api.post(`projects/${this.pid()}/db-connections/${this.selectedId}/query`, { sql: this.sql });
        if (r.ok) this.result = r; else this.error = r.error || '查詢失敗';
      } catch (e) { this.error = e.message; }
      finally { this.running = false; }
    }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/projects/'+pid())" style="margin-right:12px">← 返回專案</button>
      <h1>資料庫查詢</h1>
    </div>
    <div class="content" v-if="!loading">
      <div class="admin-section" style="margin-bottom:20px">
        <h2 class="section-title">連線管理（{{ conns.length }}）</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="border-bottom:1px solid var(--border);text-align:left">
            <th style="padding:8px 10px">名稱</th><th style="padding:8px 10px">SSH 主機</th><th style="padding:8px 10px">模式</th><th style="padding:8px 10px">DB</th><th style="padding:8px 10px">操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="c in conns" :key="c.id" style="border-bottom:1px solid var(--border)">
              <td style="padding:8px 10px;font-weight:600">{{ c.name }}</td>
              <td style="padding:8px 10px">{{ c.ssh_user }}@{{ c.ssh_host }}:{{ c.ssh_port }}</td>
              <td style="padding:8px 10px">{{ c.connect_mode }}</td>
              <td style="padding:8px 10px">{{ c.db_name }}</td>
              <td style="padding:8px 10px"><div style="display:flex;gap:6px">
                <button class="btn btn-outline btn-sm" @click="editConn(c)">編輯</button>
                <button class="btn btn-outline btn-sm" style="color:var(--error)" @click="deleteConn(c)">刪除</button>
              </div></td>
            </tr>
            <tr v-if="conns.length === 0"><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">尚無連線</td></tr>
          </tbody>
        </table>
      </div>

      <div class="admin-section" style="margin-bottom:20px">
        <h2 class="section-title">{{ form.id ? '編輯連線' : '新增連線' }}</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div class="form-group" style="margin:0"><label>連線名稱</label><input v-model="form.name" class="form-control" placeholder="hj-鴻久-正式" /></div>
          <div class="form-group" style="margin:0"><label>SSH 主機</label><input v-model="form.ssh_host" class="form-control" placeholder="1.2.3.4" /></div>
          <div class="form-group" style="margin:0"><label>SSH 埠</label><input v-model.number="form.ssh_port" class="form-control" /></div>
          <div class="form-group" style="margin:0"><label>SSH 使用者</label><input v-model="form.ssh_user" class="form-control" placeholder="root" /></div>
          <div class="form-group" style="margin:0"><label>認證方式</label><select v-model="form.auth_type" class="form-control"><option value="password">密碼</option><option value="key">金鑰</option></select></div>
          <div class="form-group" style="margin:0" v-if="form.auth_type==='password'"><label>SSH 密碼（留空＝不變）</label><input v-model="form.ssh_password" type="password" class="form-control" placeholder="••••••" /></div>
          <div class="form-group" style="margin:0" v-else><label>金鑰路徑</label><input v-model="form.ssh_key_path" class="form-control" placeholder="C:\\keys\\id_rsa" /></div>
          <div class="form-group" style="margin:0"><label>連線模式</label><select v-model="form.connect_mode" class="form-control"><option value="docker">docker</option><option value="local">local</option></select></div>
          <div class="form-group" style="margin:0" v-if="form.connect_mode==='docker'"><label>Docker 容器</label><input v-model="form.docker_container" class="form-control" /></div>
          <div class="form-group" style="margin:0" v-if="form.connect_mode==='docker'"><label>DB 使用者</label><input v-model="form.db_user" class="form-control" /></div>
          <div class="form-group" style="margin:0" v-if="form.connect_mode==='local'"><label>sudo 使用者</label><input v-model="form.sudo_user" class="form-control" /></div>
          <div class="form-group" style="margin:0"><label>資料庫名稱</label><input v-model="form.db_name" class="form-control" /></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" @click="saveConn" :disabled="saving">{{ saving ? '儲存中...' : (form.id ? '更新連線' : '+ 新增連線') }}</button>
          <button v-if="form.id" class="btn btn-outline btn-sm" @click="resetForm">取消編輯</button>
        </div>
      </div>

      <div class="admin-section">
        <h2 class="section-title">查詢（只允許 SELECT）</h2>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <select v-model="selectedId" class="form-control" style="max-width:280px">
            <option value="">選擇連線...</option>
            <option v-for="c in conns" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button class="btn btn-primary btn-sm" @click="runQuery" :disabled="running">{{ running ? '查詢中...' : '執行' }}</button>
        </div>
        <textarea v-model="sql" class="form-control" rows="4" placeholder="SELECT id, login FROM res_users LIMIT 20" style="font-family:monospace"></textarea>
        <div v-if="error" style="margin-top:10px;background:#fff5f5;border:1px solid #fc8181;border-radius:4px;padding:8px;font-size:12px;white-space:pre-wrap">{{ error }}</div>
        <div v-if="result" style="margin-top:10px;overflow-x:auto">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">{{ result.row_count }} 筆</div>
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="border-bottom:1px solid var(--border);text-align:left">
              <th v-for="col in result.columns" :key="col" style="padding:6px 8px">{{ col }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="(row,i) in result.rows" :key="i" style="border-bottom:1px solid var(--border)">
                <td v-for="(cell,j) in row" :key="j" style="padding:6px 8px">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `
});
```

- [ ] **Step 2: 註冊 script 與路由**

在 `app/public/index.html` 其他 `views/*.js` script 標籤附近加入：

```html
<script src="js/views/ProjectDbQuery.js"></script>
```

在 `app/public/js/app.js` 路由陣列，`/projects/:id/chat` 相關路由附近加入：

```js
    { path: '/projects/:id/db', component: window.ProjectDbQueryView, meta: { requiresAuth: true } },
```

- [ ] **Step 3: 語法檢查**

Run: `node -c app/public/js/views/ProjectDbQuery.js && node -c app/public/js/app.js`
Expected: 無輸出（通過）

- [ ] **Step 4: Commit**

```bash
git add app/public/js/views/ProjectDbQuery.js app/public/index.html app/public/js/app.js
git commit -m "feat(db-query): frontend query view + route"
```

---

### Task 9: 專案頁分頁式 topbar + 設定頁瘦身

**Files:**
- Modify: `app/public/js/views/ProjectDetail.js`（topbar 加分頁連結；移除 Wiki/Chat 舊區塊）
- Test: 手動 + 語法檢查

**Interfaces:**
- Consumes: 既有路由 `/projects/:id/wiki`、`/projects/:id/chat`、新 `/projects/:id/db`。

- [ ] **Step 1: 在 topbar 加入分頁列**

在 `ProjectDetail.js` template 的 topbar（`<h1>{{ project.name }}</h1>` 之後）加入分頁連結：

```html
        <div style="display:flex;gap:6px;margin-left:16px">
          <button class="btn btn-outline btn-sm" style="background:var(--primary);color:#fff">設定</button>
          <button class="btn btn-outline btn-sm" @click="$router.push('/projects/'+project.id+'/db')">資料庫查詢</button>
          <button class="btn btn-outline btn-sm" @click="goWiki">📖 Wiki</button>
          <button class="btn btn-outline btn-sm" @click="goChat">💬 Chat
            <span v-if="unreadCount()" style="display:inline-block;min-width:16px;padding:0 5px;margin-left:4px;border-radius:8px;background:var(--error,#e5484d);color:#fff;font-size:11px;line-height:16px;text-align:center">{{ unreadCount() }}</span>
          </button>
        </div>
```

- [ ] **Step 2: 移除設定頁內舊的「Wiki 與對話」區塊**

刪除 `ProjectDetail.js` template 中「Wiki 與對話」那段（含「🔄 初始化 Wiki / 📖 開啟 Wiki / 💬 開啟 Chat」的 `div.form-section` 區塊）。保留 `initWiki`、`goWiki`、`goChat`、`unreadCount` methods（topbar 仍用 goWiki/goChat/unreadCount）。「初始化 Wiki」按鈕移到 Wiki 頁自身或暫時保留於設定頁一顆小按鈕——本步驟將「初始化 Wiki」單獨保留為設定頁一顆按鈕：

```html
        <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
          <button class="btn btn-outline btn-sm" @click="initWiki">🔄 初始化 Wiki</button>
        </div>
```

- [ ] **Step 3: 語法檢查**

Run: `node -c app/public/js/views/ProjectDetail.js`
Expected: 無輸出

- [ ] **Step 4: 手動驗證**

啟動 v2，開專案頁：topbar 有「設定 / 資料庫查詢 / Wiki / Chat」分頁，點擊可正確導向；設定頁不再有舊的 Wiki/Chat 大區塊。

- [ ] **Step 5: Commit**

```bash
git add app/public/js/views/ProjectDetail.js
git commit -m "feat(project): tabbed topbar, move Wiki/Chat up, slim settings"
```

---

### Task 10: 更新 getSQL skill

**Files:**
- Modify: `C:\odoo-v2\.claude\skills\getSQL\SKILL.md`（或專案內對應 skill 路徑）
- Test: 手動（AI 依 skill 呼叫 v2）

**Interfaces:**
- Consumes: `GET http://localhost:3939/ai/db/connections?project=<name>`、`POST http://localhost:3939/ai/db/query`。

- [ ] **Step 1: 改寫 SKILL.md**

將 getSQL 的 SKILL.md 內容改為（保留 name/description frontmatter，內文改為呼叫 v2）：

```markdown
# 資料庫查詢 Skill（v2）

透過 v2 工作平台查遠端 Odoo PostgreSQL（唯讀 SELECT）。v2 需運行於 http://localhost:3939，不需另外啟動桌面服務。

## 流程
1. 判斷當前專案：依當前處理中的專案、開啟檔案路徑（如 online_addons/<專案>）、對話主題，推斷對應的 v2 專案名。
2. 列出該專案連線：
   curl "http://localhost:3939/ai/db/connections?project=<專案名>"
   - 回 1 筆：直接用其 id。
   - 回多筆：列給使用者選。
   - 回 0 筆：提示到該專案「資料庫查詢」分頁新增連線。
3. 執行查詢：
   curl -X POST http://localhost:3939/ai/db/query \
     -H "Content-Type: application/json" \
     -d '{"connection_id": <id>, "sql": "SELECT id, login FROM res_users LIMIT 5"}'

## 限制
- 只允許 SELECT / WITH，禁多語句（不可含分號，結尾分號除外）。
- 大表查詢加 LIMIT；先用 information_schema 確認欄位。
```

- [ ] **Step 2: 手動驗證**

v2 運行中，於對話觸發 getSQL：確認能列出當前專案連線並成功查詢。

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/getSQL/SKILL.md
git commit -m "feat(db-query): point getSQL skill to v2 AI endpoint"
```

---

## 完成後整體驗證

- Run: `cd app && npx jest`
- Expected: 全數通過（新增 crypto/ssh-sql/db-query 測試 + 既有測試無回歸）
- 手動：專案頁分頁、連線 CRUD、查詢結果、getSQL skill。
