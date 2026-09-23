# 測試區資料庫帳號隔離（階段 2c）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 測試區 Odoo 容器不再拿平台的 PG 超級使用者帳密，改用每個測試區自己的非超級使用者角色，只連得進自己的測試 DB。

**Architecture:** 新增 `lib/testenv-db-role.js` 管角色生命週期（建角色、平台先建 DB 或轉擁有者、建 `pg_trgm`、撤 PUBLIC 連線），密碼加密存 `odoo_envs.db_password_enc`。`env-agent` 的 `dockerCtxFor` 改從這裡取帳密；`docker-env` 的 IO 邊界（`runContainer`／`execOdoo`）拒絕任何不是 `testenv_p<id>` 的帳號。舊容器靠 deploy 前的漂移檢查擋下、夜間關機自然汰換。

**Tech Stack:** Node.js（Express）、`pg`、jest＋pg-mem、docker CLI、PostgreSQL 16。

**Spec:** `docs/superpowers/specs/2026-09-11-tenant-isolation-design.md` §10（**以 §10.6 的 09-15 實測結果為準**，它推翻了 §10.4 的 `REASSIGN OWNED` 做法）。

## Global Constraints

- 角色屬性固定：`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`；名稱 `testenv_p<projectId>`。
- **禁用 `REASSIGN OWNED`**：`odoo` 是 bootstrap 超級使用者（oid 10）會報錯，且它會連其他 DB 的擁有權一起轉走（§10.6 實測）。
- 平台先建 DB：`CREATE DATABASE "<db>" OWNER "<role>" ENCODING 'UTF8' LC_COLLATE 'C' TEMPLATE template0`；DB 已存在時 Odoo 會跳過建 `pg_trgm`，平台必須自己 `CREATE EXTENSION IF NOT EXISTS pg_trgm`。
- 缺角色或帳密時**大聲失敗、不啟動**，絕不退回平台帳號（rules/pipeline 59）。
- 平台從不 drop Odoo DB，本計畫也不 drop。
- pg-mem 不支援 `CREATE ROLE`／`REVOKE`／`DO` 區塊：這些 SQL 一律經注入的 `createClient` 送出，測試用假 client 記錄 SQL，不送 pg-mem。
- 全跑測試：`cd app && npm run test:quiet`；commit 前 `git status --porcelain -uno` 逐檔挑，禁 `git add -A`。
- 開發在獨立 worktree；改 `app/server` 要重啟平台才生效（使用者在主機跑 `upgrade.sh`）。

## 已實測、不需再驗的事實（09-15，§10.6）

- 非超級使用者跑 Odoo 17 `-i base`、既有 DB 轉擁有者後 `-u base`：exit 0。
- 逐物件 `ALTER … OWNER`：`test_liSheng` 複本 449 個 relation，不到 1 秒，殘留 0。
- 角色可自建 `pg_trgm`／`unaccent`、可 DDL；`REVOKE CONNECT … FROM PUBLIC` 後連別的 DB 被擋；`COPY TO PROGRAM`、`pg_authid`、`pg_read_file`、`CREATE DATABASE` 全擋。
- 測試區容器從 `10.0.0.x` 經 `host.docker.internal`（10.0.0.1）連 8772，走 scram；**從平台容器直接 psql 10.0.0.1 來源是 192.168.10.110，會被 pg_hba 擋——驗證時一律從 bridge 臨時容器測**。

## 實作時與本計畫的差異（09-15 執行紀錄）

- `testEnvDbArgs` 沒有 `DATABASE_URL` 時**不報錯**，只帶角色帳密（容器端會補 host）：比照舊 `odooDbArgs` 的行為，否則所有沒設該變數的 env-agent 測試會在 `dockerCtxFor` 就炸。`ensureTestEnvDbRole` 仍然缺值就失敗。已補一支測試釘住。
- `lib/docker-env.js` 是 CRLF 換行，插入內容要跟著用 CRLF。
- `env-agent-health.test.js` 不跑 `runEnvSetup`，不需要 role mock；需要的是 `env-agent-{docker,enterprise,expiration,image-deps,registry-ready,seed-fail,sso-route}`。
- Task 4「runEnvSetup 拿到角色帳密」那支測試要讓 `runContainer` 回 `ok:false`，否則會卡在等假容器的埠而逾時。

## 檔案結構

| 檔案 | 動作 | 責任 |
|---|---|---|
| `app/server/lib/testenv-db-role.js` | 新增 | 角色名、SQL 產生、`ensureTestEnvDbRole`、`loadTestEnvDbCreds`、`testEnvDbArgs`、`revokePublicConnectAll` |
| `app/server/db.js` | 修改 | ALTER 清單加 `odoo_envs.db_password_enc` |
| `app/server/lib/docker-env.js` | 修改 | `assertTestEnvDbUser` 守衛、`containerDbUser` |
| `app/server/pipeline/env-agent.js` | 修改 | 移除 `odooDbArgs`；`dockerCtxFor` 取角色帳密；`runEnvSetup` 呼叫 `ensureTestEnvDbRole`；新增 `dbUserDrift` |
| `app/server/pipeline/deploy-testing.js` | 修改 | 舊容器仍用平台帳號 → 擋部署 |
| `app/server/index.js` | 修改 | 啟動時 `revokePublicConnectAll` |
| `app/server/tests/testenv-db-role.test.js` | 新增 | |
| `app/server/tests/docker-env.test.js`、`env-agent-docker.test.js`、`deploy-testing.test.js` 與所有會跑 `runEnvSetup` 的測試 | 修改 | |

---

### Task 1: 角色名、帳密參數與 SQL 產生（純函式）

**Files:**
- Create: `app/server/lib/testenv-db-role.js`
- Test: `app/server/tests/testenv-db-role.test.js`

**Interfaces:**
- Produces:
  - `roleNameFor(projectId: number|string) → string`（`testenv_p<id>`；非正整數 throw）
  - `quoteIdent(name: string) → string`、`quoteLiteral(s: string) → string`
  - `testEnvDbArgs({ role, password }) → string[]`（`['--db_host', h, '--db_port', p, '--db_user', role, '--db_password', pw]`，host／port 取自 `DATABASE_URL`）
  - `ownershipTransferSql({ from: string, to: string }) → string`（一段 `DO $$ … $$;`）
  - `platformDbUser() → string|null`

- [ ] **Step 1: 寫失敗的測試**

