# 租戶隔離 第 3 部 a：公司管理與功能開關（後端）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓平台管理員能建立與管理客戶公司（啟用期間、GIT 憑證、綁哪些專案、能不能按上正式、能用哪些功能），讓公司管理員能管自家帳號，並關掉自助註冊、對客戶隱藏 Odoo 帳密與同步設定。

**Architecture:** 延續第 1、2 部的形狀——身分在 `verifyToken` 一次載齊成 `req.actor`，授權判斷集中在 `lib/tenant-access.js`，新增的功能開關判斷集中在 `lib/company-features.js`。兩個新路由檔各有單一職責：`company-admin-routes.js` 給平台管理員管公司，`company-routes.js` 給公司管理員管自家帳號。前端完全不動（那是第 3 部 b）。

**Tech Stack:** Node + Express + PostgreSQL（`pg`）；測試 jest + supertest + pg-mem。

**Spec:** `docs/superpowers/specs/2026-09-11-tenant-isolation-design.md`（§4、§5.3、§6、§7、§8 為本計畫的依據）。現況事實：`.claude/worktrees/tenant-scope/.superpowers/sdd/part3-research.md`（2026-09-21 唯讀盤查，所有 file:line 以該份為準）。

**基線分支：** `feat/tenant-scope`（HEAD `0b88db11`，已含第 1、2 部並已併入 master）。**不是 master。**

---

## Global Constraints

- **全跑測試一律 `cd app && npm run test:quiet`**（含 `--runInBand`），不要 `npx jest` 跑全跑。單檔用 `cd app && npx jest server/tests/<檔名> --runInBand`。
- **基線自己量**：動手前在當前 HEAD 跑一次全跑，記下 `Test Suites:` 與 `Tests:`。不要沿用別人給的數字。
- **exit code 不經管線**：`npm run test:quiet > out 2>&1; echo "EXITCODE=$?" >> out`，再讀檔。判紅綠看 `Tests:` 那一行與 EXITCODE，兩個都要寫進報告。
- **看不到要回 404，不是 403**。403 等於告訴對方「這個 id 存在，只是你不能看」。唯二可以回 403 的情境：平台管理員限定的端點、以及「看得到但不能做這個動作」（例如不能按上正式）。
- **內部公司不特判**。任何 `if (actor.isInternal)` 的捷徑都是錯的。內部公司看得到全部，是因為遷移把全部綁給它了。
- **`req.isAdmin` 語意不可改**（＝`role === 'admin'`）。公司管理員的旗標是 `req.actor.isCompanyAdmin`，永遠不併進 `isAdmin`。
- **`is_internal` 任何 API 都不可設定**。它只在 `tools/migrate-tenants.js` 寫過一次。部分唯一索引 `companies_internal_idx` 保證全表最多一列 true。
- **新布林旗標一律 DEFAULT 安全值**，只有一條路徑寫危險值（`.claude/rules/db-schema.md` #43）。改 DEFAULT 對既有列無效（#40）。
- 加欄位走 `db.js` 的 `colMigrations` 陣列（`{ table, col, sql }`），**不改 `CREATE TABLE`**。
- route 層測試的授權**走 `createApp` ＋ `/api/auth/setup`／`/api/auth/login` 取 token，不要用私有 `jwt.sign`**——私有 signer 繞過真實授權路徑，測不到 guard。
- **絕不可為了讓測試過，把 fixture 帳號改成 `role='admin'`**。正確形狀是「帳號維持一般使用者 ＋ 建一家公司 ＋ 綁上該測試的專案 ＋ 設 `company_id`」，讓檢查真的跑過並通過。唯一例外是「那個端點本來就只給管理員」。
- **既有測試紅了不要偷偷改它讓它綠**——回報，由控制者裁決。
- 時間戳一律 `TIMESTAMPTZ`。**禁止寫死絕對路徑**。註解用繁體中文寫「為什麼」。零順手重構。
- **commit 用 `git add <明確路徑>` ＋ `git commit`**，禁用 `git add -A`。commit 後跑 `git status --porcelain -uno` 確認沒殘留。
- pg-mem 限制：表在測試間不清空；不支援相關子查詢；不支援 `btrim`；`information_schema.columns.is_nullable` 永遠回 `'NO'`；**`<欄位> IS NULL` 出現在 UPDATE 的 WHERE 時，只要前面有 SELECT 用過同一個條件，UPDATE 就會靜默影響 0 列**。

---

## 本計畫刻意不做（留給第 3 部 b 或之後）

寫在這裡是為了讓執行者知道什麼**不該**做——第 2 部就是因為漏寫這份清單，把考試系統整個弄丟。

- **前端（規格 §5.5）**：nav／router guard／畫面三處齊做，全部留給 **3b**。本計畫只改後端，所以做完之後那 7 個內部一般使用者會看到「按鈕還在、按下去 403」——這是已知且刻意的中間狀態，3b 補上。
- **子專案 2（客戶自帶 API key）**：`companies.anthropic_api_key_enc` 等欄位不在本計畫。
- **客戶離開流程**（公司資料怎麼交付與刪除）：子專案 4。
- **考試題庫分家**：`exam_banks` 沒有任何擁有者欄位（實查：`db.js` 的 `CREATE TABLE exam_banks` 只有 `id/label/odoo_version/status/taken_at/created_at`），所以功能開關只能管「這家公司的人能不能用考試」，**不能把題庫依公司分開**。兩家公司都開了考試功能就會共用同一份題庫。本計畫不處理分家。
- **已排入佇列的考試判題不會被中止**：判題走 `lib/exam/review.js` 自己的 `spawn('claude')`（`review.js:402`），不接 `AbortController`、不進 `_inFlight`、不進通行證表，唯一會讓它停的是它自己的逾時計時器。所以「公司被停用」與「功能被關掉」都只擋得住**新的**排入，擋不住已經在跑的那一輪。本計畫把閘門放在排入的入口，並把這個限制寫進註解。

---

## 檔案結構

| 檔案 | 職責 |
|---|---|
| `app/server/db.js` | 加一個欄位 `companies.features`（JSONB）到 `colMigrations` |
| **新** `app/server/lib/company-features.js` | 功能開關的唯一真相：有哪些功能、預設值、`companyHasFeature`、`requireFeature` middleware |
| **新** `app/server/company-admin-routes.js` | 平台管理員：公司 CRUD、啟用期間、功能開關、綁專案與 `can_release`、公司 GIT |
| **新** `app/server/company-routes.js` | 公司管理員：管自家帳號（列出／新增／停用／在 `user`↔`company_admin` 間改角色） |
| `app/server/exam-routes.js`、`app/server/exam-upload-routes.js` | 24 支端點加上 `requireFeature('exam')` |
| `app/server/admin-routes.js` | 建立／修改帳號改成明確選公司，接上 `validateRoleCompany`，拿掉暫時預設值 |
| `app/server/auth.js` | 關閉自助註冊 `POST /api/auth/register`（不影響 `POST /api/auth/setup`） |
| `app/server/settings.js` | 對客戶公司成員隱藏 Odoo 帳密與同步設定 |
| `app/server/pipeline/runner.js` | 匯出依公司中止在飛任務所需的資訊 |
| `app/server/index.js` | 註冊兩個新路由檔 |

---

## Task 0：開工前置（worktree ＋ 基線）

**Files:** 無

- [ ] **Step 1：確認在對的分支上**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
git log --oneline -1          # 應為 0b88db11 或其後代
git status --porcelain        # 應為空
```
不是的話停下來回報。**不要**在 master 上做。

- [ ] **Step 2：量基線**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope/app
npm run test:quiet > /tmp/baseline.log 2>&1; echo "EXITCODE=$?" >> /tmp/baseline.log
tail -8 /tmp/baseline.log
```
把 `Test Suites:` 與 `Tests:` 兩行記進報告。那是基線，之後每個紅燈都先當成自己造成的。

---

## Task 1：功能開關的地基

**Files:**
- Modify: `app/server/db.js`（`colMigrations` 陣列加一筆）
- Create: `app/server/lib/company-features.js`
- Test: `app/server/tests/company-features.test.js`（新）

**Interfaces:**
- Produces:
  - `FEATURES` — `{ exam: { key: 'exam', label: '考試系統', defaultForCustomer: false } }`
  - `async companyHasFeature(companyId, key) -> Promise<boolean>`
  - `requireFeature(key) -> (req, res, next)` Express middleware
  - `normalizeFeatures(input) -> object`（只留認得的 key，值強制成布林）

**為什麼是 JSONB 一欄而不是一欄一個布林：** 每加一個可開關的功能就得再加一次 DB 欄位、再改一次 migration，而功能會一直加。JSONB 一欄存 `{ "exam": true }`，加功能只要在 `FEATURES` 加一筆常數。代價是 DB 層沒有型別保護，所以 `normalizeFeatures` 要在寫入前把不認得的 key 丟掉。

**內部公司一律當成有全部功能。** 遷移把既有 17 個專案與 7 個一般使用者全綁在內部公司，而它的 `features` 是 NULL。如果照「沒設過＝沒開」處理，這一關一上線，那 7 個同事**當天就不能考試了**——正好是使用者 2026-09-21 明確否決的結果。用 `is_internal` 判斷而不是回填資料，是因為回填只能顧到今天有的功能；以後加第二個功能時沒人會記得回頭補那一列，而那種錯誤沒有任何徵狀。

**「沒有公司」一律當成有全部功能。** 平台管理員沒有公司；遷移之前一般帳號也還沒有。寫反會把平台管理員鎖在自己的平台外面——這個錯誤第 2 部已經犯過一次（`isUserCompanyUsable` 的 LEFT JOIN 版本），不要再犯。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/company-features.test.js`：

```javascript
/**
 * company-features.test.js — 公司功能開關（規格 §5.3 考試那一列，2026-09-21 使用者裁決）
 *
 * 為什麼要這支：考試系統本來就是給內部一般使用者考的，不能鎖成平台管理員限定；
 * 但客戶公司進來之後也不該看得到內部題庫。所以用「哪家公司能用哪些功能」來管。
 * 「沒有公司」一律當成有全部功能——平台管理員沒有公司，寫反會把管理員自己鎖死。
 */
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-feat-jwt';
process.env.APP_SECRET = 'test-feat-secret';

let dbModule, coOn, coOff, coDefault, coInternal, uOn, uOff, uNoCompany;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const mkCo = async (name, features) => (await one(
    'INSERT INTO companies (name, is_active, features) VALUES ($1, true, $2) RETURNING id',
    [name, features === undefined ? null : JSON.stringify(features)]
  )).id;
  coOn = await mkCo('有考試的公司', { exam: true });
  coOff = await mkCo('沒考試的公司', { exam: false });
  coDefault = await mkCo('沒設過的公司');   // features 是 NULL
  coInternal = (await one(
    'INSERT INTO companies (name, is_active, is_internal) VALUES ($1, true, true) RETURNING id', ['內部']
  )).id;                                     // features 也是 NULL，但它是內部公司

  const mkUser = async (username, companyId) => (await one(
    'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4) RETURNING id',
    [username, 'x', 'user', companyId]
  )).id;
  uOn = await mkUser('feat-on', coOn);
  uOff = await mkUser('feat-off', coOff);
  uNoCompany = await mkUser('feat-none', null);
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('companyHasFeature', () => {
  const { companyHasFeature } = require('../lib/company-features');

  test('公司開了 → true', async () => expect(await companyHasFeature(coOn, 'exam')).toBe(true));
  test('公司關了 → false', async () => expect(await companyHasFeature(coOff, 'exam')).toBe(false));
  test('公司沒設過（features 為 NULL）→ false（客戶預設不給）', async () => {
    expect(await companyHasFeature(coDefault, 'exam')).toBe(false);
  });
  test('沒有公司 → true（平台管理員沒有公司，寫反會把管理員鎖死）', async () => {
    expect(await companyHasFeature(null, 'exam')).toBe(true);
    expect(await companyHasFeature(undefined, 'exam')).toBe(true);
  });
  test('查不到那家公司 → true（不認識的不歸這支管，交給上游的授權擋）', async () => {
    expect(await companyHasFeature(999999, 'exam')).toBe(true);
  });
  test('內部公司 → true，即使 features 沒設過（這一條防的是把自己人鎖在外面）', async () => {
    expect(await companyHasFeature(coInternal, 'exam')).toBe(true);
  });
  test('內部公司連還沒發明的功能也算有（加新功能不必回頭補內部公司的資料）', async () => {
    expect(await companyHasFeature(coInternal, 'exam')).toBe(true);
    const row = await one('SELECT features FROM companies WHERE id = $1', [coInternal]);
    expect(row.features).toBe(null);
  });
  test('不認得的功能名稱 → false（打錯字不該變成全開）', async () => {
    expect(await companyHasFeature(coOn, 'no-such-feature')).toBe(false);
  });
});

