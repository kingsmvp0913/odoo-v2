# 租戶隔離 第 1 部「公司與身分」實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立「公司」這一層身分（公司表、專案↔公司綁定、帳號掛公司、第三個角色值），讓每個請求一進來就知道「你是誰、屬於哪家公司、那家公司現在可不可以用」，並把 GIT 憑證改成「個人 → 公司」退回。

**Architecture:** 三張 schema 改動（新表 `companies`、新表 `project_companies`、`users.company_id`）＋一支一次性遷移腳本，把現況全部歸到一家「內部公司」名下。權限判斷收斂成兩個單點：`verifyToken` 掛上 `req.actor`，`lib/tenant-access.js` 提供所有「看不看得到」的問答。**本部不改任何路由的可見範圍**——路由逐支改範圍檢查是第 2 部。做完之後，現有 9 個管理員與 6 個一般使用者看到的東西與現在完全一樣。

**Tech Stack:** Node.js + Express + PostgreSQL（`pg`）；測試 jest + pg-mem + supertest。

**Spec:** `docs/superpowers/specs/2026-09-11-tenant-isolation-design.md`（§4 資料模型、§5.1 身分載入、§5.2 共用函式、§6 GIT 退回、§7 可用性檢查點、§9 測試）
**總覽：** `docs/superpowers/specs/2026-09-11-productize-overview.md`
**開發順序：** `docs/superpowers/specs/2026-09-11-productize-rollout-plan.md` 階段 2a

---

## Global Constraints

這些是整份計畫每個 Task 都適用的硬條件，違反就是做錯。

- **全跑測試一律 `cd app && npm run test:quiet`**（含 `--runInBand`），不要 `npx jest`。平行 worker 下 pg-mem 會產生浮動假紅。紅了之後才對那一支單獨跑不帶 `--silent` 的完整輸出。
- **基線自己量**：動手前先跑一次全跑，記下 `Test Suites:` 與 `Tests:` 兩行。之後出現的紅燈一律**先假設是自己造成的**；懷疑 flaky 要「stash 掉自己的改動、對那一支單獨再跑一次」，單跑綠了才算 flaky。
- **不要在計畫或程式碼裡寫死任何絕對路徑**（`/home/...`、`C:\`）。一律相對路徑或環境變數。
- **commit 前一律 `git status --porcelain -uno` 逐檔挑選，禁用 `git add -A`**；此 repo 常態多股平行工作。
- ⚠ **本計畫在專屬 worktree 裡做，所以用一般的 `git add <明確路徑>` ＋ `git commit` 就好，不要用私有 `GIT_INDEX_FILE`。** worktree 有自己獨立的 index（`.git/worktrees/tenant-isolation/index`），記憶 `shared-index-race-on-commit` 講的共用 index 競態在這裡不存在。2026-09-18 實測：照那套做反而出事——`mktemp` 會建出 0 byte 檔，git 報「index file smaller than expected」；改用 `mktemp -u` 則得到一個**空**的 index，`git add` 之後 commit 會把其餘 795 個追蹤檔全部記成刪除（當場被 `git show --stat` 抓到、已復原）。那套做法少了 `git read-tree HEAD` 這一步，而在 worktree 裡根本不需要它。
- **改 `app/server/**.js` 後必須重啟 server** 才會生效；本部不需要在開發期間重啟正式平台。
- **`db.js` 的 migration 是 add-if-missing 框架**：不改 `CREATE TABLE` 既有語句，新欄位走 `colMigrations` 清單，新表加進 `statements` 陣列（`.claude/rules/db-schema.md` 40、41）。
- **所有時間戳一律 `TIMESTAMPTZ`**（同上 42）。
- **新增布林旗標用「DEFAULT 安全值 ＋ 只有一條路徑寫危險值」**（同上 43）。
- **pg-mem 限制**（`.claude/rules/testing.md` 12–17）：不支援相關子查詢（改寫成 `NOT IN`，且子查詢要加 `IS NOT NULL`）、不支援 `btrim`、表在測試之間不清空、`WHERE <serial_pk> = ANY($1::int[])` 查不到列。
- **route 層測試的授權走 `createApp` ＋ `/api/auth/setup`／`/api/auth/login` 取得 token，不要用私有 signer 造 token**（同上 22）。
- **測試要建關聯資料先建父列**（同上 24）。
- **角色新值固定寫 `company_admin`**（不是 `companyAdmin`、不是 `company-admin`）。**內部公司名稱固定 `內部`**。
- **`companies.is_internal` 任何 API 都不可設定**，只有遷移腳本能寫 true（規格 §4.1）。
- **本部完成後，現有使用者可見範圍必須零改變**。任何 Task 若會改變既有人看得到的東西，就是做錯了——那屬於第 2 部。

---

## 檔案結構

| 檔案 | 責任 |
|---|---|
| `app/server/db.js`（改） | 新增 `companies`、`project_companies` 兩張表的 DDL、`users.company_id` 欄位、三個索引 |
| `app/server/lib/tenant-access.js`（新） | 「看不看得到／能不能做」的唯一真相：角色↔公司一致性驗證、`canSeeProject`、`loadProjectForActor`、`canReleaseProject`、`canManageCompanyUsers` |
| `app/server/auth.js`（改） | `verifyToken` 一次載入 `req.actor`；`GET /api/auth/me` 回傳公司資訊 |
| `app/server/index.js`（改） | 「公司不可用」全域閘門，比照既有的未核准閘門 |
| `app/server/lib/task-access.js`（改） | `loadTaskForActor` 加上「任務所屬專案必須看得到」 |
| `app/server/lib/git-identity.js`（改） | `buildGitEnv` 個人 → 公司退回，回傳 `source` |
| `tools/migrate-tenants.js`（新） | 一次性遷移：建內部公司、既有帳號掛公司、既有專案綁內部公司。預設 dry-run，`--apply` 才寫 |
| `app/server/tests/tenant-schema.test.js`（新） | schema 與索引 |
| `app/server/tests/tenant-access.test.js`（新） | `lib/tenant-access.js` 全部函式 |
| `app/server/tests/tenant-actor.test.js`（新） | `req.actor` 載入與公司不可用閘門（route 層） |
| `app/server/tests/task-access-tenant.test.js`（新） | `loadTaskForActor` 的專案可見性 |
| `app/server/tests/git-identity-company.test.js`（新） | GIT 退回四種情況 |
| `app/server/tests/migrate-tenants.test.js`（新） | 遷移腳本的 plan／apply／idempotent |

---

## Task 0：開工前置（worktree ＋ 基線）

**Files:** 無（只跑指令）

- [ ] **Step 1：開獨立 worktree**

多股平行工作共用同一個 checkout 會讓 commit 落到錯的分支（`.claude/rules/always.md` 5）。

```bash
cd /home/odoo/odoo-v2
git fetch origin
git worktree add .claude/worktrees/tenant-isolation -b feat/tenant-isolation origin/master
cd .claude/worktrees/tenant-isolation
git log --oneline -1
```
Expected：印出 origin/master 的最新 commit。

- [ ] **Step 2：量基線**

```bash
cd app && npm run test:quiet 2>&1 | tail -5
```
Expected：`Test Suites:` 與 `Tests:` 兩行，`0 failed`。**把這兩行抄進 `.superpowers/sdd/2026-09-18-tenant-isolation-part1/progress.md`**（沒有這個檔就建）。這兩個數字就是後面每個 Task 的比較基準。

**基線不是 0 failed 就停下來問**，不要在紅底上開工。

---

## Task 1：資料模型（`companies`、`project_companies`、`users.company_id`）

**Files:**
- Modify: `app/server/db.js`（`statements` 陣列加兩張表；`colMigrations` 加一欄；索引區加三行）
- Test: `app/server/tests/tenant-schema.test.js`（新）

**Interfaces:**
- Produces：表 `companies(id, name, is_active, is_internal, active_from, active_until, git_pat_enc, git_login, git_name, git_email, created_at, updated_at)`；表 `project_companies(project_id, company_id, can_release, created_at)`；欄位 `users.company_id INTEGER REFERENCES companies(id)`。後面所有 Task 都靠這些欄位名。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/tenant-schema.test.js`：

```javascript
/**
 * tenant-schema.test.js — 租戶隔離的資料模型（規格 §4）
 *
 * 這支守的是「遷移跑完，公司這一層的欄位真的存在且帶著該有的約束」。
 * 約束測的是意圖而不是欄位有沒有出現：
 *  - is_internal 只能有一筆 true（誤標第二筆＝客戶公司拿平台的訂閱跑 AI，違反 Anthropic 條款）
 *  - project_companies 的 project_id 必須 ON DELETE CASCADE（不帶會擋死刪專案，記憶 spec-trio-executed）
 *  - can_release 預設 false（規格 §4.3：預設不勾）
 */
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});

afterAll(() => dbModule._setPoolForTesting(null));

const cols = async (table) => {
  const { rows } = await dbModule.query(
    'SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1',
    [table]
  );
  return Object.fromEntries(rows.map(r => [r.column_name, r]));
};

test('companies 表存在且欄位齊全', async () => {
  const c = await cols('companies');
  for (const name of ['id', 'name', 'is_active', 'is_internal', 'active_from', 'active_until',
                      'git_pat_enc', 'git_login', 'git_name', 'git_email', 'created_at', 'updated_at']) {
    expect(c[name]).toBeDefined();
  }
});

test('companies.is_active 與 is_internal 預設 false（安全值，只有明確路徑寫 true）', async () => {
  await dbModule.query("INSERT INTO companies (name) VALUES ('預設值測試')");
  const { rows } = await dbModule.query("SELECT is_active, is_internal FROM companies WHERE name = '預設值測試'");
  expect(rows[0].is_active).toBe(false);
  expect(rows[0].is_internal).toBe(false);
});

test('內部公司只能有一筆：第二筆 is_internal=true 會被索引擋下', async () => {
  await dbModule.query("INSERT INTO companies (name, is_internal) VALUES ('內部', true)");
  await expect(
    dbModule.query("INSERT INTO companies (name, is_internal) VALUES ('假的內部', true)")
  ).rejects.toThrow();
});

test('users.company_id 存在且可為 NULL（平台管理員沒有公司）', async () => {
  const c = await cols('users');
  expect(c.company_id).toBeDefined();
  expect(c.company_id.is_nullable).toBe('YES');
});

