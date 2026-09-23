# 租戶隔離 第 3 部 b：前端與畫面 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓畫面說實話——後端已經拒絕的操作不要再顯示成可以按；並補上公司管理員與平台管理員各自需要的兩個新頁面。

**Architecture:** 沿用既有的三層防線（nav 的 `v-if`、router 的 meta guard、後端 403），只是把判斷條件從單一的 `isAdmin` 擴成 `isAdmin`／`isInternal`／`isCompanyAdmin`／公司功能開關。前端沒有 DOM 測試，所以每一關都要靠「靜態守衛測試 ＋ 瀏覽器人工實測」兩種驗證。

**Tech Stack:** Vue 3（CDN、無建置步驟）、hash router、jest（靜態掃描式守衛）。

**Spec:** `docs/superpowers/specs/2026-09-11-tenant-isolation-design.md` §5.5 為主，§2、§8 P2／P3 為輔。現況事實：`.claude/worktrees/tenant-scope/.superpowers/sdd/part3b-frontend-research.md`（2026-09-21 唯讀盤查，所有 file:line 以該份為準）。

**基線分支：** `feat/tenant-scope`（3a 完成之後的 HEAD）。**不是 master。**

---

## Global Constraints

- **全跑測試一律 `cd app && npm run test:quiet`**（含 `--runInBand`）。單檔用 `cd app && npx jest server/tests/<檔名> --runInBand`。
- **基線自己量**，動手前跑一次全跑記下 `Test Suites:` 與 `Tests:`。
- **exit code 不經管線**：`npm run test:quiet > out 2>&1; echo "EXITCODE=$?" >> out`，再讀檔。
- **三處齊做（`.claude/rules/frontend.md` 38）**：藏一個功能＝nav 的 `v-if` ＋ router 的 meta guard ＋ 後端 403，**缺一都是破口**。本計畫每一關都要說清楚這三處各自在哪。
- **配色硬規則**（`rules/frontend.md` 31／32／33）：新畫面一律從 `app/public/styleguide.html` 挑 token 或共用 class；**禁目測填 px、禁寫死顏色**；語意色走 `app.css` 的共用 class 或 `var(--danger)` 這類變數；**不要用 `.btn-secondary`**（`app.css` 從來沒有定義它，用了等於裸按鈕）。
- **深色模式是硬性驗收項**（規則 30）：每一關的人工實測都要在淺色與深色各看一次。寫死的淺色底在深色模式會變成亮底白字。
- **只改 `app/public/js/ui-next/`**。`app/public/js/views/` 是 legacy，只有 `?ui=legacy` 才載得到，**不需要維護**（`index.html:16-20` 的 `DEFAULT_UI = 'next'`）。動到它就是白做。
- **`app.js` 是兩套前端共用的同一份路由表** —— 改 route meta 會同時影響 legacy，這是正常且正確的。
- 註解用繁體中文寫「為什麼」。**禁止寫死絕對路徑。零順手重構。**
- **commit 用 `git add <明確路徑>`，禁用 `git add -A`**；commit 後 `git status --porcelain -uno`。
- **既有測試紅了不要偷偷改它讓它綠**——回報，由控制者裁決。

---

## 本計畫刻意不做

寫在這裡是為了讓執行者知道什麼**不該**做——第 2 部就是因為漏寫這份清單，把考試系統整個弄丟。

- **legacy 前端（`app/public/js/views/`）一律不動。**
- **不做 DOM／瀏覽器自動化測試。** repo 裡沒有這套工具鏈（`package.json` 的測試相依只有 jest＋supertest＋pg-mem），本計畫不引入。驗證靠靜態守衛＋人工實測。
- **不重構 `isAdmin` 的散落定義。** 它目前在殼層與 5 個分頁各算一次（研究 §2 列出全部行號）。統一它是好事，但那是獨立的清理工作，混進來會讓這一版的審查失焦。
- **不碰 3a 已經審查通過的後端端點**，除了本計畫明列的兩處新增（`/api/auth/me` 多吐欄位、`GET /api/tasks/:id/events` 加限制）。
- **客戶自助註冊的畫面殘留**：3a 已把 `POST /api/auth/register` 關成 403，前端若還有註冊入口，本計畫**只隱藏入口**，不重寫註冊流程。

---

## 兩個在寫計畫時發現、必須先講明的事實

### 事實一：3b 不是純前端，需要後端兩處

1. **`/api/auth/me` 沒有吐 `is_internal`**（`auth.js:210-230`）。後端 `req.actor.isInternal` 早就算好了（`buildActor`，`auth.js:25-45`），但沒有給前端。前端因此**無從得知自己是不是內部人員**。這是 §5.5 的 `isInternal` 判斷能不能存在的前提。
   （`isCompanyAdmin` 不需要後端改——`role === 'company_admin'` 可由現有欄位推導。）

2. **`/api/auth/me` 也沒有吐公司的功能開關**，理由見下。

### 事實二：規格 §5.5 對「ODOO 認證輔助」的寫法已經被 2026-09-21 的裁決推翻

§5.5 原文要求把「架構圖、流程圖、ODOO 認證輔助」三個入口都改成**平台管理員限定**。

但 3a 已經依使用者裁決，把**考試改成公司層級的功能開關**（內部公司全開、客戶預設關），理由正是「鎖成管理員限定會把考試從那 7 個同事手上收走」。

⇒ **前端若照 §5.5 字面把考試入口寫成 `v-if="isAdmin"`，就是繞一圈回到使用者否決過的結果。**

**本計畫的處理**：架構圖與流程圖照 §5.5 收成平台管理員限定；**考試入口改依公司功能開關**，所以 `/api/auth/me` 要一併吐出這個人所屬公司的功能開關。規格 §5.5 那一列要跟著更新，本計畫最後一關負責。

---

## 檔案結構

| 檔案 | 這一版的職責 |
|---|---|
| `app/server/auth.js` | `/api/auth/me` 多吐 `is_internal` 與 `features` 兩個欄位 |
| `app/server/tasks-routes.js` | `GET /api/tasks/:id/events` 加平台管理員限定（D2 裁決的後端那一處） |
| `app/public/js/store.js` | `UserStore` 從只有 `role` 擴成也放 `isInternal`／`companyId`／`features` |
| `app/public/js/app.js` | route meta 新增 `requiresInternal`，guard 加對應分支 |
| `app/public/js/ui-next/UiNextApp.js` | 殼層 nav：更多工具三顆按鈕、側欄專案右鍵選單 |
| `app/public/js/ui-next/pages/ProjectDetail.js` | 分頁列與動作按鈕依角色顯示 |
| `app/public/js/ui-next/pages/TaskDetail.js` | 「執行歷程」按鈕 |
| **新** `app/public/js/ui-next/pages/CompanyUsers.js` | 公司管理員的「公司帳號」頁 |
| **新** `app/public/js/ui-next/pages/CompanyAdmin.js` | 平台管理員的公司管理頁 |
| `app/public/index.html` | `UI_NEXT_PAGES` 陣列加兩個新頁 |
| **新** `app/server/tests/frontend-tenant-guard.test.js` | 靜態守衛：新旗標的 nav／router 兩處 |

