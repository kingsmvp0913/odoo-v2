# 租戶隔離 第 2 部「看得到什麼」實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把第 1 部建好、但刻意還沒接線的範圍判斷，逐支接到路由上，讓「一家公司看不到另一家公司的任何東西」變成真的；並補上一道靜態守衛，讓以後新增的路由忘記檢查時會直接紅燈。

**Architecture:** 第 1 部已經提供 `req.actor`（每個請求的身分與公司狀態）與 `lib/tenant-access.js`（`canSeeProject`／`loadProjectForActor`／`canReleaseProject`／`canManageCompanyUsers`），但它們目前只有 `loadTaskForActor` 一個消費者。本部把它們接到約 55 個帶專案 id 的端點上，並把「公司停用／到期」的檢查補進第 1 部沒涵蓋的三條系統路徑（AI 執行、cron 自動推進、Codex）。**本部不動任何畫面，也不改變任何人「能用哪些工具」**——那是第 3 部。

**Tech Stack:** Node.js + Express + PostgreSQL（`pg`）；測試 jest + pg-mem + supertest。

**Spec:** `docs/superpowers/specs/2026-09-11-tenant-isolation-design.md`（§5.2 共用函式、§5.3 各路由改動、§5.4 靜態守衛、§7 公司可用性檢查點、§9 測試）
**前一部：** `docs/superpowers/plans/2026-09-18-tenant-isolation-part1-foundations.md`（已完成並上線，master `814187ba`）
**開發順序：** `docs/superpowers/specs/2026-09-11-productize-rollout-plan.md` 階段 2a

---

## 為什麼現在做這個不會影響任何人

遷移已經跑完（2026-09-18 15:2x）：17 個專案**全部**綁到「內部」公司，7 個非管理員帳號**全部**屬於內部公司，9 個管理員 `company_id` 是 NULL、走 `isPlatformAdmin` 短路。

⇒ 本部接上去的每一道檢查，對現在平台上的每一個人都是「通過」。**任何一個 Task 若讓現有使用者少看到東西，就是做錯了**，停下來回報。

真正會改變現有人行為的是第 3 部（工具改成管理員限定，即開發順序的 2b），上線前要先告知那 7 個人。

---

## Global Constraints

- **全跑測試一律 `cd app && npm run test:quiet`**（含 `--runInBand`），不要 `npx jest` 跑全跑。單檔用 `cd app && npx jest server/tests/<檔名> --runInBand`。
- **基線自己量**：動手前在當前 HEAD 跑一次全跑，記下 `Test Suites:` 與 `Tests:`。**不要沿用別人給的數字**——第 1 部因為沿用過時基線白跑了一輪審查。
- **看不到要回 404，不是 403**。403 等於告訴對方「這個 id 存在，只是你不能看」，那本身就是外洩。`loadProjectForActor` 回 `null` 時一律 `res.status(404).json({ error: '找不到專案' })`。
- **內部公司不特判**。它看得到全部是因為遷移把全部綁給它了，不是因為程式對它開後門。任何 `if (actor.isInternal)` 的捷徑都是錯的。
- **`req.isAdmin` 語意不可改**（＝`role === 'admin'`）。公司管理員有自己的旗標 `req.actor.isCompanyAdmin`，永遠不併進 `isAdmin`。
- pg-mem 限制：表在測試間不清空；不支援相關子查詢（改 `NOT IN` 並在子查詢加 `IS NOT NULL`）；不支援 `btrim`；`information_schema.columns.is_nullable` 永遠回 `'NO'`；**`<欄位> IS NULL` 出現在 UPDATE 的 WHERE 時，只要前面有 SELECT 用過同一個條件，UPDATE 就會靜默影響 0 列**（第 1 部實測，見記憶 `pgmem-is-null-update-poisoned`）。
- route 層測試的授權**走 `createApp` ＋ `/api/auth/setup`／`/api/auth/login` 取 token，不要用私有 signer**——私有 signer 繞過真實授權路徑，測不到 guard。
- 時間戳一律 `TIMESTAMPTZ`。**禁止寫死絕對路徑**。註解用繁體中文寫「為什麼」。零順手重構。
- **commit 用一般 `git add <明確路徑>` ＋ `git commit`**（本計畫在專屬 worktree 做，worktree 有自己的 index，不要用 `GIT_INDEX_FILE`）。禁用 `git add -A`。commit 後跑 `git status --porcelain -uno` 確認沒殘留。
- **既有測試紅了不要偷偷改它讓它綠**——回報，由控制者裁決。第 1 部有兩次這種改動，兩次都是當成「偏離」送審才放行的。

---

## 檔案結構

| 檔案 | 責任 |
|---|---|
| `app/server/lib/tenant-access.js`（改） | 新增 `requirePlatformAdmin` 中介層；修掉 `loadProjectForActor` 把 `columns` 串進 SQL 的隱患 |
| `app/server/project-routes.js`（改） | 列表依綁定過濾；讀取走 `loadProjectForActor`；管理類改平台管理員限定；`/release` 接上 `canReleaseProject` |
| `app/server/chat-routes.js`（改） | 進入專案的對話端點先驗專案 |
| `app/server/wiki-routes.js`（改） | 同上 |
| `app/server/env-routes.js`（改） | SSO 與讀取走範圍；建立／停止／刪除改平台管理員限定 |
| `app/server/db-query-routes.js`（改） | `/api/*` 全部改平台管理員限定（`/ai/*` 不動，那是容器走的通道） |
| `app/server/search-routes.js`（改） | 專案搜尋依綁定過濾 |
| `app/server/tasks-routes.js`（改） | 建立任務時驗專案看得到 |
| `app/server/lib/agent-run-token.js`（改） | `canRun` 由永遠 true 改成看發起人所屬公司是否可用 |
| `app/server/lib/git-identity.js`（改） | `buildGitEnv` 退回公司憑證前先檢查公司可用 |
| `app/server/lib/agent-env.js`（改） | 非內部公司觸發 Codex 時丟例外 |
| `app/server/pipeline/runner.js`（改） | cron 自動推進跳過「建立者公司不可用」的任務 |
| `app/server/tests/tenant-routes-scope.test.js`（新） | 跨公司矩陣：A 公司的人對 B 公司的專案／任務／對話／wiki／測試區一律 404 |
| `app/server/tests/tenant-route-guard.test.js`（新） | 靜態守衛：掃全部 route 檔，帶專案／任務 id 的 handler 一定要有檢查 |
| `app/server/tests/tenant-company-usable.test.js`（新） | §7 四個檢查點 |

---

## Task 0：開工前置（worktree ＋ 基線）

**Files:** 無

- [ ] **Step 1：開獨立 worktree**

```bash
cd /home/odoo/odoo-v2
git fetch origin
git worktree add .claude/worktrees/tenant-scope -b feat/tenant-scope origin/master
cd .claude/worktrees/tenant-scope
ln -s /home/odoo/odoo-v2/app/node_modules app/node_modules
echo "app/node_modules" >> "$(git rev-parse --git-path info/exclude)"
git status --porcelain -uno
```
Expected：最後一行沒有輸出。

⚠ **`node_modules` 一定要走 symlink ＋ `info/exclude`**：`.gitignore` 裡的 `node_modules/` 帶尾斜線，**不匹配 symlink**，不排除的話 `git add` 會把它夾帶進去（第 1 部實測）。

- [ ] **Step 2：量基線**

```bash
cd app && npm run test:quiet 2>&1 | tail -5
```
Expected：`0 failed`。把 `Test Suites:` 與 `Tests:` 兩行抄進 `.superpowers/sdd/2026-09-18-tenant-isolation-part2/progress.md`（沒有就建）。**基線不是 0 failed 就停下來問**，不要在紅底上開工。

---

## Task 1：共用守衛與 `loadProjectForActor` 補強

**Files:**
- Modify: `app/server/lib/tenant-access.js`
- Test: `app/server/tests/tenant-access.test.js`（既有檔，append 一段）

**Interfaces:**
- Produces:
  - `requirePlatformAdmin(req, res, next)` — Express 中介層；非平台管理員回 403 `{ error: '只有平台管理員能使用這個功能' }`
  - `loadProjectForActor(projectId, req, columns = '*')` — 行為不變，但 `columns` 改為白名單驗證

**為什麼要補 `columns`：** 第 1 部的整枝審查點名過——它把 `columns` 直接串進 SQL 文字。當時零呼叫端所以安全，**但本部就是要開始從路由呼叫它**，一旦有人把 request 來的東西當欄位清單傳進去就是注入洞。現在補，比事後補便宜。

- [ ] **Step 1：寫失敗的測試**（append 到 `app/server/tests/tenant-access.test.js` 末尾）