test('project_companies 的 can_release 預設 false', async () => {
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('綁定測試專案', '17')");
  const { rows: [p] } = await dbModule.query("SELECT id FROM projects WHERE name = '綁定測試專案'");
  const { rows: [co] } = await dbModule.query("SELECT id FROM companies WHERE name = '內部'");
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1, $2)', [p.id, co.id]);
  const { rows } = await dbModule.query(
    'SELECT can_release FROM project_companies WHERE project_id = $1 AND company_id = $2', [p.id, co.id]
  );
  expect(rows[0].can_release).toBe(false);
});

test('刪專案會連帶刪掉它的公司綁定（沒有 CASCADE 會擋死刪除）', async () => {
  const { rows: [p] } = await dbModule.query("SELECT id FROM projects WHERE name = '綁定測試專案'");
  await dbModule.query('DELETE FROM projects WHERE id = $1', [p.id]);
  const { rows } = await dbModule.query('SELECT * FROM project_companies WHERE project_id = $1', [p.id]);
  expect(rows).toHaveLength(0);
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/tenant-schema.test.js --runInBand 2>&1 | tail -20
```
Expected：FAIL，`companies` 表不存在。

- [ ] **Step 3：改 `db.js`**

在 `statements` 陣列裡、`login_attempts` 那一筆後面加兩張表：

```javascript
    `CREATE TABLE IF NOT EXISTS companies (
      id           SERIAL PRIMARY KEY,
      name         TEXT UNIQUE NOT NULL,
      -- 預設安全值：新公司一律停用，只有平台管理員的建立／啟用端點寫 true（rules/db-schema 43）
      is_active    BOOLEAN NOT NULL DEFAULT false,
      -- 內部公司記號，只管「AI 用平台的訂閱付錢」，不管看得到哪些專案。
      -- 唯一寫 true 的路徑是 tools/migrate-tenants.js；任何 API 都不可設定——
      -- 客戶公司被誤標成內部，就會用平台的訂閱跑客戶的 AI，違反 Anthropic 條款。
      is_internal  BOOLEAN NOT NULL DEFAULT false,
      active_from  TIMESTAMPTZ,
      active_until TIMESTAMPTZ,
      git_pat_enc  TEXT,
      git_login    TEXT,
      git_name     TEXT,
      git_email    TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS project_companies (
      -- CASCADE 是必要的：不帶會讓「刪專案」被外鍵擋死（記憶 spec-trio-executed）。
      -- 公司那一側刻意不帶 CASCADE——公司不刪只停用，誤刪公司不該連帶清掉綁定。
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      company_id  INTEGER NOT NULL REFERENCES companies(id),
      can_release BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, company_id)
    )`,
```

在 `colMigrations` 陣列末尾加一欄：

```javascript
    // 租戶隔離（規格 §4.2）：NULL 只允許平台管理員；company_admin／user 一律有值。
    // 約束由 lib/tenant-access.js 的 validateRoleCompany 在寫入端把關，不放 CHECK——
    // 遷移跑完之前既有 6 個 user 還是 NULL，DB 層 CHECK 會讓 migrate 直接失敗。
    { table: 'users', col: 'company_id', sql: 'ALTER TABLE users ADD COLUMN company_id INTEGER REFERENCES companies(id)' },
```

在索引區塊（`CREATE INDEX IF NOT EXISTS` 那一段）加三行：

```javascript
  // 內部公司全平台只能有一筆：誤標第二筆＝客戶公司用平台訂閱跑 AI（違反 Anthropic 條款）
  await query('CREATE UNIQUE INDEX IF NOT EXISTS companies_internal_idx ON companies (is_internal) WHERE is_internal = true').catch(() => {});
  // 「這家公司看得到哪些專案」與「這個專案給哪幾家看」兩個方向都會查
  await query('CREATE INDEX IF NOT EXISTS idx_pc_company ON project_companies (company_id)').catch(() => {});
  // verifyToken 每個請求都要 JOIN companies，users.company_id 一定要有索引
  await query('CREATE INDEX IF NOT EXISTS idx_users_company ON users (company_id)').catch(() => {});
```

⚠ `colMigrations` 的 `users.company_id` 參照 `companies(id)`，所以 `companies` 的 `CREATE TABLE` **必須排在 `colMigrations` 之前執行**。`db.js` 現行順序本來就是「先跑完 `statements` 再跑 `colMigrations`」，照上面放就對；改動後務必確認這個順序沒被動到。

- [ ] **Step 4：跑測試確認它綠**

```bash
cd app && npx jest server/tests/tenant-schema.test.js --runInBand 2>&1 | tail -20
```
Expected：6 passed。

- [ ] **Step 5：全跑，確認沒弄紅別人**

```bash
cd app && npm run test:quiet 2>&1 | tail -5
```
Expected：`Test Suites:` 比基線 +1，`Tests:` 比基線 +6，`0 failed`。

- [ ] **Step 6：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-isolation
git add app/server/db.js app/server/tests/tenant-schema.test.js
git commit -m "[Tenant]: 平台要能同時服務多家客戶，先建公司這一層——公司表、專案與公司的綁定、帳號掛公司"
git status --porcelain -uno
```
Expected：commit 成功，`git status` 沒有殘留你自己的檔案。

---

## Task 2：`lib/tenant-access.js` 第一支——角色與公司的一致性

**Files:**
- Create: `app/server/lib/tenant-access.js`
- Test: `app/server/tests/tenant-access.test.js`（新，本 Task 只寫 `validateRoleCompany` 那段；Task 5 會在同一支檔案補其餘）

**Interfaces:**
- Produces:
  - `ROLES = { PLATFORM_ADMIN: 'admin', COMPANY_ADMIN: 'company_admin', USER: 'user' }`
  - `validateRoleCompany(role, companyId) -> { ok: true } | { ok: false, error: string }` — 純函式，不碰 DB

**為什麼這支要先做：** 規格 §4.4 特地不讓公司管理員重用 `role='admin'`，理由是全平台至少 6 處散落的 `role === 'admin'` 檢查，漏改一處客戶就變平台管理員。用新值的話漏改只會少一個功能。這支函式是「寫入端唯一的把關」，所有建立／修改帳號的路徑都要呼叫它。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/tenant-access.test.js`：

```javascript
/**
 * tenant-access.test.js — 租戶範圍判斷的唯一真相（規格 §4.4、§5.2）
 *
 * validateRoleCompany 守的是「平台管理員不屬於任何公司、其他人一定屬於一家」這個不變式。
 * 這條不變式一破，req.actor.companyId 就可能是 undefined，
 * 而所有範圍查詢都拿它當條件 ⇒ 條件失效、看到全部人的資料。
 */
const { ROLES, validateRoleCompany } = require('../lib/tenant-access');

describe('validateRoleCompany', () => {
  test('平台管理員沒有公司 → 通過', () => {
    expect(validateRoleCompany(ROLES.PLATFORM_ADMIN, null).ok).toBe(true);
  });

  test('平台管理員帶了公司 → 拒絕（admin 一律看全部，掛公司會讓人誤以為受限）', () => {
    const r = validateRoleCompany(ROLES.PLATFORM_ADMIN, 3);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('平台管理員');
  });

  test('公司管理員必須有公司', () => {
    expect(validateRoleCompany(ROLES.COMPANY_ADMIN, 3).ok).toBe(true);
    expect(validateRoleCompany(ROLES.COMPANY_ADMIN, null).ok).toBe(false);
  });

  test('一般使用者必須有公司', () => {
    expect(validateRoleCompany(ROLES.USER, 3).ok).toBe(true);
    expect(validateRoleCompany(ROLES.USER, null).ok).toBe(false);
  });

  test('未知角色一律拒絕（打錯字的 companyAdmin 不能悄悄變成沒有公司的身分）', () => {
    expect(validateRoleCompany('companyAdmin', 3).ok).toBe(false);
    expect(validateRoleCompany('', 3).ok).toBe(false);
    expect(validateRoleCompany(undefined, 3).ok).toBe(false);
  });

  test('company_id 用字串 "3" 傳進來也算有值（HTTP body 不帶型別）', () => {
    expect(validateRoleCompany(ROLES.USER, '3').ok).toBe(true);
  });

  test('company_id 是 0 或空字串一律視為沒有（0 不是合法的 SERIAL id）', () => {
    expect(validateRoleCompany(ROLES.USER, 0).ok).toBe(false);
    expect(validateRoleCompany(ROLES.USER, '').ok).toBe(false);
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/tenant-access.test.js --runInBand 2>&1 | tail -20
```
Expected：FAIL，`Cannot find module '../lib/tenant-access'`。

- [ ] **Step 3：寫最小實作**

Create `app/server/lib/tenant-access.js`。

⚠ **本 Task 不要 `require('../db')`**：這四個匯出全是純函式，從不碰 DB，寫了就是一行證明無用的 import，審查一定會挑。Task 6 加第一支會查 DB 的函式時再加。

```javascript
// 租戶範圍判斷的唯一真相（規格 §5.2）。
// 為什麼公司管理員不重用 role='admin'：全平台至少 6 處散落的 role === 'admin' 檢查
//（auth.js、index.js×2、project-routes.js、token-report-routes.js、pipeline-routes.js），
// 漏改一處，客戶的公司管理員就在那裡變成平台管理員。用新值的話，
// 既有檢查天生把公司管理員擋在外面——漏改的結果是「少一個功能」而不是「客戶拿到平台權限」。
const ROLES = { PLATFORM_ADMIN: 'admin', COMPANY_ADMIN: 'company_admin', USER: 'user' };

// company_id 從 HTTP body 進來時可能是字串；0 與空字串不是合法的 SERIAL id。
const hasCompany = (companyId) =>
  companyId !== null && companyId !== undefined && companyId !== '' && Number(companyId) > 0;

// 角色 ↔ 公司的一致性（規格 §4.4）。純函式，所有建立／修改帳號的路徑都要先過它。
function validateRoleCompany(role, companyId) {
  if (role === ROLES.PLATFORM_ADMIN) {
    return hasCompany(companyId)
      ? { ok: false, error: '平台管理員不能屬於任何公司' }
      : { ok: true };
  }
  if (role === ROLES.COMPANY_ADMIN || role === ROLES.USER) {
    return hasCompany(companyId)
      ? { ok: true }
      : { ok: false, error: '公司管理員與一般使用者必須指定公司' };
  }
  return { ok: false, error: `未知的角色：${role}` };
}

module.exports = { ROLES, validateRoleCompany, hasCompany };
```

- [ ] **Step 4：跑測試確認它綠**

```bash
cd app && npx jest server/tests/tenant-access.test.js --runInBand 2>&1 | tail -20
```
Expected：7 passed。

- [ ] **Step 5：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-isolation
git add app/server/lib/tenant-access.js app/server/tests/tenant-access.test.js
git commit -m "[Tenant]: 公司管理員若重用 admin 這個角色值，任何一處漏改的權限檢查都會讓客戶變成平台管理員，改用第三個角色值並在寫入端把關"
```

---

## Task 3：一次性遷移腳本 `tools/migrate-tenants.js`

**Files:**
- Create: `tools/migrate-tenants.js`
- Test: `app/server/tests/migrate-tenants.test.js`

**Interfaces:**
- Consumes: Task 1 的 `companies`／`project_companies`／`users.company_id`
- Produces: `planTenantMigration(query) -> { internalCompany, usersToAssign[], projectsToBind[] }`、`applyTenantMigration(query, plan) -> { companyCreated, usersUpdated, projectsBound }`。兩支都從 `tools/migrate-tenants.js` 匯出，讓測試不必開子行程。

**為什麼要有這支：** 規格 §4.5——遷移之後「預設就是客戶什麼都看不到」。既有 9 個管理員留 NULL、6 個一般使用者掛內部公司、17 個專案各綁一筆內部公司且 `can_release=false`。**漏綁任何一個專案，內部人員就會看不到它**，所以腳本最後要自己比對「專案總數 == 內部公司綁定數」。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/migrate-tenants.test.js`：

```javascript
/**
 * migrate-tenants.test.js — 一次性遷移（規格 §4.5）
 *
 * 守的是「遷移完，現有的人看到的東西不變」：
 *  - 9 個 admin 留 NULL（他們本來就看全部）
 *  - 6 個 user 掛內部公司，而內部公司綁了全部專案 ⇒ 還是看得到全部
 *  - 每個專案都要綁到，漏一個就有人突然看不到某個專案
 * 以及「可以重跑」——遷移腳本最怕的是跑一半失敗之後不敢再跑。
 */
const { newDb } = require('pg-mem');
const { planTenantMigration, applyTenantMigration } = require('../../../tools/migrate-tenants');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('a1', 'x', '管理一', 'admin'), ('a2', 'x', '管理二', 'admin'), ('u1', 'x', '一般一', 'user'), ('u2', 'x', '一般二', 'user')"
  );
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('p1', '17'), ('p2', '17'), ('p3', '17')");
});

afterAll(() => dbModule._setPoolForTesting(null));

test('plan 列出要建的內部公司、要掛公司的帳號、要綁的專案（還沒寫任何東西）', async () => {
  const plan = await planTenantMigration(dbModule.query);
  expect(plan.internalCompany.exists).toBe(false);
  expect(plan.usersToAssign.map(u => u.username).sort()).toEqual(['u1', 'u2']);
  expect(plan.projectsToBind).toHaveLength(3);

  const { rows } = await dbModule.query('SELECT COUNT(*)::int n FROM companies');
  expect(rows[0].n).toBe(0);
});

test('apply 之後：內部公司存在且啟用、admin 仍是 NULL、user 掛上公司、專案全綁', async () => {
  const plan = await planTenantMigration(dbModule.query);
  const res = await applyTenantMigration(dbModule.query, plan);
  expect(res.companyCreated).toBe(true);
  expect(res.usersUpdated).toBe(2);
  expect(res.projectsBound).toBe(3);

  const { rows: [co] } = await dbModule.query("SELECT id, is_active, is_internal FROM companies WHERE name = '內部'");
  expect(co.is_active).toBe(true);
  expect(co.is_internal).toBe(true);

  const { rows: admins } = await dbModule.query("SELECT company_id FROM users WHERE role = 'admin'");
  expect(admins.every(r => r.company_id === null)).toBe(true);

  const { rows: users } = await dbModule.query("SELECT company_id FROM users WHERE role = 'user'");
  expect(users.every(r => r.company_id === co.id)).toBe(true);

  const { rows: [bind] } = await dbModule.query(
    'SELECT COUNT(*)::int n FROM project_companies WHERE company_id = $1', [co.id]
  );
  expect(bind.n).toBe(3);
});

test('綁定一律 can_release=false（內部公司不能按上正式，規格 §4.3）', async () => {
  const { rows } = await dbModule.query('SELECT can_release FROM project_companies');
  expect(rows.every(r => r.can_release === false)).toBe(true);
});

test('再跑一次不會重複建、不會報錯（跑一半失敗要敢重跑）', async () => {
  const plan = await planTenantMigration(dbModule.query);
  expect(plan.internalCompany.exists).toBe(true);
  expect(plan.usersToAssign).toHaveLength(0);
  expect(plan.projectsToBind).toHaveLength(0);

  const res = await applyTenantMigration(dbModule.query, plan);
  expect(res).toEqual({ companyCreated: false, usersUpdated: 0, projectsBound: 0 });

  const { rows } = await dbModule.query('SELECT COUNT(*)::int n FROM companies');
  expect(rows[0].n).toBe(1);
});

test('遷移後新增的專案會被下一次 plan 撿到（漏綁＝有人看不到那個專案）', async () => {
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('p4', '17')");
  const plan = await planTenantMigration(dbModule.query);
  expect(plan.projectsToBind.map(p => p.name)).toEqual(['p4']);
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/migrate-tenants.test.js --runInBand 2>&1 | tail -20
```
Expected：FAIL，`Cannot find module '../../../tools/migrate-tenants'`。

- [ ] **Step 3：寫最小實作**

Create `tools/migrate-tenants.js`：

```javascript
// 一次性遷移：把現況全部歸到一家「內部公司」名下（規格 §4.5）。
// 預設只列計畫不寫入，要加 --apply 才動 DB——比照 tools/copy-agent-sessions.js。
// 可重跑：每一步都先查現況再決定要不要寫，跑一半失敗可以直接再跑。
//
// 為什麼遷移之後現有的人看到的東西不變：
//   9 個平台管理員 company_id 留 NULL（本來就看全部）
//   6 個一般使用者掛內部公司，而內部公司綁了「全部」專案 ⇒ 還是看得到全部
// 反過來說，新客戶公司什麼都沒綁 ⇒ 預設什麼都看不到，不會因為遷移漏掉而外洩。

const INTERNAL_COMPANY_NAME = '內部';

async function planTenantMigration(query) {
  const { rows: coRows } = await query('SELECT id, is_active FROM companies WHERE name = $1', [INTERNAL_COMPANY_NAME]);
  const internalCompany = coRows[0]
    ? { exists: true, id: coRows[0].id, isActive: coRows[0].is_active }
    : { exists: false, id: null, isActive: false };

  // 非平台管理員且還沒掛公司的帳號。平台管理員（role='admin'）一律不動。
  const { rows: usersToAssign } = await query(
    "SELECT id, username, role FROM users WHERE role <> 'admin' AND company_id IS NULL ORDER BY id"
  );

  // 還沒綁到內部公司的專案。pg-mem 不支援相關子查詢，用 NOT IN；
  // 子查詢必須加 IS NOT NULL——真 PG 裡 NOT IN 清單含一個 NULL，整個條件恆為 UNKNOWN，查詢會靜默全失效。
  const { rows: projectsToBind } = internalCompany.exists
    ? await query(
        `SELECT id, name FROM projects
          WHERE id NOT IN (
            SELECT project_id FROM project_companies
             WHERE company_id = $1 AND project_id IS NOT NULL
          )
          ORDER BY id`,
        [internalCompany.id]
      )
    : await query('SELECT id, name FROM projects ORDER BY id');

  return { internalCompany, usersToAssign, projectsToBind };
}

async function applyTenantMigration(query, plan) {
  let companyId = plan.internalCompany.id;
  let companyCreated = false;

  if (!plan.internalCompany.exists) {
    // 這是全平台唯一寫 is_internal=true 的地方。使用期間留 NULL＝不限。
    const { rows } = await query(
      `INSERT INTO companies (name, is_active, is_internal, active_from, active_until)
       VALUES ($1, true, true, NULL, NULL) RETURNING id`,
      [INTERNAL_COMPANY_NAME]
    );
    companyId = rows[0].id;
    companyCreated = true;
  }

  let usersUpdated = 0;
  for (const u of plan.usersToAssign) {
    await query('UPDATE users SET company_id = $1 WHERE id = $2 AND company_id IS NULL', [companyId, u.id]);
    usersUpdated++;
  }

  let projectsBound = 0;
  for (const p of plan.projectsToBind) {
    // can_release 走欄位預設 false：內部公司的綁定一律不勾（規格 §4.3）
    await query(
      `INSERT INTO project_companies (project_id, company_id) VALUES ($1, $2)
       ON CONFLICT (project_id, company_id) DO NOTHING`,
      [p.id, companyId]
    );
    projectsBound++;
  }

  return { companyCreated, usersUpdated, projectsBound };
}

module.exports = { planTenantMigration, applyTenantMigration, INTERNAL_COMPANY_NAME };

// CLI
if (require.main === module) {
  (async () => {
    const { query } = require('../app/server/db');
    const apply = process.argv.includes('--apply');
    const plan = await planTenantMigration(query);

    console.log(`內部公司：${plan.internalCompany.exists ? `已存在 (id=${plan.internalCompany.id})` : '要新建'}`);
    console.log(`要掛公司的帳號：${plan.usersToAssign.length} 個`);
    for (const u of plan.usersToAssign) console.log(`  ${u.username} (${u.role})`);
    console.log(`要綁內部公司的專案：${plan.projectsToBind.length} 個`);
    for (const p of plan.projectsToBind) console.log(`  ${p.name}`);

    if (!apply) {
      console.log('（未加 --apply，沒有寫入任何東西）');
      process.exit(0);
    }

    const res = await applyTenantMigration(query, plan);
    console.log('結果：', res);

    // 自我驗收：漏綁任何一個專案，內部人員就會看不到它（規格 §4.5）
    const { rows: [chk] } = await query(
      `SELECT (SELECT COUNT(*)::int FROM projects) AS projects,
              (SELECT COUNT(*)::int FROM project_companies pc
                 JOIN companies c ON c.id = pc.company_id AND c.is_internal = true) AS bound`
    );
    console.log(`驗收：專案 ${chk.projects} 個、內部公司綁定 ${chk.bound} 筆`);
    if (chk.projects !== chk.bound) {
      console.error('❌ 數量對不上，內部人員會看不到某些專案——請查明原因再重跑');
      process.exit(1);
    }
    console.log('✅ 數量一致');
    process.exit(0);
  })().catch(err => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4：跑測試確認它綠**

```bash
cd app && npx jest server/tests/migrate-tenants.test.js --runInBand 2>&1 | tail -20
```
Expected：5 passed。

- [ ] **Step 5：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-isolation
git add tools/migrate-tenants.js app/server/tests/migrate-tenants.test.js
git commit -m "[Tenant]: 遷移若漏綁任何一個專案，內部人員就會突然看不到它，遷移腳本改成可重跑並自己比對專案數與綁定數"
```

---

## Task 4：`verifyToken` 一次載入 `req.actor`

**Files:**
- Modify: `app/server/auth.js`（`verifyToken` 內的 `SELECT role FROM users` 那一段；`GET /api/auth/me` 的回傳）
- Test: `app/server/tests/tenant-actor.test.js`（新）

**Interfaces:**
- Consumes: Task 1 的 `users.company_id`、`companies`
- Produces:
  ```
  req.actor = { userId, role, companyId, isPlatformAdmin, isInternal, isCompanyAdmin, companyUsable }
  ```
  `req.isAdmin` 與 `req.role` **語意不變**（`req.isAdmin === (role === 'admin')`），既有 6 處散落檢查照舊生效。
  `GET /api/auth/me` 回傳多三個欄位：`company_id`、`company_name`、`company_usable`。

**⚠ 這個 Task 最容易做錯的地方：** `companyUsable` 只有在「這個人**有**公司、而那家公司停用或不在使用期間」時才是 `false`。**沒有公司（`company_id IS NULL`）一律算可用**——否則合併之後、遷移腳本跑之前，現有 6 個一般使用者（此時 `company_id` 還是 NULL）會全部被鎖在門外。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/tenant-actor.test.js`：

```javascript
/**
 * tenant-actor.test.js — 每個請求一進來就知道「你是誰、屬於哪家公司、那家能不能用」（規格 §5.1）
 *
 * 兩個最容易做錯、做錯就出事的點：
 *  1. req.isAdmin 語意不能變。全平台至少 6 處自己查 role === 'admin'，
 *     verifyToken 改寫時若順手把公司管理員也算進 isAdmin，客戶就拿到平台權限。
 *  2. 沒有公司的人一律算可用。合併之後、遷移腳本跑之前，現有 6 個一般使用者
 *     company_id 還是 NULL；把「沒有公司」當成不可用，這 6 個人會全部被鎖在門外。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let app, dbModule, adminToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  const res = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '管理員' });
  adminToken = res.body.token;
});

afterAll(() => dbModule._setPoolForTesting(null));

// 直接建帳號 + 登入拿 token（rules/testing 22：走真實授權路徑，不用私有 signer）
const makeUser = async (username, role, companyId) => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password123', 10);
  await dbModule.query(
    'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1, $2, $3, $4, $5)',
    [username, hash, username, role, companyId]
  );
  const res = await request(app).post('/api/auth/login').send({ username, password: 'password123' });
  return res.body.token;
};

const makeCompany = async (name, opts = {}) => {
  const { rows } = await dbModule.query(
    `INSERT INTO companies (name, is_active, is_internal, active_from, active_until)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, opts.isActive !== false, !!opts.isInternal, opts.activeFrom || null, opts.activeUntil || null]
  );
  return rows[0].id;
};

test('平台管理員：isAdmin 為 true、沒有公司、可用', async () => {
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.role).toBe('admin');
  expect(res.body.company_id).toBeNull();
  expect(res.body.company_usable).toBe(true);
});

test('公司管理員不是平台管理員（isAdmin 語意不能被改寫）', async () => {
  const cid = await makeCompany('甲公司');
  const token = await makeUser('ca1', 'company_admin', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.role).toBe('company_admin');
  expect(res.body.company_id).toBe(cid);
  expect(res.body.company_name).toBe('甲公司');
  expect(res.body.company_usable).toBe(true);
});

test('還沒掛公司的一般使用者仍然可用（遷移跑之前不能把人鎖在門外）', async () => {
  const token = await makeUser('legacy1', 'user', null);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.company_id).toBeNull();
  expect(res.body.company_usable).toBe(true);
});

test('公司被停用 → company_usable 是 false', async () => {
  const cid = await makeCompany('停用公司', { isActive: false });
  const token = await makeUser('off1', 'user', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.company_usable).toBe(false);
});

test('使用期間已過 → company_usable 是 false', async () => {
  const cid = await makeCompany('過期公司', { activeUntil: '2020-01-01T00:00:00Z' });
  const token = await makeUser('expired1', 'user', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.body.company_usable).toBe(false);
});

test('使用期間還沒開始 → company_usable 是 false', async () => {
  const cid = await makeCompany('未開始公司', { activeFrom: '2999-01-01T00:00:00Z' });
  const token = await makeUser('future1', 'user', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.body.company_usable).toBe(false);
});

test('使用期間兩端都是 NULL＝不限，算可用', async () => {
  const cid = await makeCompany('不限期間公司');
  const token = await makeUser('unlimited1', 'user', cid);
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  expect(res.body.company_usable).toBe(true);
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/tenant-actor.test.js --runInBand 2>&1 | tail -25
```
Expected：FAIL，`company_usable` 是 `undefined`。

- [ ] **Step 3：改 `auth.js` 的 `verifyToken`**

把 `verifyToken` 內那段 `SELECT role FROM users WHERE id = $1` 換掉：

```javascript
  try {
    // 租戶隔離（規格 §5.1）：一次把身分與公司狀態撈齊，後面的路由不必各自再查一次。
    // LEFT JOIN 而不是 JOIN——平台管理員沒有公司，遷移跑完之前一般使用者也還沒有。
    const { rows } = await query(
      `SELECT u.role, u.company_id, c.name AS company_name, c.is_active, c.is_internal,
              c.active_from, c.active_until
         FROM users u
         LEFT JOIN companies c ON c.id = u.company_id
        WHERE u.id = $1`,
      [payload.userId]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid token' });
    const r = rows[0];
    req.role = r.role;
    // 語意不變：全平台至少 6 處自己查 role === 'admin'，這裡改了就會全面走樣
    req.isAdmin = r.role === 'admin';
    req.actor = buildActor(payload.userId, r);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
```

在 `auth.js` 的模組層（`verifyToken` 上方）加這支純函式：

```javascript
// 由 verifyToken 撈到的那一列算出 actor（規格 §5.1）。抽成純函式是為了能單獨測期間判斷。
// companyUsable 的判斷只在「有公司」時才可能是 false——沒有公司一律算可用。
// 把「沒有公司」當成不可用的話，合併之後、tools/migrate-tenants.js 跑之前，
// 現有 6 個一般使用者（company_id 還是 NULL）會全部被 403 鎖在門外。
function buildActor(userId, row, now = new Date()) {
  const companyId = row.company_id ?? null;
  let companyUsable = true;
  if (companyId !== null) {
    const from = row.active_from ? new Date(row.active_from) : null;
    const until = row.active_until ? new Date(row.active_until) : null;
    companyUsable = row.is_active === true
      && (from === null || now >= from)
      && (until === null || now <= until);
  }
  return {
    userId,
    role: row.role,
    companyId,
    companyName: row.company_name ?? null,
    isPlatformAdmin: row.role === 'admin',
    isCompanyAdmin: row.role === 'company_admin',
    isInternal: row.is_internal === true,
    companyUsable,
  };
}
```

- [ ] **Step 4：改 `GET /api/auth/me` 的回傳**

把該端點的 `res.json(...)` 那一行改成：

```javascript
      // 前端要靠這三個欄位決定顯示什麼（規格 §5.5），以及公司停用時顯示原因
      res.json({
        ...rows[0],
        odoo_settings: redactSettings(rows[0].odoo_settings),
        company_id: req.actor.companyId,
        company_name: req.actor.companyName,
        company_usable: req.actor.companyUsable,
      });
```

- [ ] **Step 5：把 `buildActor` 匯出**（Step 3 的純函式要能被測到；`auth.js` 底部的 `module.exports` 加一個 key）

`auth.js:211` 現行是 `module.exports = { verifyToken, registerRoutes };`，改成：

```javascript
module.exports = { verifyToken, registerRoutes, buildActor };
```

- [ ] **Step 6：跑測試確認它綠**

```bash
cd app && npx jest server/tests/tenant-actor.test.js --runInBand 2>&1 | tail -25
```
Expected：7 passed。

- [ ] **Step 7：全跑**

```bash
cd app && npm run test:quiet 2>&1 | tail -5
```
Expected：`0 failed`。`verifyToken` 是全平台最熱的一段，這一步紅了幾乎一定是自己造成的。

- [ ] **Step 8：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-isolation
git add app/server/auth.js app/server/tests/tenant-actor.test.js
git commit -m "[Tenant]: 每支路由各自查一次身分會有人漏查，改成進門時一次載齊「你是誰、哪家公司、那家能不能用」"
```

---

## Task 5：公司不可用 → 全域 403 閘門

**Files:**
- Modify: `app/server/index.js`（緊接在既有「未核准閘門」之後加一個同形狀的閘門）
- Test: `app/server/tests/tenant-actor.test.js`（Task 4 那支，補一段）

**Interfaces:**
- Consumes: Task 1 的 `companies` 表（**不是** Task 4 的 `req.actor`——見下方 ⚠，這個閘門跑在 `verifyToken` 之前，那時 `req.actor` 還不存在）

**為什麼要全域擋而不是逐支路由擋：** 規格 §7——公司停用或到期時，客戶的每一支 API 都要 403。逐支加檢查一定會漏，而漏掉的那一支就是客戶停繳之後還能用的那一支。

**放行清單**：`GET /api/auth/me` 必須放行，否則前端拿不到「為什麼不能用」，畫面會變成一片空白而不是一句說明（登出是前端丟掉 token，不經後端）。

⚠ 既有的未核准閘門是自己 `jwt.verify` 再查 DB 的（`index.js:78` 起），它跑在 `verifyToken` **之前**，所以那裡拿不到 `req.actor`。本閘門照同樣形狀自己查一次，不要試圖共用 `req.actor`。

- [ ] **Step 1：寫失敗的測試**（append 到 `tenant-actor.test.js` 末尾）

```javascript
describe('公司不可用時的全域閘門（規格 §7）', () => {
  let offToken;

  beforeAll(async () => {
    const cid = await makeCompany('已停用客戶', { isActive: false });
    offToken = await makeUser('blocked1', 'user', cid);
  });

  test('工作台 API 一律 403，並說明原因', async () => {
    const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${offToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('停用');
    expect(res.body.companyUnusable).toBe(true);
  });

  test('GET /api/auth/me 仍然通（前端要顯示原因，不能變成白畫面）', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${offToken}`);
    expect(res.status).toBe(200);
    expect(res.body.company_usable).toBe(false);
  });

  test('公司正常的人不受影響', async () => {
    const cid = await makeCompany('正常客戶');
    const okToken = await makeUser('normal1', 'user', cid);
    const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${okToken}`);
    expect(res.status).toBe(200);
  });

  test('還沒掛公司的舊帳號不受影響（遷移跑之前）', async () => {
    const token = await makeUser('legacy2', 'user', null);
    const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  test('平台管理員不受影響', async () => {
    const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/tenant-actor.test.js --runInBand 2>&1 | tail -25
```
Expected：第一支 FAIL（拿到 200 而不是 403）。

- [ ] **Step 3：在 `index.js` 加閘門**

緊接在既有未核准閘門的那個 `{ ... }` 區塊之後，加一個同形狀的：

```javascript
  // 公司不可用閘門（規格 §7）：公司停用或不在使用期間 ⇒ 所有工作台 API 403。
  // 為什麼全域擋而不是逐支路由擋：逐支一定會漏，而漏掉的那一支就是客戶停繳之後還能用的那一支。
  // 只放行 GET /api/auth/me——前端要靠它顯示「為什麼不能用」，擋掉會變成一片空白而不是一句說明。
  // 形狀照抄上面的未核准閘門（自己 jwt.verify 再查 DB）：這一段跑在 verifyToken 之前，拿不到 req.actor。
  {
    const jwt = require('jsonwebtoken');
    const { query } = require('./db');
    app.use('/api', async (req, res, next) => {
      if (req.method === 'GET' && req.path === '/auth/me') return next();
      if (req.path.startsWith('/auth/') || req.path.startsWith('/setup/')) return next();
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) return next();
      let userId;
      try { userId = jwt.verify(header.slice(7), process.env.JWT_SECRET).userId; } catch { return next(); }
      try {
        const { rows } = await query(
          `SELECT c.is_active, c.active_from, c.active_until
             FROM users u JOIN companies c ON c.id = u.company_id
            WHERE u.id = $1`,
          [userId]
        );
        // JOIN 沒撈到 ⇒ 這個人沒有公司（平台管理員，或遷移還沒跑的舊帳號）⇒ 放行
        if (!rows[0]) return next();
        const r = rows[0];
        const now = new Date();
        const usable = r.is_active === true
          && (!r.active_from || now >= new Date(r.active_from))
          && (!r.active_until || now <= new Date(r.active_until));
        if (!usable) {
          return res.status(403).json({ error: '公司帳號已停用或不在使用期間', companyUnusable: true });
        }
      } catch {
        // 查不動 DB 時放行，交給後面的 verifyToken 決定——這一關是附加防線，
        // 不該因為 DB 抖一下就把全部人擋在外面
      }
      next();
    });
  }
```

- [ ] **Step 4：跑測試確認它綠**

```bash
cd app && npx jest server/tests/tenant-actor.test.js --runInBand 2>&1 | tail -25
```
Expected：12 passed（Task 4 的 7 支 ＋ 本 Task 的 5 支）。

- [ ] **Step 5：全跑**

```bash
cd app && npm run test:quiet 2>&1 | tail -5
```
Expected：`0 failed`。這一步加了一個套在**全部** `/api` 上的 middleware，是本計畫風險最高的改動；任何紅燈都先假設是它造成的。

- [ ] **Step 6：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-isolation
git add app/server/index.js app/server/tests/tenant-actor.test.js
git commit -m "[Tenant]: 公司停繳或到期時逐支路由擋一定會漏，漏掉的那支就是停繳後還能用的那支，改成全域擋"
```

---

## Task 6：`lib/tenant-access.js` 的範圍函式

**Files:**
- Modify: `app/server/lib/tenant-access.js`（Task 2 建的檔，補四支函式）
- Test: `app/server/tests/tenant-access.test.js`（Task 2 建的檔，補一段）

**Interfaces:**
- Consumes: Task 1 的 `project_companies`；Task 4 的 `req.actor`
- Produces:
  - `canSeeProject(actor, projectId) -> Promise<boolean>`
  - `loadProjectForActor(projectId, req, columns = '*') -> Promise<row|null>`
  - `canReleaseProject(actor, projectId) -> Promise<boolean>`
  - `canManageCompanyUsers(actor, companyId) -> boolean`

**本 Task 只建函式、不接到任何路由上。** 接路由是第 2 部——這樣本部合併後行為零改變，而第 2 部可以一支一支接、一支一支審。

**兩個規格要點不能走樣：**
- **內部公司不特判**（規格 §5.2）。它看得到全部專案，是因為遷移把全部專案都綁給它了，不是因為程式對它開後門。哪天有人解掉某個綁定，它就該看不到那一個——這正是我們要的行為。
- **看不到要回 404 不是 403**（規格 §5.2）。403 等於告訴對方「這個 id 存在，只是你不能看」，那本身就是資料外洩。

- [ ] **Step 1：寫失敗的測試**（append 到 `tenant-access.test.js` 末尾）

```javascript
const { newDb } = require('pg-mem');
const { canSeeProject, loadProjectForActor, canReleaseProject, canManageCompanyUsers } = require('../lib/tenant-access');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

describe('範圍函式（規格 §5.2）', () => {
  let dbModule, internalId, aId, bId, pShared, pAOnly, pInternalOnly;

  beforeAll(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    dbModule = require('../db');
    dbModule._setPoolForTesting(new Pool());
    await dbModule.migrate();

    const mkCo = async (name, isInternal) => {
      const { rows } = await dbModule.query(
        'INSERT INTO companies (name, is_active, is_internal) VALUES ($1, true, $2) RETURNING id',
        [name, isInternal]
      );
      return rows[0].id;
    };
    const mkPr = async (name) => {
      const { rows } = await dbModule.query(
        "INSERT INTO projects (name, odoo_version) VALUES ($1, '17') RETURNING id", [name]
      );
      return rows[0].id;
    };
    const bind = (p, c, canRelease = false) => dbModule.query(
      'INSERT INTO project_companies (project_id, company_id, can_release) VALUES ($1, $2, $3)', [p, c, canRelease]
    );

    internalId = await mkCo('內部', true);
    aId = await mkCo('甲公司', false);
    bId = await mkCo('乙公司', false);

    pShared = await mkPr('共用專案');       // 甲、乙、內部都綁
    pAOnly = await mkPr('甲專屬專案');       // 只有甲 + 內部
    pInternalOnly = await mkPr('內部專案');  // 只有內部

    await bind(pShared, internalId);
    await bind(pShared, aId, true);   // 甲可以按上正式
    await bind(pShared, bId, false);  // 乙不行
    await bind(pAOnly, internalId);
    await bind(pAOnly, aId, false);
    await bind(pInternalOnly, internalId);
  });

  afterAll(() => dbModule._setPoolForTesting(null));

  const actor = (over) => ({
    userId: 1, role: 'user', companyId: null,
    isPlatformAdmin: false, isCompanyAdmin: false, isInternal: false, companyUsable: true, ...over
  });

  test('平台管理員看得到全部專案', async () => {
    const a = actor({ role: 'admin', isPlatformAdmin: true });
    expect(await canSeeProject(a, pShared)).toBe(true);
    expect(await canSeeProject(a, pInternalOnly)).toBe(true);
  });

  test('甲公司看得到綁給它的，看不到沒綁的', async () => {
    const a = actor({ companyId: aId });
    expect(await canSeeProject(a, pShared)).toBe(true);
    expect(await canSeeProject(a, pAOnly)).toBe(true);
    expect(await canSeeProject(a, pInternalOnly)).toBe(false);
  });

  test('乙公司只看得到共用那一個', async () => {
    const a = actor({ companyId: bId });
    expect(await canSeeProject(a, pShared)).toBe(true);
    expect(await canSeeProject(a, pAOnly)).toBe(false);
  });

  test('內部公司不特判：它看得到全部是因為全部都綁了，不是因為程式開後門', async () => {
    const a = actor({ companyId: internalId, isInternal: true });
    expect(await canSeeProject(a, pInternalOnly)).toBe(true);
    // 解掉一個綁定，它就該看不到那一個
    await dbModule.query('DELETE FROM project_companies WHERE project_id = $1 AND company_id = $2',
      [pInternalOnly, internalId]);
    expect(await canSeeProject(a, pInternalOnly)).toBe(false);
    await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1, $2)',
      [pInternalOnly, internalId]);
  });

  test('沒有公司又不是平台管理員 → 什麼都看不到', async () => {
    expect(await canSeeProject(actor({ companyId: null }), pShared)).toBe(false);
  });

  test('loadProjectForActor 看得到回列、看不到回 null（路由要據此回 404，不是 403）', async () => {
    const req = { actor: actor({ companyId: bId }) };
    const ok = await loadProjectForActor(pShared, req, 'id, name');
    expect(ok.name).toBe('共用專案');
    expect(await loadProjectForActor(pAOnly, req, 'id, name')).toBeNull();
  });

  test('canReleaseProject：公司管理員 + 該綁定勾了才行', async () => {
    const ca = (companyId) => actor({ role: 'company_admin', isCompanyAdmin: true, companyId });
    expect(await canReleaseProject(ca(aId), pShared)).toBe(true);   // 甲的綁定勾了
    expect(await canReleaseProject(ca(bId), pShared)).toBe(false);  // 乙的沒勾
    expect(await canReleaseProject(ca(aId), pAOnly)).toBe(false);   // 甲對這個沒勾
  });

  test('canReleaseProject：一般使用者一律不行，即使綁定勾了', async () => {
    expect(await canReleaseProject(actor({ companyId: aId }), pShared)).toBe(false);
  });

  test('canReleaseProject：平台管理員一律可以', async () => {
    expect(await canReleaseProject(actor({ role: 'admin', isPlatformAdmin: true }), pInternalOnly)).toBe(true);
  });

  test('canManageCompanyUsers：平台管理員管全部，公司管理員只管自己公司', async () => {
    expect(canManageCompanyUsers(actor({ role: 'admin', isPlatformAdmin: true }), bId)).toBe(true);
    const ca = actor({ role: 'company_admin', isCompanyAdmin: true, companyId: aId });
    expect(canManageCompanyUsers(ca, aId)).toBe(true);
    expect(canManageCompanyUsers(ca, bId)).toBe(false);
    expect(canManageCompanyUsers(actor({ companyId: aId }), aId)).toBe(false); // 一般使用者不行
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/tenant-access.test.js --runInBand 2>&1 | tail -25
```
Expected：FAIL，`canSeeProject is not a function`。

- [ ] **Step 3：補實作到 `lib/tenant-access.js`**

先在檔案最上方加上 DB 存取（Task 2 刻意沒加，因為那時還沒有任何函式查 DB）：

```javascript
const { query } = require('../db');
```

然後在 `module.exports` 之前加：

```javascript
// 這家公司綁了這個專案嗎（規格 §5.2）。
// 內部公司刻意不特判——它看得到全部專案是因為遷移把全部都綁給它了，不是因為程式開後門。
// 解掉某個綁定，它就該看不到那一個，這正是我們要的行為。
async function canSeeProject(actor, projectId) {
  if (!actor) return false;
  if (actor.isPlatformAdmin) return true;
  if (!hasCompany(actor.companyId)) return false;
  const { rows } = await query(
    'SELECT 1 FROM project_companies WHERE project_id = $1 AND company_id = $2',
    [projectId, actor.companyId]
  );
  return rows.length > 0;
}

// 比照 lib/task-access.js 的 loadTaskForActor。
// 看不到時回 null，路由要據此回 404——回 403 等於告訴對方「這個 id 存在，只是你不能看」，
// 那本身就是資料外洩。
async function loadProjectForActor(projectId, req, columns = '*') {
  if (!await canSeeProject(req.actor, projectId)) return null;
  const { rows } = await query(`SELECT ${columns} FROM projects WHERE id = $1`, [projectId]);
  return rows[0] || null;
}

// 能不能對這個專案按「上正式」（規格 §5.2、§4.3）。
// 一般使用者一律不行：上正式是專案層批次，會帶上同事已核准的任務，必須有人負責。
async function canReleaseProject(actor, projectId) {
  if (!actor) return false;
  if (actor.isPlatformAdmin) return true;
  if (!actor.isCompanyAdmin || !hasCompany(actor.companyId)) return false;
  const { rows } = await query(
    'SELECT can_release FROM project_companies WHERE project_id = $1 AND company_id = $2',
    [projectId, actor.companyId]
  );
  return rows[0]?.can_release === true;
}

// 能不能管這家公司的帳號（規格 §5.2）。純同步——只看身分，不必查 DB。
function canManageCompanyUsers(actor, companyId) {
  if (!actor) return false;
  if (actor.isPlatformAdmin) return true;
  return actor.isCompanyAdmin
    && hasCompany(actor.companyId)
    && Number(actor.companyId) === Number(companyId);
}
```

把 `module.exports` 改成：

```javascript
module.exports = {
  ROLES, validateRoleCompany, hasCompany,
  canSeeProject, loadProjectForActor, canReleaseProject, canManageCompanyUsers,
};
```

- [ ] **Step 4：跑測試確認它綠**

```bash
cd app && npx jest server/tests/tenant-access.test.js --runInBand 2>&1 | tail -25
```
Expected：17 passed（Task 2 的 7 支 ＋ 本 Task 的 10 支）。

- [ ] **Step 5：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-isolation
git add app/server/lib/tenant-access.js app/server/tests/tenant-access.test.js
git commit -m "[Tenant]: 每支路由各自寫一套「看不看得到」的判斷會各自長歪，收斂成一個檔案回答全部問題"
```

---

## Task 7：`loadTaskForActor` 加上專案可見性

**Files:**
- Modify: `app/server/lib/task-access.js`
- Test: `app/server/tests/task-access-tenant.test.js`（新）

**Interfaces:**
- Consumes: Task 6 的 `canSeeProject`
- Produces: `loadTaskForActor` 行為不變的簽章，但多一道「任務所屬專案必須看得到」

**為什麼這一支可以現在就接上（其他路由要等第 2 部）：** 遷移之後每個專案都綁了內部公司、每個一般使用者都屬於內部公司 ⇒ 現有的人一個都不會被這道新檢查擋到。而它是**任務權限的單點**（`pipeline-routes.js` 與 `tasks-routes.js` 的關卡端點全部經過它），接上之後整條 pipeline 自動有了租戶邊界。

⚠ **不要改成把專案條件塞進 SQL**。`tasks.project_id` 可以是 NULL（非專案任務），塞進 `JOIN` 會讓那些任務全部查不到。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/task-access-tenant.test.js`：

```javascript
/**
 * task-access-tenant.test.js — 任務權限單點加上租戶邊界（規格 §5.2）
 *
 * loadTaskForActor 是 pipeline-routes 與 tasks-routes 全部關卡端點的共同入口，
 * 所以這一支的正確性等於整條 pipeline 的租戶邊界。
 * 特別守住兩件事：
 *  1. project_id 是 NULL 的非專案任務不能被新檢查誤殺
 *  2. admin 照舊看得到全部（他本來就是這樣，改壞了整個平台管理功能都會斷）
 */
const { newDb } = require('pg-mem');
const { loadTaskForActor } = require('../lib/task-access');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let dbModule, aId, bId, pA, taskInA, taskNoProject, userA, userB;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

  aId = (await one('INSERT INTO companies (name, is_active) VALUES ($1, true) RETURNING id', ['甲公司'])).id;
  bId = (await one('INSERT INTO companies (name, is_active) VALUES ($1, true) RETURNING id', ['乙公司'])).id;
  pA = (await one("INSERT INTO projects (name, odoo_version) VALUES ('甲專案', '17') RETURNING id")).id;
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1, $2)', [pA, aId]);

  userA = (await one(
    "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('ua','x','甲員','user',$1) RETURNING id", [aId]
  )).id;
  userB = (await one(
    "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('ub','x','乙員','user',$1) RETURNING id", [bId]
  )).id;

  taskInA = (await one(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'t1','manual','甲的任務','new',$2) RETURNING id",
    [userA, pA]
  )).id;
  taskNoProject = (await one(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1,'t2','manual','沒有專案的任務','new') RETURNING id",
    [userA]
  )).id;
});

afterAll(() => dbModule._setPoolForTesting(null));

const req = (userId, companyId, over = {}) => ({
  userId, isAdmin: false,
  actor: { userId, role: 'user', companyId, isPlatformAdmin: false, isCompanyAdmin: false, isInternal: false, companyUsable: true, ...over },
});

test('本人 + 專案看得到 → 拿得到任務', async () => {
  expect(await loadTaskForActor(taskInA, req(userA, aId), 'id, user_id, project_id')).not.toBeNull();
});

test('別家公司的人即使硬帶任務 id 也拿不到', async () => {
  expect(await loadTaskForActor(taskInA, req(userB, bId), 'id, user_id, project_id')).toBeNull();
});

test('本人但公司沒綁那個專案 → 拿不到（公司綁定被解除後立刻生效）', async () => {
  await dbModule.query('DELETE FROM project_companies WHERE project_id = $1 AND company_id = $2', [pA, aId]);
  expect(await loadTaskForActor(taskInA, req(userA, aId), 'id, user_id, project_id')).toBeNull();
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1, $2)', [pA, aId]);
});