---

## Task 0：開工前置

- [ ] **Step 1：確認分支與基線**

```bash
cd /home/odoo/odoo-v2/.claude/worktrees/tenant-scope
git log --oneline -1          # 應為 3a 完成後的 HEAD
git status --porcelain        # 應為空
cd app && npm run test:quiet > /tmp/3b-baseline.log 2>&1; echo "EXITCODE=$?" >> /tmp/3b-baseline.log
tail -8 /tmp/3b-baseline.log
```

把 `Test Suites:` 與 `Tests:` 記進報告。

- [ ] **Step 2：確認自己在看活的那一套前端**

```bash
grep -n "DEFAULT_UI" app/public/index.html
```
Expected：`DEFAULT_UI = 'next'`。**看到別的值就停下來回報**——代表活的前端換了，本計畫的每一個 file:line 都要重新確認。

---

## Task 1：後端補兩個欄位（3b 的前提）

**Files:**
- Modify: `app/server/auth.js`（`/api/auth/me`，約 `:210-230`）
- Test: `app/server/tests/auth-me-tenant-fields.test.js`（新）

**Interfaces:**
- Produces：`GET /api/auth/me` 的回應新增
  - `is_internal: boolean` — 取自 `req.actor.isInternal`
  - `features: { [key: string]: boolean }` — 這個人所屬公司的有效功能開關

**為什麼**：前端要判斷「我是不是內部人員」「我能不能用考試」，這兩件事的答案都只在後端。`isCompanyAdmin` 不必加，前端由 `role === 'company_admin'` 推導即可。

**`features` 要回「有效值」不是「資料庫原始值」**：內部公司與沒有公司的人（平台管理員）在 `companyHasFeature` 裡是一律全開的，但他們的 `companies.features` 欄位可能是 NULL。若直接把原始欄位吐出去，前端會以為他們什麼功能都沒有，**於是把考試入口藏起來——正是這個計畫要避免的結果**。所以要用 `lib/company-features.js` 的判斷逐項算出有效值。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/auth-me-tenant-fields.test.js`：

```javascript
/**
 * auth-me-tenant-fields.test.js — /api/auth/me 要吐出前端判斷身分所需的欄位（3b 前提）
 *
 * 前端沒有別的管道知道「我是不是內部人員」「我能不能用考試」。
 * features 必須回「有效值」：內部公司與平台管理員在後端是一律全開的，
 * 但他們的 companies.features 欄位是 NULL——直接吐原始值會讓前端把入口藏起來。
 */
const request = require('supertest');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

jest.mock('../pipeline/runner', () => ({
  ...jest.requireActual('../pipeline/runner'),
  runPipeline: jest.fn().mockResolvedValue({ dispatched: 0 })
}));

process.env.JWT_SECRET = 'test-me-jwt';
process.env.APP_SECRET = 'test-me-secret';

let app, dbModule, adminToken, internalToken, custOnToken, custOffToken;

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

  const mkCo = async (name, opts = {}) => (await one(
    'INSERT INTO companies (name, is_active, is_internal, features) VALUES ($1,true,$2,$3) RETURNING id',
    [name, !!opts.internal, opts.features === undefined ? null : JSON.stringify(opts.features)]
  )).id;
  const coInternal = await mkCo('內部', { internal: true });
  const coOn = await mkCo('有考試的客戶', { features: { exam: true } });
  const coOff = await mkCo('沒考試的客戶', { features: { exam: false } });

  const mkUser = async (username, companyId, role = 'user') => {
    const hash = await bcrypt.hash('password123', 10);
    await dbModule.query(
      'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4)',
      [username, hash, role, companyId]);
    return (await request(app).post('/api/auth/login').send({ username, password: 'password123' })).body.token;
  };
  internalToken = await mkUser('inside', coInternal);
  custOnToken = await mkUser('cust-on', coOn);
  custOffToken = await mkUser('cust-off', coOff);
});

afterAll(() => dbModule._setPoolForTesting(null));

test('內部公司的一般使用者：is_internal 為 true', async () => {
  const res = await request(app).get('/api/auth/me').set(as(internalToken));
  expect(res.status).toBe(200);
  expect(res.body.is_internal).toBe(true);
});

test('客戶公司的一般使用者：is_internal 為 false', async () => {
  expect((await request(app).get('/api/auth/me').set(as(custOnToken))).body.is_internal).toBe(false);
});

test('平台管理員沒有公司：is_internal 為 true（他們本來就是內部人員）', async () => {
  expect((await request(app).get('/api/auth/me').set(as(adminToken))).body.is_internal).toBe(true);
});

test('內部公司的 features 欄位是 NULL，但回傳的有效值必須全開', async () => {
  const res = await request(app).get('/api/auth/me').set(as(internalToken));
  expect(res.body.features.exam).toBe(true);
});

test('平台管理員同理全開', async () => {
  expect((await request(app).get('/api/auth/me').set(as(adminToken))).body.features.exam).toBe(true);
});

test('客戶公司開了考試 → true；沒開 → false', async () => {
  expect((await request(app).get('/api/auth/me').set(as(custOnToken))).body.features.exam).toBe(true);
  expect((await request(app).get('/api/auth/me').set(as(custOffToken))).body.features.exam).toBe(false);
});

test('回應不含密碼雜湊或任何密文（既有行為，不可因新增欄位而破壞）', async () => {
  const body = JSON.stringify((await request(app).get('/api/auth/me').set(as(internalToken))).body);
  expect(body).not.toContain('password_hash');
  expect(body).not.toContain('$2a$');
});
```

- [ ] **Step 2：跑測試確認它紅**

```bash
cd app && npx jest server/tests/auth-me-tenant-fields.test.js --runInBand 2>&1 | tail -20
```
Expected：`is_internal` 與 `features` 相關的斷言失敗（`undefined`）。

- [ ] **Step 3：實作**

在 `auth.js` 頂部（或函式內，比照該檔既有 require 風格）取得 `FEATURES` 與 `companyHasFeature`，並在 `/api/auth/me` 的回應加兩個欄位：

```javascript
      // 3b 需要：前端沒有別的管道知道「我是不是內部人員」「我能不能用哪些功能」。
      // features 必須算「有效值」而不是直接吐 companies.features——內部公司與平台管理員
      // 在 companyHasFeature 裡是一律全開的，但他們的欄位是 NULL，直接吐原始值
      // 會讓前端把他們的入口藏起來（正是 2026-09-21 裁決要避免的結果）。
      const features = {};
      for (const key of Object.keys(FEATURES)) {
        features[key] = await companyHasFeature(req.actor.companyId, key);
      }