```javascript
describe('requirePlatformAdmin 與 columns 白名單（第 2 部）', () => {
  const { requirePlatformAdmin } = require('../lib/tenant-access');

  const runMw = (actor) => {
    const req = { actor };
    let status = null, body = null, nexted = false;
    const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
    requirePlatformAdmin(req, res, () => { nexted = true; });
    return { status, body, nexted };
  };

  test('平台管理員放行', () => {
    expect(runMw({ isPlatformAdmin: true }).nexted).toBe(true);
  });

  test('公司管理員擋下——它不是平台管理員（整個角色模型就靠這一點）', () => {
    const r = runMw({ isPlatformAdmin: false, isCompanyAdmin: true, companyId: 3 });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  test('一般使用者擋下', () => {
    expect(runMw({ isPlatformAdmin: false }).status).toBe(403);
  });

  test('完全沒有 actor 也擋下（不是放行）', () => {
    expect(runMw(undefined).status).toBe(403);
  });
});

describe('loadProjectForActor 的 columns 白名單', () => {
  const { loadProjectForActor } = require('../lib/tenant-access');
  const adminReq = { actor: { isPlatformAdmin: true, companyId: null } };

  test('欄位清單含 SQL 片段 → 丟例外，不送進資料庫', async () => {
    await expect(loadProjectForActor(1, adminReq, 'id, name; DROP TABLE projects'))
      .rejects.toThrow(/欄位清單/);
    await expect(loadProjectForActor(1, adminReq, '(SELECT password_hash FROM users)'))
      .rejects.toThrow(/欄位清單/);
  });

  test('正常的欄位清單照常運作', async () => {
    await expect(loadProjectForActor(999999, adminReq, 'id, name')).resolves.toBeNull();
    await expect(loadProjectForActor(999999, adminReq, '*')).resolves.toBeNull();
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/tenant-access.test.js --runInBand 2>&1 | tail -20
```
Expected：FAIL，`requirePlatformAdmin is not a function`。

- [ ] **Step 3：實作**（加進 `app/server/lib/tenant-access.js` 的 `module.exports` 之前）

```javascript
// 平台管理員限定的中介層（規格 §5.3）。放在 verifyToken 之後，所以 req.actor 一定在。
// 為什麼不重用各 route 檔自己那份 requireAdmin：那五份都另外查一次 DB，而 verifyToken
// 已經把身分載好了。新掛的守衛一律用這支；既有那五份不動（零順手重構）。
function requirePlatformAdmin(req, res, next) {
  if (!req.actor?.isPlatformAdmin) {
    return res.status(403).json({ error: '只有平台管理員能使用這個功能' });
  }
  next();
}

// 欄位清單只允許「識別字、逗號、空白」與單獨一個 *。
// 這支函式把 columns 直接串進 SQL 文字（沿用 loadTaskForActor 的既有形狀），
// 第 1 部零呼叫端所以安全；第 2 部開始從路由呼叫它，只要有人把 request 來的東西
// 當欄位清單傳進來就是注入洞。白名單擋在這裡，比每個呼叫端各自小心可靠。
const SAFE_COLUMNS = /^\s*(\*|[A-Za-z_][A-Za-z0-9_]*(\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*$/;
function assertSafeColumns(columns) {
  if (!SAFE_COLUMNS.test(columns)) {
    throw new Error(`欄位清單只能是欄位名或 *，收到：${columns}`);
  }
}
```

並在 `loadProjectForActor` 的第一行加上 `assertSafeColumns(columns);`。

把 `module.exports` 補上 `requirePlatformAdmin`（其餘既有 key 原樣保留，不要重排）。

- [ ] **Step 4：跑測試確認它綠**

```bash
cd app && npx jest server/tests/tenant-access.test.js --runInBand 2>&1 | tail -20
```
Expected：全綠，比先前多 6 支。

- [ ] **Step 5：全跑**

```bash
cd app && npm run test:quiet 2>&1 | tail -5
```
Expected：`0 failed`。

- [ ] **Step 6：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
git add app/server/lib/tenant-access.js app/server/tests/tenant-access.test.js
git commit -m "[Tenant]: 路由開始傳欄位清單進來之前，先把它擋成白名單；另加平台管理員限定的共用守衛"
git status --porcelain -uno
```

---

## Task 2：`project-routes.js` 接上範圍（含 `/release`）

**Files:**
- Modify: `app/server/project-routes.js`
- Test: `app/server/tests/tenant-routes-scope.test.js`（新）

**Interfaces:**
- Consumes: Task 1 的 `requirePlatformAdmin`；第 1 部的 `canSeeProject`／`loadProjectForActor`／`canReleaseProject`

**這一支的端點分三類處理**（規格 §5.3 與 §2 的裁決表）：

| 端點 | 處理 |
|---|---|
| `GET /api/projects` | 列表**在 SQL 裡 JOIN 綁定過濾**，不要撈全部再用 JS 篩 |
| `GET /api/projects/:id(\d+)`、`GET /api/projects/:id/repos`、`GET /api/projects/:id/repos/:repoId/branches`、`GET /api/projects/:id/pending-release`、`POST/DELETE /api/projects/:id/favorite` | `loadProjectForActor`，看不到回 **404** |
| `POST /api/projects`、`PUT/PATCH/DELETE /api/projects/:id`、`PATCH /api/projects/:id/mapping`、repos 的 `POST/PUT/DELETE/reclone` | **平台管理員限定**（規格 §2：建專案／加 repo 對客戶關閉） |
| `POST /api/projects/:id/release` | `canReleaseProject`——**這是本計畫的硬性條件**，見下 |

⚠ **`/release` 是整個第 2 部最重要的一行。** 第 1 部把 GIT 憑證改成「個人 → 公司」退回，順手拆掉了「沒有個人 PAT 就擋」這道事實上的煞車。在那之前，一般成員因為沒有 PAT 而推不了 main；之後只要有人替公司設了 PAT，**該公司每一個成員都能對平台上任何專案按上正式**。`canReleaseProject` 已經寫好但零呼叫端。**接上它之前，任何畫面都不可以開放設定公司 PAT**（那是第 3 部的事，第 3 部的 brief 會再寫一次）。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/tenant-routes-scope.test.js`：

```javascript
/**
 * tenant-routes-scope.test.js — 跨公司矩陣（規格 §9）
 *
 * 這支守的是整個產品化最核心的一句承諾：一家客戶看不到另一家客戶的任何東西。
 * 刻意用「硬帶對方的 id 打 API」的方式測，而不是只測列表——列表漏一筆只是少看到，
 * 帶 id 打得進去才是真的外洩。
 * 看不到一律期待 404 而不是 403：403 等於承認「這個 id 存在」，那本身就是外洩。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-scope-jwt';
process.env.APP_SECRET = 'test-scope-secret';

let app, dbModule;
let adminToken, aToken, bToken;
let coA, coB, coInternal, pA, pB;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  adminToken = (await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '平台管理員' })).body.token;

  const mkCo = async (name, isInternal = false) => (await one(
    'INSERT INTO companies (name, is_active, is_internal) VALUES ($1, true, $2) RETURNING id', [name, isInternal]
  )).id;
  coInternal = await mkCo('內部', true);
  coA = await mkCo('甲公司');
  coB = await mkCo('乙公司');

  const mkUser = async (username, companyId) => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      [username, hash, 'user', companyId]
    );
    return (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
  };
  aToken = await mkUser('userA', coA);
  bToken = await mkUser('userB', coB);

  const mkProject = async (name, companyId) => {
    const id = (await one("INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", [name])).id;
    await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2)', [id, companyId]);
    return id;
  };
  pA = await mkProject('甲的專案', coA);
  pB = await mkProject('乙的專案', coB);
});

afterAll(() => dbModule._setPoolForTesting(null));

const as = (t) => ({ Authorization: `Bearer ${t}` });

describe('專案', () => {
  test('列表只看得到自己公司綁的', async () => {
    const res = await request(app).get('/api/projects').set(as(aToken));
    expect(res.status).toBe(200);
    expect(res.body.map(p => p.id)).toEqual([pA]);
  });

  test('平台管理員看得到全部', async () => {
    const res = await request(app).get('/api/projects').set(as(adminToken));
    expect(res.body.map(p => p.id).sort()).toEqual([pA, pB].sort());
  });

  test('硬帶別家的專案 id → 404（不是 403，403 等於承認它存在）', async () => {
    expect((await request(app).get(`/api/projects/${pB}`).set(as(aToken))).status).toBe(404);
    expect((await request(app).get(`/api/projects/${pB}/repos`).set(as(aToken))).status).toBe(404);
    expect((await request(app).get(`/api/projects/${pB}/pending-release`).set(as(aToken))).status).toBe(404);
  });

  test('自己公司的專案照常打得開', async () => {
    expect((await request(app).get(`/api/projects/${pA}`).set(as(aToken))).status).toBe(200);
  });

  test('建立專案改成平台管理員限定', async () => {
    const res = await request(app).post('/api/projects')
      .set(as(aToken)).send({ name: '偷建的', odoo_version: '17' });
    expect(res.status).toBe(403);
  });

  test('改專案、刪專案、加 repo 都是平台管理員限定', async () => {
    expect((await request(app).patch(`/api/projects/${pA}`).set(as(aToken)).send({ description: 'x' })).status).toBe(403);
    expect((await request(app).delete(`/api/projects/${pA}`).set(as(aToken))).status).toBe(403);
    expect((await request(app).post(`/api/projects/${pA}/repos`).set(as(aToken)).send({ label: 'x', repo_url: 'y' })).status).toBe(403);
  });
});

describe('上正式（規格 §4.3 can_release）', () => {
  test('一般使用者不能按，即使綁定勾了', async () => {
    await dbModule.query('UPDATE project_companies SET can_release = true WHERE project_id=$1 AND company_id=$2', [pA, coA]);
    const res = await request(app).post(`/api/projects/${pA}/release`).set(as(aToken)).send({});
    expect(res.status).toBe(403);
  });

  test('別家公司的人連專案都看不到，更不可能按', async () => {
    const res = await request(app).post(`/api/projects/${pB}/release`).set(as(aToken)).send({});
    expect([403, 404]).toContain(res.status);
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/tenant-routes-scope.test.js --runInBand 2>&1 | tail -25
```
Expected：多支 FAIL（列表回全部、帶別家 id 回 200、建專案回 200）。