test('project_id 是 NULL 的非專案任務不能被誤殺', async () => {
  expect(await loadTaskForActor(taskNoProject, req(userA, aId), 'id, user_id, project_id')).not.toBeNull();
});

test('平台管理員照舊看得到全部（含別人的、含沒綁公司的專案）', async () => {
  const adminReq = {
    userId: 999, isAdmin: true,
    actor: { userId: 999, role: 'admin', companyId: null, isPlatformAdmin: true, isCompanyAdmin: false, isInternal: false, companyUsable: true },
  };
  expect(await loadTaskForActor(taskInA, adminReq, 'id, user_id, project_id')).not.toBeNull();
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/task-access-tenant.test.js --runInBand 2>&1 | tail -25
```
Expected：「別家公司的人即使硬帶任務 id 也拿不到」FAIL（目前回的是 null 還是列？現行 SQL 已經有 `user_id = $2 OR isAdmin`，所以 userB 本來就拿不到 userA 的任務——**這一支會假綠**）。⚠ **真正會紅的是第三支**（本人但公司沒綁那個專案）。若跑出來第三支綠，表示實作已存在或測試寫錯，停下來查清楚再往下。

- [ ] **Step 3：改 `lib/task-access.js`**

```javascript
const { query } = require('../db');
const { canSeeProject } = require('./tenant-access');

// 回傳指定任務列，僅當請求者是該任務 owner 或 admin，且（若任務屬於某專案）看得到那個專案。
// columns 預設 '*'；呼叫端若指定欄位清單，務必包含 user_id（觸發 pipeline 用）。
//
// 租戶邊界為什麼加在這裡（規格 §5.2）：這支是 pipeline-routes 與 tasks-routes
// 全部關卡端點的共同入口，接在這裡等於整條 pipeline 一次有了邊界。
// 專案條件刻意不塞進 SQL——tasks.project_id 可以是 NULL（非專案任務），
// 塞進 JOIN 會讓那些任務全部查不到。
async function loadTaskForActor(taskId, req, columns = '*') {
  // 多撈 project_id 才判斷得了；呼叫端常常只挑幾欄（例 'id, status'）。
  // 已經帶了就不要再加——重複欄位在真 PG 合法但 pg-mem 會出狀況。
  const hasProjectId = /(^|[\s,])project_id([\s,]|$)/.test(columns);
  const cols = columns === '*' || hasProjectId ? columns : `${columns}, project_id`;
  const { rows } = await query(
    `SELECT ${cols} FROM tasks WHERE id = $1 AND (user_id = $2 OR $3 = true)`,
    [taskId, req.userId, !!req.isAdmin]
  );
  const row = rows[0];
  if (!row) return null;
  if (row.project_id && !await canSeeProject(req.actor, row.project_id)) return null;
  return row;
}

module.exports = { loadTaskForActor };
```

⚠ 多撈一欄是安全的——多回一個欄位不會讓任何既有呼叫端出錯。但**不可以無條件加**：呼叫端本來就帶 `project_id` 時會變成重複欄位，真 PG 合法、pg-mem 會出狀況，所以上面先用 regex 判一次。

- [ ] **Step 4：跑測試確認它綠**

```bash
cd app && npx jest server/tests/task-access-tenant.test.js --runInBand 2>&1 | tail -25
```
Expected：5 passed。

- [ ] **Step 5：全跑**

```bash
cd app && npm run test:quiet 2>&1 | tail -5
```
Expected：`0 failed`。`loadTaskForActor` 有大量既有測試會經過它，**這一步紅了幾乎一定是 `req.actor` 在某些既有測試裡是 `undefined`**。`canSeeProject(undefined, …)` 回 `false` ⇒ 那些測試的任務會突然拿不到。修法是**在 `canSeeProject` 保留 `if (!actor) return false`，並在 `loadTaskForActor` 改成「沒有 actor 時沿用舊行為」**：

```javascript
  // req.actor 由 verifyToken 掛上。少數不經 verifyToken 的內部呼叫（cron、pipeline）
  // 沒有 actor——那些呼叫本來就是平台自己在跑，不套租戶邊界。
  if (row.project_id && req.actor && !await canSeeProject(req.actor, row.project_id)) return null;
```
⚠ 這是**刻意的例外，不是偷懶**：cron 與 pipeline 自動推進不代表任何人，套租戶邊界會讓自動推進全部停擺。若全跑綠、不需要這個例外，就**不要加**——加了等於開一個「只要不帶 actor 就繞過」的洞。先跑再決定。

- [ ] **Step 6：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-isolation
git add app/server/lib/task-access.js app/server/tests/task-access-tenant.test.js
git commit -m "[Tenant]: 任務權限只看「本人或管理員」，同一個人換公司後仍拿得到舊公司的任務，補上專案可見性"
```

---

## Task 8：GIT 憑證改為「個人 → 公司」退回

**Files:**
- Modify: `app/server/lib/git-identity.js`（`buildGitEnv`）
- Modify: `app/server/project-routes.js`（約 :930 那段「只用本人 PAT、不退機器憑證」的擋法與註解）
- Test: `app/server/tests/git-identity-company.test.js`（新）

**Interfaces:**
- Consumes: Task 1 的 `companies.git_pat_enc` 等欄位
- Produces: `buildGitEnv(userId)` 回傳值多一個 `source: 'personal' | 'company'`；其餘 key 不變，15 個呼叫端不必改

**規格 §6 的退回順序**（不可調換）：
1. 該使用者有個人 PAT → 用個人的（**行為與現在完全相同**）
2. 沒有，且屬於某家公司（含內部公司）→ 用該公司的 `git_pat_enc`
3. 沒有，且是平台管理員（無公司）→ **不退回**（09-14 裁決 P4）
4. 都沒有 → 維持丟 `NoGitCredentialError`

**為什麼 `source` 要回傳出去：** 推上去的 commit 看得出是誰推的。第 2 部會把它寫進時間軸。本部只負責回傳，不接時間軸。

**順帶解掉的舊問題：** 自動部署因為「系統觸發、找不到人的 PAT」而失敗（記憶 `deploy-fetch-missing-pat`）——只要那個人屬於某家公司且公司有設 PAT，就不會再失敗。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/git-identity-company.test.js`：

```javascript
/**
 * git-identity-company.test.js — GIT 憑證的「個人 → 公司」退回（規格 §6）
 *
 * 順序本身就是規格：個人優先是為了「推上去看得出是誰」，
 * 平台管理員刻意不退回（09-14 裁決 P4）是因為他沒有公司可退，
 * 而悄悄退到某家公司的憑證會讓 commit 掛上錯誤的身分。
 */
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let dbModule, buildGitEnv, NoGitCredentialError, encrypt;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ buildGitEnv, NoGitCredentialError } = require('../lib/git-identity'));
  ({ encrypt } = require('../lib/crypto'));

  const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

  const coId = (await one(
    `INSERT INTO companies (name, is_active, git_pat_enc, git_login, git_name, git_email)
     VALUES ('甲公司', true, $1, 'company-bot', '甲公司機器人', 'bot@jia.example') RETURNING id`,
    [encrypt('COMPANY_PAT')]
  )).id;
  const noPatCoId = (await one(
    "INSERT INTO companies (name, is_active) VALUES ('沒設PAT公司', true) RETURNING id"
  )).id;

  // 有個人 PAT、也屬於有 PAT 的公司
  await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, role, company_id, github_pat_enc, github_login, git_name, git_email)
     VALUES ('both','x','兩者都有','user',$1,$2,'me','我','me@example.com')`,
    [coId, encrypt('PERSONAL_PAT')]
  );
  // 沒個人 PAT、屬於有 PAT 的公司
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('onlyco','x','只有公司','user',$1)",
    [coId]
  );
  // 沒個人 PAT、公司也沒 PAT
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('neither','x','都沒有','user',$1)",
    [noPatCoId]
  );
  // 平台管理員：沒個人 PAT、沒公司
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('plat','x','平台管理員','admin')"
  );
});

afterAll(() => dbModule._setPoolForTesting(null));

const idOf = async (username) =>
  (await dbModule.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;

test('有個人 PAT → 用個人的，source=personal（與現行行為相同）', async () => {
  const env = await buildGitEnv(await idOf('both'));
  expect(env.GIT_PAT).toBe('PERSONAL_PAT');
  expect(env.GIT_AUTHOR_NAME).toBe('我');
  expect(env.source).toBe('personal');
});

test('沒個人 PAT 但公司有 → 退回公司的，source=company，身分掛公司', async () => {
  const env = await buildGitEnv(await idOf('onlyco'));
  expect(env.GIT_PAT).toBe('COMPANY_PAT');
  expect(env.GIT_AUTHOR_NAME).toBe('甲公司機器人');
  expect(env.GIT_AUTHOR_EMAIL).toBe('bot@jia.example');
  expect(env.source).toBe('company');
});

test('個人與公司都沒有 → 丟 NoGitCredentialError', async () => {
  await expect(buildGitEnv(await idOf('neither'))).rejects.toThrow(NoGitCredentialError);
});

test('平台管理員沒有公司可退，一律擋下（09-14 裁決 P4）', async () => {
  await expect(buildGitEnv(await idOf('plat'))).rejects.toThrow(NoGitCredentialError);
});

test('不存在的 user 一樣擋下', async () => {
  await expect(buildGitEnv(999999)).rejects.toThrow(NoGitCredentialError);
});

test('source 不可列舉：整包展開進子行程 env 時不會多出一個 source 變數', async () => {
  const env = await buildGitEnv(await idOf('both'));
  expect(env.source).toBe('personal');              // 讀得到
  expect(Object.keys(env)).not.toContain('source');  // 但展開拿不到
  expect({ ...env }.source).toBeUndefined();
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/git-identity-company.test.js --runInBand 2>&1 | tail -25
```
Expected：「退回公司的」那支 FAIL（丟 `NoGitCredentialError`）。