```js
// app/server/tests/testenv-db-role.test.js
// 意圖：測試區 Odoo 以前拿平台的 PG 超級使用者帳密（進測試區的人能讀平台 DB、別家測試資料、COPY TO PROGRAM
// 拿總鑰匙）。改成每個測試區自己的非超級使用者角色——這支守的是「帳密絕不帶到平台帳號」與
// 「轉擁有者的 SQL 不能用 REASSIGN OWNED」（09-15 實測：odoo 是 bootstrap 角色會報錯，且會連別的 DB 一起轉走）。
const role = require('../lib/testenv-db-role');

const PLATFORM_URL = 'postgres://odoo:platform-pw@localhost:8772/aidev';
let prevUrl;
beforeEach(() => { prevUrl = process.env.DATABASE_URL; process.env.DATABASE_URL = PLATFORM_URL; });
afterEach(() => { if (prevUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevUrl; });

describe('roleNameFor', () => {
  test('用專案 id 組出固定前綴的角色名', () => {
    expect(role.roleNameFor(18)).toBe('testenv_p18');
    expect(role.roleNameFor('7')).toBe('testenv_p7');
  });
  test('不是正整數一律拒絕（角色名會進 SQL）', () => {
    for (const bad of [0, -1, '1; DROP ROLE odoo', 'abc', null, undefined, 1.5]) {
      expect(() => role.roleNameFor(bad)).toThrow();
    }
  });
});

test('quoteIdent／quoteLiteral：大小寫混合的 DB 名與含引號的字串都要正確跳脫', () => {
  expect(role.quoteIdent('test_liSheng')).toBe('"test_liSheng"');
  expect(role.quoteIdent('a"b')).toBe('"a""b"');
  expect(role.quoteLiteral("it's")).toBe("'it''s'");
});

test('testEnvDbArgs：host／port 沿用平台 DB，帳密換成測試區角色——平台密碼不得出現', () => {
  const args = role.testEnvDbArgs({ role: 'testenv_p18', password: 'role-pw' });
  expect(args).toEqual(['--db_host', 'localhost', '--db_port', '8772', '--db_user', 'testenv_p18', '--db_password', 'role-pw']);
  expect(args.join(' ')).not.toContain('platform-pw');
  expect(args).not.toContain('odoo');
});

test('platformDbUser：取 DATABASE_URL 的帳號；沒設回 null', () => {
  expect(role.platformDbUser()).toBe('odoo');
  delete process.env.DATABASE_URL;
  expect(role.platformDbUser()).toBeNull();
});

describe('ownershipTransferSql', () => {
  const sql = role.ownershipTransferSql({ from: 'odoo', to: 'testenv_p18' });
  test('逐物件 ALTER OWNER，不用 REASSIGN OWNED', () => {
    expect(sql).not.toMatch(/REASSIGN\s+OWNED/i);
    expect(sql).toMatch(/ALTER %s %I\.%I OWNER TO %I/);
    expect(sql).toMatch(/ALTER ROUTINE %s OWNER TO %I/);
  });
  test('排除擴充套件成員與被表擁有的序列（改它們會報錯）', () => {
    expect(sql).toContain("d.deptype IN ('e', 'a', 'i')");
    expect(sql).toContain("d.deptype = 'e'");
  });
  test('來源與目標角色以字面值嵌入並跳脫', () => {
    const tricky = role.ownershipTransferSql({ from: "o'doo", to: 'testenv_p1' });
    expect(tricky).toContain("'o''doo'");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx jest server/tests/testenv-db-role.test.js`
Expected: FAIL，`Cannot find module '../lib/testenv-db-role'`

- [ ] **Step 3: 最小實作**