```
回應物件加上 `is_internal: req.actor.isInternal` 與 `features`。

⚠ `/api/auth/me` 每次導覽都會被 router guard 呼叫一次（`app.js:300-312`，無快取）。功能數量現在是個位數，逐項查詢可接受；**若之後功能變多，這裡會變成每次換頁 N 次查詢**。在程式碼註解裡寫明這個已知成本，不要現在就做快取（YAGNI）。

- [ ] **Step 4：跑測試、全跑、commit**

```bash
cd app && npx jest server/tests/auth-me-tenant-fields.test.js --runInBand 2>&1 | tail -15
cd app && npm run test:quiet > /tmp/3b-t1.log 2>&1; echo "EXITCODE=$?" >> /tmp/3b-t1.log; tail -8 /tmp/3b-t1.log
cd .. && git add app/server/auth.js app/server/tests/auth-me-tenant-fields.test.js
git commit -m "[Tenant]: 前端無從得知自己是不是內部人員、能用哪些功能——判斷的依據只在後端"
git status --porcelain -uno
```

---

## Task 2：前端把身分接起來

**Files:**
- Modify: `app/public/js/store.js`
- Modify: `app/public/js/ui-next/UiNextApp.js`（`:431` data、`:567` mounted、`:1171` logout）

**Interfaces:**
- Produces：`window.UserStore` 從 `{ role }` 擴成 `{ role, isInternal, companyId, companyName, features }`

**為什麼放 store 而不是各分頁自己算**：`isAdmin` 現在散落在殼層與 5 個分頁各算一次（研究 §2 列出全部行號）。**本計畫不重構既有的那 5 處**（零順手重構），但新增的兩個旗標從一開始就放在一個地方，不要複製第 6 份。

- [ ] **Step 1：擴充 store**

`app/public/js/store.js` 目前只有兩行。改成：

```javascript
window.UnreadStore = Vue.reactive({ byProject: {} });
// 身分旗標集中放這裡。既有的 isAdmin 散落在殼層與 5 個分頁各算一次（歷史包袱，本版不動），
// 但新加的旗標一律只在這裡有一份——不要再複製第 6 份出來。
window.UserStore = Vue.reactive({
  role: '',
  isInternal: false,
  companyId: null,
  companyName: '',
  features: {},
});
```

**預設值一律是「最少權限」**：`isInternal: false`、`features: {}`。在 `/api/auth/me` 回來之前畫面不應該先把東西顯示出來再收回去——那個閃爍會讓使用者以為自己有權限。

- [ ] **Step 2：mounted 時填入**

`UiNextApp.js:567` 附近既有的 `this.isAdmin = me.role === "admin";` 旁邊補：

```javascript
      window.UserStore.isInternal = me.is_internal === true;
      window.UserStore.companyId = me.company_id ?? null;
      window.UserStore.companyName = me.company_name || '';
      window.UserStore.features = me.features || {};
```

- [ ] **Step 3：logout 時清乾淨**

`UiNextApp.js:1171` 的 `logout()` 目前清 `window.UserStore.role = ""`。**先讀那一段確認 `this.isAdmin` 有沒有跟著清**（研究 §2 指出「未見到同步清空的那一行，需要在計畫裡核實」）。

把新加的四個欄位一起清回預設值。**若發現 `this.isAdmin` 確實沒有被清**，那是既有缺陷——**回報，不要順手修**（零順手重構），我會決定放哪一關。

- [ ] **Step 4：人工實測 ＋ commit**

這一關沒有可斷言的畫面變化，驗法是在瀏覽器 console 看 `window.UserStore`：以平台管理員、內部一般使用者各登入一次，確認四個欄位有值且正確；登出後確認清乾淨。**把兩次的實際值貼進報告。**

```bash
git add app/public/js/store.js app/public/js/ui-next/UiNextApp.js
git commit -m "[Tenant]: 前端只知道 role，無從分辨內部人員、公司、能用哪些功能"
```

---

## Task 3：Router 的 meta 與 guard

**Files:**
- Modify: `app/public/js/app.js`（route 表 `:193-223`、guard `:300-312`）

**Interfaces:**
- Produces：route meta 新增 `requiresInternal`（布林）

**為什麼不加 `requiresCompanyAdmin`**：公司帳號頁（Task 7）是**公司管理員與平台管理員都能進**的。用一個 `requiresCompanyAdmin` 會把平台管理員擋在外面，得再加例外，反而更難讀。那一頁在 guard 裡用 `role === 'company_admin' || role === 'admin'` 這個明確條件判斷即可——**只有一個頁面用得到，不值得發明一個 meta 旗標**（YAGNI）。

- [ ] **Step 1：guard 加分支**

`app.js:300-312` 既有 guard 已經會在 `requiresAdmin` 時打一次 `auth/me`。新分支比照同樣寫法：

```javascript
  if (to.meta.requiresInternal) {
    try {
      const me = await Api.get("auth/me");
      // 平台管理員沒有公司，後端一律視為內部人員；這裡照樣只看 is_internal，
      // 不要再補 role === 'admin' 的特判——特判會讓兩邊的定義慢慢分岔。
      if (me.is_internal !== true) return "/forbidden";
    } catch {
      return { path: "/login", query: { redirect: to.fullPath } };
    }
  }