- [ ] **Step 3：改 `lib/git-identity.js` 的 `buildGitEnv`**

```javascript
// 解出某 user 的 git 注入 env。退回順序：個人 → 公司 →（平台管理員不退回）→ 丟例外（規格 §6）。
// 個人優先是為了「推上去看得出是誰」；平台管理員沒有公司可退，悄悄退到某家公司的憑證
// 會讓 commit 掛上錯誤的身分，所以 09-14 裁決是擋下、要他自己填個人 PAT。
// 回傳值多一個 source，讓呼叫端寫得出「這次是用誰的身分推的」。
async function buildGitEnv(userId) {
  const { rows } = await query(
    `SELECT u.github_pat_enc, u.github_login, u.git_name, u.git_email,
            c.git_pat_enc AS co_pat_enc, c.git_login AS co_login,
            c.git_name AS co_name, c.git_email AS co_email
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
      WHERE u.id = $1`,
    [userId]
  );
  const u = rows[0];
  if (!u) throw new NoGitCredentialError();

  let source, patEnc, login, name, email;
  if (u.github_pat_enc) {
    source = 'personal';
    patEnc = u.github_pat_enc; login = u.github_login; name = u.git_name; email = u.git_email;
  } else if (u.co_pat_enc) {
    source = 'company';
    patEnc = u.co_pat_enc; login = u.co_login; name = u.co_name; email = u.co_email;
  } else {
    throw new NoGitCredentialError();
  }

  const pat = decrypt(patEnc);
  const gitName = name || login || 'user';
  const gitEmail = email || `${login || 'user'}@users.noreply.github.com`;
  const out = hardenGitEnv({
      GIT_ASKPASS: askpassShimPath(),
      GIT_ASKPASS_NODE: process.execPath,
      GIT_PAT: pat,
      GIT_AUTHOR_NAME: gitName, GIT_AUTHOR_EMAIL: gitEmail,
      GIT_COMMITTER_NAME: gitName, GIT_COMMITTER_EMAIL: gitEmail,
      // 機器上設定的 credential.helper（如 Windows Credential Manager）會搶在 GIT_ASKPASS 前被 git 嘗試，
      // 導致仍以機器帳號認證、PAT 被靜默繞過。清空 helper 清單（GIT_CONFIG_* 等效 -c credential.helper=）
      // 讓 askpass 成為唯一來源；GIT_TERMINAL_PROMPT=0 讓壞/空 PAT 直接失敗，不會 headless 卡死等互動輸入。
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_TERMINAL_PROMPT: '0',
  });
  // source 刻意設成「不可列舉」：gitEnv 在 7 個地方被 { ...process.env, ...gitEnv } 整包
  // 展開丟進子行程（lib/deploy-run.js:218、lib/enterprise-sources.js:124、
  // pipeline/finding-fix.js:445/459/575、project-routes.js:148、pipeline/git.js:54）。
  // 若用普通屬性，git 會收到一個叫 source 的環境變數——無害但髒，而且以後有人加
  // 別的 metadata 時會一路帶進所有子行程。不可列舉讓展開拿不到它，gitEnv.source 照樣讀得到。
  Object.defineProperty(out, 'source', { value: source, enumerable: false });
  return out;
}
```