```js
// app/server/lib/testenv-db-role.js
/**
 * lib/testenv-db-role.js — 測試區自己的 PostgreSQL 角色（產品化規格 1 §10）
 *
 * 以前測試區 Odoo 拿的是平台 DATABASE_URL 的帳密，而那個帳號是超級使用者：進得了測試區的人
 * （客戶驗收時就是 Odoo admin，可寫伺服器動作跑 Python）或 AI 寫進模組的一段碼，都能讀平台 DB、
 * 改別家測試庫、COPY … TO PROGRAM 在平台容器執行指令。這條路不經過 AI 容器。
 *
 * ⚠ 禁用 REASSIGN OWNED（09-15 實測，規格 §10.6）：odoo 是 initdb 的 bootstrap 角色，直接報錯；
 *   而且 REASSIGN OWNED 會連「其他 DB 的擁有權」一起轉走。一律逐物件 ALTER … OWNER。
 */
const crypto = require('crypto');
const { Client } = require('pg');
const { query } = require('../db');
const { encrypt, decrypt } = require('./crypto');

function platformDbUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('沒有 DATABASE_URL，無法管理測試區資料庫帳號');
  return new URL(raw);
}

function platformDbUser() {
  try { return decodeURIComponent(new URL(process.env.DATABASE_URL).username) || null; } catch { return null; }
}

function roleNameFor(projectId) {
  const id = typeof projectId === 'string' && /^\d+$/.test(projectId) ? Number(projectId) : projectId;
  if (!Number.isInteger(id) || id <= 0) throw new Error(`不合法的專案 id：${projectId}`);
  return `testenv_p${id}`;
}

function quoteIdent(name) { return `"${String(name).replace(/"/g, '""')}"`; }
function quoteLiteral(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function testEnvDbArgs({ role, password }) {
  const u = platformDbUrl();
  const args = [];
  if (u.hostname) args.push('--db_host', u.hostname);
  if (u.port) args.push('--db_port', u.port);
  args.push('--db_user', role, '--db_password', password);
  return args;
}

// 在「目標 DB 內」以超級使用者執行。擴充套件成員（deptype e）改不了也不該改；
// 被表擁有的序列（deptype a）與索引（i）會跟著表轉，單獨改會報錯。
function ownershipTransferSql({ from, to }) {
  const f = quoteLiteral(from);
  const t = quoteLiteral(to);
  return `DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND pg_get_userbyid(c.relowner) = ${f}
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('e', 'a', 'i'))
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO %I',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.nspname, r.relname, ${t});
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND pg_get_userbyid(p.proowner) = ${f}
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO %I', r.sig, ${t});
  END LOOP;
END
$$;`;
}

module.exports = {
  platformDbUser, roleNameFor, quoteIdent, quoteLiteral, testEnvDbArgs, ownershipTransferSql,
  // Task 2 補上：ensureTestEnvDbRole, loadTestEnvDbCreds, revokePublicConnectAll
  _internal: { platformDbUrl, crypto, Client, query, encrypt, decrypt },
};
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx jest server/tests/testenv-db-role.test.js`
Expected: PASS（9 tests）

- [ ] **Step 5: Commit**

```bash
git add app/server/lib/testenv-db-role.js app/server/tests/testenv-db-role.test.js
git commit -m "[TestEnv]: 測試區拿平台超級使用者帳密，先備好角色名與轉擁有者的 SQL（不用 REASSIGN OWNED）"
```

---

### Task 2: 建角色／建或轉 DB／撤 PUBLIC 連線（`ensureTestEnvDbRole`、`revokePublicConnectAll`）

**Files:**
- Modify: `app/server/lib/testenv-db-role.js`
- Modify: `app/server/db.js`（ALTER 清單，與 `odoo_envs` 其他欄位放一起，約 1037 行 `started_at` 之後）
- Test: `app/server/tests/testenv-db-role.test.js`

**Interfaces:**
- Consumes: Task 1 全部。
- Produces:
  - `ensureTestEnvDbRole({ projectId, dbName, createClient? }) → Promise<{ role, password }>`
  - `loadTestEnvDbCreds(projectId) → Promise<{ role, password } | null>`
  - `revokePublicConnectAll({ createClient? }?) → Promise<number>`（處理了幾個 DB）
  - `createClient(database: string) → { connect(), query(sql, params?), end() }`（預設用 `DATABASE_URL` 換 database）

- [ ] **Step 1: 加欄位**

在 `app/server/db.js` 的 ALTER 清單 `{ table: 'odoo_envs', col: 'started_at', … }` 那一行後面加：

```js
    // 2c：測試區自己的 PG 角色密碼（lib/crypto 加密）。角色名由專案 id 推得（testenv_p<id>），不另存。
    { table: 'odoo_envs', col: 'db_password_enc', sql: 'ALTER TABLE odoo_envs ADD COLUMN db_password_enc TEXT' },
```

- [ ] **Step 2: 寫失敗的測試**（附加到 `testenv-db-role.test.js` 檔尾）

```js
// ── Task 2：ensureTestEnvDbRole ──
const { newDb } = require('pg-mem');

describe('ensureTestEnvDbRole（假 PG client 記錄 SQL；odoo_envs 用 pg-mem）', () => {
  let dbModule;
  const PID = 18;
  beforeAll(async () => {
    process.env.APP_SECRET = process.env.APP_SECRET || 'test-app-secret-2c';
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    dbModule = require('../db');
    dbModule._setPoolForTesting(new Pool());
    await dbModule.migrate();
    await dbModule.query(`INSERT INTO projects (id, name, odoo_version, folder_name) VALUES (${PID}, 'P-2c', '17.0', 'liSheng')`);
  });
  afterAll(() => dbModule._setPoolForTesting(null));
  beforeEach(async () => {
    await dbModule.query('DELETE FROM odoo_envs');
    await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1, 'setting_up')", [PID]);
  });

  // pg_roles／pg_database 的查詢依 fixture 回答，其餘 SQL 只記錄
  function fakePg({ roleExists = false, dbOwner = null } = {}) {
    const log = [];
    const createClient = (database) => ({
      connect: async () => {},
      end: async () => {},
      query: async (sql, params = []) => {
        log.push({ database, sql, params });
        if (/FROM pg_roles/.test(sql)) return { rows: roleExists ? [{ '?column?': 1 }] : [] };
        if (/FROM pg_database WHERE datname/.test(sql)) return { rows: dbOwner ? [{ owner: dbOwner }] : [] };
        return { rows: [] };
      },
    });
    return { createClient, log, sqls: () => log.map((l) => l.sql) };
  }

  test('全新測試區：建角色 → 平台先建 DB（擁有者＝角色）→ 撤 PUBLIC 連線 → 在該 DB 建 pg_trgm 並轉擁有者', async () => {
    const pg = fakePg();
    const r = await role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: pg.createClient });
    expect(r.role).toBe('testenv_p18');
    const s = pg.sqls();
    const idx = (re) => s.findIndex((x) => re.test(x));
    expect(s[idx(/^CREATE ROLE/)]).toMatch(/^CREATE ROLE "testenv_p18" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '/);
    expect(s[idx(/^CREATE DATABASE/)]).toBe(`CREATE DATABASE "test_liSheng" OWNER "testenv_p18" ENCODING 'UTF8' LC_COLLATE 'C' TEMPLATE template0`);
    expect(idx(/^REVOKE CONNECT ON DATABASE "test_liSheng" FROM PUBLIC$/)).toBeGreaterThan(idx(/^CREATE DATABASE/));
    const ext = pg.log.find((l) => /CREATE EXTENSION IF NOT EXISTS pg_trgm/.test(l.sql));
    expect(ext.database).toBe('test_liSheng');                 // 建在測試 DB 裡，不是 postgres
    expect(idx(/^DO \$\$/)).toBeGreaterThan(idx(/CREATE EXTENSION/));
    expect(s.some((x) => /REASSIGN\s+OWNED/i.test(x))).toBe(false);
    expect(s.some((x) => /SUPERUSER(?!\s)/.test(x.replace(/NOSUPERUSER/g, '')))).toBe(false);
  });

  test('既有 DB 擁有者還是平台帳號：ALTER DATABASE OWNER，不重建 DB', async () => {
    const pg = fakePg({ roleExists: false, dbOwner: 'odoo' });
    await role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: pg.createClient });
    const s = pg.sqls();
    expect(s).toContain('ALTER DATABASE "test_liSheng" OWNER TO "testenv_p18"');
    expect(s.some((x) => /^CREATE DATABASE/.test(x))).toBe(false);
  });

  test('已經轉好的 DB：不再 ALTER DATABASE，但轉擁有者的 DO 區塊照跑（冪等，補轉之後 Odoo 以超級使用者建的漏網物件）', async () => {
    const pg = fakePg({ roleExists: true, dbOwner: 'testenv_p18' });
    await role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: pg.createClient });
    const s = pg.sqls();
    expect(s.some((x) => /^ALTER DATABASE/.test(x))).toBe(false);
    expect(s.some((x) => /^DO \$\$/.test(x))).toBe(true);
    expect(s.some((x) => /^ALTER ROLE "testenv_p18" LOGIN NOSUPERUSER/.test(x))).toBe(true);
  });

  test('密碼加密存進 odoo_envs、明文不落庫；下次沿用同一把（重建時容器與角色密碼不脫鉤）', async () => {
    const first = await role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: fakePg().createClient });
    const { rows: [env] } = await dbModule.query('SELECT db_password_enc FROM odoo_envs WHERE project_id=$1', [PID]);
    expect(env.db_password_enc).toBeTruthy();
    expect(env.db_password_enc).not.toContain(first.password);
    const second = await role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: fakePg({ roleExists: true, dbOwner: 'testenv_p18' }).createClient });
    expect(second.password).toBe(first.password);
    expect(await role.loadTestEnvDbCreds(PID)).toEqual({ role: 'testenv_p18', password: first.password });
  });

  test('存的密文解不開（例如 APP_SECRET 換過）：產新密碼並 ALTER ROLE 設進去，不沿用壞值', async () => {
    await dbModule.query("UPDATE odoo_envs SET db_password_enc='not:valid:cipher' WHERE project_id=$1", [PID]);
    const pg = fakePg({ roleExists: true, dbOwner: 'testenv_p18' });
    const r = await role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: pg.createClient });
    expect(r.password).toMatch(/^[0-9a-f]{48}$/);
    expect(pg.sqls().find((x) => /^ALTER ROLE/.test(x))).toContain(`PASSWORD '${r.password}'`);
  });

  test('loadTestEnvDbCreds：沒存過密碼回 null（呼叫端據此大聲失敗，不退回平台帳號）', async () => {
    expect(await role.loadTestEnvDbCreds(PID)).toBeNull();
  });

  test('沒有 DATABASE_URL：直接失敗，不送任何 SQL', async () => {
    delete process.env.DATABASE_URL;
    const pg = fakePg();
    await expect(role.ensureTestEnvDbRole({ projectId: PID, dbName: 'test_liSheng', createClient: pg.createClient })).rejects.toThrow(/DATABASE_URL/);
    expect(pg.log).toHaveLength(0);
  });
});