- [ ] **Step 3：實作——列表過濾**

`GET /api/projects` 目前是 `SELECT ${PROJECT_PUBLIC_COLS} FROM projects ORDER BY name ASC`。改成：

```javascript
      // 租戶範圍（規格 §5.2）：平台管理員看全部；其他人只看自己公司綁到的專案。
      // 在 SQL 裡 JOIN 過濾，不要撈全部再用 JS 篩——後者在專案變多時是 N 筆傳輸，
      // 而且「忘記篩」的失敗方式是靜默外洩。
      // 內部公司刻意不特判：它看得到全部是因為遷移把全部綁給它了。
      const { rows: projects } = req.actor.isPlatformAdmin
        ? await query(`SELECT ${PROJECT_PUBLIC_COLS} FROM projects ORDER BY name ASC`)
        : await query(
            `SELECT ${PROJECT_PUBLIC_COLS} FROM projects p
               JOIN project_companies pc ON pc.project_id = p.id AND pc.company_id = $1
              ORDER BY p.name ASC`,
            [req.actor.companyId]
          );
```

⚠ `PROJECT_PUBLIC_COLS` 若是不帶表別名的欄位清單（例如 `id, name, …`），JOIN 之後要確認沒有同名欄位造成 ambiguous。實作時先讀那個常數；若有歧義，在常數不變的前提下改用 `p.*` 之外的最小調整，並在 commit 訊息說明。

- [ ] **Step 4：實作——讀取類接 `loadProjectForActor`**

對 `GET /api/projects/:id(\d+)`、`GET /api/projects/:id/repos`、`GET /api/projects/:id/repos/:repoId/branches`、`GET /api/projects/:id/pending-release`、`POST /api/projects/:id/favorite`、`DELETE /api/projects/:id/favorite`，在 handler 最前面加：

```javascript
      // 看不到就當它不存在（規格 §5.2）——回 403 等於告訴對方「這個 id 存在，只是你不能看」
      if (!await loadProjectForActor(req.params.id, req, 'id')) {
        return res.status(404).json({ error: '找不到專案' });
      }
```

在檔案頂端 `require` 進 `loadProjectForActor`、`canReleaseProject`、`requirePlatformAdmin`。

- [ ] **Step 5：實作——管理類掛平台管理員**

`POST /api/projects`、`PUT /api/projects/:id`、`PATCH /api/projects/:id`、`PATCH /api/projects/:id/mapping`、`DELETE /api/projects/:id`、`POST /api/projects/:id/repos`、`PUT /api/projects/:id/repos/:repoId`、`DELETE /api/projects/:id/repos/:repoId`、`POST /api/projects/:id/repos/:repoId/reclone`：把 middleware 從 `verifyToken` 改成 `verifyToken, requirePlatformAdmin`。

⚠ 這幾支本來就有的 `requireAdmin`（`project-routes.js:42`）不要拆掉也不要重複掛——**先看那一支端點現在掛了什麼**，已經有 `requireAdmin` 的就不動（行為相同），只有裸 `verifyToken` 的才補。

- [ ] **Step 6：實作——`/release` 接上 `canReleaseProject`**

在 `POST /api/projects/:id/release` 的 handler 最前面：

```javascript
      // 上正式是專案層批次，會把同事已核准的任務一起帶上去，所以必須有人負責（規格 §4.3）：
      // 平台管理員，或「該公司對這個專案的綁定勾了可上正式」的公司管理員。一般成員一律不行。
      // ⚠ 這一行是硬性前提：第 1 部把 GIT 憑證改成可退回公司憑證，順手拆掉了
      // 「沒有個人 PAT 就擋」這道事實上的煞車。沒有這一行，只要有人替公司設了 PAT，
      // 該公司每個成員都能對任何專案按上正式。
      if (!await canReleaseProject(req.actor, req.params.id)) {
        return res.status(403).json({ error: '只有平台管理員或公司管理員能上正式' });
      }
```

- [ ] **Step 7：跑測試確認它綠**

```bash
cd app && npx jest server/tests/tenant-routes-scope.test.js --runInBand 2>&1 | tail -25
```
Expected：全綠。

- [ ] **Step 8：全跑**

```bash
cd app && npm run test:quiet 2>&1 | tail -5
```
Expected：`0 failed`。`project-routes` 有大量既有測試，紅了先看是不是那些測試用的帳號現在沒有公司（第 1 部的先例：既有 fixture 是「使用者沒公司、專案沒綁定」的舊形狀）。**若是，回報，不要自己改測試。**