⚠ **這裡實測過的兩件事**（2026-09-18 查證，不要再自己推導）：
- `hardenGitEnv` 的實作是 `const out = { ...env }` 再加 `GIT_CONFIG_*`（`lib/git-hardening.js:8-20`），所以它回的是普通物件，可以直接 `defineProperty`。
- `buildGitEnv` 有 15 個呼叫點，其中 **7 個**會把回傳值整包展開進 `spawn` 的 `env`。這就是 `source` 必須不可列舉的原因。
- 測試裡驗 `env.source` 仍然讀得到（不可列舉不等於讀不到），但要另加一支驗「展開之後拿不到」。

- [ ] **Step 4：改 `project-routes.js` 的上正式擋法**

找到約 :930「只用操作者本人 GitHub PAT、沒設就擋、不退機器憑證」的那段註解與擋法，改成：

```javascript
        // GIT 憑證退回規則（09-11／09-14 裁決，規格 §6）：個人 → 公司 → 擋下。
        // 原本刻意「只用本人 PAT、不退機器憑證」是為了歸屬，但客戶不會每個人都有 PAT；
        // 改由 buildGitEnv 回傳的 source 記錄是用誰的身分推的，歸屬仍然看得出來。
```
把原本「沒有個人 PAT 就直接回錯」的判斷拿掉，改成讓 `buildGitEnv` 自己決定（它會在真的都沒有時丟 `NoGitCredentialError`，既有的 catch 會處理）。