test('revokePublicConnectAll：每個允許連線的 DB（含平台 DB 與 postgres）都撤 PUBLIC 的 CONNECT', async () => {
  const log = [];
  const createClient = (database) => ({
    connect: async () => {}, end: async () => {},
    query: async (sql) => {
      log.push({ database, sql });
      if (/FROM pg_database/.test(sql)) return { rows: [{ datname: 'aidev' }, { datname: 'postgres' }, { datname: 'test_liSheng' }] };
      return { rows: [] };
    },
  });
  const n = await role.revokePublicConnectAll({ createClient });
  expect(n).toBe(3);
  expect(log[0].sql).toMatch(/WHERE datallowconn/);
  expect(log.slice(1).map((l) => l.sql)).toEqual([
    'REVOKE CONNECT ON DATABASE "aidev" FROM PUBLIC',
    'REVOKE CONNECT ON DATABASE "postgres" FROM PUBLIC',
    'REVOKE CONNECT ON DATABASE "test_liSheng" FROM PUBLIC',
  ]);
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `cd app && npx jest server/tests/testenv-db-role.test.js`
Expected: FAIL，`role.ensureTestEnvDbRole is not a function`

- [ ] **Step 4: 實作**（在 `testenv-db-role.js` 的 `module.exports` 之前加入，並改寫 exports）

```js
function defaultCreateClient(database) {
  const u = platformDbUrl();
  u.pathname = `/${encodeURIComponent(database)}`;
  return new Client({ connectionString: u.toString() });
}

async function loadTestEnvDbCreds(projectId) {
  const { rows: [env] } = await query('SELECT db_password_enc FROM odoo_envs WHERE project_id=$1', [projectId]);
  if (!env || !env.db_password_enc) return null;
  try { return { role: roleNameFor(projectId), password: decrypt(env.db_password_enc) }; } catch { return null; }
}

// 每次建置都跑：冪等。順序有意義——DB 要先存在（或轉好擁有者）才能連進去建擴充套件、轉物件。
async function ensureTestEnvDbRole({ projectId, dbName, createClient = defaultCreateClient }) {
  platformDbUrl();                                   // 沒有 DATABASE_URL 就在送任何 SQL 之前失敗
  const role = roleNameFor(projectId);
  const superuser = platformDbUser();
  const saved = await loadTestEnvDbCreds(projectId);
  const password = saved ? saved.password : crypto.randomBytes(24).toString('hex');

  const admin = createClient('postgres');
  await admin.connect();
  try {
    const { rows: roleRows } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    // 已存在也重設一次：密碼以 odoo_envs 為準，屬性不小心被改過也拉回來
    await admin.query(`${roleRows.length ? 'ALTER' : 'CREATE'} ROLE ${quoteIdent(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${quoteLiteral(password)}`);
    const { rows: dbRows } = await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [dbName]);
    if (!dbRows.length) {
      await admin.query(`CREATE DATABASE ${quoteIdent(dbName)} OWNER ${quoteIdent(role)} ENCODING 'UTF8' LC_COLLATE 'C' TEMPLATE template0`);
    } else if (dbRows[0].owner !== role) {
      await admin.query(`ALTER DATABASE ${quoteIdent(dbName)} OWNER TO ${quoteIdent(role)}`);
    }
    await admin.query(`REVOKE CONNECT ON DATABASE ${quoteIdent(dbName)} FROM PUBLIC`);
  } finally {
    await admin.end().catch(() => {});
  }

  const db = createClient(dbName);
  await db.connect();
  try {
    // DB 由平台先建時 Odoo 會跳過它自己的建擴充套件步驟（odoo/service/db.py _create_empty_database）
    await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    if (superuser && superuser !== role) await db.query(ownershipTransferSql({ from: superuser, to: role }));
  } finally {
    await db.end().catch(() => {});
  }

  await query('UPDATE odoo_envs SET db_password_enc=$2 WHERE project_id=$1', [projectId, encrypt(password)]);
  return { role, password };
}

// 平台啟動時跑：撤掉 PUBLIC 對每個 DB 的 CONNECT。超級使用者不受影響；測試區角色是自己 DB 的擁有者，照連。
async function revokePublicConnectAll({ createClient = defaultCreateClient } = {}) {
  const admin = createClient('postgres');
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname');
    for (const r of rows) await admin.query(`REVOKE CONNECT ON DATABASE ${quoteIdent(r.datname)} FROM PUBLIC`);
    return rows.length;
  } finally {
    await admin.end().catch(() => {});
  }
}

module.exports = {
  platformDbUser, roleNameFor, quoteIdent, quoteLiteral, testEnvDbArgs, ownershipTransferSql,
  ensureTestEnvDbRole, loadTestEnvDbCreds, revokePublicConnectAll,
};
```

（刪掉 Task 1 exports 裡的 `_internal` 那一行。）

- [ ] **Step 5: 跑測試確認通過**

Run: `cd app && npx jest server/tests/testenv-db-role.test.js server/tests/db-migration.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/server/lib/testenv-db-role.js app/server/tests/testenv-db-role.test.js app/server/db.js
git commit -m "[TestEnv]: 測試區拿平台超級使用者帳密，改由平台建每個測試區自己的角色並把 DB 擁有權轉過去"
```

---

### Task 3: docker 邊界守衛（非 `testenv_p<id>` 一律不准起容器／exec）與讀容器帳號

**Files:**
- Modify: `app/server/lib/docker-env.js`（`runContainer` 約 413 行、`execOdoo` 約 421 行；新增兩個函式並加進 exports）
- Test: `app/server/tests/docker-env.test.js`

**Interfaces:**
- Produces:
  - `assertTestEnvDbUser(dbArgs: string[]) → void`（不合格 throw）
  - `containerDbUser(name: string, deps?) → Promise<string|null>`（容器 `Config.Env` 的 `USER=` 值；inspect 失敗回 null）
  - `runContainer` 帳號不合格時回 `{ ok: false, log: <訊息>, stderr: <訊息> }`，不呼叫 docker
  - `execOdoo` 帳號不合格時回 `{ code: 1, stdout: '', stderr: <訊息> }`，不呼叫 docker

- [ ] **Step 1: 寫失敗的測試**（附加到 `docker-env.test.js`）

```js
// 2c：測試區容器只准拿自己的 PG 角色。沒帶帳號時官方 image 的 entrypoint 會退回 USER=odoo——正好是平台
// 超級使用者的名字；帶平台帳號就回到原本的洞。守衛放在 IO 邊界（真的要跑 docker 之前），純參數組裝不動。
describe('assertTestEnvDbUser（2c）', () => {
  test('testenv_p<id> 放行', () => {
    expect(() => d.assertTestEnvDbUser(['--db_host', 'localhost', '--db_user', 'testenv_p18', '--db_password', 'x'])).not.toThrow();
  });
  test('沒帶帳號、帶平台帳號 odoo、或其他名字一律拒絕', () => {
    for (const dbArgs of [[], ['--db_host', 'localhost'], ['--db_user', 'odoo', '--db_password', 'p'], ['--db_user', 'postgres'], ['--db_user', 'testenv_px']]) {
      expect(() => d.assertTestEnvDbUser(dbArgs)).toThrow(/測試區資料庫帳號/);
    }
  });
  test('runContainer：帳號不合格就不跑 docker，回 ok:false 帶原因', async () => {
    let spawned = false;
    const r = await d.runContainer(
      { name: 'c', image: 'odoo-idx:17', port: 8070, dbName: 'test_p1', dbArgs: ['--db_user', 'odoo'] },
      { spawnFn: () => { spawned = true; return fakeSpawn({ code: 0 })(); } }
    );
    expect(spawned).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/測試區資料庫帳號/);
  });
  test('execOdoo：帳號不合格就不跑 docker，回 code 1', async () => {
    let spawned = false;
    const r = await d.execOdoo(
      { container: 'c1', dbName: 'test_p1', dbArgs: [], odooArgs: ['-u', 'sale', '--stop-after-init'] },
      { spawnFn: () => { spawned = true; return fakeSpawn({ code: 0 })(); } }
    );
    expect(spawned).toBe(false);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/測試區資料庫帳號/);
  });
});

describe('containerDbUser（2c：找出還帶著平台帳號的舊容器）', () => {
  test('讀出 Config.Env 裡的 USER', async () => {
    const r = await d.containerDbUser('odoo-test-x', { spawnFn: fakeSpawn({ code: 0, stdout: 'PATH=/usr/bin\nHOST=host.docker.internal\nUSER=odoo\nPASSWORD=secret\n' }) });
    expect(r).toBe('odoo');
  });
  test('容器不存在回 null', async () => {
    expect(await d.containerDbUser('nope', { spawnFn: fakeSpawn({ code: 1, stderr: 'No such object' }) })).toBeNull();
  });
});
```

同一檔既有的兩支 `execOdoo` 測試（約 469、484 行）會被守衛擋下，把它們 `dbArgs: ['--db_host', 'localhost']` 改成：

```js
dbArgs: ['--db_host', 'localhost', '--db_user', 'testenv_p1', '--db_password', 'x']
```

`describe('buildRunArgs')` 開頭的 `dbArgs: ['--db_host', 'localhost', '--db_user', 'odoo']` 改成 `['--db_host', 'localhost', '--db_user', 'testenv_p1']`，並把該 describe 內 `expect(preImage).toContain('USER=odoo');` 改成 `expect(preImage).toContain('USER=testenv_p1');`（純組裝函式不加守衛，這裡只是讓 fixture 不再示範平台帳號）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx jest server/tests/docker-env.test.js`
Expected: FAIL，`d.assertTestEnvDbUser is not a function`

- [ ] **Step 3: 實作**（`lib/docker-env.js`）

在 `dbEnvFlags` 之前加：

```js
// 2c（產品化規格 1 §10）：測試區容器只准拿該測試區自己的 PG 角色 testenv_p<projectId>。
// 沒帶帳號時官方 image 的 entrypoint 會退回 USER=odoo——正好是平台超級使用者的名字；
// 帶到平台帳號，進測試區的人就能讀平台 DB、COPY TO PROGRAM。不合格一律拒絕，不退回任何預設值。
const TEST_ENV_DB_USER_RE = /^testenv_p\d+$/;
function assertTestEnvDbUser(dbArgs = []) {
  const i = dbArgs.indexOf('--db_user');
  const user = i >= 0 ? dbArgs[i + 1] : null;
  if (!user || !TEST_ENV_DB_USER_RE.test(user)) {
    throw new Error(`測試區資料庫帳號不合格（${user || '未提供'}），拒絕啟動：請重建測試環境以建立該測試區自己的資料庫帳號`);
  }
}
```

`runContainer` 改成：

```js
async function runContainer(opts, deps = {}) {
  try { assertTestEnvDbUser(opts.dbArgs); } catch (e) { return { ok: false, log: e.message, stderr: e.message }; }
  const { code, stdout, stderr } = await runDocker(buildRunArgs(opts), deps);
  return { ok: code === 0, log: (stdout || '') + (stderr || ''), stderr };
}
```

`execOdoo` 函式本體第一行加：

```js
  try { assertTestEnvDbUser(dbArgs); } catch (e) { return { code: 1, stdout: '', stderr: e.message }; }
```

在 `containerMountSources` 之後加：

```js
// 容器建立時帶進去的 DB 帳號（官方 image 以 USER 環境變數給 entrypoint）。docker run 那一刻定型，
// 事後換不掉——2c 之前建的容器仍是平台帳號，只能靠這裡問出來再要求重建。
async function containerDbUser(name, deps = {}) {
  const { code, stdout } = await runDocker(['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', name], deps);
  if (code !== 0) return null;
  const line = String(stdout).split('\n').find((l) => l.startsWith('USER='));
  return line ? line.slice('USER='.length).trim() : null;
}
```

exports 加上 `assertTestEnvDbUser, containerDbUser`。

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx jest server/tests/docker-env.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/server/lib/docker-env.js app/server/tests/docker-env.test.js
git commit -m "[TestEnv]: 測試區容器可能帶著平台超級使用者帳密啟動，docker 邊界拒絕 testenv_p<id> 以外的帳號"
```

---

### Task 4: env-agent 接上角色（`dockerCtxFor`、`runEnvSetup`、`dbUserDrift`）

**Files:**
- Modify: `app/server/pipeline/env-agent.js`
  - 刪除 `odooDbArgs()`（約 192-207 行）與其註解
  - `dockerCtxFor`（約 30-72 行）
  - `runEnvSetup`：在「filestore 空但 DB 已存在」檢查區塊（約 957-971 行）**之後**、`ensureDockerRunning` 之前
  - 新增並 export `dbUserDrift`
- Test: `app/server/tests/env-agent-docker.test.js`；以及所有會跑 `runEnvSetup` 的測試檔（Step 1 找出來）

**Interfaces:**
- Consumes: Task 2 `ensureTestEnvDbRole`、`loadTestEnvDbCreds`、`testEnvDbArgs`、`roleNameFor`；Task 3 `containerDbUser`
- Produces:
  - `dockerCtxFor(projectId)` 回傳的 `ctx.dbArgs`：有存角色密碼時為 `testEnvDbArgs(creds)`，沒有時為 `[]`（Task 3 守衛會擋）
  - `dbUserDrift(projectId) → Promise<boolean>`：容器在跑且 `USER` 不是 `testenv_p<id>` 時 true

- [ ] **Step 1: 找出會跑 `runEnvSetup` 的測試檔**

Run: `cd app && grep -ln "runEnvSetup" server/tests/*.test.js`
在每一支（已 `jest.mock('../pipeline/env-agent')` 整支 mock 掉的除外）的其他 `jest.mock` 旁邊加：

```js
// 2c：建置會先建測試區 PG 角色（真的連 PG）。這裡只驗建置流程，換成固定帳密。
jest.mock('../lib/testenv-db-role', () => ({
  ...jest.requireActual('../lib/testenv-db-role'),
  ensureTestEnvDbRole: jest.fn().mockResolvedValue({ role: 'testenv_p1', password: 'test-role-pw' }),
  loadTestEnvDbCreds: jest.fn().mockResolvedValue({ role: 'testenv_p1', password: 'test-role-pw' }),
}));
```

- [ ] **Step 2: 寫失敗的測試**（附加到 `env-agent-docker.test.js`，並把 Step 1 的 mock 也加在這支）

```js
// 2c：容器只拿測試區自己的角色；還沒建角色時 ctx 不得偷偷退回平台帳號。
describe('2c 測試區資料庫角色', () => {
  const roleLib = require('../lib/testenv-db-role');
  let prevUrl;
  beforeEach(() => { prevUrl = process.env.DATABASE_URL; process.env.DATABASE_URL = 'postgres://odoo:platform-pw@localhost:8772/aidev'; });
  afterEach(() => { if (prevUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevUrl; });

  test('dockerCtxFor：有存角色密碼 → dbArgs 是角色帳密，平台帳密不出現', async () => {
    roleLib.loadTestEnvDbCreds.mockResolvedValueOnce({ role: `testenv_p${PID}`, password: 'role-pw' });
    const ctx = await envAgent.dockerCtxFor(PID);
    expect(ctx.dbArgs).toEqual(['--db_host', 'localhost', '--db_port', '8772', '--db_user', `testenv_p${PID}`, '--db_password', 'role-pw']);
    expect(ctx.dbArgs.join(' ')).not.toContain('platform-pw');
  });

  test('dockerCtxFor：沒存過角色密碼 → dbArgs 為空（交給 docker 邊界守衛擋下），不退回平台帳號', async () => {
    roleLib.loadTestEnvDbCreds.mockResolvedValueOnce(null);
    const ctx = await envAgent.dockerCtxFor(PID);
    expect(ctx.dbArgs).toEqual([]);
  });

  test('runEnvSetup：先建好角色，docker run 拿到的是角色帳密', async () => {
    roleLib.ensureTestEnvDbRole.mockResolvedValueOnce({ role: `testenv_p${PID}`, password: 'fresh-pw' });
    await envAgent.runEnvSetup(PID);
    expect(roleLib.ensureTestEnvDbRole).toHaveBeenCalledWith(expect.objectContaining({ projectId: PID, dbName: 'test_shopx' }));
    const runOpts = dockerEnv.runContainer.mock.calls.at(-1)[0];
    expect(runOpts.dbArgs).toEqual(expect.arrayContaining(['--db_user', `testenv_p${PID}`, '--db_password', 'fresh-pw']));
  });

  test('runEnvSetup：建角色失敗 → 環境落 error、不跑 docker run（絕不退回平台帳號）', async () => {
    roleLib.ensureTestEnvDbRole.mockRejectedValueOnce(new Error('permission denied to create role'));
    dockerEnv.runContainer.mockClear();
    await envAgent.runEnvSetup(PID);
    expect(dockerEnv.runContainer).not.toHaveBeenCalled();
    const { rows: [env] } = await dbModule.query('SELECT status, error_msg FROM odoo_envs WHERE project_id=$1', [PID]);
    expect(env.status).toBe('error');
    expect(env.error_msg).toContain('測試區資料庫帳號設定失敗');
  });

  test('dbUserDrift：容器在跑且 USER 仍是平台帳號 → true；是自己的角色 → false；容器沒跑 → false', async () => {
    dockerEnv.containerRunning.mockResolvedValue(true);
    dockerEnv.containerDbUser = jest.fn().mockResolvedValueOnce('odoo');
    expect(await envAgent.dbUserDrift(PID)).toBe(true);
    dockerEnv.containerDbUser.mockResolvedValueOnce(`testenv_p${PID}`);
    expect(await envAgent.dbUserDrift(PID)).toBe(false);
    dockerEnv.containerRunning.mockResolvedValueOnce(false);
    expect(await envAgent.dbUserDrift(PID)).toBe(false);
  });
});
```

（`env-agent-docker.test.js` 頂端的 `jest.mock('../lib/docker-env', …)` 物件裡加一行 `containerDbUser: jest.fn().mockResolvedValue(null),`，上面 `dockerEnv.containerDbUser = jest.fn()` 那行就改成直接 `dockerEnv.containerDbUser.mockResolvedValueOnce('odoo')`。）

- [ ] **Step 3: 跑測試確認失敗**

Run: `cd app && npx jest server/tests/env-agent-docker.test.js`
Expected: FAIL（`dbUserDrift is not a function`、dbArgs 不符）

- [ ] **Step 4: 實作**（`pipeline/env-agent.js`）

檔頭 require 區加：

```js
const { ensureTestEnvDbRole, loadTestEnvDbCreds, testEnvDbArgs, roleNameFor } = require('../lib/testenv-db-role');
```

`dockerCtxFor` 的 return 物件前加：

```js
  // 2c：測試區只拿自己的 PG 角色。還沒建過（2c 之前的環境）就給空陣列——docker 邊界守衛會擋下並要求重建，
  // 絕不退回平台 DATABASE_URL 的超級使用者（rules/pipeline 59）。
  const dbCreds = await loadTestEnvDbCreds(projectId);
```

return 物件內 `dbArgs: odooDbArgs(),` 改成：

```js
    dbArgs: dbCreds ? testEnvDbArgs(dbCreds) : [],
```

刪除 `function odooDbArgs() { … }` 整段（含上方那行註解）。

`runEnvSetup` 在 filestore 檢查區塊結束的 `}` 之後、`// 0) 確保 Docker daemon 在跑` 之前加：

```js
  // 2c：測試區用自己的 PG 角色（非超級使用者）。建角色／平台先建 DB 或把擁有權轉過去／撤 PUBLIC 連線。
  // 必須排在上面的「DB 已存在但 filestore 空」檢查之後：這一步會在 DB 不存在時先建出空 DB。
  // 失敗就停，絕不退回平台帳號。
  try {
    ctx.dbArgs = testEnvDbArgs(await ensureTestEnvDbRole({ projectId, dbName: ctx.dbName }));
  } catch (e) {
    return _failEnv(projectId, `測試區資料庫帳號設定失敗：${e.message}`, log + `[db-role] ${e.message}\n`);
  }
```

在 `addonsMountDrift` 函式之後加：

```js
// 2c：容器的 DB 帳號在 docker run 那一刻定型。2c 之前建的容器仍以平台超級使用者連線，
// 夜間關機會把它們收掉、下次開啟就換成角色；在那之前靠這裡問出來，deploy 擋下要求重建。
async function dbUserDrift(projectId) {
  const ctx = await dockerCtxFor(projectId);
  if (!ctx || !(await dockerEnv.containerRunning(ctx.container))) return false;
  const user = await dockerEnv.containerDbUser(ctx.container);
  return user !== null && user !== roleNameFor(projectId);
}
```

`module.exports` 加上 `dbUserDrift`。

- [ ] **Step 5: 跑相關測試**

Run: `cd app && npx jest server/tests/env-agent-docker.test.js server/tests/env-agent-enterprise.test.js server/tests/env-agent-seed-fail.test.js server/tests/env-agent-registry-ready.test.js server/tests/env-agent-module-depends.test.js`
Expected: PASS。若 Step 1 漏加 mock 的檔案出現 `ECONNREFUSED`／`DATABASE_URL`，補上 Step 1 的 mock 再跑。

- [ ] **Step 6: Commit**

```bash
git add app/server/pipeline/env-agent.js app/server/tests/env-agent-*.test.js
git commit -m "[TestEnv]: 測試區容器改拿自己的 PG 角色，建置時先建角色並轉 DB 擁有權，失敗就停不退回平台帳號"
```

---

### Task 5: 舊容器仍用平台帳號時擋部署

**Files:**
- Modify: `app/server/pipeline/deploy-testing.js`（第 5 行 require；`addonsMountDrift` 擋下區塊之後，約 286 行）
- Test: `app/server/tests/deploy-testing.test.js`

**Interfaces:**
- Consumes: Task 4 `dbUserDrift(projectId)`

- [ ] **Step 1: 寫失敗的測試**

`deploy-testing.test.js` 頂端 `jest.mock('../pipeline/env-agent', …)` 的物件加 `dbUserDrift: jest.fn().mockResolvedValue(false),`；在既有 `beforeEach`（約 161 行 `envAgent.addonsMountDrift.mockReset().mockResolvedValue([]);` 那行後面）加 `envAgent.dbUserDrift.mockReset().mockResolvedValue(false);`。在「容器缺掛新加入的 repo」那支測試（約 213 行）後面加（`setEnvRunning`、`makeTask`、`runDeployTesting`、`userId`、`dbModule` 都是該檔既有的）：

```js
// 2c：資料庫帳號隔離上線前建的容器還帶著平台超級使用者帳密。對它部署等於照舊開著洞，
// 而且重建是使用者看得到的中斷，所以擋下要求重建，不自動重建（比照 addons 漂移）。
test('測試區容器仍以平台資料庫帳號連線 → stopped(env)，不升級', async () => {
  await setEnvRunning();
  envAgent.dbUserDrift.mockResolvedValue(true);
  const id = await makeTask();

  await runDeployTesting(id, userId);

  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
  expect(t.blocker_content).toContain('平台資料庫帳號');
  expect(t.blocker_content).toContain('重建測試環境');
  expect(envAgent.upgradeModules).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx jest server/tests/deploy-testing.test.js -t "平台資料庫帳號"`
Expected: FAIL（status 不是 stopped）

- [ ] **Step 3: 實作**

第 5 行 require 的解構加上 `dbUserDrift`。在 addons 漂移擋下區塊的 `}` 之後加：

```js
  // 2c：容器的 DB 帳號在 docker run 時定型，資料庫帳號隔離上線前建的容器仍以平台超級使用者連線。
  // 擋下要求重建而不是自動重建——重建會中斷使用者正在用的測試區（同上）。
  if (await dbUserDrift(task.project_id).catch(() => false)) {
    await query(
      "UPDATE tasks SET status='stopped', blocker_type='env', blocker_content=$2, updated_at=NOW() WHERE id=$1",
      [taskId, '測試環境仍以平台資料庫帳號連線（資料庫帳號隔離上線前建立的舊容器）。'
        + '請到專案環境頁重建測試環境後再重試部署。']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return;
  }
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx jest server/tests/deploy-testing.test.js server/tests/workflow-scenarios.test.js`
Expected: PASS（`workflow-scenarios.test.js` 若因 mock 物件缺 `dbUserDrift` 而失敗，在它約 55 行 `addonsMountDrift: jest.fn()…` 旁加 `dbUserDrift: jest.fn().mockResolvedValue(false),`）

- [ ] **Step 5: Commit**

```bash
git add app/server/pipeline/deploy-testing.js app/server/tests/deploy-testing.test.js app/server/tests/workflow-scenarios.test.js
git commit -m "[TestEnv]: 資料庫帳號隔離前建的容器仍帶平台帳密，部署前擋下要求重建"
```

---

### Task 6: 啟動時撤銷所有 DB 的 PUBLIC 連線、全跑測試

**Files:**
- Modify: `app/server/index.js`（`migrate().then(async () => {` 區塊內，`releaseInterruptedSetups` 那個 try 之前）

- [ ] **Step 1: 實作**

```js
    // 2c：每個 DB 撤掉 PUBLIC 的 CONNECT——測試區角色只連得進自己擁有的 DB（平台超級使用者不受影響）。
    // 冪等，每次啟動跑一次，新建的測試 DB 另由 ensureTestEnvDbRole 各自撤。
    try {
      const { revokePublicConnectAll } = require('./lib/testenv-db-role');
      const n = await revokePublicConnectAll();
      console.log(`[STARTUP] 已撤銷 ${n} 個資料庫的 PUBLIC 連線權限`);
    } catch (e) { console.error('[STARTUP] 撤銷資料庫 PUBLIC 連線權限失敗:', e.message); }
```

- [ ] **Step 2: 語法檢查＋全跑**

```bash
cd app && node --check server/index.js && npm run test:quiet > /tmp/2c-full.out 2>&1; echo "EXITCODE=$?" >> /tmp/2c-full.out; grep -E "^FAIL|Tests:|Test Suites:|EXITCODE" /tmp/2c-full.out
```
Expected: `EXITCODE=0`，失敗 0；通過數 ≥ 開工前量的基線＋本計畫新增數。

- [ ] **Step 3: Commit**

```bash
git add app/server/index.js
git commit -m "[TestEnv]: 任何 PG 帳號都連得進平台 DB，啟動時撤掉每個資料庫的 PUBLIC 連線權限"
```

---

### Task 7: 正式平台驗證（合併、使用者重啟之後）

**前置**：Task 1-6 合併進 master、push，使用者在主機跑 `upgrade.sh`。

- [ ] **Step 1: 啟動 log 與撤銷結果**

```bash
cd /home/odoo/odoo-v2 && URL="$(node -e 'console.log(require("./data/config.json").DATABASE_URL)')"
psql "$URL" -Atc "select datname, has_database_privilege('public', datname, 'CONNECT') from pg_database where datallowconn order by 1"
```
Expected: 每一列第二欄都是 `f`。

- [ ] **Step 2: 重建一個低使用量的測試區（立勝補習班，project 18，`test_liSheng`）**

先確認沒有任務在用它：`psql "$URL" -Atc "select id,status from tasks where project_id=18 and status in ('deploy_testing','playwright_running')"` 應為空。然後請使用者在專案環境頁按「重建測試環境」（或平台管理員從畫面操作）。

- [ ] **Step 3: 驗證容器、DB 擁有者、Odoo 可用**

```bash
docker inspect odoo-test-liSheng -f '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^USER='
psql "$URL" -Atc "select pg_get_userbyid(datdba) from pg_database where datname='test_liSheng'"
psql "${URL%/*}/test_liSheng" -Atc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and pg_get_userbyid(c.relowner)='odoo'"
```
Expected: `USER=testenv_p18`；DB 擁有者 `testenv_p18`；public schema 內仍屬 `odoo` 的 relation = 0。並從平台畫面 SSO 登入該測試區，首頁正常。

- [ ] **Step 4: 從測試區容器內驗證攻擊路徑被擋**

```bash
PW="$(docker inspect odoo-test-liSheng -f '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PASSWORD=//p')"
for db in aidev test_odoo17 postgres; do docker exec odoo-test-liSheng psql "postgresql://testenv_p18:$PW@host.docker.internal:8772/$db" -Atc "select 1" 2>&1 | tail -1; done
docker exec odoo-test-liSheng psql "postgresql://testenv_p18:$PW@host.docker.internal:8772/test_liSheng" -Atc "COPY (select 1) TO PROGRAM 'id'" 2>&1 | tail -1
docker exec odoo-test-liSheng env | grep -c '^PASSWORD=' ; docker exec odoo-test-liSheng env | grep -E '^USER=odoo$' | wc -l
```
Expected: 三個 DB 都 `permission denied for database`；COPY 被擋；容器環境沒有 `USER=odoo`。

- [ ] **Step 5: 隔天確認舊容器汰換完**

夜間關機（23:00）會移除容器，下次開啟即以角色重建。隔天跑：

```bash
for c in $(docker ps --format '{{.Names}}' | grep '^odoo-test-'); do printf "%s " "$c"; docker inspect "$c" -f '{{range .Config.Env}}{{println .}}{{end}}' | grep '^USER='; done
```
Expected: 沒有任何一行是 `USER=odoo`。有的話那是使用中被夜間關機跳過的環境：在沒人用的時段請使用者重建。

- [ ] **Step 6: 更新規格與記憶**

在 `docs/superpowers/specs/2026-09-11-productize-rollout-plan.md` 階段 2c 列標記完成日期與驗證結果；更新記憶 `testenv-db-superuser.md`。

---

## Self-Review

- **Spec 覆蓋（§10.4 各列）**：每測試區角色 → Task 2；DB 擁有者 → Task 2（依 §10.6 改逐物件）；擋連別的 DB → Task 2（新 DB）＋Task 6（全部）；容器帳密 → Task 3、4；既有測試區遷移 → Task 4（下次建置自動轉）＋Task 5（擋舊容器部署）＋Task 7 Step 5（確認汰換完）；缺角色大聲失敗 → Task 3 守衛＋Task 4 失敗路徑。§10.4「密碼加密存 odoo_envs」→ Task 2。
- **未認領、明確排除**：畫面上顯示「此測試區仍用平台帳號」的提示（env-routes／前端）——部署會擋、夜間關機會汰換，列為不做；若 Task 7 Step 5 發現長期不關的環境再補。
- **型別一致**：`roleNameFor`、`testEnvDbArgs`、`ensureTestEnvDbRole`、`loadTestEnvDbCreds`、`revokePublicConnectAll`、`assertTestEnvDbUser`、`containerDbUser`、`dbUserDrift` 在各 Task 名稱與參數一致。
- **已知風險**：`waitForModulesInstalled`（env-agent 約 153 行）仍以平台帳號從平台端讀測試 DB——這是平台進程自己，不進容器，保留。