describe('normalizeFeatures', () => {
  const { normalizeFeatures } = require('../lib/company-features');

  test('只留認得的 key，值強制成布林', () => {
    expect(normalizeFeatures({ exam: 'yes', bogus: true })).toEqual({ exam: true });
  });
  test('null／非物件 → 空物件', () => {
    expect(normalizeFeatures(null)).toEqual({});
    expect(normalizeFeatures('exam')).toEqual({});
  });
});

describe('requireFeature middleware', () => {
  const { requireFeature } = require('../lib/company-features');
  const mkRes = () => {
    const res = { code: null, body: null };
    res.status = c => { res.code = c; return res; };
    res.json = b => { res.body = b; return res; };
    return res;
  };

  test('有功能 → 放行', async () => {
    const res = mkRes(); let nexted = false;
    await requireFeature('exam')({ actor: { companyId: coOn } }, res, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(res.code).toBe(null);
  });

  test('沒有功能 → 404，訊息不說「你沒權限」（說了等於告訴對方這功能存在）', async () => {
    const res = mkRes(); let nexted = false;
    await requireFeature('exam')({ actor: { companyId: coOff } }, res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.code).toBe(404);
  });

  test('沒有 actor（未登入就到這支）→ 404，不當成「沒有公司」放行', async () => {
    const res = mkRes(); let nexted = false;
    await requireFeature('exam')({}, res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.code).toBe(404);
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/company-features.test.js --runInBand 2>&1 | tail -25
```
Expected：FAIL，`Cannot find module '../lib/company-features'`。

- [ ] **Step 3：加 DB 欄位**

在 `app/server/db.js` 的 `colMigrations` 陣列**尾端**加一筆（緊接在 `users.company_id` 那一筆之後的位置即可）：

```javascript
    // 公司功能開關（規格 §5.3 考試那一列，2026-09-21 使用者裁決）：哪家公司能用哪些功能。
    // 用 JSONB 一欄而不是一欄一個布林——功能會一直加，每加一個就改一次 schema 划不來。
    // 預設 NULL＝什麼功能都沒開（客戶安全值）；「沒有公司」的人（平台管理員）由程式判斷為全開，不靠這個欄位。
    { table: 'companies', col: 'features', sql: 'ALTER TABLE companies ADD COLUMN features JSONB' },
```

- [ ] **Step 4：寫 `app/server/lib/company-features.js`**

```javascript
/**
 * company-features.js — 「哪家公司能用哪些功能」的唯一真相。
 *
 * 為什麼需要它：考試系統是給內部一般使用者考的，不能用角色鎖（鎖了他們就不能考）；
 * 但客戶公司也不該看得到內部題庫。所以改用公司層級的功能開關。
 */
const { query } = require('../db');

// 可被開關的功能。加新功能只要在這裡加一筆，不必動 DB schema。
// defaultForCustomer 目前一律 false：新客戶預設什麼加值功能都沒開，要平台管理員明確開。
const FEATURES = {
  exam: { key: 'exam', label: '考試系統', defaultForCustomer: false },
};

// 只留認得的 key、值強制成布林。寫進 DB 之前一定要過這一關——
// JSONB 沒有型別保護，不過濾的話前端傳什麼就存什麼，下次讀出來判斷會歪掉。
function normalizeFeatures(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const key of Object.keys(FEATURES)) {
    if (key in input) out[key] = input[key] === true || input[key] === 'true';
  }
  return out;
}

// 「這家公司能不能用這個功能」。
// 沒有公司 ⇒ true：平台管理員沒有公司，寫反會把管理員鎖在自己的平台外面。
// 查不到公司 ⇒ true：不認識的人不歸這支管，交給上游的授權擋（與 isUserCompanyUsable 同一條原則）。
// 不認得的功能名稱 ⇒ false：打錯字不該變成全開。
async function companyHasFeature(companyId, key) {
  if (!FEATURES[key]) return false;
  if (companyId === null || companyId === undefined || companyId === '') return true;
  const { rows } = await query('SELECT is_internal, features FROM companies WHERE id = $1', [companyId]);
  if (!rows[0]) return true;
  // 內部公司一律全開。這不是「對內部公司開後門」那種被禁止的捷徑——
  // 那條禁令講的是「看得到哪些專案」，那裡內部公司必須跟別家一樣靠綁定拿權限。
  // 功能開關問的是另一件事：「這是不是我們自己」。答案是的時候，全部功能本來就都是我們的。
  // 這樣寫還有一個實際好處：以後加第 N 個功能，不必回頭補內部公司那一列資料，
  // 忘了補就會把自己的同事鎖在外面——而那種錯誤沒有任何徵狀，只會有人說「我的考試不見了」。
  if (rows[0].is_internal === true) return true;
  const f = rows[0].features;
  const parsed = typeof f === 'string' ? JSON.parse(f) : f;
  return normalizeFeatures(parsed)[key] === true;
}

// Express middleware，放在 verifyToken 之後。
// 沒有功能一律回 404 不回 403——403 等於告訴對方「這個功能存在，只是你不能用」。
// 沒有 req.actor 也回 404：能走到這裡代表 verifyToken 沒擋下來，但我們不把「沒有身分」
// 當成「沒有公司」放行，那會讓未登入路徑變成全開。
function requireFeature(key) {
  return async (req, res, next) => {
    try {
      if (!req.actor) return res.status(404).json({ error: '找不到這個功能' });
      if (!(await companyHasFeature(req.actor.companyId, key))) {
        return res.status(404).json({ error: '找不到這個功能' });
      }
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

module.exports = { FEATURES, normalizeFeatures, companyHasFeature, requireFeature };
```

- [ ] **Step 5：跑測試確認它綠**

```bash
cd app && npx jest server/tests/company-features.test.js --runInBand 2>&1 | tail -15
```
Expected：16 passed。

- [ ] **Step 6：全跑**

```bash
cd app && npm run test:quiet > /tmp/t1.log 2>&1; echo "EXITCODE=$?" >> /tmp/t1.log; tail -8 /tmp/t1.log
```
Expected：`0 failed`，通過數＝基線＋本支新測試數。有落差就逐支查清楚再往下。

- [ ] **Step 7：commit**

```bash
git add app/server/db.js app/server/lib/company-features.js app/server/tests/company-features.test.js
git commit -m "[Tenant]: 考試不能用角色鎖（鎖了內部同事就不能考），改用公司層級的功能開關"
git status --porcelain -uno
```

---

## Task 2：考試的 24 支端點掛上功能開關

**Files:**
- Modify: `app/server/exam-routes.js`（6 支）
- Modify: `app/server/exam-upload-routes.js`（18 支）
- Test: `app/server/tests/exam-feature-gate.test.js`（新）

**Interfaces:**
- Consumes: `requireFeature(key)`、`companyHasFeature(companyId, key)`（Task 1）

**為什麼這一關存在：** 考試那 24 支端點目前只掛 `verifyToken`——任何登入的人都能讀內部題庫、開新考試、觸發 AI 判題。今天沒事是因為平台上只有內部公司一家；**第一家客戶公司建立之前，這一關必須先上**。

**三種入口要分開處理**（先讀過 `exam-upload-routes.js` 的 `checkExamToken`，約 `:54` 起，再動手）：

| 入口 | 目前的守衛 | 這一關怎麼做 |
|---|---|---|
| 22 支掛 `verifyToken` 的 | `verifyToken` | 在 `verifyToken` **之後**插 `requireFeature('exam')` |
| `POST /api/exam/submit`（`:234`）、`POST /api/exam/batch`（`:272`） | `checkExamToken` | 見 Step 3 |
| 本機請求、共用 X-Token | `checkExamToken` 的前兩條路 | **不加檢查**，理由見 Step 3 註解 |

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/exam-feature-gate.test.js`：

```javascript
/**
 * exam-feature-gate.test.js — 考試端點依公司功能開關放行（規格 §5.3、2026-09-21 使用者裁決）
 *
 * 為什麼：24 支考試端點原本只要求「有登入」，客戶公司一旦存在就摸得到內部題庫。
 * 沒開這個功能的公司一律看到 404——不是 403，403 等於告訴對方「這個功能存在」。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-examgate-jwt';
process.env.APP_SECRET = 'test-examgate-secret';

let app, dbModule, adminToken, onToken, offToken;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });

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

  const mkCo = async (name, features) => (await one(
    'INSERT INTO companies (name, is_active, features) VALUES ($1, true, $2) RETURNING id',
    [name, JSON.stringify(features)]
  )).id;
  const coOn = await mkCo('有考試的公司', { exam: true });
  const coOff = await mkCo('沒考試的公司', { exam: false });

  const mkUser = async (username, companyId) => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id, approved) VALUES ($1,$2,$1,$3,$4,true)',
      [username, hash, 'user', companyId]
    );
    return (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
  };
  onToken = await mkUser('exam-on', coOn);
  offToken = await mkUser('exam-off', coOff);
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('沒開考試功能的公司', () => {
  test('讀題庫清單 → 404', async () => {
    expect((await request(app).get('/api/exam/banks').set(as(offToken))).status).toBe(404);
  });
  test('開新考試 → 404（寫入端點也要擋，只擋讀的等於沒擋）', async () => {
    expect((await request(app).post('/api/exam/banks').set(as(offToken))
      .send({ label: 'x', odoo_version: '17' })).status).toBe(404);
  });
  test('觸發 AI 判題 → 404（這支會燒錢，最該擋）', async () => {
    expect((await request(app).post('/api/exam/run').set(as(offToken)).send({ bankId: 1 })).status).toBe(404);
  });
  test('拿上傳用的共用 token → 404（拿得到就能繞過所有 verifyToken 的檢查）', async () => {
    expect((await request(app).post('/api/exam/upload-token').set(as(offToken))).status).toBe(404);
  });
});

describe('開了考試功能的公司', () => {
  test('讀題庫清單 → 不是 404（功能開關放行，後面照原本的邏輯走）', async () => {
    expect((await request(app).get('/api/exam/banks').set(as(onToken))).status).not.toBe(404);
  });
});

describe('平台管理員（沒有公司）', () => {
  test('照常可用——沒有公司一律當成全開，寫反會把管理員自己鎖死', async () => {
    expect((await request(app).get('/api/exam/banks').set(as(adminToken))).status).not.toBe(404);
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/exam-feature-gate.test.js --runInBand 2>&1 | tail -25
```
Expected：`沒開考試功能的公司` 那四支全紅（實際拿到 200 或其他非 404 狀態），因為現在什麼都沒擋。

- [ ] **Step 3：實作**

兩個檔案頂部各加：

```javascript
const { requireFeature, companyHasFeature } = require('./lib/company-features');
```

**(a) 22 支掛 `verifyToken` 的**：把 `verifyToken` 後面插一個 `requireFeature('exam')`。例（`exam-routes.js:25`）：

```javascript
// 變更前
app.get('/api/exam/banks', verifyToken, async (req, res) => {
// 變更後
app.get('/api/exam/banks', verifyToken, requireFeature('exam'), async (req, res) => {
```

逐支照做，**一支都不能漏**。`exam-routes.js` 6 支在 `:25,43,66,77,126,173`；`exam-upload-routes.js` 掛 `verifyToken` 的 16 支在 `:221,228,323,358,377,389,403,508,532,551,569,631,657,685,719,744`。行號是 2026-09-21 盤查時的值，動過就會位移——**以「這一支掛了 `verifyToken`」為準去找，不要照行號硬插**。

**(b) `POST /api/exam/submit`（`:234`）與 `POST /api/exam/batch`（`:272`）**：這兩支掛的是 `checkExamToken`，它有三條路（本機、Bearer JWT、共用 X-Token），**沒有 `req.actor`**，所以套不上 `requireFeature`。

先讀 `checkExamToken`（`exam-upload-routes.js:54` 起）確認它的實際形狀，然後只在**Bearer JWT 那一條路**補上檢查：驗完簽章、拿到 `userId` 之後，查該使用者的 `company_id` 再問 `companyHasFeature`。沒過就回 404。

```javascript
// checkExamToken 的 Bearer 分支，驗完簽章拿到 userId 之後補：
// 為什麼只補這一條路：
//   本機請求＝這台主機上的截圖工具，不是客戶進得來的路；
//   共用 X-Token 只能從 POST /api/exam/upload-token 拿，而那一支已經掛上 requireFeature，
//   所以沒開考試功能的公司根本拿不到 token，不必在這裡重複擋。
const { rows: fr } = await query('SELECT company_id FROM users WHERE id = $1', [userId]);
if (!(await companyHasFeature(fr[0] ? fr[0].company_id : null, 'exam'))) {
  return res.status(404).json({ error: '找不到這個功能' });
}
```

⚠ 如果 `checkExamToken` 的實際結構跟這裡描述的不一樣（例如三條路不是分支而是依序 fallback），**停下來回報，不要自己改寫它的控制流程**。

**(c) 已排入佇列的判題擋不住**：在 `exam-upload-routes.js` 的 `scheduleQueue`（`:178` 起）上方加註解：

```javascript
// ⚠ 已知限制：這個閘門只擋得住「新的排入」。已經在跑的判題走 lib/exam/review.js 自己的
// spawn('claude')（review.js:402），不接 AbortController、不進 _inFlight、不進通行證表，
// 唯一會讓它停的是它自己的逾時計時器。所以公司被停用或功能被關掉時，正在跑的那一輪會跑完。
// 要真的能中止，得先讓 review.js 走平台的 runClaude 通道——不在第 3 部 a 的範圍。
```

- [ ] **Step 4：跑測試確認它綠**

```bash
cd app && npx jest server/tests/exam-feature-gate.test.js --runInBand 2>&1 | tail -15
```
Expected：6 passed。

- [ ] **Step 5：自己數一次，證明沒漏**

```bash
cd app/server
grep -c "requireFeature('exam')" exam-routes.js exam-upload-routes.js
```
Expected：`exam-routes.js:6`、`exam-upload-routes.js:16`。數字對不上就是漏了，把漏的補完再往下。把這兩行輸出貼進報告——**沒有這個證據，就當作沒數過**。

- [ ] **Step 6：全跑**

```bash
cd app && npm run test:quiet > /tmp/t2.log 2>&1; echo "EXITCODE=$?" >> /tmp/t2.log; tail -8 /tmp/t2.log
```
⚠ 既有的考試測試可能因為 fixture 沒有公司而變色。**沒有公司應該一律放行**，若因此紅了代表實作把「沒有公司」判成沒功能，那就是寫反了。真的紅了先回報，不要自己改既有測試。

- [ ] **Step 7：commit**

```bash
git add app/server/exam-routes.js app/server/exam-upload-routes.js app/server/tests/exam-feature-gate.test.js
git commit -m "[Tenant]: 考試 24 支端點只要求「有登入」，客戶公司一建立就摸得到內部題庫"
git status --porcelain -uno
```

---

## Task 3：平台管理員的公司管理（建立、啟用期間、功能開關）

**Files:**
- Create: `app/server/company-admin-routes.js`
- Modify: `app/server/index.js`（註冊路由）
- Test: `app/server/tests/company-admin-routes.test.js`（新）

**Interfaces:**
- Consumes: `requirePlatformAdmin`（`lib/tenant-access.js`）、`normalizeFeatures`、`FEATURES`（Task 1）
- Produces：以下端點，Task 4、5 會往同一個檔案加更多
  - `GET /api/admin/companies` → `[{ id, name, is_active, is_internal, active_from, active_until, features, git_login, has_git_pat, user_count, project_count }]`
  - `POST /api/admin/companies` → 201 `{ id, name, ... }`
  - `PUT /api/admin/companies/:id` → 200 同形狀
  - `GET /api/admin/companies/features` → `[{ key, label }]`（給前端畫勾選框用）

**硬規則：`is_internal` 永遠不可經 API 設定。** 建立與修改都必須忽略它。客戶公司被誤標成內部，就會用平台的訂閱去跑客戶的 AI——那是違約，不是小 bug。部分唯一索引 `companies_internal_idx` 是最後一道防線，但不要依賴它擋（它擋下來時使用者看到的是 500）。

**`is_active` 建立時預設 false。** 規格 §4.1 明訂；要啟用就明確帶 `is_active: true`。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/company-admin-routes.test.js`：

```javascript
/**
 * company-admin-routes.test.js — 平台管理員的公司管理（規格 §5.3「新增 公司管理（admin）」）
 *
 * 為什麼要這支：公司表從第 1 部就存在，但至今沒有任何端點能建立或修改公司——
 * 唯一寫過它的是一次性遷移腳本。沒有這一關，就沒有辦法建立第一家客戶公司。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-coadmin-jwt';
process.env.APP_SECRET = 'test-coadmin-secret';

let app, dbModule, adminToken, userToken;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });

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

  const co = (await one('INSERT INTO companies (name, is_active) VALUES ($1, true) RETURNING id', ['既有公司'])).id;
  const hash = await bcrypt.hash('password123', 10);
  await dbModule.query(
    'INSERT INTO users (username, password_hash, display_name, role, company_id, approved) VALUES ($1,$2,$1,$3,$4,true)',
    ['plain', hash, 'user', co]
  );
  userToken = (await request(app).post('/api/auth/login').send({ username: 'plain', password: 'password123' })).body.token;
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('授權', () => {
  test('一般使用者列公司 → 403（這是平台管理員限定的工具，不是「看不到」）', async () => {
    expect((await request(app).get('/api/admin/companies').set(as(userToken))).status).toBe(403);
  });
  test('一般使用者建公司 → 403', async () => {
    expect((await request(app).post('/api/admin/companies').set(as(userToken)).send({ name: 'x' })).status).toBe(403);
  });
  test('未登入 → 401', async () => {
    expect((await request(app).get('/api/admin/companies')).status).toBe(401);
  });
});

describe('建立公司', () => {
  test('預設不啟用（規格 §4.1：預設安全值，要啟用得明確帶）', async () => {
    const res = await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '甲客戶' });
    expect(res.status).toBe(201);
    expect(res.body.is_active).toBe(false);
    expect(res.body.is_internal).toBe(false);
  });

  test('帶 is_internal: true 會被忽略——誤標成內部就是拿平台的訂閱跑客戶的 AI', async () => {
    const res = await request(app).post('/api/admin/companies').set(as(adminToken))
      .send({ name: '乙客戶', is_internal: true });
    expect(res.status).toBe(201);
    expect(res.body.is_internal).toBe(false);
    const row = await one('SELECT is_internal FROM companies WHERE id = $1', [res.body.id]);
    expect(row.is_internal).toBe(false);
  });

  test('名稱重複 → 409', async () => {
    await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '丙客戶' });
    const res = await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '丙客戶' });
    expect(res.status).toBe(409);
  });

  test('沒給名稱 → 400', async () => {
    expect((await request(app).post('/api/admin/companies').set(as(adminToken)).send({})).status).toBe(400);
  });

  test('功能開關：認得的存下來，不認得的丟掉', async () => {
    const res = await request(app).post('/api/admin/companies').set(as(adminToken))
      .send({ name: '丁客戶', features: { exam: true, bogus: true } });
    expect(res.status).toBe(201);
    expect(res.body.features).toEqual({ exam: true });
  });
});

describe('修改公司', () => {
  test('改啟用與使用期間', async () => {
    const id = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '戊客戶' })).body.id;
    const res = await request(app).put(`/api/admin/companies/${id}`).set(as(adminToken))
      .send({ is_active: true, active_until: '2030-01-01T00:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(true);
    expect(new Date(res.body.active_until).getUTCFullYear()).toBe(2030);
  });

  test('改 is_internal 一樣被忽略', async () => {
    const id = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '己客戶' })).body.id;
    await request(app).put(`/api/admin/companies/${id}`).set(as(adminToken)).send({ is_internal: true });
    const row = await one('SELECT is_internal FROM companies WHERE id = $1', [id]);
    expect(row.is_internal).toBe(false);
  });

  test('改不存在的公司 → 404', async () => {
    expect((await request(app).put('/api/admin/companies/999999').set(as(adminToken)).send({ is_active: true })).status).toBe(404);
  });

  test('沒帶的欄位不動（部分更新不可以把別的欄位洗成 null）', async () => {
    const id = (await request(app).post('/api/admin/companies').set(as(adminToken))
      .send({ name: '庚客戶', features: { exam: true } })).body.id;
    await request(app).put(`/api/admin/companies/${id}`).set(as(adminToken)).send({ is_active: true });
    const res = await request(app).get('/api/admin/companies').set(as(adminToken));
    const row = res.body.find(c => c.id === id);
    expect(row.features).toEqual({ exam: true });
    expect(row.name).toBe('庚客戶');
  });
});

describe('列出公司', () => {
  test('不回傳 PAT 密文，只回「有沒有設」', async () => {
    const id = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '辛客戶' })).body.id;
    await dbModule.query('UPDATE companies SET git_pat_enc = $1 WHERE id = $2', ['fake-cipher', id]);
    const res = await request(app).get('/api/admin/companies').set(as(adminToken));
    const row = res.body.find(c => c.id === id);
    expect(row.has_git_pat).toBe(true);
    expect(row.git_pat_enc).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('fake-cipher');
  });
});

describe('功能清單', () => {
  test('回得出可勾選的功能（前端要拿它畫勾選框）', async () => {
    const res = await request(app).get('/api/admin/companies/features').set(as(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.some(f => f.key === 'exam')).toBe(true);
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/company-admin-routes.test.js --runInBand 2>&1 | tail -25
```
Expected：全紅（404），因為端點不存在。

- [ ] **Step 3：寫 `app/server/company-admin-routes.js`**

```javascript
/**
 * company-admin-routes.js — 平台管理員的公司管理（規格 §5.3「新增 公司管理（admin）」）。
 *
 * 為什麼另開一個檔案而不是塞進 admin-routes.js：admin-routes.js 已經很大，
 * 而公司管理是一整塊有自己生命週期的東西（公司、綁專案、公司 GIT、功能開關）。
 *
 * is_internal 在這個檔案裡永遠是唯讀的——它只在一次性遷移時被寫過一次。
 * 客戶公司被誤標成內部，平台就會拿自己的 AI 訂閱去跑客戶的工作，那是違約。
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { requirePlatformAdmin } = require('./lib/tenant-access');
const { FEATURES, normalizeFeatures } = require('./lib/company-features');

const auth = [verifyToken, requirePlatformAdmin];

// 回給前端的公司形狀。git_pat_enc 永遠不出現——只回「有沒有設」。
const listSql = `
  SELECT c.id, c.name, c.is_active, c.is_internal, c.active_from, c.active_until,
         c.features, c.git_login, c.git_name, c.git_email,
         (c.git_pat_enc IS NOT NULL) AS has_git_pat,
         (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id)::int AS user_count,
         (SELECT COUNT(*) FROM project_companies pc WHERE pc.company_id = c.id)::int AS project_count
    FROM companies c`;

function shape(row) {
  return { ...row, features: normalizeFeatures(typeof row.features === 'string' ? JSON.parse(row.features) : row.features) };
}

function registerRoutes(app) {
  app.get('/api/admin/companies/features', auth, async (req, res) => {
    res.json(Object.values(FEATURES).map(f => ({ key: f.key, label: f.label })));
  });

  app.get('/api/admin/companies', auth, async (req, res) => {
    try {
      const { rows } = await query(`${listSql} ORDER BY c.is_internal DESC, c.name`);
      res.json(rows.map(shape));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/companies', auth, async (req, res) => {
    try {
      const { name, is_active, active_from, active_until, features } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: '缺公司名稱' });
      // is_internal 刻意不從 req.body 取：只有遷移腳本寫過它，API 一律建一般公司。
      const { rows } = await query(
        `INSERT INTO companies (name, is_active, active_from, active_until, features)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [String(name).trim(), is_active === true, active_from || null, active_until || null,
         JSON.stringify(normalizeFeatures(features))]
      );
      const { rows: out } = await query(`${listSql} WHERE c.id = $1`, [rows[0].id]);
      res.status(201).json(shape(out[0]));
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '公司名稱已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/companies/:id', auth, async (req, res) => {
    try {
      const { name, is_active, active_from, active_until, features } = req.body || {};
      // COALESCE 讓「沒帶的欄位不動」；features 要能被改成 {}，所以用「有沒有這個 key」判斷而不是 truthy。
      const featuresArg = ('features' in (req.body || {})) ? JSON.stringify(normalizeFeatures(features)) : null;
      const { rows } = await query(
        `UPDATE companies SET
           name         = COALESCE($2, name),
           is_active    = COALESCE($3, is_active),
           active_from  = COALESCE($4, active_from),
           active_until = COALESCE($5, active_until),
           features     = COALESCE($6::jsonb, features),
           updated_at   = NOW()
         WHERE id = $1 RETURNING id`,
        [req.params.id,
         name ? String(name).trim() : null,
         typeof is_active === 'boolean' ? is_active : null,
         active_from || null, active_until || null, featuresArg]
      );
      if (!rows.length) return res.status(404).json({ error: '找不到這家公司' });
      const { rows: out } = await query(`${listSql} WHERE c.id = $1`, [req.params.id]);
      res.json(shape(out[0]));
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '公司名稱已存在' });
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
```

⚠ `active_from`／`active_until` 用 `COALESCE` 代表**沒辦法把它改回 NULL**（「不限期間」）。這是已知取捨：本關先求能設，清除期間留給 3b 的畫面一起處理。把這件事寫進報告，不要自己加 `clear_active_until` 之類的參數。

- [ ] **Step 4：在 `index.js` 註冊**

頂部 require 區（與其他 route 檔並列）：

```javascript
const { registerRoutes: registerCompanyAdminRoutes } = require('./company-admin-routes');
```

`createApp()` 內，與其他 `registerXxxRoutes(app)` 並列：

```javascript
  registerCompanyAdminRoutes(app);
```

- [ ] **Step 5：跑測試確認它綠**

```bash
cd app && npx jest server/tests/company-admin-routes.test.js --runInBand 2>&1 | tail -15
```
Expected：13 passed。

- [ ] **Step 6：全跑 ＋ commit**

```bash
cd app && npm run test:quiet > /tmp/t3.log 2>&1; echo "EXITCODE=$?" >> /tmp/t3.log; tail -8 /tmp/t3.log
cd .. && git add app/server/company-admin-routes.js app/server/index.js app/server/tests/company-admin-routes.test.js
git commit -m "[Tenant]: 公司表從第 1 部就在，卻沒有任何端點能建公司——第一家客戶根本建不出來"
git status --porcelain -uno
```

---

## Task 4：綁專案與「可上正式」

**Files:**
- Modify: `app/server/company-admin-routes.js`
- Test: `app/server/tests/company-admin-bindings.test.js`（新）

**Interfaces:**
- Produces:
  - `GET /api/admin/companies/:id/projects` → `[{ project_id, name, can_release }]`
  - `PUT /api/admin/companies/:id/projects/:projectId` → 200 `{ project_id, company_id, can_release }`（沒綁就建、已綁就改 `can_release`）
  - `DELETE /api/admin/companies/:id/projects/:projectId` → 204

**硬規則：內部公司的綁定 `can_release` 必須是 false**（規格 §4.3）。內部公司綁了全部 17 個專案，給它 `can_release` 等於每個內部成員都能對任何專案按上正式。

**為什麼解除綁定要小心：** 解除之後那家公司的人對該專案立刻 404——包含他們自己開的任務。這是設計本意，但要讓操作的人知道，所以 `GET` 要回得出該公司在那個專案底下有幾張任務。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/company-admin-bindings.test.js`：

```javascript
/**
 * company-admin-bindings.test.js — 公司↔專案綁定與「可上正式」（規格 §4.3、§5.3）
 *
 * 綁定就是可視範圍本身：綁了才看得到，解除立刻看不到。
 * can_release 另外控制「能不能按上正式」，預設不給。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-bind-jwt';
process.env.APP_SECRET = 'test-bind-secret';

let app, dbModule, adminToken, coCustomer, coInternal, projectId;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });

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

  coInternal = (await one('INSERT INTO companies (name, is_active, is_internal) VALUES ($1,true,true) RETURNING id', ['內部'])).id;
  coCustomer = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '甲客戶' })).body.id;
  projectId = (await one("INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", ['測試專案'])).id;
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('綁定', () => {
  test('綁上去，can_release 預設 false', async () => {
    const res = await request(app).put(`/api/admin/companies/${coCustomer}/projects/${projectId}`)
      .set(as(adminToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body.can_release).toBe(false);
    const row = await one('SELECT can_release FROM project_companies WHERE project_id=$1 AND company_id=$2',
      [projectId, coCustomer]);
    expect(row.can_release).toBe(false);
  });

  test('重複綁同一個專案不會爆（改成更新 can_release）', async () => {
    const res = await request(app).put(`/api/admin/companies/${coCustomer}/projects/${projectId}`)
      .set(as(adminToken)).send({ can_release: true });
    expect(res.status).toBe(200);
    expect(res.body.can_release).toBe(true);
  });

  test('內部公司不准勾可上正式（它綁了全部專案，勾了等於全員可上正式）', async () => {
    const res = await request(app).put(`/api/admin/companies/${coInternal}/projects/${projectId}`)
      .set(as(adminToken)).send({ can_release: true });
    expect(res.status).toBe(400);
    const row = await one('SELECT can_release FROM project_companies WHERE project_id=$1 AND company_id=$2',
      [projectId, coInternal]);
    expect(row === undefined || row.can_release === false).toBe(true);
  });

  test('內部公司可以綁專案，只是 can_release 一定 false', async () => {
    const res = await request(app).put(`/api/admin/companies/${coInternal}/projects/${projectId}`)
      .set(as(adminToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body.can_release).toBe(false);
  });

  test('綁不存在的專案 → 404', async () => {
    expect((await request(app).put(`/api/admin/companies/${coCustomer}/projects/999999`)
      .set(as(adminToken)).send({})).status).toBe(404);
  });

  test('不存在的公司 → 404', async () => {
    expect((await request(app).put(`/api/admin/companies/999999/projects/${projectId}`)
      .set(as(adminToken)).send({})).status).toBe(404);
  });
});

describe('列出與解除', () => {
  test('列得出綁了哪些專案，含 can_release 與任務數（解除前要讓人知道會影響幾張單）', async () => {
    const res = await request(app).get(`/api/admin/companies/${coCustomer}/projects`).set(as(adminToken));
    expect(res.status).toBe(200);
    const row = res.body.find(r => r.project_id === projectId);
    expect(row.can_release).toBe(true);
    expect(typeof row.task_count).toBe('number');
  });

  test('解除綁定 → 204，DB 真的沒了', async () => {
    const res = await request(app).delete(`/api/admin/companies/${coCustomer}/projects/${projectId}`).set(as(adminToken));
    expect(res.status).toBe(204);
    const row = await one('SELECT 1 FROM project_companies WHERE project_id=$1 AND company_id=$2',
      [projectId, coCustomer]);
    expect(row).toBeUndefined();
  });

  test('解除沒綁過的 → 404（靜默成功會讓人以為解除了別的東西）', async () => {
    expect((await request(app).delete(`/api/admin/companies/${coCustomer}/projects/${projectId}`)
      .set(as(adminToken))).status).toBe(404);
  });
});

describe('授權', () => {
  test('一般使用者不能綁——但他連公司都看不到，先確認是 403 不是 404', async () => {
    const res = await request(app).put(`/api/admin/companies/${coCustomer}/projects/${projectId}`).send({});
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/company-admin-bindings.test.js --runInBand 2>&1 | tail -25
```

- [ ] **Step 3：實作——在 `company-admin-routes.js` 的 `registerRoutes` 內加**

```javascript
  app.get('/api/admin/companies/:id/projects', auth, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT pc.project_id, p.name, pc.can_release,
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = pc.project_id)::int AS task_count
           FROM project_companies pc JOIN projects p ON p.id = pc.project_id
          WHERE pc.company_id = $1 ORDER BY p.name`,
        [req.params.id]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/admin/companies/:id/projects/:projectId', auth, async (req, res) => {
    try {
      const wantRelease = req.body && req.body.can_release === true;
      const { rows: co } = await query('SELECT is_internal FROM companies WHERE id = $1', [req.params.id]);
      if (!co.length) return res.status(404).json({ error: '找不到這家公司' });
      const { rows: pj } = await query('SELECT 1 FROM projects WHERE id = $1', [req.params.projectId]);
      if (!pj.length) return res.status(404).json({ error: '找不到這個專案' });
      // 規格 §4.3：內部公司綁了全部專案，給它 can_release 等於每個內部成員都能按上正式。
      if (co[0].is_internal === true && wantRelease) {
        return res.status(400).json({ error: '內部公司的綁定不能勾「可上正式」' });
      }
      await query(
        `INSERT INTO project_companies (project_id, company_id, can_release) VALUES ($1,$2,$3)
         ON CONFLICT (project_id, company_id) DO UPDATE SET can_release = EXCLUDED.can_release`,
        [req.params.projectId, req.params.id, wantRelease]
      );
      // 不信任 ON CONFLICT ... RETURNING（pg-mem 在這個組合上回過錯的值），改重讀一次。
      const { rows } = await query(
        'SELECT project_id, company_id, can_release FROM project_companies WHERE project_id=$1 AND company_id=$2',
        [req.params.projectId, req.params.id]
      );
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/admin/companies/:id/projects/:projectId', auth, async (req, res) => {
    try {
      const { rows } = await query(
        'DELETE FROM project_companies WHERE project_id=$1 AND company_id=$2 RETURNING project_id',
        [req.params.projectId, req.params.id]
      );
      // 沒綁過卻回 204，操作的人會以為自己解除了某個東西。
      if (!rows.length) return res.status(404).json({ error: '這家公司沒有綁這個專案' });
      res.status(204).end();
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
```

⚠ **`ON CONFLICT ... RETURNING` 在 pg-mem 下會說謊**（本 repo 已記錄過：測試紅、正式對）。上面刻意分成「寫入」與「重讀」兩步就是為了這個。**不要為了少一次查詢把它改回 RETURNING。**

- [ ] **Step 4：跑測試 ＋ 全跑 ＋ commit**

```bash
cd app && npx jest server/tests/company-admin-bindings.test.js --runInBand 2>&1 | tail -15
cd app && npm run test:quiet > /tmp/t4.log 2>&1; echo "EXITCODE=$?" >> /tmp/t4.log; tail -8 /tmp/t4.log
cd .. && git add app/server/company-admin-routes.js app/server/tests/company-admin-bindings.test.js
git commit -m "[Tenant]: 沒有綁定端點，公司看得到哪些專案只能手改資料庫"
git status --porcelain -uno
```

---

## Task 5：公司 GIT 憑證（存之前先驗證真的連得上）

**Files:**
- Modify: `app/server/lib/git-identity.js`（抽出一個小函式，行為不變）
- Modify: `app/server/company-admin-routes.js`
- Test: `app/server/tests/company-admin-git.test.js`（新）

**Interfaces:**
- Produces:
  - `buildGitEnvFromPat(pat, { login, name, email }) -> object`（`git-identity.js` 新匯出）
  - `PUT /api/admin/companies/:id/git` → 200 `{ ok: true, checked: [{ repo_url, ok }] }`；驗證失敗回 400 且**不存**
  - `DELETE /api/admin/companies/:id/git` → 204

**為什麼存之前要驗（規格 §6）：** 公司 PAT 是「這家公司所有成員在沒有個人 PAT 時的退路」。存了一個沒有權限的 PAT，症狀會出現在很後面——某次自動部署或夜間推送失敗，而且錯誤訊息是 git 的英文認證錯誤，追不回這裡。當場驗一次，失敗就不存，問題留在操作的人面前。

**驗哪些 repo：** 該公司綁定的每個專案底下的 `project_repos.repo_url`，每個跑一次 `git ls-remote`。一個失敗就整批不存。沒有綁任何專案時直接存（沒東西可驗）。

- [ ] **Step 1：先抽出可重用的憑證組裝（行為必須完全不變）**

讀 `app/server/lib/git-identity.js:25-77` 的 `buildGitEnv`。它在拿到 `patEnc` 之後 `decrypt` 再組出 env（`:56` 起的 `hardenGitEnv({...})`）。把「組 env」那一段抽成函式，讓 `buildGitEnv` 呼叫它：

```javascript
// 從一把明文 PAT 組出 git 子行程用的環境。抽出來是為了讓「存公司 PAT 之前先驗證」
// 能用同一套組法——驗證用的憑證跟實際推送用的必須完全一樣，否則驗過了也不代表推得動。
// 祕密只走 env、不進 argv：同 uid 的人讀得到 /proc/<pid>/cmdline。
function buildGitEnvFromPat(pat, { login, name, email } = {}) {
  const out = hardenGitEnv({
    GIT_ASKPASS: askpassShimPath(),
    GIT_ASKPASS_NODE: process.execPath,
    GIT_PAT: pat,
    GIT_AUTHOR_NAME: name || login || 'aidev',
    GIT_AUTHOR_EMAIL: email || 'aidev@local',
    GIT_COMMITTER_NAME: name || login || 'aidev',
    GIT_COMMITTER_EMAIL: email || 'aidev@local',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_TERMINAL_PROMPT: '0',
  });
  return out;
}
```

⚠ **`buildGitEnv` 的輸出必須逐字不變**，包含那個 `Object.defineProperty(out, 'source', { enumerable: false })`（不可列舉是刻意的：有 7 處 `{ ...process.env, ...gitEnv }` 會把它展開進子行程，變成一個叫 `source` 的環境變數）。`source` 留在 `buildGitEnv` 裡設，**不要**搬進新函式。抽完先跑 `npx jest server/tests/git-identity.test.js --runInBand` 確認既有測試全綠再往下——這一步只要行為變了就是回歸。

把 `buildGitEnvFromPat` 加進 `module.exports`（既有 key 原樣保留）。

- [ ] **Step 2：寫失敗的測試**

Create `app/server/tests/company-admin-git.test.js`：

```javascript
/**
 * company-admin-git.test.js — 公司 GIT 憑證，存之前先用 git ls-remote 驗證（規格 §6）
 *
 * 為什麼要當場驗：公司 PAT 是全公司在沒有個人 PAT 時的退路。存一把沒權限的 PAT，
 * 症狀會在很久以後的某次自動推送才出現，而且錯誤是 git 的英文認證訊息，追不回這裡。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

// 不真的連 GitHub：驗證這一關要能被測，就得能換掉它。
jest.mock('../pipeline/git', () => ({
  ...jest.requireActual('../pipeline/git'),
  listRemoteBranchesByUrl: jest.fn(),
}));

process.env.JWT_SECRET = 'test-cogit-jwt';
process.env.APP_SECRET = 'test-cogit-secret';

let app, dbModule, adminToken, coId, projectId;
const { listRemoteBranchesByUrl } = require('../pipeline/git');

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });

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

  coId = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '甲客戶' })).body.id;
  projectId = (await one("INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", ['甲專案'])).id;
  await dbModule.query('INSERT INTO project_repos (project_id, label, repo_url) VALUES ($1,$2,$3)',
    [projectId, 'main', 'https://github.com/example/repo.git']);
  await dbModule.query('INSERT INTO project_companies (project_id, company_id) VALUES ($1,$2)', [projectId, coId]);
});

afterEach(() => listRemoteBranchesByUrl.mockReset());
afterAll(() => dbModule._setPoolForTesting(null));

describe('存公司 GIT', () => {
  test('每個綁定專案的 repo 都連得上 → 存起來', async () => {
    listRemoteBranchesByUrl.mockResolvedValue({ branches: ['main'], defaultBranch: 'main' });
    const res = await request(app).put(`/api/admin/companies/${coId}/git`).set(as(adminToken))
      .send({ pat: 'ghp_good', login: 'co-bot', name: '甲公司機器人', email: 'bot@example.com' });
    expect(res.status).toBe(200);
    expect(listRemoteBranchesByUrl).toHaveBeenCalledTimes(1);
    const row = await one('SELECT git_pat_enc, git_login FROM companies WHERE id=$1', [coId]);
    expect(row.git_pat_enc).toBeTruthy();
    expect(row.git_login).toBe('co-bot');
  });

  test('存起來的是密文，不是明碼', async () => {
    const row = await one('SELECT git_pat_enc FROM companies WHERE id=$1', [coId]);
    expect(row.git_pat_enc).not.toContain('ghp_good');
  });

  test('回應不含 PAT（回去就等於外洩給任何看得到回應的人）', async () => {
    listRemoteBranchesByUrl.mockResolvedValue({ branches: ['main'], defaultBranch: 'main' });
    const res = await request(app).put(`/api/admin/companies/${coId}/git`).set(as(adminToken))
      .send({ pat: 'ghp_secret_value', login: 'co-bot' });
    expect(JSON.stringify(res.body)).not.toContain('ghp_secret_value');
  });

  test('連不上 → 400 且不存（舊的值也不可以被洗掉）', async () => {
    const before = await one('SELECT git_pat_enc FROM companies WHERE id=$1', [coId]);
    listRemoteBranchesByUrl.mockRejectedValue(new Error('Authentication failed'));
    const res = await request(app).put(`/api/admin/companies/${coId}/git`).set(as(adminToken))
      .send({ pat: 'ghp_bad', login: 'co-bot' });
    expect(res.status).toBe(400);
    const after = await one('SELECT git_pat_enc FROM companies WHERE id=$1', [coId]);
    expect(after.git_pat_enc).toBe(before.git_pat_enc);
  });

  test('沒綁任何專案的公司 → 沒東西可驗，直接存', async () => {
    const id = (await request(app).post('/api/admin/companies').set(as(adminToken)).send({ name: '乙客戶' })).body.id;
    const res = await request(app).put(`/api/admin/companies/${id}/git`).set(as(adminToken))
      .send({ pat: 'ghp_x', login: 'b' });
    expect(res.status).toBe(200);
    expect(listRemoteBranchesByUrl).not.toHaveBeenCalled();
  });

  test('沒給 pat → 400', async () => {
    expect((await request(app).put(`/api/admin/companies/${coId}/git`).set(as(adminToken)).send({})).status).toBe(400);
  });
});

describe('清除公司 GIT', () => {
  test('清掉四個欄位', async () => {
    const res = await request(app).delete(`/api/admin/companies/${coId}/git`).set(as(adminToken));
    expect(res.status).toBe(204);
    const row = await one('SELECT git_pat_enc, git_login, git_name, git_email FROM companies WHERE id=$1', [coId]);
    expect(row.git_pat_enc).toBeNull();
    expect(row.git_login).toBeNull();
  });
});
```

- [ ] **Step 3：跑測試確認它紅，然後實作**

在 `company-admin-routes.js` 頂部補 require：

```javascript
const { encrypt } = require('./lib/crypto');
const { buildGitEnvFromPat } = require('./lib/git-identity');
const { listRemoteBranchesByUrl } = require('./pipeline/git');
```

在 `registerRoutes` 內加：

```javascript
  app.put('/api/admin/companies/:id/git', auth, async (req, res) => {
    try {
      const { pat, login, name, email } = req.body || {};
      if (!pat) return res.status(400).json({ error: '缺 PAT' });
      const { rows: co } = await query('SELECT id FROM companies WHERE id = $1', [req.params.id]);
      if (!co.length) return res.status(404).json({ error: '找不到這家公司' });

      // 規格 §6：存之前對這家公司綁到的每個 repo 跑一次 git ls-remote。
      // 一個失敗就整批不存——存一把沒權限的 PAT，症狀要到很久以後某次推送才出現。
      const { rows: repos } = await query(
        `SELECT DISTINCT r.repo_url FROM project_repos r
           JOIN project_companies pc ON pc.project_id = r.project_id
          WHERE pc.company_id = $1`,
        [req.params.id]
      );
      const gitEnv = buildGitEnvFromPat(pat, { login, name, email });
      const checked = [];
      for (const r of repos) {
        try {
          await listRemoteBranchesByUrl(r.repo_url, gitEnv);
          checked.push({ repo_url: r.repo_url, ok: true });
        } catch (err) {
          return res.status(400).json({
            error: `這把 PAT 連不上 ${r.repo_url}：${err.message}`,
            checked: [...checked, { repo_url: r.repo_url, ok: false }],
          });
        }
      }

      await query(
        `UPDATE companies SET git_pat_enc=$2, git_login=$3, git_name=$4, git_email=$5, updated_at=NOW()
          WHERE id=$1`,
        [req.params.id, encrypt(pat), login || null, name || null, email || null]
      );
      res.json({ ok: true, checked });   // 刻意不回 pat，也不回密文
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/admin/companies/:id/git', auth, async (req, res) => {
    try {
      const { rows } = await query(
        `UPDATE companies SET git_pat_enc=NULL, git_login=NULL, git_name=NULL, git_email=NULL, updated_at=NOW()
          WHERE id=$1 RETURNING id`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: '找不到這家公司' });
      res.status(204).end();
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
```

- [ ] **Step 4：跑測試 ＋ 全跑 ＋ commit**

```bash
cd app && npx jest server/tests/company-admin-git.test.js server/tests/git-identity.test.js --runInBand 2>&1 | tail -15
cd app && npm run test:quiet > /tmp/t5.log 2>&1; echo "EXITCODE=$?" >> /tmp/t5.log; tail -8 /tmp/t5.log
cd .. && git add app/server/lib/git-identity.js app/server/company-admin-routes.js app/server/tests/company-admin-git.test.js
git commit -m "[Tenant]: 公司 PAT 沒地方設，設了也沒驗——壞憑證的症狀會拖到某次自動推送才爆"
git status --porcelain -uno
```

---

## Task 6：公司管理員管自家帳號

**Files:**
- Create: `app/server/company-routes.js`
- Modify: `app/server/index.js`
- Modify: `app/server/auth.js`（`verifyToken` 補 `approved === false` 檢查，見下方補充）
- Test: `app/server/tests/company-routes.test.js`（新）

**Interfaces:**
- Consumes: `canManageCompanyUsers(actor, companyId)`、`validateRoleCompany(role, companyId)`、`ROLES`（`lib/tenant-access.js`）
- Produces:
  - `GET /api/company/users` → 自己公司的帳號清單
  - `POST /api/company/users` → 201，新帳號自動掛在自己公司
  - `PUT /api/company/users/:id` → 200，只能改 `display_name` 與 `role`（限 `user`↔`company_admin`）
  - `PUT /api/company/users/:id/active` → 200，停用／啟用

**公司 id 不從網址來，從 `req.actor.companyId` 來。** 讓公司 id 出現在路徑上，就等於開了一條「改個數字試試看」的路，然後每一支都得自己記得檢查。這裡只有一個正確答案（你自己的公司），就不要把它做成參數。

**只能停用不能刪除（規格 §8 P6）。** 帳號刪掉，他建的任務、留過的話、推過的 commit 就失去歸屬。

**角色只能在 `user` ↔ `company_admin` 之間改。** 公司管理員把自己人升成平台管理員 `admin`，等於拿到全平台。

### ⚠ 2026-09-21 盤查補充：停用目前擋不住已經發出去的 token

實查結果（`auth.js:199-201`）：**登入時確實會擋** `approved === false` 的帳號。但 `verifyToken`（每一個其他請求都會經過的那一關）**完全沒有檢查 `approved`**。

後果：公司管理員按下「停用」之後，對方**手上那張還沒過期的 token 照樣能用**，而 token 效期是 7 天。畫面顯示已停用、對方照常在用——這種失敗沒有任何徵狀，而且是安全問題不是體驗問題。

**所以本關除了做停用端點，還要讓停用真的生效。** 做法與安全性：

- `verifyToken` 裡補一個 `approved === false` 就擋的檢查，回 403。
- **判斷式必須是 `=== false`，不可以用 `!approved`**：欄位值可能是 `NULL`（從來沒被寫過的既有帳號，包含 9 個平台管理員），`!null` 是 true，那樣會把所有人鎖在外面。既有的登入檢查用的就是 `=== false`，照抄同一個寫法。
- 全庫唯一寫 `false` 的路徑是自助註冊（`auth.js:155`），而那一支在 Task 8 會被關掉——所以這道檢查上線後，唯一會被它擋下的就是「被公司管理員停用的人」，正是我們要的。

- [ ] **Step 1：確認 `users` 有沒有可用的「停用」欄位**

```bash
cd app/server && grep -n "approved\|is_active" db.js | grep -i user | head
```
本專案既有的 `users.approved`（自助註冊用，預設 false）語意是「已核准」，停用就是把它設回 false。**先看清楚它現在怎麼被用**（`auth.js` 登入時有沒有檢查它），再決定沿用還是加新欄位。
- 若登入有檢查 `approved` ⇒ **沿用它**，不要加新欄位。
- 若沒有檢查 ⇒ **停下來回報**，因為那代表「停用」在這個系統裡還不存在，得先決定語意再做。

把你查到的結果寫進報告。這一步的結論會決定 Step 2 的測試怎麼寫。

- [ ] **Step 2：寫失敗的測試**

Create `app/server/tests/company-routes.test.js`。以下以「沿用 `approved`」為前提；Step 1 若結論不同，**先回報再調整**。

```javascript
/**
 * company-routes.test.js — 公司管理員管自家帳號（規格 §5.3「新增 company-routes.js」、§8 P6）
 *
 * 範圍限自己公司，而且公司 id 不是參數——是從 req.actor 來的，
 * 讓它變成路徑參數就等於開了一條「改個數字試試看」的路。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-cort-jwt';
process.env.APP_SECRET = 'test-cort-secret';

let app, dbModule, adminToken, caToken, plainToken, coA, coB, userInB;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });

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

  const mkCo = async (name) => (await one(
    'INSERT INTO companies (name, is_active) VALUES ($1, true) RETURNING id', [name])).id;
  coA = await mkCo('甲公司');
  coB = await mkCo('乙公司');

  const mkUser = async (username, companyId, role) => {
    const hash = await bcrypt.hash('password123', 10);
    const id = (await one(
      'INSERT INTO users (username, password_hash, display_name, role, company_id, approved) VALUES ($1,$2,$1,$3,$4,true) RETURNING id',
      [username, hash, role, companyId])).id;
    const token = (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
    return { id, token };
  };
  caToken = (await mkUser('ca-a', coA, 'company_admin')).token;
  plainToken = (await mkUser('plain-a', coA, 'user')).token;
  userInB = (await mkUser('someone-b', coB, 'user')).id;
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('誰能用', () => {
  test('一般使用者 → 403（他看得到自己公司，只是不能管帳號）', async () => {
    expect((await request(app).get('/api/company/users').set(as(plainToken))).status).toBe(403);
  });
  test('公司管理員 → 200', async () => {
    expect((await request(app).get('/api/company/users').set(as(caToken))).status).toBe(200);
  });
  test('平台管理員沒有公司 → 400，訊息要講清楚要去哪管', async () => {
    const res = await request(app).get('/api/company/users').set(as(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('公司');
  });
});

describe('範圍', () => {
  test('只列得到自己公司的人', async () => {
    const res = await request(app).get('/api/company/users').set(as(caToken));
    expect(res.body.every(u => u.company_id === coA)).toBe(true);
    expect(res.body.some(u => u.id === userInB)).toBe(false);
  });

  test('改別家公司的人 → 404（不是 403：403 等於承認這個 id 存在）', async () => {
    const res = await request(app).put(`/api/company/users/${userInB}`).set(as(caToken))
      .send({ display_name: '被改到了' });
    expect(res.status).toBe(404);
    const row = await one('SELECT display_name FROM users WHERE id=$1', [userInB]);
    expect(row.display_name).not.toBe('被改到了');
  });

  test('停用別家公司的人 → 404，而且真的沒被停用', async () => {
    const res = await request(app).put(`/api/company/users/${userInB}/active`).set(as(caToken))
      .send({ active: false });
    expect(res.status).toBe(404);
    const row = await one('SELECT approved FROM users WHERE id=$1', [userInB]);
    expect(row.approved).toBe(true);
  });
});

describe('新增帳號', () => {
  test('自動掛在自己公司，不看 body 給什麼 company_id', async () => {
    const res = await request(app).post('/api/company/users').set(as(caToken))
      .send({ username: 'new-a', password: 'password123', display_name: '新人', company_id: coB });
    expect(res.status).toBe(201);
    const row = await one('SELECT company_id, role FROM users WHERE username=$1', ['new-a']);
    expect(row.company_id).toBe(coA);
    expect(row.role).toBe('user');
  });

  test('不准建平台管理員（建得出來就等於拿到全平台）', async () => {
    const res = await request(app).post('/api/company/users').set(as(caToken))
      .send({ username: 'evil', password: 'password123', role: 'admin' });
    expect(res.status).toBe(400);
    expect(await one('SELECT 1 FROM users WHERE username=$1', ['evil'])).toBeUndefined();
  });

  test('可以建公司管理員', async () => {
    const res = await request(app).post('/api/company/users').set(as(caToken))
      .send({ username: 'ca2', password: 'password123', role: 'company_admin' });
    expect(res.status).toBe(201);
    expect((await one('SELECT role FROM users WHERE username=$1', ['ca2'])).role).toBe('company_admin');
  });

  test('密碼太短 → 400（比照平台既有規則）', async () => {
    expect((await request(app).post('/api/company/users').set(as(caToken))
      .send({ username: 'short', password: 'abc' })).status).toBe(400);
  });

  test('帳號重複 → 409', async () => {
    const res = await request(app).post('/api/company/users').set(as(caToken))
      .send({ username: 'new-a', password: 'password123' });
    expect(res.status).toBe(409);
  });
});

describe('改角色與停用', () => {
  test('user → company_admin 可以', async () => {
    const id = (await one('SELECT id FROM users WHERE username=$1', ['new-a'])).id;
    const res = await request(app).put(`/api/company/users/${id}`).set(as(caToken)).send({ role: 'company_admin' });
    expect(res.status).toBe(200);
    expect((await one('SELECT role FROM users WHERE id=$1', [id])).role).toBe('company_admin');
  });

  test('改成 admin → 400，而且 DB 沒變', async () => {
    const id = (await one('SELECT id FROM users WHERE username=$1', ['new-a'])).id;
    const res = await request(app).put(`/api/company/users/${id}`).set(as(caToken)).send({ role: 'admin' });
    expect(res.status).toBe(400);
    expect((await one('SELECT role FROM users WHERE id=$1', [id])).role).toBe('company_admin');
  });

  test('停用＝approved 設 false（規格 §8 P6：只能停用不能刪）', async () => {
    const id = (await one('SELECT id FROM users WHERE username=$1', ['new-a'])).id;
    const res = await request(app).put(`/api/company/users/${id}/active`).set(as(caToken)).send({ active: false });
    expect(res.status).toBe(200);
    expect((await one('SELECT approved FROM users WHERE id=$1', [id])).approved).toBe(false);
  });

  test('停用之後，對方手上那張還沒過期的 token 立刻失效（不然停用等於做半套）', async () => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id, approved) VALUES ($1,$2,$1,$3,$4,true)',
      ['tobedisabled', hash, 'user', coA]);
    const victimToken = (await request(app).post('/api/auth/login')
      .send({ username: 'tobedisabled', password: 'password123' })).body.token;
    // 停用之前：用得動
    expect((await request(app).get('/api/auth/me').set(as(victimToken))).status).toBe(200);

    const id = (await one('SELECT id FROM users WHERE username=$1', ['tobedisabled'])).id;
    await request(app).put(`/api/company/users/${id}/active`).set(as(caToken)).send({ active: false });

    // 停用之後：同一張 token 立刻不能用
    expect((await request(app).get('/api/auth/me').set(as(victimToken))).status).toBe(403);
  });

  test('從來沒設過 approved 的既有帳號照樣能用（判斷式寫成 !approved 會把 9 個管理員全鎖死）', async () => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      ['legacy-null', hash, 'user', coA]);
    const t = (await request(app).post('/api/auth/login')
      .send({ username: 'legacy-null', password: 'password123' })).body.token;
    expect((await request(app).get('/api/auth/me').set(as(t))).status).toBe(200);
  });

  test('沒有刪除端點（規格 §8 P6）', async () => {
    const id = (await one('SELECT id FROM users WHERE username=$1', ['new-a'])).id;
    expect((await request(app).delete(`/api/company/users/${id}`).set(as(caToken))).status).toBe(404);
  });
});
```

- [ ] **Step 3：跑測試確認它紅，然後實作 `app/server/company-routes.js`**

```javascript
/**
 * company-routes.js — 公司管理員管自家帳號（規格 §5.3、§8 P6）。
 *
 * 公司 id 一律取自 req.actor.companyId，不從網址收——讓它變成路徑參數就等於
 * 開了一條「把數字改掉試試看」的路，然後每一支端點都得自己記得檢查。
 * 這裡只有一個正確答案（你自己的公司），所以不做成參數。
 */
const { query } = require('./db');
const { verifyToken, hashPassword } = require('./auth');
const { canManageCompanyUsers, ROLES } = require('./lib/tenant-access');

// 公司管理員能指派的角色。刻意不含 admin——公司管理員能建平台管理員的話，
// 等於任何一家客戶都能替自己開一個全平台的後門。
const ASSIGNABLE = [ROLES.USER, ROLES.COMPANY_ADMIN];

// 取「我管的公司」。平台管理員沒有公司，他要管帳號是走 /api/admin/users，
// 訊息要講清楚要去哪裡，不然對方只會看到一個沒頭沒尾的錯誤。
function myCompany(req, res) {
  const companyId = req.actor && req.actor.companyId;
  if (!canManageCompanyUsers(req.actor, companyId)) {
    res.status(403).json({ error: '只有公司管理員能管理公司帳號' });
    return null;
  }
  if (!companyId) {
    res.status(400).json({ error: '這個帳號不屬於任何公司；平台管理員請用管理員設定的使用者管理' });
    return null;
  }
  return companyId;
}

function registerRoutes(app) {
  app.get('/api/company/users', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      const { rows } = await query(
        `SELECT id, username, display_name, role, company_id, approved, created_at
           FROM users WHERE company_id = $1 ORDER BY username`,
        [companyId]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/company/users', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      const { username, password, display_name, role } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: '缺帳號或密碼' });
      if (String(password).length < 8) return res.status(400).json({ error: '密碼至少 8 個字元' });
      const finalRole = role || ROLES.USER;
      if (!ASSIGNABLE.includes(finalRole)) {
        return res.status(400).json({ error: '只能建立一般使用者或公司管理員' });
      }
      // company_id 取自 actor，不看 req.body——body 給什麼都不算數。
      const { rows } = await query(
        `INSERT INTO users (username, password_hash, display_name, role, company_id, approved)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING id, username, display_name, role, company_id, approved`,
        [username, await hashPassword(password), display_name || username, finalRole, companyId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: '帳號已存在' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/company/users/:id', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      const { display_name, role } = req.body || {};
      if (role !== undefined && !ASSIGNABLE.includes(role)) {
        return res.status(400).json({ error: '只能在一般使用者與公司管理員之間調整' });
      }
      // WHERE 同時綁 company_id：別家的人一律當作不存在，回 404 而不是 403。
      const { rows } = await query(
        `UPDATE users SET display_name = COALESCE($3, display_name), role = COALESCE($4, role)
          WHERE id = $1 AND company_id = $2
        RETURNING id, username, display_name, role, company_id, approved`,
        [req.params.id, companyId, display_name || null, role || null]
      );
      if (!rows.length) return res.status(404).json({ error: '找不到這個帳號' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/company/users/:id/active', verifyToken, async (req, res) => {
    const companyId = myCompany(req, res); if (!companyId) return;
    try {
      const active = req.body && req.body.active === true;
      // 規格 §8 P6：只能停用不能刪除——刪掉帳號，他建的任務與留過的話就失去歸屬。
      const { rows } = await query(
        `UPDATE users SET approved = $3 WHERE id = $1 AND company_id = $2
         RETURNING id, username, display_name, role, company_id, approved`,
        [req.params.id, companyId, active]
      );
      if (!rows.length) return res.status(404).json({ error: '找不到這個帳號' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
```

⚠ `hashPassword` 是否由 `auth.js` 匯出要先確認（`admin-routes.js` 有在用，照它的 require 寫法抄）。匯出處不同就照既有寫法改，**不要**自己再實作一次雜湊。

- [ ] **Step 4：在 `index.js` 註冊、跑測試、全跑、commit**

```bash
cd app && npx jest server/tests/company-routes.test.js --runInBand 2>&1 | tail -15
cd app && npm run test:quiet > /tmp/t6.log 2>&1; echo "EXITCODE=$?" >> /tmp/t6.log; tail -8 /tmp/t6.log
cd .. && git add app/server/company-routes.js app/server/auth.js app/server/index.js app/server/tests/company-routes.test.js
git commit -m "[Tenant]: 客戶公司沒辦法自己管帳號；而且停用只擋登入，對方手上的 token 還能再用七天"
git status --porcelain -uno
```

---

## Task 7：建立帳號時明確選公司（拿掉第 1 部的暫時預設值）

**Files:**
- Modify: `app/server/admin-routes.js:354-385`（`POST /api/admin/users`）、`:387-401`（`PUT /api/admin/users/:id`）
- Test: `app/server/tests/admin-users-company.test.js`（新）

**為什麼：** 第 1 部留了一個暫時措施——非平台管理員的新帳號一律硬掛內部公司（`admin-routes.js:354-385`，註解自己寫著「子專案 2 會改成明確選公司，屆時這裡要拿掉」）。第 2 部沒拿掉。**客戶公司一旦存在，這個預設值就會把客戶的新帳號掛進內部公司**，那個人於是看得到全部 17 個專案。

同時把 `validateRoleCompany` 接上去——它從第 1 部就寫好了，至今**零呼叫端**，等於一道寫好但沒接電的閘門。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/admin-users-company.test.js`：

```javascript
/**
 * admin-users-company.test.js — 平台管理員建帳號要明確選公司（規格 §4.4、§5.3）
 *
 * 第 1 部留的暫時措施是「非管理員一律掛內部公司」。客戶公司存在之後，
 * 那個預設值會把客戶的新帳號掛進內部公司，那個人就看得到全部專案。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-auc-jwt';
process.env.APP_SECRET = 'test-auc-secret';

let app, dbModule, adminToken, coA;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });

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
  await dbModule.query('INSERT INTO companies (name, is_active, is_internal) VALUES ($1,true,true)', ['內部']);
  coA = (await one('INSERT INTO companies (name, is_active) VALUES ($1,true) RETURNING id', ['甲客戶'])).id;
});

afterAll(() => dbModule._setPoolForTesting(null));

test('建一般使用者要帶 company_id，沒帶 → 400（不再靜默掛內部公司）', async () => {
  const res = await request(app).post('/api/admin/users').set(as(adminToken))
    .send({ username: 'u1', password: 'password123', role: 'user' });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('公司');
});

test('帶了就掛在那家公司', async () => {
  const res = await request(app).post('/api/admin/users').set(as(adminToken))
    .send({ username: 'u2', password: 'password123', role: 'user', company_id: coA });
  expect(res.status).toBe(201);
  expect((await one('SELECT company_id FROM users WHERE username=$1', ['u2'])).company_id).toBe(coA);
});

test('建平台管理員不可以帶公司 → 400（規格 §4.4：admin 的 company_id 必須是 NULL）', async () => {
  const res = await request(app).post('/api/admin/users').set(as(adminToken))
    .send({ username: 'u3', password: 'password123', role: 'admin', company_id: coA });
  expect(res.status).toBe(400);
  expect(await one('SELECT 1 FROM users WHERE username=$1', ['u3'])).toBeUndefined();
});

test('建平台管理員不帶公司 → 201，company_id 是 NULL', async () => {
  const res = await request(app).post('/api/admin/users').set(as(adminToken))
    .send({ username: 'u4', password: 'password123', role: 'admin' });
  expect(res.status).toBe(201);
  expect((await one('SELECT company_id FROM users WHERE username=$1', ['u4'])).company_id).toBeNull();
});

test('不存在的公司 → 400', async () => {
  const res = await request(app).post('/api/admin/users').set(as(adminToken))
    .send({ username: 'u5', password: 'password123', role: 'user', company_id: 999999 });
  expect(res.status).toBe(400);
});

test('改角色時公司要一起合法：把一般使用者升成 admin 但還掛著公司 → 400', async () => {
  const id = (await one('SELECT id FROM users WHERE username=$1', ['u2'])).id;
  const res = await request(app).put(`/api/admin/users/${id}`).set(as(adminToken)).send({ role: 'admin' });
  expect(res.status).toBe(400);
  expect((await one('SELECT role FROM users WHERE id=$1', [id])).role).toBe('user');
});

test('同時把角色改成 admin 並清掉公司 → 200', async () => {
  const id = (await one('SELECT id FROM users WHERE username=$1', ['u2'])).id;
  const res = await request(app).put(`/api/admin/users/${id}`).set(as(adminToken))
    .send({ role: 'admin', company_id: null });
  expect(res.status).toBe(200);
  const row = await one('SELECT role, company_id FROM users WHERE id=$1', [id]);
  expect(row.role).toBe('admin');
  expect(row.company_id).toBeNull();
});
```

- [ ] **Step 2：跑測試確認它紅，然後實作**

`POST /api/admin/users`：把那段查內部公司的暫時措施整段刪掉，改成從 `req.body` 收 `company_id`，並在 INSERT 前呼叫 `validateRoleCompany(finalRole, companyId)`；不合法回 400 帶它的錯誤訊息。`company_id` 有值時先確認那家公司存在（`SELECT 1 FROM companies WHERE id=$1`），不存在回 400。

`PUT /api/admin/users/:id`：加收 `company_id`（要能被明確設成 `null`，所以用「body 裡有沒有這個 key」判斷，不是 truthy）。先讀出這個人目前的 `role` 與 `company_id`，把 body 有帶的蓋上去算出「改完會變成什麼」，再用 `validateRoleCompany` 驗那個結果；不合法回 400 且不寫 DB。

⚠ 刪掉暫時措施時，`POST /api/auth/register`（`auth.js:139`）裡有**一模一樣的一段**。那一支在 Task 8 處理，**這一關不要動它**——兩關各自 commit，審查才看得出各自的效果。

- [ ] **Step 3：全跑 ＋ commit**

```bash
cd app && npm run test:quiet > /tmp/t7.log 2>&1; echo "EXITCODE=$?" >> /tmp/t7.log; tail -8 /tmp/t7.log
cd .. && git add app/server/admin-routes.js app/server/tests/admin-users-company.test.js
git commit -m "[Tenant]: 新帳號一律硬掛內部公司——客戶的人一建立就看得到全部 17 個專案"
git status --porcelain -uno
```

---

## Task 8：關閉自助註冊

**Files:**
- Modify: `app/server/auth.js:139-163`（`POST /api/auth/register`）
- Test: `app/server/tests/auth-register-closed.test.js`（新）

**為什麼（規格 §8 P3）：** `POST /api/auth/register` 現在是**開放的**——沒有任何開關擋它，網路上任何人 POST 一次就有帳號（`approved=false`、但帳號已經存在、而且會拿到 token）。做成多租戶之後，帳號一律由平台管理員或公司管理員建立。

**不可以動到 `POST /api/auth/setup`。** 那是全新安裝時建立第一個管理員的唯一入口，它自己的守衛是「`users` 表不是空的就 403」，天生只能用一次。兩支端點互不依賴（`setup` 只看表空不空，`register` 完全不管），關掉 `register` **不影響** `setup`——但這件事必須有測試釘住，否則下一個人重裝平台時會發現自己進不去。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/auth-register-closed.test.js`：

```javascript
/**
 * auth-register-closed.test.js — 關閉自助註冊（規格 §8 P3）
 *
 * 多租戶之後帳號一律由平台管理員或公司管理員建立。
 * 最重要的一支是最後那個：關掉註冊不可以連帶把「全新安裝建第一個管理員」也關掉，
 * 否則下一個重裝平台的人會進不去，而且要很久才會發現原因在這裡。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-reg-jwt';
process.env.APP_SECRET = 'test-reg-secret';

let app, dbModule;

beforeEach(async () => {
  jest.resetModules();
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
});

afterEach(() => dbModule._setPoolForTesting(null));

test('全新安裝：第一個管理員照樣建得出來（這支壞掉會讓人裝不起平台）', async () => {
  const res = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password123', display_name: '平台管理員' });
  expect(res.status).toBe(201);
  expect(res.body.token).toBeTruthy();
});

test('建過之後 setup 就鎖死（既有行為，不可因本關改動而變）', async () => {
  await request(app).post('/api/auth/setup').send({ username: 'admin', password: 'password123' });
  const res = await request(app).post('/api/auth/setup').send({ username: 'admin2', password: 'password123' });
  expect(res.status).toBe(403);
});

test('自助註冊一律拒絕，且沒有建出帳號', async () => {
  await request(app).post('/api/auth/setup').send({ username: 'admin', password: 'password123' });
  const res = await request(app).post('/api/auth/register')
    .send({ username: 'selfserve', password: 'password123' });
  expect(res.status).toBe(403);
  expect(res.body.token).toBeUndefined();
  const { rows } = await dbModule.query('SELECT 1 FROM users WHERE username = $1', ['selfserve']);
  expect(rows.length).toBe(0);
});

test('表還是空的時候註冊也一樣拒絕（不可以留一條「趁還沒人就註冊」的路）', async () => {
  const res = await request(app).post('/api/auth/register')
    .send({ username: 'first', password: 'password123' });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2：跑測試確認它紅，然後實作**

把 `POST /api/auth/register` 的 handler 整個換成直接拒絕，**保留這支路由**（移除路由會讓舊前端拿到 404，看起來像壞掉而不是像被關閉）：

```javascript
  // 規格 §8 P3：多租戶之後帳號一律由平台管理員或公司管理員建立，自助註冊關閉。
  // 保留這支路由只為了回一個講得清楚的訊息——整支移除的話舊前端會拿到 404，
  // 看起來像壞掉而不是像被關閉。
  // ⚠ 不要因為這支關了就順手動 POST /api/auth/setup：那是全新安裝建第一個管理員的唯一入口，
  //    它自己的守衛是「users 表不是空的就 403」，與本規則無關。
  app.post('/api/auth/register', (req, res) => {
    res.status(403).json({ error: '本平台不開放自助註冊，請聯絡貴公司的管理員開通帳號' });
  });
```

原本那段「查內部公司塞 company_id」的暫時措施隨著 handler 一起消失——這是對的，它本來就該在這一批拿掉。

- [ ] **Step 3：全跑 ＋ commit**

```bash
cd app && npm run test:quiet > /tmp/t8.log 2>&1; echo "EXITCODE=$?" >> /tmp/t8.log; tail -8 /tmp/t8.log
cd .. && git add app/server/auth.js app/server/tests/auth-register-closed.test.js
git commit -m "[Tenant]: 自助註冊是開的，網路上任何人 POST 一次就在平台裡有帳號"
git status --porcelain -uno
```

⚠ 既有測試若有人用 `/api/auth/register` 取 token，會整批變紅。**回報，不要自己改**——那些測試要改成手動 INSERT ＋ `/api/auth/login`（`tenant-routes-scope.test.js` 的 `mkUser` 就是那個形狀），但要由控制者裁決。

---

## Task 9：對客戶隱藏 Odoo 帳密與同步設定

**Files:**
- Modify: `app/server/lib/company-features.js`（`FEATURES` 加一筆）
- Modify: `app/server/settings.js`
- Test: `app/server/tests/settings-customer-hidden.test.js`（新）

**為什麼（規格 §8 P2）：** 個人設定頁現在有 Odoo 帳密與 eService 同步設定。那是「我們用來連客戶系統的憑證」，客戶自己不需要、也不該看到這個介面。

**用功能開關而不是 `if (actor.isInternal)`：** 機制已經有了（Task 1），內部公司自動全開，客戶預設關。多一個概念不如共用一個。

- [ ] **Step 1：`FEATURES` 加一筆**

```javascript
const FEATURES = {
  exam: { key: 'exam', label: '考試系統', defaultForCustomer: false },
  // Odoo 帳密與 eService 同步設定（規格 §8 P2）。那是「我們用來連客戶系統的憑證」，
  // 客戶自己不需要這個介面。內部公司自動全開，不必回頭設定。
  odoo_sync: { key: 'odoo_sync', label: 'Odoo 連線與同步設定', defaultForCustomer: false },
};
```

- [ ] **Step 2：寫失敗的測試**

Create `app/server/tests/settings-customer-hidden.test.js`：

```javascript
/**
 * settings-customer-hidden.test.js — 客戶看不到 Odoo 帳密與同步設定（規格 §8 P2）
 *
 * 那是我們用來連客戶系統的憑證，不是客戶自己的東西。
 * 顯示名稱、密碼、個人 GIT 三項客戶照樣要能改——收太多會讓客戶連改密碼都做不到。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-sch-jwt';
process.env.APP_SECRET = 'test-sch-secret';

let app, dbModule, adminToken, custToken, internalToken;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];
const as = (t) => ({ Authorization: `Bearer ${t}` });

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

  const coInternal = (await one(
    'INSERT INTO companies (name, is_active, is_internal) VALUES ($1,true,true) RETURNING id', ['內部'])).id;
  const coCust = (await one(
    'INSERT INTO companies (name, is_active) VALUES ($1,true) RETURNING id', ['甲客戶'])).id;

  const mkUser = async (username, companyId) => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id, approved) VALUES ($1,$2,$1,$3,$4,true)',
      [username, hash, 'user', companyId]);
    return (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
  };
  internalToken = await mkUser('inside', coInternal);
  custToken = await mkUser('cust', coCust);
});

afterAll(() => dbModule._setPoolForTesting(null));

test('客戶讀設定：回應裡沒有 Odoo／eService 相關欄位', async () => {
  const res = await request(app).get('/api/settings').set(as(custToken));
  expect(res.status).toBe(200);
  const body = JSON.stringify(res.body);
  expect(body).not.toContain('odoo_username');
  expect(body).not.toContain('service_username');
  expect(res.body.sync_interval).toBeUndefined();
});

test('客戶寫 Odoo 設定：被忽略，DB 沒有被寫進去', async () => {
  await request(app).put('/api/settings').set(as(custToken))
    .send({ odoo_settings: { odoo_username: 'sneaky', odoo_password: 'x' }, sync_interval: 5 });
  const row = await one('SELECT odoo_settings, sync_interval FROM users WHERE username=$1', ['cust']);
  const s = typeof row.odoo_settings === 'string' ? JSON.parse(row.odoo_settings || '{}') : (row.odoo_settings || {});
  expect(s.odoo_username).toBeUndefined();
});

test('客戶呼叫驗證 Odoo 帳密 → 404（這個功能對他不存在）', async () => {
  expect((await request(app).post('/api/settings/verify-odoo').set(as(custToken)).send({})).status).toBe(404);
});

test('客戶呼叫驗證 eService → 404', async () => {
  expect((await request(app).post('/api/settings/verify-service').set(as(custToken)).send({})).status).toBe(404);
});

test('客戶照樣能設個人 GitHub PAT（收太多會讓他連自己的憑證都設不了）', async () => {
  const res = await request(app).post('/api/settings/github-pat').set(as(custToken))
    .send({ pat: 'ghp_customer', login: 'cust-bot' });
  expect(res.status).not.toBe(404);
  expect(res.status).not.toBe(403);
});

test('客戶照樣能改主題（純 UI 偏好，與租戶無關）', async () => {
  expect((await request(app).put('/api/settings/theme').set(as(custToken)).send({ theme: 'dark' })).status).toBe(200);
});

test('內部公司的人完全不受影響——這一關對現在平台上的人必須零改變', async () => {
  const res = await request(app).get('/api/settings').set(as(internalToken));
  expect(res.status).toBe(200);
  expect((await request(app).post('/api/settings/verify-odoo').set(as(internalToken)).send({})).status).not.toBe(404);
});

test('平台管理員（沒有公司）不受影響', async () => {
  expect((await request(app).get('/api/settings').set(as(adminToken))).status).toBe(200);
  expect((await request(app).post('/api/settings/verify-odoo').set(as(adminToken)).send({})).status).not.toBe(404);
});
```

- [ ] **Step 3：跑測試確認它紅，然後實作**

`settings.js` 頂部：

```javascript
const { requireFeature, companyHasFeature } = require('./lib/company-features');
```

- `POST /api/settings/verify-odoo`、`POST /api/settings/verify-service`：在 `verifyToken` 之後插 `requireFeature('odoo_sync')`。
- `GET /api/settings`：算出 `const canSync = await companyHasFeature(req.actor && req.actor.companyId, 'odoo_sync');`，`canSync` 為 false 時把回應裡的 Odoo／eService 鍵與 `sync_interval` 拿掉再回。**只留下 `theme`、`saved_views` 等 UI 偏好鍵。**
- `PUT /api/settings`：`canSync` 為 false 時，忽略 body 裡的 Odoo／eService 鍵與 `sync_interval`，其餘照常寫入。**不要回 403**——客戶按的是同一顆儲存鈕，回 403 會讓他連改主題都失敗。

⚠ 既有的 `redactSettings`／`preserveSecrets`（`lib/user-settings.js`）不要動。它管的是「密文不要回給瀏覽器」，跟這一關管的「這個人看不看得到這個區塊」是兩件事，混在一起改會兩邊都說不清楚。

- [ ] **Step 4：全跑 ＋ commit**

```bash
cd app && npm run test:quiet > /tmp/t9.log 2>&1; echo "EXITCODE=$?" >> /tmp/t9.log; tail -8 /tmp/t9.log
cd .. && git add app/server/lib/company-features.js app/server/settings.js app/server/tests/settings-customer-hidden.test.js
git commit -m "[Tenant]: 客戶的個人設定頁看得到我們連他系統用的 Odoo 帳密欄位"
git status --porcelain -uno
```

---

## Task 10：停用公司時，立刻中止那家公司正在跑的 AI

**Files:**
- Modify: `app/server/pipeline/runner.js`（加一支依公司中止的函式）
- Modify: `app/server/company-admin-routes.js`（`PUT /api/admin/companies/:id` 停用時呼叫）
- Test: `app/server/tests/company-deactivate-abort.test.js`（新）

**Interfaces:**
- Produces: `async abortCompanyTasks(companyId) -> Promise<number[]>`（回被中止的 taskId 陣列）

**為什麼（規格 §7 第五列、§8 P5）：** 公司停用之後，`canRun` 只擋得住**下一次**執行；已經在跑的那一輪會跑完，平台繼續替停繳的客戶燒錢。使用者 09-14 明確選了「立刻中止」而不是「跑完這一輪」。

**怎麼知道哪些在跑的任務屬於這家公司：** `getInflightInfo()`（`runner.js:105`）回的是 `[{ taskId, userId, startedAt }]`——有 `userId` 就夠了，查 `users.company_id` 即可。**用建任務的人所屬公司判斷**，與 cron 那一關（Task 7 of Part 2）同一條規則：一個專案可以綁多家公司，所以不能用專案判斷。

**中止的語意沿用既有慣例：** 各 agent 收到 abort 一律「狀態原地不動、不寫失敗、不列 blocker」。所以這一關**不改狀態**，只中止＋寫一行時間軸讓人看得懂發生什麼事。改到一半的程式碼留在任務 worktree，沒有合併，不影響正式。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/company-deactivate-abort.test.js`：

```javascript
/**
 * company-deactivate-abort.test.js — 停用公司立刻中止它正在跑的 AI（規格 §7 第五列、§8 P5）
 *
 * canRun 只擋得住下一次執行；已經在跑的那一輪會跑完，平台繼續替停繳的客戶燒錢。
 * 中止的語意沿用既有慣例：狀態原地不動、不寫失敗，只留一行時間軸讓人看得懂。
 */
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-cda-jwt';
process.env.APP_SECRET = 'test-cda-secret';

let dbModule, runner, coA, coB, uA, uB, tA, tB;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  runner = require('../pipeline/runner');

  coA = (await one('INSERT INTO companies (name, is_active) VALUES ($1,true) RETURNING id', ['甲'])).id;
  coB = (await one('INSERT INTO companies (name, is_active) VALUES ($1,true) RETURNING id', ['乙'])).id;
  const mkUser = async (n, co) => (await one(
    'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4) RETURNING id',
    [n, 'x', 'user', co])).id;
  uA = await mkUser('a', coA);
  uB = await mkUser('b', coB);
  const pid = (await one("INSERT INTO projects (name, odoo_version) VALUES ($1,'17') RETURNING id", ['p'])).id;
  const mkTask = async (uid) => (await one(
    "INSERT INTO tasks (title, user_id, project_id, status) VALUES ($1,$2,$3,'coding_running') RETURNING id",
    ['t', uid, pid])).id;
  tA = await mkTask(uA);
  tB = await mkTask(uB);
});

afterAll(() => dbModule._setPoolForTesting(null));

test('只中止那家公司的任務，別家的不動', async () => {
  const ctrlA = new AbortController();
  const ctrlB = new AbortController();
  runner._setInflightForTesting(tA, { ctrl: ctrlA, userId: uA, startedAt: Date.now(), status: 'coding_running' });
  runner._setInflightForTesting(tB, { ctrl: ctrlB, userId: uB, startedAt: Date.now(), status: 'coding_running' });

  const aborted = await runner.abortCompanyTasks(coA);

  expect(aborted).toEqual([tA]);
  expect(ctrlA.signal.aborted).toBe(true);
  expect(ctrlB.signal.aborted).toBe(false);
});

test('寫一行時間軸，讓人看得懂為什麼停了', async () => {
  const { rows } = await dbModule.query(
    "SELECT role, content FROM task_logs WHERE task_id = $1 ORDER BY id DESC LIMIT 1", [tA]);
  expect(rows[0].content).toContain('停用');
});

test('狀態原地不動（既有中止慣例：不寫失敗、不列 blocker）', async () => {
  expect((await one('SELECT status FROM tasks WHERE id=$1', [tA])).status).toBe('coding_running');
});

test('沒有任何任務在跑的公司 → 回空陣列，不爆', async () => {
  expect(await runner.abortCompanyTasks(coB === undefined ? 0 : 999999)).toEqual([]);
});
```

- [ ] **Step 2：跑測試確認它紅，然後實作**

在 `app/server/pipeline/runner.js` 加（放在 `abortTask` 附近）：

```javascript
// 規格 §7 第五列：公司停用或到期時，立刻中止它正在跑的 AI。
// canRun 只擋得住下一次執行；不中止的話已經在跑的那一輪會跑完，平台繼續替停繳的客戶燒錢。
// 用「建任務的人所屬公司」判斷，與 cron 那一關同一條規則——一個專案可以綁多家公司，
// 所以不能用專案判斷。
// 狀態刻意不動：全平台的中止語意就是「原地不動、不寫失敗、不列 blocker」，
// 只補一行時間軸讓人看得懂為什麼停了。
async function abortCompanyTasks(companyId) {
  const inflight = getInflightInfo();
  if (!inflight.length || !companyId) return [];
  const userIds = [...new Set(inflight.map(e => e.userId).filter(Boolean))];
  if (!userIds.length) return [];
  const { rows } = await query(
    `SELECT id FROM users WHERE company_id = $1 AND id = ANY($2::int[])`,
    [companyId, userIds]
  );
  const mine = new Set(rows.map(r => r.id));
  const aborted = [];
  for (const e of inflight) {
    if (!mine.has(e.userId)) continue;
    abortTask(e.taskId);
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
      [e.taskId, '公司帳號已停用或到期，本輪執行已中止。改到一半的程式碼留在任務分支，沒有合併。']
    );
    aborted.push(e.taskId);
  }
  return aborted;
}

// 測試用：直接塞一筆在飛紀錄。正式程式碼不要呼叫。
function _setInflightForTesting(taskId, entry) {
  _inFlight.set(Number(taskId), entry);
}
```

兩支都加進 `module.exports`（既有 key 原樣保留）。

⚠ `id = ANY($2::int[])` 在 pg-mem 下若不支援，**回報**，不要改成把 userId 串進 SQL 字串（那是注入洞）。備案是用 `IN` 搭配逐一參數化的佔位符。

在 `company-admin-routes.js` 的 `PUT /api/admin/companies/:id` 成功之後、回應之前加：

```javascript
      // 規格 §7 第五列：這次修改讓公司變成不可用時，立刻中止它正在跑的 AI。
      // 用改完的值判斷，不是用 req.body——只帶 active_until 也可能讓公司變成過期。
      const after = out[0];
      const now = new Date();
      const usable = after.is_active === true
        && (!after.active_from || now >= new Date(after.active_from))
        && (!after.active_until || now <= new Date(after.active_until));
      if (!usable) await abortCompanyTasks(req.params.id);
```

頂部補 `const { abortCompanyTasks } = require('./pipeline/runner');`。

- [ ] **Step 3：全跑 ＋ commit**

```bash
cd app && npm run test:quiet > /tmp/t10.log 2>&1; echo "EXITCODE=$?" >> /tmp/t10.log; tail -8 /tmp/t10.log
cd .. && git add app/server/pipeline/runner.js app/server/company-admin-routes.js app/server/tests/company-deactivate-abort.test.js
git commit -m "[Tenant]: 公司停用後正在跑的那一輪照樣跑完，平台還在替停繳的客戶燒錢"
git status --porcelain -uno
```

---

## Task 11：整枝審查 → 合併決定

**Files:** 無新檔

- [ ] **Step 1：整枝自審**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
git fetch origin && git merge origin/master
cd app && npm run test:quiet > /tmp/t11.log 2>&1; echo "EXITCODE=$?" >> /tmp/t11.log; tail -8 /tmp/t11.log
```

逐項自己對一次，每一項都要把指令輸出貼進報告：

| 檢查 | 怎麼確認 |
|---|---|
| 考試 24 支一支不漏 | `grep -c "requireFeature('exam')" app/server/exam-routes.js app/server/exam-upload-routes.js` → 6 與 16，另兩支在 `checkExamToken` 裡 |
| `is_internal` 沒有任何 API 寫得到 | `git diff origin/master \| grep -n "is_internal"` 逐條看，只能出現在「讀」與「刻意忽略」的位置 |
| 暫時預設值真的拿掉了 | `grep -rn "is_internal = true LIMIT 1" app/server --include=*.js \| grep -v tests/` 應為空 |
| `validateRoleCompany` 有人呼叫了 | `grep -rn "validateRoleCompany" app/server --include=*.js \| grep -v tests/` 應有 admin-routes 的兩處 |
| 沒有寫死絕對路徑 | `git diff origin/master \| grep -nE '^\+' \| grep -E '/home/\|C:\\\\'` 回空 |
| 祕密沒有回給瀏覽器 | `git diff origin/master \| grep -n "git_pat_enc"` 逐條看，回應物件裡只能有 `has_git_pat` |

- [ ] **Step 2：請控制者派整枝總審查**

**這一關不可以省。** 第 1 部與第 2 部各有一個「掉在兩份計畫中間、所有人都以為做完了」的缺陷，兩次都是整枝總審查抓到的，逐關審查兩次都沒看見。

總審查要特別看的：
- 規格 §5.3 的表**逐列**對一次，哪一列本計畫沒做、有沒有寫進「刻意不做」清單
- 「對現在平台上的人零改變」還成不成立——特別是內部公司 `features` 是 NULL 卻必須全開這條
- 三道檢查（全域公司閘門、功能開關、角色）疊起來有沒有互相干擾
- 新端點有沒有被 Part 2 的靜態守衛掃到；掃不到的要說明為什麼

- [ ] **Step 3：把第 2 部與第 3 部 a 一起送交使用者裁決**

使用者 2026-09-21 的指示是「先不要合併，全部都好了再合」。所以**這一關不自行合併**，把以下攤開給使用者：
1. 第 2 部 ＋ 第 3 部 a 合起來對那 7 個內部一般使用者的實際影響（第 2 部收回至少 8 樣工具；第 3 部 a 不再收回任何東西，考試與 Odoo 設定都維持可用）
2. 前端還沒做（3b），所以按鈕仍會留在畫面上、按下去 403
3. 第一家客戶公司建立之前還缺什麼

- [ ] **Step 4：更新規格頁**

照記憶 `spec-progress-annotation`：改 `docs/superpowers/specs/2026-09-11-productize-rollout-plan.md` 的 `## 0. 目前進度` 表 → `cd docs/superpowers/specs/_page && node build-specs-page.js` → 手動複製到 `docs/odoo-v2-saas-specs.html`。**驗證到什麼程度要寫出來**：未合併、未重啟、未實測都要講。

---

## 自我檢查（寫完計畫後對照規格跑過一次）

**規格涵蓋**（§5.3 逐列）：
- `project-routes.js`／`search-routes.js`／`wiki-routes.js`／`chat-routes.js`／`tasks-routes.js`／`env-routes.js`／`db-query-routes.js`／`pipeline-routes.js` → **第 2 部已完成**，本計畫不重做。
- `exam-routes.js`／`exam-upload-routes.js` → **Task 2**。
- `settings.js` → **Task 9**。
- `admin-routes.js`（使用者建立／修改要能設 `company_id` 與 `company_admin`）→ **Task 7**。
- 新增 `company-routes.js` → **Task 6**。
- 新增 公司管理（admin）→ **Task 3（公司本身）＋ Task 4（綁定）＋ Task 5（公司 GIT）**。
- `auth.js` 註冊（§8 P3）→ **Task 8**。
- §6 公司 GIT 綁定時 `git ls-remote` 驗證 → **Task 5**。
- §7 第五個檢查點（立刻中止）→ **Task 10**。
- §5.5 前端 → **刻意不做，留給 3b**（已寫進「本計畫刻意不做」）。

**沒有涵蓋而且刻意寫明的**：§5.5 前端、子專案 2 的 API key 欄位、客戶離開流程、考試題庫依公司分家、已排入佇列的考試判題無法中止、`active_from`／`active_until` 無法改回 NULL。

**型別一致性**：`companyHasFeature(companyId, key)` 在 Task 1 定義，Task 2、9 依同一簽章使用；`requireFeature(key)` 回 middleware，Task 2、9 都掛在 `verifyToken` 之後；`abortCompanyTasks(companyId)` 在 Task 10 定義並於同一關使用；`buildGitEnvFromPat(pat, ids)` 在 Task 5 定義並於同一關使用。