⚠ **這一步不會改變現有人的行為**：9 個平台管理員沒有公司 ⇒ 照舊擋下；6 個一般使用者遷移後屬於內部公司，而內部公司的 `git_pat_enc` 初始是 NULL ⇒ 也照舊擋下。真正生效要等平台管理員替公司設了 PAT（那是第 2 部的公司管理頁）。

- [ ] **Step 5：跑測試確認它綠**

```bash
cd app && npx jest server/tests/git-identity-company.test.js --runInBand 2>&1 | tail -25
```
Expected：6 passed。

- [ ] **Step 6：全跑**

```bash
cd app && npm run test:quiet 2>&1 | tail -5
```
Expected：`0 failed`。`buildGitEnv` 有 15 個呼叫點，既有測試很可能有 mock 它的——紅了先看是不是 mock 的回傳值少了 `source`。

- [ ] **Step 7：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-isolation
git add app/server/lib/git-identity.js app/server/project-routes.js app/server/tests/git-identity-company.test.js
git commit -m "[Tenant]: 客戶不會每個人都有 GitHub PAT，沒有就完全動不了，改成退回用公司的憑證並記錄這次用了誰的身分"
```

---

## Task 9：整枝審查 → 合併 → 上線遷移

**Files:** 無新檔

- [ ] **Step 1：整枝自審**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-isolation
git fetch origin && git merge origin/master
cd app && npm run test:quiet 2>&1 | tail -5
```
Expected：合併乾淨、`0 failed`。**每天早上開工前都要做一次這個合併**（`.claude/rules/always.md` §3）——不然分支放久了，合併時要一次面對一週的衝突。