```

⚠ **不要把兩次 `auth/me` 合併成一次**（`requiresAdmin` 與 `requiresInternal` 各打一次）。合併是對的方向，但那是既有 guard 的重構，超出本關範圍——在註解裡記一句「兩個分支各打一次，之後可合併」即可。

- [ ] **Step 2：架構圖與流程圖改成平台管理員限定**

`app.js:193-223`，`/architecture` 與 `/pipeline-flow` 兩條的 meta 從 `{ requiresAuth: true }` 改成 `{ requiresAuth: true, requiresAdmin: true }`。

- [ ] **Step 3：考試兩條路由改成內部限定**

`/exam-bank` 與 `/exam-run` 改成 `{ requiresAuth: true, requiresInternal: true }`。

**為什麼是 `requiresInternal` 而不是 `requiresAdmin`**：規格 §5.5 原文寫「ODOO 認證輔助 → 平台管理員限定」，但那一列已被 2026-09-21 的裁決推翻——考試改由公司功能開關決定，而鎖成管理員限定會把考試從 7 個內部同事手上收走。router 這一層用 `requiresInternal` 是**近似**（內部人員＝有考試功能），真正精確的判斷在後端（`requireFeature('exam')`，3a Task 2 已上線）與 nav（Task 4 用 `features.exam`）。

⚠ 這個近似在「客戶公司被開了考試功能」時會過嚴：router 會擋，但後端其實放行。**這是刻意的保守**——router 擋錯的後果是客戶看不到一個他該看到的入口（會有人來說），放行錯的後果是客戶進到內部題庫（不會有人說）。把這段理由寫進 route 的註解。

- [ ] **Step 4：`/task/:id/terminal` 改成平台管理員限定**

`app.js:131-135`。依 2026-09-21 使用者裁決 D2（「兩個都收」）。

- [ ] **Step 5：跑既有的 router 守衛測試**

```bash
cd app && npx jest server/tests/frontend-admin-route-guard.test.js server/tests/frontend-syntax.test.js --runInBand 2>&1 | tail -20
```

⚠ `frontend-admin-route-guard.test.js` 會斷言「`role` 檢查只出現在 `requiresAdmin` 分支」。你新增的 `requiresInternal` 分支查的是 `is_internal` 不是 `role`，**理論上不該觸發它**——但**真的紅了就停下來回報**，那代表那支守衛的規則需要一起更新，而怎麼更新要由我裁決。

- [ ] **Step 6：全跑 ＋ commit**

```bash
cd app && npm run test:quiet > /tmp/3b-t3.log 2>&1; echo "EXITCODE=$?" >> /tmp/3b-t3.log; tail -8 /tmp/3b-t3.log
cd .. && git add app/public/js/app.js
git commit -m "[Tenant]: 架構圖、流程圖、考試、終端機頁面任何登入者都進得去"
```

---

## Task 4：殼層 nav —— 更多工具與側欄選單

**Files:**
- Modify: `app/public/js/ui-next/UiNextApp.js`（`:1259` 更多工具、`:1250` 側欄專案右鍵選單、`:1249` 側欄任務右鍵選單）

**為什麼 nav 與 router 都要做**：router 擋的是「直接打網址」，nav 藏的是「畫面上看得到」。只做 router，使用者會看到按鈕、按下去被踢到 `/forbidden`——看起來像壞掉。只做 nav，知道網址的人照樣進得去。

- [ ] **Step 1：更多工具的三顆按鈕**

`UiNextApp.js:1259`。目前「架構圖」「流程圖」「ODOO認證輔助」**完全沒有 `v-if`**。

- 架構圖、流程圖 → `v-if="isAdmin"`（比照同一個選單裡「進行中 Pipeline」「用量報表」「產品化規格」的既有寫法）
- ODOO 認證輔助（考試）→ **`v-if="userStore.features.exam"`**，理由同 Task 3 Step 3

殼層要能讀到 store，比照既有寫法在 computed 加一個 `userStore() { return window.UserStore; }`（若殼層已有等價物就沿用，**先讀過再加**）。

- [ ] **Step 2：側欄專案右鍵選單**

`UiNextApp.js:1250`，項目：測試區／上正式／REPO／連線設定／專案設定。

- 「REPO」「連線設定」→ `v-if="isAdmin"`（它們導去的分頁在 Task 5 也會被藏，兩處都要）
- 「專案設定」→ `v-if="isAdmin"`（`PUT /api/projects/:id` 已是平台管理員限定）
- 「上正式」→ **不要用 `isAdmin`**。後端的規則是 `canReleaseProject`（平台管理員，或該專案綁定勾了「可上正式」的公司管理員）。前端無法只靠 `role` 算出這個答案。**這一項本關不動，改在 Task 5 處理**，理由見那一關。
- 「測試區」→ 不動（讀取類端點對一般使用者仍開放）

- [ ] **Step 3：人工實測（四種身分）**

以平台管理員、內部一般使用者各登入一次，確認：管理員看得到全部；一般使用者看不到架構圖、流程圖、REPO、連線設定、專案設定，**但看得到考試**（這一項是整個計畫的試金石——看不到就是又把同事鎖掉了）。**淺色與深色各看一次。**

- [ ] **Step 4：commit**

```bash
git add app/public/js/ui-next/UiNextApp.js
git commit -m "[Tenant]: 選單顯示著一般使用者按下去只會 403 的工具"
```

---

## Task 5：專案頁的分頁與動作按鈕

**Files:**
- Modify: `app/public/js/ui-next/pages/ProjectDetail.js`（`tabs()` computed 約 `:13-17`、動作按鈕 `:181-183`／`:200`／`:215-220`、既有 `isAdmin` computed `:127`）
- Modify: `app/public/js/ui-next/UiNextApp.js`（側欄「上正式」那一項）

**這一關是 Part 2 造成「按鈕還在、按了 403」的主要現場。** 研究 §9 逐項核過，以下四個分頁對一般內部使用者全部無條件顯示：

| 分頁 | 後端現況 | 這一關怎麼做 |
|---|---|---|
| **Repo** | 四個寫入端點全是平台管理員限定（`project-routes.js:738/812/893/918`），`GET` 不限 | **整個分頁藏起來**。讀得到但什麼都不能改的分頁沒有價值，只會讓人以為自己壞了 |
| **連線設定（db）** | `db-query-routes.js` **全部**端點（含 `GET`）都是平台管理員限定 | **整個分頁藏起來**。一般使用者切進去連清單都讀不到，畫面會直接顯示錯誤 |
| **測試環境（env）** | `GET` 類開放；四個動作端點是平台管理員限定（`env-routes.js:179/189/223/231`） | **分頁保留**（客戶驗收要進測試區），**只藏四顆動作按鈕**（`:215-220`） |
| **自動部署** | `deploy-routes.js` 全部端點平台管理員限定 | **整個分頁藏起來**。既有的 `auto_deploy_enabled` 判斷保留，再加角色條件 |

- [ ] **Step 1：`tabs()` 依角色過濾**

`ProjectDetail.js:13-17` 目前是：

```js
tabs() {
  const base = [["chat","Chat"],["settings","設定"],["repos","Repo"],["db","連線設定"],["env","測試環境"],["wiki","Wiki"]];
  if (this.project && this.project.auto_deploy_enabled) base.push(["deploy","自動部署"]);
  return base;
},
```

改成只有平台管理員才 push `repos`、`db`、`deploy` 三個。`chat`／`settings`／`env`／`wiki` 維持所有人可見。

⚠ **同時檢查 `activeTab` 的預設值與切換邏輯**：如果一般使用者的網址或 localStorage 記著 `repos`，而那個分頁現在不存在，畫面可能變成空白。**先讀那段再改**；若發現會空白，讓它落回第一個可見分頁，並在註解寫明為什麼。

- [ ] **Step 2：測試環境的四顆動作按鈕**

`ProjectDetail.js:215-220`（「建立環境／重新啟動」「停止」「刪除環境」「關閉對外」）加 `v-if="isAdmin"`。`ProjectDetail.js:127` 已有 `isAdmin` computed，直接用。

- [ ] **Step 3：「上正式」——這一項不能用 `isAdmin`**

後端的規則是 `canReleaseProject`：平台管理員，**或**該專案綁定勾了「可上正式」的公司管理員。前端光靠 `role` 算不出來——它取決於**這個人的公司在這個專案上的綁定**。

**做法**：專案資料裡要帶一個布林，例如 `can_release`，由後端依呼叫者算好。**這需要後端配合**，而 `GET /api/projects/:id` 是 3a 沒有動過的端點。

**所以這一步是：先讀 `GET /api/projects/:id` 的回應，確認有沒有現成可用的欄位。**
- **有** → 前端直接用，`v-if` 掛上去。
- **沒有** → **停下來回報**。要在既有端點加欄位是後端改動，由我裁決要不要做、放哪一關。**不要自己加**，也**不要**退而求其次寫成 `v-if="isAdmin"`——那會讓有權限的公司管理員看不到自己該有的按鈕，而那正是 3a Task 4 花力氣做出來的能力。

- [ ] **Step 4：人工實測**

以平台管理員與內部一般使用者各開一個專案頁：
- 管理員：六個分頁都在，動作按鈕都在
- 一般使用者：只看得到 Chat／設定／測試環境／Wiki；測試環境分頁進得去、**但四顆動作按鈕不見**；沒有 Repo／連線設定／自動部署
- **切換分頁不會白畫面**（Step 1 的 ⚠）
- **淺色與深色各看一次**

- [ ] **Step 5：commit**

```bash
git add app/public/js/ui-next/pages/ProjectDetail.js app/public/js/ui-next/UiNextApp.js
git commit -m "[Tenant]: 專案頁四個分頁對一般使用者全開，點進去每個動作都 403"
```

---

## Task 5b：後端補 `can_release`，讓「上正式」按鈕算得出來（2026-09-21 追加）

**Files:**
- Modify: `app/server/project-routes.js`（專案列表與單一專案的回應）
- Modify: `app/public/js/ui-next/UiNextApp.js`（側欄「上正式」項目）
- Test: `app/server/tests/project-can-release-flag.test.js`（新）

**為什麼追加這一關：** Task 5 依計畫停下來回報——`GET /api/projects/:id`（`project-routes.js:464-489`）**沒有回任何能判斷「這個人能不能按上正式」的欄位**，而那個答案前端算不出來：它取決於**這個人的公司在這個專案上的綁定有沒有勾 `can_release`**。

兩條路都不能走：
- 寫 `v-if="isAdmin"` → **把按鈕從真正有權限的公司管理員手上藏掉**，毀掉 3a Task 4 做出來的能力。
- 什麼都不做 → 留一顆按下去必定 403 的按鈕，而**消滅這種按鈕正是第 3 部 b 存在的理由**。

所以補後端那一個欄位。

**這是本計畫第二處後端改動**（第一處是 Task 1 的 `/api/auth/me`），兩處都在「前端拿不到判斷依據」這個同一個原因上。

- [ ] **Step 1：先確認按鈕吃的是哪一份資料**

「上正式」出現在側欄專案右鍵選單（`UiNextApp.js:1272`），那份選單的專案清單來自**列表端點**，不是單一專案端點。

```bash
grep -n "api/projects" app/public/js/ui-next/UiNextApp.js | head
```

**先確認清楚按鈕實際吃哪一個回應**，再決定要在哪個（或哪兩個）端點補欄位。**只補到沒人讀的那一份，就是做白工而且測試還會綠。**

- [ ] **Step 2：寫失敗的測試**

Create `app/server/tests/project-can-release-flag.test.js`。至少涵蓋：

- 平台管理員 → `can_release` 為 `true`
- 公司管理員、該專案綁定 `can_release = true` → `true`
- 公司管理員、綁定 `can_release = false` → `false`
- 一般使用者（同公司、綁定有勾）→ **`false`**（勾的是公司管理員的權限，不是全公司的）
- 看不到這個專案的人 → 拿不到這筆資料（維持既有的 404／過濾行為，不要因為加欄位而改變可見性）

fixture 形狀照 `tenant-routes-scope.test.js`。**判斷一律呼叫既有的 `canReleaseProject`（`lib/tenant-access.js`），不要在路由裡重寫一份**——兩份判斷會漂，而漂掉的那一天沒有人會發現。

- [ ] **Step 3：後端補欄位**

在回應裡加 `can_release`，值取自 `canReleaseProject(req.actor, <projectId>)`。

⚠ **列表端點要小心 N+1**：若列表一次回 17 個專案，逐個 `await` 就是 17 次查詢。先讀既有的列表查詢怎麼組，**能用一次 JOIN 帶出來就用 JOIN**；真的只能逐筆，就在註解寫明這個成本與為什麼接受。

- [ ] **Step 4：前端掛上去**

`UiNextApp.js:1272` 的「上正式」加 `v-if`，條件用新欄位（**不是 `isAdmin`**）。註解寫明為什麼不能用角色判斷，並指向 `canReleaseProject`。

- [ ] **Step 5：全跑 ＋ commit**

```bash
cd app && npm run test:quiet > /tmp/3b-t5b.log 2>&1; echo "EXITCODE=$?" >> /tmp/3b-t5b.log; tail -8 /tmp/3b-t5b.log
git add app/server/project-routes.js app/public/js/ui-next/UiNextApp.js app/server/tests/project-can-release-flag.test.js
git commit -m "[Tenant]: 前端算不出誰能按上正式，只好整顆顯示給所有人——按下去必定 403"
git status --porcelain -uno
```

---

## Task 6：執行歷程與終端機頁（含後端那一處）

**Files:**
- Modify: `app/server/tasks-routes.js`（`GET /api/tasks/:id/events`，約 `:611`）
- Modify: `app/public/js/ui-next/pages/TaskDetail.js`（`:1110` 按鈕）
- Test: `app/server/tests/task-events-admin-only.test.js`（新）

**為什麼這一關跟其他的不一樣**：前面六項都是「後端已經擋了、畫面還沒跟上」。這一項**前後端目前是一致的——都對所有登入使用者開放**。是 2026-09-21 使用者裁決 D2（「兩個都收」）要求把它收起來，所以**後端也要改**，不是只藏按鈕。

規格 §5.5 沒有列到這個後端端點——這是逐項核實時才發現的，寫在這裡免得又掉進計畫縫裡。

- [ ] **Step 1：寫失敗的測試**

Create `app/server/tests/task-events-admin-only.test.js`：一般使用者（有公司、綁了該專案、任務是他自己的）打 `GET /api/tasks/:id/events` → 403；平台管理員 → 200。fixture 形狀照 `tenant-routes-scope.test.js`。

⚠ **回 403 不是 404**：這個人看得到這張任務（那是他自己的），只是不能看執行歷程——屬於「看得到但不能做這個動作」，正是 403 的兩種正當情境之一。

- [ ] **Step 2：後端加限制**

`tasks-routes.js:611` 的 `GET /api/tasks/:id/events` 加 `requirePlatformAdmin`。

⚠ **先確認這支端點沒有被別的東西依賴**：`grep -rn "events" app/public/js/ui-next | grep -v node_modules` 看看除了「執行歷程」按鈕還有誰在打它。**有別的呼叫端就停下來回報**——把某個一般使用者天天在用的功能靜默關掉，跟這一關的意圖不同。

- [ ] **Step 3：前端藏按鈕**

`TaskDetail.js:1110` 的按鈕加 `v-if="isAdmin"`（`:14` 已有 `isAdmin` computed）。

- [ ] **Step 4：全跑 ＋ 人工實測 ＋ commit**

一般使用者的任務詳情頁不該再看到那顆終端機圖示鈕；管理員照舊。淺色深色各看一次。

```bash
git add app/server/tasks-routes.js app/public/js/ui-next/pages/TaskDetail.js app/server/tests/task-events-admin-only.test.js
git commit -m "[Tenant]: 執行歷程對所有登入者開放，前後端都沒擋"
```

---

## Task 7：公司管理員的「公司帳號」頁

**Files:**
- Create: `app/public/js/ui-next/pages/CompanyUsers.js`
- Modify: `app/public/index.html`（`UI_NEXT_PAGES` 陣列）
- Modify: `app/public/js/app.js`（新路由）
- Modify: `app/public/js/ui-next/UiNextApp.js`（帳號選單入口）

**後端契約（3a Task 6 已上線並審查通過，不要改它）**：

| 端點 | 用途 | 回應要點 |
|---|---|---|
| `GET /api/company/users` | 列出自己公司的帳號 | `[{ id, username, display_name, role, company_id, approved, created_at }]` |
| `POST /api/company/users` | 新增 | body `{ username, password, display_name, role }`；`role` 只能是 `user` 或 `company_admin`；**`company_id` 送了也不算數**（後端從身分取） |
| `PUT /api/company/users/:id` | 改顯示名稱或角色 | 角色只能在 `user` ↔ `company_admin` 之間 |
| `PUT /api/company/users/:id/active` | 停用／啟用 | body `{ active: boolean }` |

**沒有刪除端點**（規格 §8 P6：只能停用不能刪）。**畫面上不要出現「刪除」**，也不要用垃圾桶圖示做停用——那會讓人以為資料會不見。

- [ ] **Step 1：先讀兩個既有頁面當範本**

新增頁面的三處改動（`index.html` 的陣列、`app.js` 的路由、`UiNextApp.js` 的 nav）有現成前例：研究 §6 記錄了 `/saas-specs`（commit `1ed47965`）的完整作法，逐字抄那個形狀。**先讀過再動手。**

配色與 class **一律從 `app/public/styleguide.html` 挑**，禁目測填 px、禁寫死顏色、**不要用 `.btn-secondary`**（那個 class 不存在）。

- [ ] **Step 2：路由**

`path: "/company-users"`，meta `{ requiresAuth: true }`，並在 guard 裡加這一頁專屬的條件（`role === 'company_admin' || role === 'admin'`），理由見 Task 3 的「為什麼不加 `requiresCompanyAdmin`」。

- [ ] **Step 3：nav 入口**

放在「帳號與設定」下拉裡（`UiNextApp.js:1260` 那一組），`v-if="userStore.role === 'company_admin' || isAdmin"`。

- [ ] **Step 4：畫面**

一個清單（帳號、顯示名稱、角色、狀態）＋「新增帳號」＋每列的「改角色」「停用／啟用」。

**停用要二次確認**，而且確認文字要講清楚**會發生什麼事**：對方手上還沒過期的登入憑證會立刻失效（3a Task 6 做的），不是「下次登入才擋」。使用者需要知道這一點，否則他會以為還有緩衝。

- [ ] **Step 5：人工實測（這一關沒有自動化測試能涵蓋）**

用公司管理員身分：列得出自家帳號、看不到別家的；新增一個帳號並用它登入成功；把它停用後，**用它剛才那張還沒過期的 token 再打一次 API，確認被擋**；改角色成功。**淺色深色各看一次。** 把每一步的實際結果寫進報告。

- [ ] **Step 6：commit**

---

## Task 8：平台管理員的公司管理頁

**Files:**
- Create: `app/public/js/ui-next/pages/CompanyAdmin.js`
- Modify: `app/public/index.html`、`app/public/js/app.js`、`app/public/js/ui-next/UiNextApp.js`

**後端契約（3a Tasks 3／4／5 已上線並審查通過，不要改它）**：

| 端點 | 用途 |
|---|---|
| `GET /api/admin/companies` | 列公司，含 `user_count`、`project_count`、`has_git_pat`、`features` |
| `GET /api/admin/companies/features` | 可勾選的功能清單 `[{ key, label }]` |
| `POST /api/admin/companies` | 建立（`is_internal` 送了也會被忽略） |
| `PUT /api/admin/companies/:id` | 改名稱／啟用／使用期間／功能開關 |
| `GET /api/admin/companies/:id/projects` | 該公司綁了哪些專案，含 `can_release` 與 `task_count` |
| `PUT /api/admin/companies/:id/projects/:projectId` | 綁定或改 `can_release` |
| `DELETE /api/admin/companies/:id/projects/:projectId` | 解除綁定 |
| `PUT /api/admin/companies/:id/git` | 設公司 GIT（**存之前後端會真的連一次驗證**，失敗回 400 且不存） |
| `DELETE /api/admin/companies/:id/git` | 清除公司 GIT |

**畫面上三件必須講清楚的事**：

1. **`is_internal` 不可設定。** 內部公司那一列要標示出來，但**不要提供切換**。後端會忽略，畫面若提供開關等於騙人。
2. **解除綁定會讓那家公司立刻看不到該專案**，包含他們自己開的任務。`GET .../projects` 回的 `task_count` 就是為了讓操作的人知道影響幾張單——**確認對話框要把這個數字唸出來**。
3. **公司 GIT 存檔可能要等幾秒**（後端逐個 repo 跑 `git ls-remote`），**失敗時要把後端回的錯誤原文顯示出來**（它會指名是哪一個 repo 連不上）。不要吞掉換成「儲存失敗」——那會讓人完全無從查起。

- [ ] **Step 1：路由與 nav**

`path: "/companies"`，meta `{ requiresAuth: true, requiresAdmin: true }`；入口放「更多工具」，`v-if="isAdmin"`。三處齊做（nav／router／後端本來就已經是平台管理員限定）。

- [ ] **Step 2：畫面**

公司清單 → 點進去看單一公司：基本資料（名稱、啟用、使用期間）、功能開關（用 `GET /api/admin/companies/features` 畫勾選框）、綁定的專案（含「可上正式」勾選）、GIT 憑證（顯示「已設定／未設定」，不顯示任何密文）。

⚠ **`active_from`／`active_until` 目前無法清回「不限期間」**（3a 的已知取捨，後端用 COALESCE 更新）。畫面**不要提供清除按鈕**，並在欄位旁用一句話說明——提供了一個實際上沒用的按鈕比沒有更糟。

- [ ] **Step 3：人工實測**

建一家測試用公司 → 綁一個專案 → 勾「可上正式」→ 開一個功能 → 設一把**故意錯的** GIT PAT（確認會失敗、錯誤訊息指名 repo、而且舊值沒被洗掉）→ 解除綁定（確認對話框有唸出任務數）→ **最後把這家測試公司停用**，不要留在正式資料裡。淺色深色各看一次。

- [ ] **Step 4：commit**

---

## Task 8b：新手教學的步驟要跟著角色走（2026-09-21 追加）

**Files:**
- Modify: `app/public/js/tour-courses.js`（依角色跳過步驟）
- 可能 Modify: `app/public/js/tour.js`（若跳過機制不存在）

**為什麼追加這一關：** 本計畫藏起來的每一個入口，都可能是新手教學某一步的目標。目前已知**至少兩處**：

1. **Task 5 期間發現**：示範專案缺 `can_release`，教學第 ⑦ 課指向的「上正式」按鈕會對**所有人**消失。已在該關補掉（給假專案那個欄位），但那是治標。
2. **Task 6 期間發現**：教學第 ⑤ 課點的是「執行歷程」按鈕，而它現在對一般使用者隱藏。
3. **Task 3 留下的同型問題**：`/pipeline-flow` 變成管理員限定之後，指向它的步驟同樣落空。

目前的行為是「找不到錨點就把提示框置中顯示」——**不會當掉，但使用者看到的是一個指著空白的說明**。

**這件事的荒謬之處值得寫下來**：新手教學服務的對象，正好就是**新來的一般使用者與客戶**——也就是被這一版藏掉最多東西的那群人。教學對管理員完好，對它真正的受眾殘缺。

- [ ] **Step 1：先盤出全部受影響的步驟，不要邊做邊找**

把 `tour-courses.js` 每一課的每一個錨點，對照本計畫藏起來的元素逐一比對，**列成表**：課別、步驟、錨點、現在對誰不可見。

**前兩關是撞到才發現的；這一步要求一次找齊**，否則會一直有第四個、第五個冒出來。

- [ ] **Step 2：確認跳過機制存不存在**

讀 `tour.js`，確認有沒有「這一步不適用就跳過」的既有能力。

- **有** → 用它。
- **沒有** → **停下來回報**。新增一個教學引擎的能力不是這一關該自己決定的事。

- [ ] **Step 3：依角色跳過**

每一個受影響的步驟加上條件（比照畫面本身用的同一個判斷——`isAdmin` 或 `features.*`，**不要另發明一套**，兩套判斷會漂）。

⚠ **跳過之後課程還要讀得通。** 一課跳掉中間兩步，剩下的敘述可能變成前言不對後語。跳完自己從頭讀一次那一課的文字。

- [ ] **Step 4：測試與人工驗收**

`tour-isolation.test.js` 與 `tour-courses` 相關的既有測試必須維持綠。**這一關的真正驗收是人工的**：以一般使用者身分把教學從頭跑一次，確認沒有任何一步指著看不見的東西。寫進 Task 10 的人工驗收清單。

---

## Task 8c：被停用的人看到的訊息是假話（2026-09-21 追加）

**Files:**
- Modify: `app/server/index.js:106`（未核准閘門的訊息）
- Modify: 任何斷言那句舊訊息的既有測試

**為什麼追加：** Task 7 的審查追出一個**跟新頁面的承諾直接矛盾**的既有缺陷。

新的「公司帳號」頁告訴管理員：停用**會立刻生效、直到重新啟用**。這句話是真的。

但**被停用的那個人**下一次打 API 時，看到的是（`index.js:106`）：

> 「帳號審核中，管理員核准後即可使用」

這暗示「暫時的、等一下就會好」。對一個**被刻意停用**的人來說，那是假話——而且會讓他去問「我的審核什麼時候會過」，問一件不存在的事。

**而且這句話現在已經徹底過時**：3a 關掉了自助註冊，那是全庫唯一會寫入「未核准」的路徑。所以在這條分支上，那個欄位**只剩「被停用」一種意思**，不可能再有審核中的帳號。

**已查證的兩件事**（動手前可以直接用）：
- 那句訊息在 `app/server/index.js:106`
- **前端沒有任何程式讀 `pendingApproval` 這個旗標**（實查 `app/public/js` 零命中）

- [ ] **Step 1：改訊息**

改成講實話的版本，例如「此帳號已停用，請聯絡貴公司的管理員」。**旗標名稱 `pendingApproval` 先不要改**——改名會波及斷言它的測試，而且對使用者沒有任何好處。但**在旁邊加一行繁中註解**寫明：這個名稱現在是誤稱，保留只是為了不動既有斷言。

- [ ] **Step 2：既有測試會紅，而且那是對的**

有既有測試斷言舊的訊息文字。**這一次不是「回報不要動」——這一關的工作本身就是要改那句話**，所以那些測試要跟著翻面：把期望值改成新文字，**其餘斷言一個字都不要動**。

如果發現有測試斷言的是**行為**而不是文字（例如只檢查 403 與旗標），那些**不要碰**。

- [ ] **Step 3：全跑 ＋ commit**

⚠ 改完自己讀一次：**被停用的人現在看到的那句話，跟管理員在停用確認框看到的那句話，說的是同一件事嗎？** 兩邊不一致就是這一關沒做完。

---

## Task 9：靜態守衛——以後忘記了會直接紅燈

**Files:**
- Create: `app/server/tests/frontend-tenant-guard.test.js`

**為什麼**：前端沒有 DOM 測試，人工實測不會在 CI 裡重跑。這份計畫藏起來的每一個入口，下一次有人改 nav 或 route 時都可能被無聲地放回去。既有的 `frontend-admin-route-guard.test.js` 與 `frontend-saas-specs.test.js` 已經證明這種靜態掃描守衛在這個 repo 裡行得通——照抄它們的手法。

### ⚠ 2026-09-21 Task 3 審查追加：這一關**同時**要補既有那支守衛的兩個缺口

Task 3 的審查逐字追過 `frontend-admin-route-guard.test.js` 的正則，發現兩件事，**都必須在這一關處理**（Task 3 的實作者被限制只能動 `app.js`，沒有路徑自己補）：

1. **那支測試看不到新的 `requiresInternal` 分支。** 它的正則 `/if\s*\([^)]*requiresAdmin[^)]*\)\s*\{[\s\S]*?\n\s{2}\}/` 在遇到 `requiresAdmin` 區塊自己的收尾大括號時就停了，新分支在那之後，所以從來沒被納入比對。而它的斷言是「比對到的那段裡面要出現 role」——**不是**「role 不可以出現在別的地方」。所以就算有人在 `requiresInternal` 裡塞一個 role 判斷，它照樣綠。
2. **這一版新設為管理員限定的三條路由沒被登記**：`/architecture`、`/pipeline-flow`、`/task/:id/terminal`。它們都不是 `/admin` 前綴，而那支測試自己的註解就說 `ADMIN_ONLY_OUTSIDE` 白名單正是為這種情況存在的（目前只有 `/token-report` 一筆）。

**要做的**：把這三條加進 `ADMIN_ONLY_OUTSIDE`，並讓守衛也涵蓋 `requiresInternal`——`/exam-bank`、`/exam-run` 兩條必須有它，而且 `role` 檢查不可以出現在那個分支裡。

**改既有測試檔在這一關是允許的**（這是這一關的工作本身），但**只加斷言與清單，不要放寬任何既有斷言**。若為了讓新斷言通過而必須改動既有的比對方式，**停下來回報**。

- [ ] **Step 1：守衛內容**

掃 `app/public/js/app.js` 的 route 表，斷言：
- `/architecture`、`/pipeline-flow`、`/task/:id/terminal` 都有 `requiresAdmin: true`
- `/exam-bank`、`/exam-run` 都有 `requiresInternal: true`
- `/companies` 有 `requiresAdmin: true`

掃 `app/public/js/ui-next/UiNextApp.js`，斷言更多工具那三顆按鈕與側欄的受限項目都帶著條件（不是裸露的）。

- [ ] **Step 2：守衛必須自己會紅**

比照本專案既有做法：**暫時拿掉其中一個 `requiresAdmin`，跑一次確認它紅且訊息指名那一條，再還原。兩次輸出都貼進報告。** 沒有這個證據，這支守衛就只是裝飾。

- [ ] **Step 3：把盲區寫進註解**

這支守衛是正則掃字面，**它看不到**：用變數組出來的 meta、動態產生的 nav 項目、以及「條件存在但條件寫錯」（例如 `v-if="isAdmin"` 寫成 `v-if="isadmin"` 之類）。**兩個方向都要寫明**：有守衛的可能被誤判成沒有，沒守衛的也可能藏在它看不懂的寫法裡。

隱藏盲區的守衛比沒有守衛更糟——它讓人以為有東西在擋。

- [ ] **Step 4：全跑 ＋ commit**

---

## Task 10：整枝審查 → 人工驗收 → 規格更新

- [ ] **Step 1：整枝自審**

```bash
git fetch origin && git merge origin/master
cd app && npm run test:quiet > /tmp/3b-final.log 2>&1; echo "EXITCODE=$?" >> /tmp/3b-final.log; tail -8 /tmp/3b-final.log
```

逐項確認並把輸出貼進報告：

| 檢查 | 怎麼確認 |
|---|---|
| legacy 前端沒被動到 | `git diff origin/master --stat -- app/public/js/views/` 回空 |
| 沒有寫死顏色 | `git diff origin/master -- app/public/ \| grep -nE '^\+.*(#[0-9a-fA-F]{3,6}\|rgb\()'` 逐條看 |
| 沒有用不存在的 class | `git diff origin/master -- app/public/ \| grep -n 'btn-secondary'` 回空 |
| 三處齊做 | 每一個藏起來的入口，nav／router／後端三處各指出一行 |
| 守衛真的會紅 | Task 9 Step 2 的兩次輸出在報告裡 |

- [ ] **Step 2：請控制者派整枝總審查**

**這一關不可以省。** 第 1 部與第 2 部各有一個「掉在兩份計畫中間、所有人都以為做完了」的缺陷，兩次都是整枝總審查抓到的。

- [ ] **Step 3：四種身分的人工驗收（規格 §9 明訂）**

平台管理員、內部一般使用者、客戶公司管理員、客戶一般使用者**各登入一次人工點過**，每一種都要淺色深色各看一次。後兩種需要先用 Task 8 的畫面建一家測試公司與帳號。

**驗收的核心問題只有一個：畫面上看得到的每一個東西，按下去都真的能用嗎？** 把每種身分看到什麼、按了什麼、結果如何，寫成表格進報告。

- [ ] **Step 4：更新規格**

`docs/superpowers/specs/2026-09-11-tenant-isolation-design.md` §5.5 的「ODOO 認證輔助 → 平台管理員限定」那一列已被 2026-09-21 裁決推翻，改成「依公司功能開關」，並註明日期與理由。**規格與程式矛盾不可以留著**——下一個人會不知道該信哪一個。

- [ ] **Step 5：更新進度頁**

照記憶 `spec-progress-annotation`：改 `2026-09-11-productize-rollout-plan.md` 的 `## 0. 目前進度` 表 → `cd docs/superpowers/specs/_page && node build-specs-page.js` → 手動複製到 `docs/odoo-v2-saas-specs.html`。**驗證到什麼程度要寫出來**。