- [ ] **Step 9：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
git add app/server/project-routes.js app/server/tests/tenant-routes-scope.test.js
git commit -m "[Tenant]: 專案端點只驗登入，任何人帶別家的 id 就看得到別家的東西；上正式更是誰都能按"
git status --porcelain -uno
```

---

## Task 3：對話與 wiki 接上範圍

**Files:**
- Modify: `app/server/chat-routes.js`、`app/server/wiki-routes.js`
- Test: `app/server/tests/tenant-routes-scope.test.js`（Task 2 建的檔，append 一段）

**為什麼這兩支放在一起：** 形狀完全一樣——兩者的端點都掛在 `/api/projects/:projectId/...` 底下，都只要在 handler 最前面加同一道檢查。分開派工只是多一輪審查成本。

**目前的缺口：** 對話端點只驗「這場對話屬於本人」（`getOwnedChat`），**不驗那個專案看不看得到**。所以帶著別家的 `projectId` 建立新對話是通的——而對話會把 AI 接到那個專案的 repo 與資料庫連線上。wiki 則是完全沒有專案層檢查。

- [ ] **Step 1：寫失敗的測試**（append 到 `tenant-routes-scope.test.js`）

```javascript
describe('對話', () => {
  test('在別家的專案底下開對話 → 404', async () => {
    const res = await request(app).post(`/api/projects/${pB}/chats`).set(as(aToken)).send({ title: '偷開的' });
    expect(res.status).toBe(404);
  });

  test('列別家專案的對話 → 404', async () => {
    expect((await request(app).get(`/api/projects/${pB}/chats`).set(as(aToken))).status).toBe(404);
  });

  test('自己公司的專案照常開得了對話', async () => {
    const res = await request(app).post(`/api/projects/${pA}/chats`).set(as(aToken)).send({ title: '正常的' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeGreaterThan(0);
  });
});

describe('wiki', () => {
  test('讀別家專案的 wiki → 404', async () => {
    expect((await request(app).get(`/api/projects/${pB}/wiki/overview`).set(as(aToken))).status).toBe(404);
  });

  test('改別家專案的 wiki → 404', async () => {
    const res = await request(app).put(`/api/projects/${pB}/wiki/overview`).set(as(aToken)).send({ content: '偷改' });
    expect(res.status).toBe(404);
  });

  test('重建別家專案的 wiki → 404（這支會叫 AI，擋不住等於幫別家燒錢）', async () => {
    expect((await request(app).post(`/api/projects/${pB}/wiki/overview/refresh`).set(as(aToken)).send({})).status).toBe(404);
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/tenant-routes-scope.test.js --runInBand 2>&1 | tail -25
```
Expected：對話與 wiki 那兩段 FAIL。

- [ ] **Step 3：實作——`chat-routes.js`**

在檔案頂端 `require` 進 `loadProjectForActor`，然後在**每一支** `/api/projects/:projectId/...` 端點的 handler 最前面加：

```javascript
      // 對話會把 AI 接到這個專案的 repo 與資料庫連線上，所以進來之前先驗看不看得到這個專案。
      // 既有的 getOwnedChat 只驗「這場對話是不是本人的」，驗不到專案這一層（規格 §5.3）。
      if (!await loadProjectForActor(req.params.projectId, req, 'id')) {
        return res.status(404).json({ error: '找不到專案' });
      }
```

共 10 支：`GET/POST /chats`、`PUT/DELETE /chats/:id`、`GET/POST /chats/:id/messages`、`POST /chats/:id/stop`、`GET /chats/:id/attachments/:attId/download`、`POST /chats/:id/draft-task`、`POST /chats/:id/read`。

- [ ] **Step 4：實作——`wiki-routes.js`**

同樣的一段，加在 `${base}` 底下**每一支**端點的最前面（`base = '/api/projects/:projectId/wiki'`）：`POST /init`、`POST /:slug/refresh`、`GET /:slug/raw`、`GET /:slug`、`PUT /:slug`、`DELETE /:slug`，以及該檔其餘掛在 `base` 下的端點（實作時用 `grep -n "\${base}" wiki-routes.js` 列全，**一支都不能漏**）。

⚠ `wiki-routes.js` 同時註冊 `/ai/...` 版本給容器用——**那些不要動**。容器走的是 unix socket，身分由每次執行通行證決定，不是 `req.actor`。判別方式：路徑不是以 `${base}` 開頭的就不要碰。

- [ ] **Step 5：跑測試確認它綠，再全跑**

```bash
cd app && npx jest server/tests/tenant-routes-scope.test.js --runInBand 2>&1 | tail -10
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope/app && npm run test:quiet 2>&1 | tail -5
```
Expected：兩者都 `0 failed`。

- [ ] **Step 6：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
git add app/server/chat-routes.js app/server/wiki-routes.js app/server/tests/tenant-routes-scope.test.js
git commit -m "[Tenant]: 對話只驗「這場對話是我的」，帶著別家專案 id 就能開一場接到別家 repo 與資料庫的對話"
git status --porcelain -uno
```

---

## Task 4：測試環境與資料庫查詢

**Files:**
- Modify: `app/server/env-routes.js`、`app/server/db-query-routes.js`
- Test: `app/server/tests/tenant-routes-scope.test.js`（append）

**兩支的處理不同，不要弄混：**

| 檔案 | 處理 | 理由 |
|---|---|---|
| `env-routes.js` 的 `GET /env`、`GET /env/summary`、`GET /env/sso`、`GET /env/log` | `loadProjectForActor` → 404 | 客戶要進測試區驗收（規格 §5.3） |
| `env-routes.js` 的 `POST /env/setup`、`POST /env/stop`、`DELETE /env`、`POST /env/external/release` | 平台管理員限定 | 規格 §2：測試環境管理對客戶關閉 |
| `env-routes.js` 的 `GET /api/projects/env-summaries`（沒有專案 id 的總覽） | 依綁定過濾 | 不過濾等於列出全部客戶的專案名 |
| `db-query-routes.js` 的**全部 `/api/*`** | 平台管理員限定 | 規格 §2／§5.3：資料庫查詢頁對客戶完全關閉 |
| `db-query-routes.js` 的 `/ai/*` | **完全不動** | 那是容器經閘道走的通道，身分由每次執行通行證決定 |

⚠ **`GET /api/projects/:id/env/sso` 是本計畫風險最高的一支。** 規格 §3.2 實查過：它目前只驗登入，任何人帶任一專案 id 就能進那個專案的測試區，而測試區帳號是 admin。這一支漏掉，租戶隔離等於沒做。

- [ ] **Step 1：寫失敗的測試**（append）

```javascript
describe('測試環境', () => {
  test('用別家的專案 id 進測試區 SSO → 404（測試區帳號是 admin，這支漏掉等於沒做隔離）', async () => {
    expect((await request(app).get(`/api/projects/${pB}/env/sso`).set(as(aToken))).status).toBe(404);
  });

  test('看別家的測試區狀態、log → 404', async () => {
    expect((await request(app).get(`/api/projects/${pB}/env`).set(as(aToken))).status).toBe(404);
    expect((await request(app).get(`/api/projects/${pB}/env/log`).set(as(aToken))).status).toBe(404);
  });

  test('建立／停止／刪除測試區改成平台管理員限定（自己公司的也不行）', async () => {
    expect((await request(app).post(`/api/projects/${pA}/env/setup`).set(as(aToken)).send({})).status).toBe(403);
    expect((await request(app).post(`/api/projects/${pA}/env/stop`).set(as(aToken)).send({})).status).toBe(403);
    expect((await request(app).delete(`/api/projects/${pA}/env`).set(as(aToken))).status).toBe(403);
  });

  test('測試區總覽只列自己公司的專案', async () => {
    const res = await request(app).get('/api/projects/env-summaries').set(as(aToken));
    expect(res.status).toBe(200);
    const ids = (Array.isArray(res.body) ? res.body : res.body.items || []).map(r => r.project_id ?? r.projectId);
    expect(ids).not.toContain(pB);
  });
});

describe('資料庫查詢頁（規格 §2：對客戶完全關閉）', () => {
  test('一般使用者一律 403，連自己公司的專案也是', async () => {
    expect((await request(app).get(`/api/projects/${pA}/db-connections`).set(as(aToken))).status).toBe(403);
    expect((await request(app).get(`/api/projects/${pA}/vpn`).set(as(aToken))).status).toBe(403);
    expect((await request(app).post(`/api/projects/${pA}/db-connections/test`).set(as(aToken)).send({})).status).toBe(403);
  });

  test('平台管理員照常可用', async () => {
    expect((await request(app).get(`/api/projects/${pA}/db-connections`).set(as(adminToken))).status).toBe(200);
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/tenant-routes-scope.test.js --runInBand 2>&1 | tail -25
```

- [ ] **Step 3：實作——`env-routes.js`**

讀取類（`GET /env`、`/env/summary`、`/env/sso`、`/env/log`）在 handler 最前面加：

```javascript
      // 測試區裡的帳號是 admin，能跑伺服器動作、看得到那個專案的全部資料。
      // 這一支原本只驗登入（規格 §3.2 實查），任何人帶任一專案 id 就進得去。
      if (!await loadProjectForActor(req.params.id, req, 'id')) {
        return res.status(404).json({ error: '找不到專案' });
      }
```

管理類（`POST /env/setup`、`POST /env/stop`、`DELETE /env`、`POST /env/external/release`）把 middleware 改成 `verifyToken, requirePlatformAdmin`。

`GET /api/projects/env-summaries` 沒有專案 id，改成在 SQL 加綁定條件：

```javascript
      // 不過濾的話，這一支會把平台上全部客戶的專案名字列給任何登入者看
      const scoped = req.actor.isPlatformAdmin
        ? await query(`<原本的 SQL>`)
        : await query(
            `<原本的 SQL，FROM 之後加：>
               JOIN project_companies pc ON pc.project_id = <原本的專案別名>.id AND pc.company_id = $1`,
            [req.actor.companyId]
          );
```
實作時先讀那支原本的 SQL，把 JOIN 接在正確的別名上；不要改動它 SELECT 的欄位。

- [ ] **Step 4：實作——`db-query-routes.js`**

把該檔**所有以 `/api/` 開頭**的端點的 middleware 改成 `verifyToken, requirePlatformAdmin`。共 9 支：`GET/POST /api/projects/:id/db-connections`、`PUT/DELETE /api/projects/:id/db-connections/:cid`、`GET/PUT /api/projects/:id/vpn`、`POST /api/projects/:id/db-connections/test`、`POST /api/projects/:id/db-connections/:cid/query`、`POST /api/projects/:id/db-connections/:cid/probe-log`。

**`/ai/db/connections`、`/ai/db/query`、`/ai/db/log` 三支完全不動。**

- [ ] **Step 5：跑測試確認它綠，再全跑**

```bash
cd app && npx jest server/tests/tenant-routes-scope.test.js --runInBand 2>&1 | tail -10
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope/app && npm run test:quiet 2>&1 | tail -5
```
Expected：`0 failed`。⚠ 既有的 `db-query-routes` 測試若用非管理員帳號打 `/api/*`，會開始 403——**那是預期的行為改變，但仍要回報**，由控制者判斷該改測試還是改實作。

- [ ] **Step 6：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
git add app/server/env-routes.js app/server/db-query-routes.js app/server/tests/tenant-routes-scope.test.js
git commit -m "[Tenant]: 測試區 SSO 只驗登入，帶任一專案 id 就能以 admin 身分進別家的測試區"
git status --porcelain -uno
```

---

## Task 5：搜尋與建立任務

**Files:**
- Modify: `app/server/search-routes.js`、`app/server/tasks-routes.js`
- Test: `app/server/tests/tenant-routes-scope.test.js`（append）

**兩個缺口：**
- **搜尋**：`search-routes.js` 的任務與對話那兩段已經限本人，但**專案那一段用名稱搜全部**（規格 §3.2 實查）。客戶打一個字就能列出所有客戶的專案名。
- **建立任務**：`POST /api/tasks` 收 `project_id` 卻不驗。帶別家的 id 建出來的任務，`loadTaskForActor` 之後會擋住**本人**讀取（因為公司對不上），變成一張誰都打不開的殭屍任務，而 pipeline 照樣會派 AI 去跑。

- [ ] **Step 1：寫失敗的測試**（append）

```javascript
describe('搜尋', () => {
  test('專案搜尋只回自己公司綁的（打一個字就列出所有客戶的專案名是最廉價的外洩）', async () => {
    const res = await request(app).get('/api/search?q=專案').set(as(aToken));
    expect(res.status).toBe(200);
    const names = (res.body.projects || []).map(p => p.name);
    expect(names).toContain('甲的專案');
    expect(names).not.toContain('乙的專案');
  });

  test('平台管理員搜得到全部', async () => {
    const res = await request(app).get('/api/search?q=專案').set(as(adminToken));
    const names = (res.body.projects || []).map(p => p.name);
    expect(names).toEqual(expect.arrayContaining(['甲的專案', '乙的專案']));
  });
});

describe('建立任務', () => {
  test('把任務建在別家的專案底下 → 404（否則會產生一張誰都打不開、AI 卻照跑的殭屍任務）', async () => {
    const res = await request(app).post('/api/tasks').set(as(aToken))
      .send({ title: '偷建的', original_text: 'x', project_id: pB });
    expect(res.status).toBe(404);
  });

  test('建在自己公司的專案底下照常成功，而且本人打得開', async () => {
    const created = await request(app).post('/api/tasks').set(as(aToken))
      .send({ title: '正常的', original_text: 'x', project_id: pA });
    expect(created.status).toBe(200);
    const opened = await request(app).get(`/api/tasks/${created.body.id}`).set(as(aToken));
    expect(opened.status).toBe(200);
  });

  test('不帶 project_id 的任務照常可以建（非專案任務是合法的）', async () => {
    const res = await request(app).post('/api/tasks').set(as(aToken)).send({ title: '沒有專案', original_text: 'x' });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/tenant-routes-scope.test.js --runInBand 2>&1 | tail -25
```

- [ ] **Step 3：實作——`search-routes.js`**

找到專案那一段（`SELECT id, name FROM projects ...`），改成依身分二選一：

```javascript
        // 專案搜尋原本不帶任何範圍條件：客戶打一個字就列得出全平台客戶的專案名。
        // 任務與對話那兩段本來就限本人，只有這一段是開的（規格 §3.2）。
        req.actor.isPlatformAdmin
          ? query(`<原本的 SQL>`, [<原本的參數>])
          : query(
              `SELECT p.id, p.name FROM projects p
                 JOIN project_companies pc ON pc.project_id = p.id AND pc.company_id = $2
                <原本的 WHERE 條件，欄位加上 p. 前綴>
                <原本的 ORDER／LIMIT>`,
              [<原本的參數>, req.actor.companyId]
            ),
```
實作時先把原本那段 SQL 讀出來照抄，只加 JOIN 與參數；**不要改它回傳的欄位或排序**，那會動到前端。

- [ ] **Step 4：實作——`tasks-routes.js`**

在 `POST /api/tasks` 的 handler 裡，`INSERT INTO tasks` **之前**加：

```javascript
      // 帶別家專案 id 建出來的任務，本人之後也讀不到（loadTaskForActor 會因為公司對不上而擋），
      // 變成一張誰都打不開、pipeline 卻照樣派 AI 去跑的殭屍任務。所以在建立當下就擋。
      // project_id 可以不帶——非專案任務是合法的，只有帶了才驗。
      if (project_id && !await loadProjectForActor(project_id, req, 'id')) {
        return res.status(404).json({ error: '找不到專案' });
      }
```

- [ ] **Step 5：跑測試確認它綠，再全跑**

```bash
cd app && npx jest server/tests/tenant-routes-scope.test.js --runInBand 2>&1 | tail -10
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope/app && npm run test:quiet 2>&1 | tail -5
```
Expected：`0 failed`。

- [ ] **Step 6：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
git add app/server/search-routes.js app/server/tasks-routes.js app/server/tests/tenant-routes-scope.test.js
git commit -m "[Tenant]: 搜尋一個字就列得出全平台客戶的專案名；任務建在別家專案底下會變成誰都打不開、AI 卻照跑的殭屍單"
git status --porcelain -uno
```

---

## Task 6：靜態守衛——以後忘記檢查會直接紅燈

**Files:**
- Create: `app/server/tests/tenant-route-guard.test.js`

**為什麼要有它（規格 §5.4）：** 前面五個 Task 是一次性把現有端點補齊。**真正的長期風險是「以後新增的路由忘記加檢查」**——那種缺口沒有任何徵狀：測試全綠、畫面正常，只是某家客戶看得到另一家的東西。守衛把這件事變成紅燈。

**守衛的規則：** 掃描 `app/server` 底下**全部** route 檔（走訪全樹，不要寫死檔名清單——寫死清單只涵蓋「當初改到的那幾支」，之後新增的檔案不會被掃到，防線形同虛設）。凡是路徑含 `/api/projects/:` 或 `/api/tasks/:` 的 `app.<method>(...)` 註冊，它的 handler 本文裡必須出現 `loadProjectForActor`、`loadTaskForActor` 或 `requirePlatformAdmin` 其中之一，否則紅燈。

**豁免清單**：`/ai/` 開頭的路徑（容器通道，身分由每次執行通行證決定）。豁免必須寫死在測試裡並附理由，不可以用「這支我知道沒事」跳過。

- [ ] **Step 1：寫測試（這一支一開始就該是綠的——它描述的是前面五個 Task 做完的狀態）**

Create `app/server/tests/tenant-route-guard.test.js`：

```javascript
/**
 * tenant-route-guard.test.js — 防止「以後新增的路由忘記加租戶檢查」（規格 §5.4）
 *
 * 這一支不測行為，測的是「每一支碰得到專案或任務的端點，都有人在把關」這個結構性事實。
 * 為什麼需要：忘記加檢查沒有任何徵狀——測試全綠、畫面正常，只是某家客戶看得到另一家的東西。
 * 走訪全樹而不是寫死檔名清單：寫死清單只涵蓋當初改到的那幾支，之後新增的檔案不會被掃到。
 */
const fs = require('fs');
const path = require('path');

const serverDir = path.join(__dirname, '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  if (e.name === 'node_modules' || e.name === 'tests') return [];
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
});

// 身分由每次執行通行證決定，不是 req.actor——那是容器經閘道走的通道
const EXEMPT_PREFIXES = ['/ai/'];
const GUARDS = ['loadProjectForActor', 'loadTaskForActor', 'requirePlatformAdmin'];

// 取出一支 app.<method>('<path>', ...) 註冊，以及它到下一支註冊為止的原始碼
function collectRoutes(src) {
  const re = /app\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  const hits = [];
  let m;
  while ((m = re.exec(src))) hits.push({ method: m[1], routePath: m[3], at: m.index });
  return hits.map((h, i) => ({
    ...h,
    body: src.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : src.length),
  }));
}

const files = walk(serverDir);

test('掃到的 route 檔數量合理（走訪壞掉時這一支會先紅，而不是讓守衛靜默空轉）', () => {
  const routeFiles = files.filter(f => /app\.(get|post|put|patch|delete)\(/.test(fs.readFileSync(f, 'utf8')));
  expect(routeFiles.length).toBeGreaterThanOrEqual(10);
});

test('每一支碰得到專案或任務的端點都有租戶守衛', () => {
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    // wiki-routes 之類用 `${base}` 組路徑的，把 base 展開後再比對
    const baseMatch = src.match(/const base = ['"`]([^'"`]+)['"`]/);
    const base = baseMatch ? baseMatch[1] : '';
    for (const r of collectRoutes(src)) {
      const full = r.routePath.startsWith('$') || r.routePath.startsWith('/') ? r.routePath : base + r.routePath;
      const effective = r.routePath.includes('${base}') ? r.routePath.replace('${base}', base) : full;
      if (EXEMPT_PREFIXES.some(p => effective.startsWith(p))) continue;
      const touchesScoped = /\/api\/projects\/:/.test(effective) || /\/api\/tasks\/:/.test(effective);
      if (!touchesScoped) continue;
      if (!GUARDS.some(g => r.body.includes(g))) {
        offenders.push(`${path.relative(serverDir, file)} ${r.method.toUpperCase()} ${effective}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2：跑它**

```bash
cd app && npx jest server/tests/tenant-route-guard.test.js --runInBand 2>&1 | tail -30
```
Expected：**綠**。若是紅的，它會把漏掉的端點逐條印出來——那些就是前面五個 Task 漏掉的，回去補完再繼續，**不要把它們加進豁免清單**。

⚠ **`${base}` 的處理是這支測試最容易失真的地方。** `wiki-routes.js` 用範本字串組路徑，正則抓到的字面可能是 `${base}/:slug`。實作時先實跑一次、把 `offenders` 印出來人工看過，確認它**真的**掃到了 wiki 那 6 支（可以暫時把 `expect(offenders).toEqual([])` 改成 `console.log(offenders)` 觀察，看完改回去）。掃不到而顯示綠燈，是最壞的結果——防線看起來在，其實空的。

- [ ] **Step 3：證明它會紅（守衛本身要能失敗，否則等於沒有）**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
# 暫時拿掉 chat-routes 其中一支的檢查
node -e "const fs=require('fs');const p='app/server/chat-routes.js';let s=fs.readFileSync(p,'utf8');const i=s.indexOf('loadProjectForActor(req.params.projectId');s=s.slice(0,i)+'/*TEMP*/false && '+s.slice(i);fs.writeFileSync(p+'.bak',fs.readFileSync(p));fs.writeFileSync(p,s)"
cd app && npx jest server/tests/tenant-route-guard.test.js --runInBand 2>&1 | tail -10
```
Expected：**紅**，而且訊息指名那一支端點。

⚠ 上面那個手法是把呼叫短路掉但字串還在，守衛（比對字串）**不會**因此變紅。**正確的做法是整段刪掉**：

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
cp app/server/chat-routes.js /tmp/chat-routes.bak
# 手動編輯，把「GET /chats」那一支的三行檢查整段刪掉
cd app && npx jest server/tests/tenant-route-guard.test.js --runInBand 2>&1 | tail -10
# 確認紅了、訊息指名那一支之後還原
cp /tmp/chat-routes.bak /home/odoo/odoo-v2/.claude/worktrees/tenant-scope/app/server/chat-routes.js
cd app && npx jest server/tests/tenant-route-guard.test.js --runInBand 2>&1 | tail -5
```
Expected：刪掉時紅、還原後綠。**在報告裡貼出那兩次的輸出**——沒有這個證據，這支守衛只是一段永遠綠的裝飾。

- [ ] **Step 4：全跑**

```bash
cd app && npm run test:quiet 2>&1 | tail -5
```
Expected：`0 failed`。確認 `chat-routes.js` 已還原（`git status --porcelain -uno` 不該顯示它被改動）。

- [ ] **Step 5：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
git add app/server/tests/tenant-route-guard.test.js
git commit -m "[Tenant]: 忘記加租戶檢查沒有任何徵狀——測試綠、畫面正常，只是某家客戶看得到另一家的東西"
git status --porcelain -uno
```

---

## Task 7：公司不可用時，系統自己跑的那幾條路也要擋

**Files:**
- Modify: `app/server/lib/tenant-access.js`（加兩支查詢函式）
- Modify: `app/server/lib/agent-run-token.js:71`（`canRun`）
- Modify: `app/server/pipeline/agent-runner.js:6-9`（Codex 守衛）
- Modify: `app/server/pipeline/runner.js`（cron 自動推進）
- Modify: `app/server/lib/git-identity.js`（退回公司憑證前檢查）
- Test: `app/server/tests/tenant-company-usable.test.js`（新）

**Interfaces:**
- Produces:
  - `isUserCompanyUsable(userId, now = new Date()) -> Promise<boolean>`
  - `isUserCompanyInternal(userId) -> Promise<boolean>`

**為什麼要這一關：** 第 1 部的全域閘門只擋**HTTP 請求**。但平台有三條路不經過 HTTP：AI 執行（`sandbox-run`）、cron 自動推進、以及 `buildGitEnv` 被系統觸發時。公司停用或到期之後，這三條照樣會跑——等於客戶停繳之後，平台還在替他燒 AI 的錢、還在替他推 code。

**沒有公司 = 可用。** 跟第 1 部的 `buildActor` 一致：平台管理員沒有公司，而 `company_id` 是 NULL 的帳號在遷移之前也存在。把「沒有公司」當成不可用，會把平台管理員自己鎖死。

⚠ **規格 §7 的第五個檢查點「公司停用時立刻中止正在跑的任務」不在本部。** 那需要「停用公司」這個端點，而它還不存在（目前只有遷移腳本寫得了 `companies`）。列進第 3 部，和公司管理頁一起做。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/tenant-company-usable.test.js`：

```javascript
/**
 * tenant-company-usable.test.js — 公司停用／到期之後，不經過 HTTP 的那幾條路也要停（規格 §7）
 *
 * 第 1 部的全域閘門只擋 HTTP。AI 執行、cron 自動推進、系統觸發的 git 推送都不經過它，
 * 所以客戶停繳之後，平台還會繼續替他燒 AI 的錢、繼續替他推 code。
 * 「沒有公司」一律算可用——平台管理員沒有公司，這一點寫反會把管理員自己鎖死。
 */
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-usable-jwt';
process.env.APP_SECRET = 'test-usable-secret';

let dbModule, uOk, uOff, uExpired, uInternal, uNoCompany, uAdmin;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const mkCo = async (name, opts = {}) => (await one(
    `INSERT INTO companies (name, is_active, is_internal, active_from, active_until)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [name, opts.active !== false, !!opts.internal, opts.from || null, opts.until || null]
  )).id;
  const mkUser = async (username, companyId, role = 'user') => (await one(
    'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4) RETURNING id',
    [username, 'x', role, companyId]
  )).id;

  uOk = await mkUser('ok', await mkCo('正常公司'));
  uOff = await mkUser('off', await mkCo('停用公司', { active: false }));
  uExpired = await mkUser('expired', await mkCo('過期公司', { until: '2020-01-01T00:00:00Z' }));
  uInternal = await mkUser('inside', await mkCo('內部', { internal: true }));
  uNoCompany = await mkUser('nocompany', null);
  uAdmin = await mkUser('platadmin', null, 'admin');
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('isUserCompanyUsable', () => {
  const { isUserCompanyUsable } = require('../lib/tenant-access');

  test('公司正常 → true', async () => expect(await isUserCompanyUsable(uOk)).toBe(true));
  test('公司停用 → false', async () => expect(await isUserCompanyUsable(uOff)).toBe(false));
  test('使用期間已過 → false', async () => expect(await isUserCompanyUsable(uExpired)).toBe(false));
  test('沒有公司 → true（平台管理員沒有公司，寫反會把管理員鎖死）', async () => {
    expect(await isUserCompanyUsable(uNoCompany)).toBe(true);
    expect(await isUserCompanyUsable(uAdmin)).toBe(true);
  });
  test('不存在的 user → true（不認識的人不歸這支管，交給上游的授權擋）', async () => {
    expect(await isUserCompanyUsable(999999)).toBe(true);
  });
});

describe('isUserCompanyInternal', () => {
  const { isUserCompanyInternal } = require('../lib/tenant-access');

  test('內部公司成員 → true', async () => expect(await isUserCompanyInternal(uInternal)).toBe(true));
  test('客戶公司成員 → false', async () => expect(await isUserCompanyInternal(uOk)).toBe(false));
  test('沒有公司（平台管理員）→ true（他們本來就是內部人員）', async () => {
    expect(await isUserCompanyInternal(uAdmin)).toBe(true);
  });
});

describe('canRun：公司不可用就不發通行證、不開容器', () => {
  const { canRun } = require('../lib/agent-run-token');

  test('公司正常 → 准跑', async () => expect(await canRun('project-1', uOk)).toBe(true));
  test('公司停用 → 不准（客戶停繳之後平台不該繼續替他燒 AI 的錢）', async () => {
    expect(await canRun('project-1', uOff)).toBe(false);
  });
  test('內部工作（沒有發起人）→ 准跑', async () => {
    expect(await canRun('internal-audit', null)).toBe(true);
  });
});

describe('Codex 只給內部人員（規格 §7、子專案 0 Q3）', () => {
  const { runAgent } = require('../pipeline/agent-runner');

  test('客戶公司的人觸發 Codex → 丟例外（Codex 沒有容器保護，等於繞過整個隔離）', async () => {
    await expect(runAgent('x', { provider: 'codex', userId: uOk })).rejects.toThrow(/只能用 Claude/);
  });

  test('內部公司的人照常可以用 Codex', async () => {
    // 不真的跑 Codex，只驗它沒有在守衛這一關被擋下來
    await expect(runAgent('x', { provider: 'codex', userId: uInternal }))
      .rejects.not.toThrow(/只能用 Claude/);
  });

  test('Claude 不受影響', async () => {
    await expect(runAgent('x', { provider: 'claude', userId: uOk }))
      .rejects.not.toThrow(/只能用 Claude/);
  });
});

describe('buildGitEnv：停用公司的憑證不可用', () => {
  const { buildGitEnv, NoGitCredentialError } = require('../lib/git-identity');
  const { encrypt } = require('../lib/crypto');

  test('公司停用時不退回它的 PAT', async () => {
    await dbModule.query(
      'UPDATE companies SET git_pat_enc = $1 WHERE id = (SELECT company_id FROM users WHERE id = $2)',
      [encrypt('OFF_COMPANY_PAT'), uOff]
    );
    await expect(buildGitEnv(uOff)).rejects.toThrow(NoGitCredentialError);
  });

  test('公司正常時照常退回', async () => {
    await dbModule.query(
      'UPDATE companies SET git_pat_enc = $1 WHERE id = (SELECT company_id FROM users WHERE id = $2)',
      [encrypt('OK_COMPANY_PAT'), uOk]
    );
    const env = await buildGitEnv(uOk);
    expect(env.GIT_PAT).toBe('OK_COMPANY_PAT');
    expect(env.source).toBe('company');
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/tenant-company-usable.test.js --runInBand 2>&1 | tail -25
```
Expected：FAIL，`isUserCompanyUsable is not a function`。

- [ ] **Step 3：實作——`lib/tenant-access.js` 加兩支**

```javascript
// 不經過 HTTP 的路徑（AI 執行、cron、系統觸發的 git）要能自己問「這個人的公司現在能用嗎」。
// 判斷邏輯與 auth.js 的 buildActor 一致：沒有公司一律算可用——平台管理員沒有公司，
// 而遷移之前一般帳號也還沒有。寫反的話會把平台管理員自己鎖死。
// 查不到這個 user 也算可用：不認識的人不歸這支管，交給上游的授權擋。
async function isUserCompanyUsable(userId, now = new Date()) {
  if (!userId) return true;
  const { rows } = await query(
    `SELECT c.is_active, c.active_from, c.active_until
       FROM users u JOIN companies c ON c.id = u.company_id
      WHERE u.id = $1`,
    [userId]
  );
  if (!rows[0]) return true;
  const r = rows[0];
  return r.is_active === true
    && (!r.active_from || now >= new Date(r.active_from))
    && (!r.active_until || now <= new Date(r.active_until));
}

// 「這個人算不算內部人員」。平台管理員沒有公司，他們本來就是內部人員 ⇒ true。
// 用途：Codex 沒有容器保護，只給內部人員（規格 §7）。
async function isUserCompanyInternal(userId) {
  if (!userId) return true;
  const { rows } = await query(
    'SELECT c.is_internal FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = $1',
    [userId]
  );
  if (!rows[0]) return true;
  return rows[0].is_internal !== false;
}
```
兩支都加進 `module.exports`（既有 key 原樣保留）。

- [ ] **Step 4：實作——`canRun`（`lib/agent-run-token.js:71`）**

```javascript
// 檢查點（§4.4）：公司停用或不在使用期間就不發通行證、不開容器。
// 子專案 2 之後會在同一個地方再接「公司已設 key、未超花費上限」。
// 內部工作（健檢、夜間改善）沒有發起人，actorUserId 是 null ⇒ 照跑。
async function canRun(_scope, actorUserId) {
  return require('./tenant-access').isUserCompanyUsable(actorUserId);
}
```
⚠ `require` 寫在函式內是刻意的——`tenant-access` 會 `require('../db')`，模組層互相引用容易在測試環境形成載入順序問題。

- [ ] **Step 5：實作——Codex 守衛（`pipeline/agent-runner.js`）**

把 provider 分派那段改成：

```javascript
  const provider = opts.provider || 'claude';
  if (provider === 'claude') return runClaude(prompt, opts);
  if (provider === 'codex') {
    // Codex 自帶的沙箱在平台容器裡起不來，所以它沒有容器保護——客戶觸發的 AI 走 Codex
    // 等於整個隔離被繞過（規格 §7、子專案 0 Q3 裁決）。只放行內部人員。
    if (!await require('../lib/tenant-access').isUserCompanyInternal(opts.userId ?? null)) {
      throw new Error('客戶公司的 AI 只能用 Claude');
    }
    return runCodex(prompt, opts);
  }
```
⚠ 這個函式要能 `await`，確認它本來就是 `async`；不是的話改成 `async` 並確認呼叫端都有 `await`（`grep -rn "runAgent(" app/server --include=*.js | grep -v test`）。

- [ ] **Step 6：實作——cron 自動推進（`pipeline/runner.js`）**

在挑出待推進任務之後、實際派工之前，逐張過濾：

```javascript
    // 公司停用或到期之後，cron 不該繼續替那家客戶推進任務（規格 §7）。
    // 依「建任務的人」所屬公司判斷，與「誰付錢」同一個人——一個專案可以掛多家公司，
    // 所以不能用專案判斷。
    const { isUserCompanyUsable } = require('../lib/tenant-access');
    if (!await isUserCompanyUsable(task.user_id)) continue;
```
實作時先讀那段迴圈，把這一段放在正確的位置（`continue` 要跳過的是「這一張任務」，不是整輪）。

- [ ] **Step 7：實作——`buildGitEnv` 檢查公司可用**

在「退回公司憑證」那個分支（`else if (u.co_pat_enc)`）之前，先確認公司可用：

```javascript
  // 停用或到期的公司，它的憑證不可以再被拿來推 code（規格 §7）。
  // HTTP 那一側第 1 部的全域閘門已經擋掉了，但 cron／部署／夜間批次不經過 HTTP。
  const companyUsable = u.co_pat_enc ? await isUserCompanyUsable(userId) : true;
```
然後把分支條件從 `else if (u.co_pat_enc)` 改成 `else if (u.co_pat_enc && companyUsable)`。在檔案頂端 `require` 進 `isUserCompanyUsable`。

- [ ] **Step 8：跑測試確認它綠，再全跑**

```bash
cd app && npx jest server/tests/tenant-company-usable.test.js --runInBand 2>&1 | tail -15
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope/app && npm run test:quiet 2>&1 | tail -5
```
Expected：`0 failed`。⚠ `canRun` 與 `runAgent` 有既有測試會經過，紅了先看是不是那些測試的 fixture 沒有公司（沒有公司應該一律放行，若因此紅了代表實作把「沒有公司」判成不可用，那就是寫反了）。

- [ ] **Step 9：commit**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
git add app/server/lib/tenant-access.js app/server/lib/agent-run-token.js app/server/pipeline/agent-runner.js app/server/pipeline/runner.js app/server/lib/git-identity.js app/server/tests/tenant-company-usable.test.js
git commit -m "[Tenant]: 公司停繳之後 HTTP 擋得住，但 cron、AI 執行、系統觸發的 git 推送照跑——平台還在替他燒錢"
git status --porcelain -uno
```

---

## Task 8：整枝審查 → 合併 → 上線驗收

**Files:** 無新檔

- [ ] **Step 1：整枝自審**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
git fetch origin && git merge origin/master
cd app && npm run test:quiet 2>&1 | tail -5
```
Expected：合併乾淨、`0 failed`。**每天開工前都先做一次這個合併**——分支放久了，合併時要一次面對一週的衝突。第 1 部合併時就在 `db.js` 的欄位遷移清單撞過一次（兩邊都在陣列尾端加了一筆，兩筆都要留）。

逐項自己對一次：

| 檢查 | 怎麼確認 |
|---|---|
| 靜態守衛真的會紅 | Task 6 Step 3 的兩次輸出要在報告裡；沒有那個證據就當它是裝飾 |
| 沒有任何 `isInternal` 捷徑 | `grep -rn "isInternal" app/server --include=*.js \| grep -v test` — 只該出現在 `tenant-access.js` 的定義、Codex 守衛、與註解 |
| `req.isAdmin` 語意沒變 | `git diff origin/master -- app/server/auth.js` 應為空 |
| `/ai/*` 沒被動到 | `git diff origin/master \| grep -n "'/ai/"` 回空 |
| 看不到一律 404 不是 403 | `git diff origin/master \| grep -n "403" ` 逐條看，每一個 403 都該是「平台管理員限定」或「不能上正式」，不該有「看不到」用 403 |
| 沒有寫死絕對路徑 | `git diff origin/master \| grep -nE "/home/\|C:\\\\"` 回空 |

- [ ] **Step 2：請控制者派整枝總審查**

第 1 部的教訓：**逐關審查會漏掉「整條分支合起來才看得見」的問題**——那次漏的是「規格要求新建專案自動綁公司，九個 Task 沒有一個做，而計畫的自我檢查還把它算成已涵蓋」，是整枝總審查抓到的（1 Critical＋3 Important）。這一關不可以省。

總審查要特別看的：
- 55 個端點**有沒有漏掉的**（靜態守衛應該抓得到，但守衛本身可能有盲區——例如用變數組路徑、或用 `router` 而非 `app`）
- 三道檢查疊起來的請求路徑有沒有互相干擾
- 有沒有哪一支端點現在對**現有的內部使用者**行為變了（本部的硬前提是零改變）

- [ ] **Step 3：請使用者裁決後合併**

把這三件事講給使用者聽，**取得同意才合併**：
1. 本部對現在平台上的每個人**行為零改變**（17 個專案全綁內部公司、7 個非管理員全屬內部公司）。真正會讓那 7 個人失去工具的是第 3 部。
2. 合併＋重啟後，**跨公司邊界就真的生效了**——以後新增客戶公司，他們預設什麼都看不到。
3. **`/release` 現在接上了權限檢查**，所以第 3 部可以安全地開放「設定公司 PAT」。在此之前不行。

- [ ] **Step 4：合併、推送、請使用者重啟**

推送照 `pushRepo` skill（PAT／`DATABASE_URL`／`APP_SECRET` 的取法寫在那裡，不要自己重推導）。
⚠ **推之前先確認要推的分支是從當前 `origin/master` 長出來的**；`git merge-base --is-ancestor origin/master HEAD` 回 0 才可以快轉。

- [ ] **Step 5：上線驗收（實測，不是只看資料庫）**

重啟後，用一個**真的一般使用者**的身分打 API（自簽 JWT，`userId` 取 `SELECT id FROM users WHERE role<>'admin' AND company_id IS NOT NULL LIMIT 1`）：

```bash
cd /home/odoo/odoo-v2
export PGPASSWORD=$(node -e "console.log(new URL(require('./data/config.json').DATABASE_URL).password)")
UID_U=$(psql -h localhost -p 8772 -U odoo -d aidev -At -c "select id from users where role<>'admin' and company_id is not null order by id limit 1;")
cd app/server
JT=$(node -e "const c=require('/home/odoo/odoo-v2/data/config.json');console.log(require('jsonwebtoken').sign({userId:$UID_U}, c.JWT_SECRET, {expiresIn:'5m'}))")
curl -s -H "Authorization: Bearer $JT" http://localhost:8771/api/projects | node -pe "JSON.parse(require('fs').readFileSync(0)).length + ' 個專案'"
curl -s -o /dev/null -w "任務列表 HTTP=%{http_code}\n" -H "Authorization: Bearer $JT" http://localhost:8771/api/tasks
```
Expected：**17 個專案**（與上線前相同）、任務列表 200。**數字變少就是做錯了**，立刻回報。

再挑一張那個人的專案任務打開，確認 200（這是「範圍檢查寫太嚴」會變 404 的指標）。

- [ ] **Step 6：把進度標上規格頁**（記憶 `spec-progress-annotation`——使用者只從網頁看進度）

1. 改 `docs/superpowers/specs/2026-09-11-productize-rollout-plan.md` 的 `## 0. 目前進度` 表，寫清楚**驗證到什麼程度**（未重啟／未實測／未由真人點過都要寫出來）。
2. `cd docs/superpowers/specs/_page && node build-specs-page.js`，再**手動複製**到 `docs/odoo-v2-saas-specs.html`。
3. 不必重啟。

---

## 第 3 部預告（本計畫**不含**，另寫一份）

列在這裡是為了讓執行者知道什麼**不該**在第 2 部做：

- **公司管理頁（平台管理員）**：建立公司、改啟用與使用期間、綁公司 GIT、綁定專案與勾 `can_release`。`is_internal` 不開放設定。
- **`company-routes.js`（公司管理員）**：管自家帳號——列出／新增／停用／在 `user` ↔ `company_admin` 之間改角色，範圍限自己公司。只能停用不能刪除（§8 P6）。
- **公司 GIT 綁定時跑 `git ls-remote` 驗證**可存取，失敗就不存（§6）。
- **⚠ 硬性順序：開放「設定公司 PAT」之前，`/release` 的 `canReleaseProject` 必須已經接上。** 第 2 部 Task 2 Step 6 就是它——做第 3 部之前先確認那一行在。
- **公司停用時立刻中止正在跑的任務**（§7 第五個檢查點、§8 P5）：砍掉該公司所有在跑的 AI 容器，任務停在原地並寫時間軸。要等「停用公司」這個端點存在才做得了。
- **2b：工具改成平台管理員限定的前端部分** — nav／router guard 與後端 403 三處齊做（`.claude/rules/frontend.md` 38）。**上線前要先告知那 7 個內部一般使用者。**
- 關閉自助註冊（§8 P3）；客戶的個人設定隱藏 Odoo 帳密與同步設定（§8 P2）。
- `admin-routes` 建立帳號時改成**明確選公司**，取代第 1 部那個「一律預設掛內部公司」的暫時措施。

---

## 自我檢查結果（寫完後對照規格跑過一次）

**規格涵蓋**：§5.2 共用函式接線→Task 2–5；§5.3 各路由→Task 2（project）、Task 3（wiki／chat）、Task 4（env／db-query）、Task 5（search／tasks）；§5.4 靜態守衛→Task 6；§7 檢查點 2–4（`canRun`、Codex、cron）→Task 7；§9 跨公司矩陣→Task 2–5 的測試檔。
**刻意留給第 3 部**：§5.3 的 `settings.js`／`admin-routes.js`／新增 `company-routes.js`、§5.5 前端、§6 公司 GIT 驗證、§7 第五個檢查點（立刻中止）、§8 P2／P3、`exam-routes.js`／`exam-upload-routes.js`（**2026-09-21 使用者裁決：考試要保持可以考，不鎖成平台管理員限定**——規格 §5.3 原本標「平台管理員限定」，那一行已被此裁決推翻，規格必須跟著改，不可留著與程式矛盾。第 1 部計畫 1758 行曾把這兩個檔轉交第 2 部，本部未做，**列為刻意延後**（寫在這裡是因為前一版兩份清單都沒提到它，任何人拿計畫對規格都會誤以為 §5.3 已全數涵蓋——這正是它被弄丟的原因）。現況：**24** 支端點只掛 `verifyToken`（`exam-routes.js` 6 支，`exam-upload-routes.js` 18 支；09-21 實查更正，先前寫 22 是錯的）。**另有一條完全繞過本專案所有機制的路**：`lib/exam/review.js` 的 AI 閱卷自己 `spawn('claude')`，不經 `runAgent`／`runClaude`，沒有 `AbortController`、不在 `_inFlight`、不在通行證表 ⇒ `canRun` 的公司閘門與「停用公司就中止」都碰不到它。**未來的形狀是「公司設定裡的功能開關」**：哪一家公司能用考試由公司設定授予，不是靠身分判斷，隨第 3 部的公司管理頁一起做。**這仍是建立第一家客戶公司之前的阻擋條件**——那批端點現在只要求「有登入」，客戶公司一旦存在就摸得到內部題庫，所以功能開關必須在第一家客戶進來之前先擋住，客戶預設關閉。）
**已完成不必再做**：§4 資料模型、§5.1 `req.actor`、§7 第一個檢查點（HTTP 全域閘門）、§6 的退回順序本身——全部在第 1 部。
**型別一致性**：`requirePlatformAdmin`（Task 1）被 Task 2、4 當 middleware 用；`loadProjectForActor(projectId, req, columns)` 的簽章在 Task 2–5 一致；`isUserCompanyUsable(userId, now)` 與 `isUserCompanyInternal(userId)`（Task 7 產出）被同一個 Task 內的四個呼叫點消費，沒有跨 Task 的型別依賴。
**已知盲區**：靜態守衛（Task 6）比對的是 handler 原始碼裡有沒有出現守衛的名字，**擋不住「呼叫了但把結果丟掉」**。Task 6 Step 3 的實測要求就是為了至少證明它對「整段刪掉」有反應；更強的守衛（例如比對 AST）不在本部範圍。