逐項自己對一次：

| 檢查 | 怎麼確認 |
|---|---|
| `req.isAdmin` 語意沒變 | `grep -rn "isAdmin" app/server --include=*.js \| grep -v tests` 逐一看，沒有任何一處把 `company_admin` 算進去 |
| 沒有任何路由的可見範圍被改到 | `git diff origin/master --stat` — 除了 `task-access.js` 之外，不該有任何 `*-routes.js` 的範圍查詢被改（`project-routes.js` 只改 GIT 那段） |
| `is_internal` 只有遷移腳本寫 true | `grep -rn "is_internal" app/server tools --include=*.js` — 除了讀取，只有 `tools/migrate-tenants.js` 寫 |
| 沒有寫死絕對路徑 | `git diff origin/master \| grep -nE "/home/\|C:\\\\"` 回空 |

- [ ] **Step 2：請使用者裁決後合併**

把下面這三件事講給使用者聽，**取得同意才合併**：
1. 這一批合併後，現有 9 個管理員與 6 個一般使用者**看到的東西完全一樣**；真正會讓那 6 個人失去工具的是第 2 部（R4：2b 跟 2a 一起上，上線前要先告知那 6 個人）。
2. 合併＋重啟之後**必須立刻跑遷移腳本**，中間這段空窗期一般使用者的 `company_id` 還是 NULL——本計畫刻意讓「沒有公司」算可用，所以空窗期沒有人會被鎖住，但也還沒有任何租戶邊界。
3. GIT 退回現在起生效，但**內部公司還沒有 PAT**，所以實際行為與現在相同。