---

## 自我檢查（寫完計畫後對照規格跑過一次）

**規格 §5.5 逐項**：
- `isAdmin` 維持＝平台管理員，新增 `isInternal`、`isCompanyAdmin` → **Task 1（後端欄位）＋ Task 2（前端 store）**
- 架構圖／流程圖／ODOO 認證輔助 → **Task 3（router）＋ Task 4（nav）**；考試那一項**刻意偏離 §5.5 字面**，理由與補救寫在 Task 3 Step 3 與 Task 10 Step 4
- 專案頁的 repo／環境／DB 管理區塊 → **Task 5**
- 任務選單的 AI 執行畫面 → **Task 6**（兩個候選都收，含後端那一處）
- 公司管理員的「公司帳號」頁 → **Task 7**
- 平台管理員的公司管理頁 → **Task 8**
- 三處齊做 → 每一關各自說明，**Task 9** 用靜態守衛把它變成會紅燈的規則

**刻意不做而且寫明的**：legacy 前端、DOM 測試、`isAdmin` 既有散落定義的重構、自助註冊流程重寫。

**已知會停下來問的兩處**：Task 5 Step 3（「上正式」需要後端多一個欄位）、Task 2 Step 3（`this.isAdmin` 登出時可能沒清）。兩處都明訂**回報、不要自己改**。