- [ ] **Step 3：合併並推上去**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-isolation
git fetch origin && git merge origin/master   # 再同步一次
cd app && npm run test:quiet 2>&1 | tail -5   # 確認仍 0 failed
```
推送流程照 `pushRepo` skill（PAT／`DATABASE_URL`／`APP_SECRET` 的取法寫在那裡，不要自己重推導）。

- [ ] **Step 4：請使用者跑 `upgrade.sh` 重啟**

重啟時**不能有 Claude session 或 subagent 在跑**（會一起被砍）。重啟後 `db.js` 的 migrate 會自動建表與加欄位。

確認 schema 真的上去了：

```bash
cd /home/odoo/odoo-v2
export PGPASSWORD=$(node -e "console.log(new URL(require('./data/config.json').DATABASE_URL).password)")
psql -h localhost -p 8772 -U odoo -d aidev -At -c \
  "select table_name from information_schema.tables where table_name in ('companies','project_companies');"
psql -h localhost -p 8772 -U odoo -d aidev -At -c \
  "select column_name from information_schema.columns where table_name='users' and column_name='company_id';"
```
Expected：三行輸出。

- [ ] **Step 5：跑遷移（先看計畫，再套用）**

```bash
cd /home/odoo/odoo-v2
export DATABASE_URL="$(node -p "require('./data/config.json').DATABASE_URL")"
node tools/migrate-tenants.js            # 只列計畫
node tools/migrate-tenants.js --apply    # 真的寫
unset DATABASE_URL
```
Expected：計畫列出「要建內部公司」「6 個帳號」「17 個專案」（實際數字以當下為準）；`--apply` 之後印出 `✅ 數量一致`。

⚠ **印出 `❌ 數量對不上` 就停下來**，不要自己補綁——先查為什麼有專案沒被撿到。

- [ ] **Step 6：上線後驗收**

```bash
cd /home/odoo/odoo-v2
export PGPASSWORD=$(node -e "console.log(new URL(require('./data/config.json').DATABASE_URL).password)")
psql -h localhost -p 8772 -U odoo -d aidev -At -F'|' -c "
  select 'admins_without_company', count(*) from users where role='admin' and company_id is not null
  union all select 'users_without_company', count(*) from users where role<>'admin' and company_id is null
  union all select 'projects', count(*) from projects
  union all select 'internal_bindings', count(*) from project_companies pc join companies c on c.id=pc.company_id and c.is_internal
  union all select 'can_release_true_internal', count(*) from project_companies pc join companies c on c.id=pc.company_id and c.is_internal and pc.can_release;"
```
Expected：前兩列都是 `0`；`projects` 與 `internal_bindings` 相等；`can_release_true_internal` 是 `0`。

然後**人工點過一次**（前端沒有自動化測試，`.claude/rules/frontend.md` 30）：
- 用平台管理員登入 → 專案列表、任務、設定都跟以前一樣
- 用一個內部一般使用者登入 → 看得到的專案數量與以前一樣

- [ ] **Step 7：把進度標上規格頁**（記憶 `spec-progress-annotation`——使用者只從網頁看進度）

1. 改 `docs/superpowers/specs/2026-09-11-productize-rollout-plan.md` 的 `## 0. 目前進度` 表，階段 2a 那列寫「第 1 部完成」與**驗證到什麼程度**（未重啟／未實測／未由真人點過都要寫出來）。
2. `cd docs/superpowers/specs/_page && node build-specs-page.js`，再**手動複製**到 `docs/odoo-v2-saas-specs.html`。
3. 不必重啟（`docs-routes.js:29` 每次請求才讀檔）。

---

## 第 2 部預告（本計畫**不含**，另寫一份）

第 2 部「範圍檢查與畫面」要做的事，列在這裡是為了讓執行者知道什麼**不該**在第 1 部做：

- 逐支路由接上 `loadProjectForActor`／平台管理員限定（規格 §5.3 的表：`project-routes`、`search-routes`、`wiki-routes`、`chat-routes`、`tasks-routes`、`env-routes`、`db-query-routes`、`exam-routes`、`settings`、`admin-routes`）
- 靜態守衛測試（規格 §5.4）：掃全部 route 檔，凡路徑含 `/api/projects/:id` 或 `/api/tasks/:id` 的 handler 必須呼叫 `loadProjectForActor`／`loadTaskForActor` 或掛平台管理員 middleware
- 新增 `company-routes.js`（公司管理員管自家帳號）與平台管理員的公司管理頁（建立公司、啟用與期間、綁公司 GIT、綁定專案與勾 `can_release`）
- 公司 GIT 綁定時對該公司每個專案的 repo 跑 `git ls-remote` 驗證（規格 §6）
- 前端：`isInternal`／`isCompanyAdmin`、工具改平台管理員限定（**這就是 2b，上線前要先告知那 6 個人**）、三處齊做（nav／router guard／後端 403）
- 規格 §7 其餘檢查點：子專案 0 的 `canRun(scope)`、Codex 對非內部公司丟例外、cron 依任務建立者的公司判斷、公司停用時立刻中止在跑的任務
- 關閉自助註冊（§8 P3）、客戶隱藏 Odoo 帳密與同步設定（§8 P2）
- 規格 §9 的跨公司矩陣測試

---

## 自我檢查結果（寫完後對照規格跑過一次）

**規格涵蓋**：§4.1 `companies`→Task 1；§4.2 `users.company_id`→Task 1；§4.3 `project_companies`→Task 1；§4.4 角色→Task 2；§4.5 遷移→Task 3；§5.1 `req.actor`→Task 4；§5.2 共用函式→Task 6、§5.2 `loadTaskForActor`→Task 7；§6 GIT 退回→Task 8；§7 第一列（`verifyToken` 檢查點）→Task 5。
**刻意留給第 2 部**：§5.3 各路由、§5.4 靜態守衛、§5.5 前端、§7 其餘四個檢查點、§8 P2／P3、§9 跨公司矩陣。
**已完成不必再做**：§10 測試區 DB 帳號（階段 2c，09-16 已上線驗證）。
**型別一致性**：`ROLES`／`validateRoleCompany`／`hasCompany`（Task 2）被 Task 6 的四支函式沿用；`req.actor` 的欄位名（Task 4 `buildActor` 產出）與 Task 6、7 的測試 fixture 逐字對得上；`buildGitEnv` 的 `source` 只在 Task 8 產出、第 2 部才消費。
