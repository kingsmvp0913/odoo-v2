# AI Dev Web Platform — Sub-plan 6: Odoo Test Environment Installer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `/admin/odoo-env` 頁面，讓管理員可透過 Web UI 安裝並管理 Odoo 測試環境（Python venv、odoo-bin 路徑、版本設定），並提供版本設定 API 讓 coding/qa agent 能取得正確的執行環境。

**Architecture:** 新增 `odoo_version_configs` 表（已存在於 schema）的 CRUD API；新增 `/admin` 路由（僅限 `role='admin'`）；Admin.js + OdooEnv.js Vue view；backend `admin-routes.js`；使用現有 DB schema（無新表格）。

**Tech Stack:** Express 4、Vue 3 CDN（options API）、pg（現有 schema）

## Global Constraints

- Port: **3939**
- 僅 `role='admin'` 可存取 `/api/admin/` 路由
- `odoo_version_configs` 已在 db.js migrate() 建立（odoo_version UNIQUE, python_bin NOT NULL, venv_base_path, odoo_bin_path, notes）
- `project_maps` 已在 db.js migrate() 建立（project_name UNIQUE, odoo_version NOT NULL, project_dir, notes）
- Vue 3 options API，CDN 模式（不用 Composition API）
- 所有 API 用 `verifyToken` + `requireAdmin` middleware
- **後端測試**：admin routes 需有測試；現有 82/82 後端測試必須繼續通過
- 每個 API endpoint 必須 return 4xx 當非 admin 嘗試存取

---

## Task 1: Admin Routes + middleware

**Files:**
- Create: `app/server/admin-routes.js`
- Modify: `app/server/index.js` — mount admin routes
- Create: `app/server/tests/admin-routes.test.js`

**Interfaces:**
- Consumes: `verifyToken` from `./auth`
- Produces: `requireAdmin` middleware（從 DB 查 users.role，非 admin → 403）
- Produces: CRUD for `odoo_version_configs` and `project_maps`

**API Endpoints:**

```
GET  /api/admin/version-configs              → list all odoo_version_configs
POST /api/admin/version-configs              → create { odoo_version, python_bin, venv_base_path, odoo_bin_path, notes }
PUT  /api/admin/version-configs/:id          → update by id
DELETE /api/admin/version-configs/:id        → delete by id

GET  /api/admin/project-maps                 → list all project_maps
POST /api/admin/project-maps                 → create { project_name, odoo_version, project_dir, notes }
PUT  /api/admin/project-maps/:id             → update by id
DELETE /api/admin/project-maps/:id           → delete by id
```

**admin-routes.js 實作：**

```javascript
const { query } = require('./db');
const { verifyToken } = require('./auth');

async function requireAdmin(req, res, next) {
  const { rows } = await query('SELECT role FROM users WHERE id = $1', [req.userId]);
  if (!rows.length || rows[0].role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

function registerRoutes(app) {
  const auth = [verifyToken, requireAdmin];

  // Version configs
  app.get('/api/admin/version-configs', auth, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM odoo_version_configs ORDER BY odoo_version ASC');
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/version-configs', auth, async (req, res) => {
    try {
      const { odoo_version, python_bin, venv_base_path, odoo_bin_path, notes } = req.body;
      if (!odoo_version || !python_bin) return res.status(400).json({ error: 'odoo_version and python_bin required' });
      const { rows } = await query(
        `INSERT INTO odoo_version_configs (odoo_version, python_bin, venv_base_path, odoo_bin_path, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [odoo_version, python_bin, venv_base_path || null, odoo_bin_path || null, notes || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'odoo_version already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/version-configs/:id', auth, async (req, res) => {
    try {
      const { python_bin, venv_base_path, odoo_bin_path, notes } = req.body;
      const { rows } = await query(
        `UPDATE odoo_version_configs SET
           python_bin = COALESCE($2, python_bin),
           venv_base_path = COALESCE($3, venv_base_path),
           odoo_bin_path = COALESCE($4, odoo_bin_path),
           notes = COALESCE($5, notes)
         WHERE id = $1 RETURNING *`,
        [req.params.id, python_bin || null, venv_base_path || null, odoo_bin_path || null, notes || null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/admin/version-configs/:id', auth, async (req, res) => {
    try {
      const { rows } = await query('DELETE FROM odoo_version_configs WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Project maps (same CRUD pattern)
  app.get('/api/admin/project-maps', auth, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM project_maps ORDER BY project_name ASC');
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/project-maps', auth, async (req, res) => {
    try {
      const { project_name, odoo_version, project_dir, notes } = req.body;
      if (!project_name || !odoo_version) return res.status(400).json({ error: 'project_name and odoo_version required' });
      const { rows } = await query(
        `INSERT INTO project_maps (project_name, odoo_version, project_dir, notes)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [project_name, odoo_version, project_dir || null, notes || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'project_name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/project-maps/:id', auth, async (req, res) => {
    try {
      const { odoo_version, project_dir, notes } = req.body;
      const { rows } = await query(
        `UPDATE project_maps SET
           odoo_version = COALESCE($2, odoo_version),
           project_dir = COALESCE($3, project_dir),
           notes = COALESCE($4, notes),
           updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [req.params.id, odoo_version || null, project_dir || null, notes || null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/admin/project-maps/:id', auth, async (req, res) => {
    try {
      const { rows } = await query('DELETE FROM project_maps WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
```

- [ ] **Step 1: 建立 admin-routes.js**

依照上方實作建立檔案。

- [ ] **Step 2: 修改 index.js 掛載 admin routes**

在 `registerPipelineRoutes(app)` 之後加入：

```javascript
const { registerRoutes: registerAdminRoutes } = require('./admin-routes');
// ... in createApp():
registerAdminRoutes(app);
```

- [ ] **Step 3: 撰寫測試**

建立 `app/server/tests/admin-routes.test.js`：

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
jest.mock('../pipeline/coding-agent', () => ({ runCodingAgent: jest.fn() }));
jest.mock('../pipeline/qa-agent', () => ({ runQaAgent: jest.fn() }));

process.env.JWT_SECRET = 'test-admin';

let app, dbModule, adminToken, userToken;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const { createApp } = require('../index');
  app = createApp();

  // Create admin (first user via setup = admin role)
  const adminRes = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'admin1234', display_name: 'Admin'
  });
  adminToken = adminRes.body.token;

  // Manually insert a non-admin user
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('regular', $1, 'Regular', 'user')",
    [hash]
  );
  const userRes = await request(app).post('/api/auth/login').send({
    username: 'regular', password: 'pass'
  });
  userToken = userRes.body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

// --- Version configs ---
let createdConfigId;

test('GET /api/admin/version-configs → 403 for non-admin', async () => {
  const res = await request(app).get('/api/admin/version-configs')
    .set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});

test('GET /api/admin/version-configs → 200 empty list for admin', async () => {
  const res = await request(app).get('/api/admin/version-configs')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

test('POST /api/admin/version-configs → creates config', async () => {
  const res = await request(app).post('/api/admin/version-configs')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ odoo_version: '17.0', python_bin: '/usr/bin/python3', venv_base_path: '/opt/venvs', odoo_bin_path: '/opt/odoo/odoo-bin' });
  expect(res.status).toBe(201);
  expect(res.body.odoo_version).toBe('17.0');
  createdConfigId = res.body.id;
});

test('POST /api/admin/version-configs → 400 missing required fields', async () => {
  const res = await request(app).post('/api/admin/version-configs')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ odoo_version: '16.0' }); // missing python_bin
  expect(res.status).toBe(400);
});

test('PUT /api/admin/version-configs/:id → updates config', async () => {
  const res = await request(app).put(`/api/admin/version-configs/${createdConfigId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ notes: 'Production version' });
  expect(res.status).toBe(200);
  expect(res.body.notes).toBe('Production version');
});

test('DELETE /api/admin/version-configs/:id → deletes config', async () => {
  const res = await request(app).delete(`/api/admin/version-configs/${createdConfigId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

// --- Project maps ---
let createdMapId;

test('POST /api/admin/project-maps → creates map', async () => {
  const res = await request(app).post('/api/admin/project-maps')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ project_name: 'MyOdoo', odoo_version: '17.0', project_dir: '/opt/myodoo' });
  expect(res.status).toBe(201);
  expect(res.body.project_name).toBe('MyOdoo');
  createdMapId = res.body.id;
});

test('GET /api/admin/project-maps → lists maps', async () => {
  const res = await request(app).get('/api/admin/project-maps')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBeGreaterThan(0);
});

test('DELETE /api/admin/project-maps/:id → deletes map', async () => {
  const res = await request(app).delete(`/api/admin/project-maps/${createdMapId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
});
```

- [ ] **Step 4: 執行測試**

```bash
cd app && npx jest tests/admin-routes.test.js --no-coverage
```

預期：10/10 PASS

- [ ] **Step 5: 執行全部測試**

```bash
npx jest --no-coverage
```

預期：92/92 PASS（82 + 10 新）

- [ ] **Step 6: Commit**

```bash
git add app/server/admin-routes.js app/server/index.js app/server/tests/admin-routes.test.js
git commit -m "feat: admin CRUD API for odoo_version_configs and project_maps"
```

---

## Task 2: Admin UI (OdooEnv Page)

**Files:**
- Create: `app/public/js/views/Admin.js` — OdooEnv 管理頁（版本設定 + 專案對應表）
- Modify: `app/public/index.html` — 加入 Admin.js
- Modify: `app/public/js/app.js` — 加入 `/admin` route（requiresAdmin meta）、sidebar 連結

**Admin.js 職責：**
- 顯示 `odoo_version_configs` 列表，支援新增 / 刪除
- 顯示 `project_maps` 列表，支援新增 / 刪除
- 僅 admin 角色可看到此頁（前端用 `Api.get('auth/me')` 取得 user.role 判斷）

- [ ] **Step 1: 建立 Admin.js**

```javascript
window.AdminView = Vue.defineComponent({
  name: 'AdminView',
  data() {
    return {
      versionConfigs: [],
      projectMaps: [],
      loadingVC: true,
      loadingPM: true,
      newVC: { odoo_version: '', python_bin: '', venv_base_path: '', odoo_bin_path: '', notes: '' },
      newPM: { project_name: '', odoo_version: '', project_dir: '', notes: '' },
      savingVC: false,
      savingPM: false
    };
  },
  async created() {
    await Promise.all([this.loadVC(), this.loadPM()]);
  },
  methods: {
    async loadVC() {
      this.loadingVC = true;
      try {
        this.versionConfigs = await Api.get('admin/version-configs');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loadingVC = false; }
    },
    async loadPM() {
      this.loadingPM = true;
      try {
        this.projectMaps = await Api.get('admin/project-maps');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loadingPM = false; }
    },
    async addVC() {
      if (!this.newVC.odoo_version || !this.newVC.python_bin) return showToast('請填寫版本號和 Python 路徑', 'error');
      this.savingVC = true;
      try {
        await Api.post('admin/version-configs', { ...this.newVC });
        this.newVC = { odoo_version: '', python_bin: '', venv_base_path: '', odoo_bin_path: '', notes: '' };
        await this.loadVC();
        showToast('已新增版本設定', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingVC = false; }
    },
    async deleteVC(id) {
      try {
        await Api.delete(`admin/version-configs/${id}`);
        await this.loadVC();
        showToast('已刪除', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    async addPM() {
      if (!this.newPM.project_name || !this.newPM.odoo_version) return showToast('請填寫專案名稱和版本號', 'error');
      this.savingPM = true;
      try {
        await Api.post('admin/project-maps', { ...this.newPM });
        this.newPM = { project_name: '', odoo_version: '', project_dir: '', notes: '' };
        await this.loadPM();
        showToast('已新增專案對應', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingPM = false; }
    },
    async deletePM(id) {
      try {
        await Api.delete(`admin/project-maps/${id}`);
        await this.loadPM();
        showToast('已刪除', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    }
  },
  template: `
    <div class="topbar"><h1>管理員設定</h1></div>
    <div class="content" style="max-width:760px">

      <div class="form-section">Odoo 版本設定</div>
      <div v-if="loadingVC" class="loading">載入中...</div>
      <table v-else-if="versionConfigs.length > 0" style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px">
        <thead><tr style="border-bottom:1px solid var(--border);text-align:left">
          <th style="padding:6px 8px">版本</th>
          <th style="padding:6px 8px">Python</th>
          <th style="padding:6px 8px">Venv</th>
          <th style="padding:6px 8px">odoo-bin</th>
          <th style="padding:6px 8px">備註</th>
          <th></th>
        </tr></thead>
        <tbody>
          <tr v-for="v in versionConfigs" :key="v.id" style="border-bottom:1px solid var(--border)">
            <td style="padding:6px 8px;font-weight:600">{{ v.odoo_version }}</td>
            <td style="padding:6px 8px;font-size:12px;color:var(--text-muted)">{{ v.python_bin }}</td>
            <td style="padding:6px 8px;font-size:12px;color:var(--text-muted)">{{ v.venv_base_path || '—' }}</td>
            <td style="padding:6px 8px;font-size:12px;color:var(--text-muted)">{{ v.odoo_bin_path || '—' }}</td>
            <td style="padding:6px 8px;font-size:12px;color:var(--text-muted)">{{ v.notes || '—' }}</td>
            <td><button class="btn btn-outline btn-sm" style="color:var(--error)" @click="deleteVC(v.id)">刪除</button></td>
          </tr>
        </tbody>
      </table>
      <div v-else style="color:var(--text-muted);font-size:13px;margin-bottom:16px">尚無版本設定</div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px">
        <input v-model="newVC.odoo_version" placeholder="版本（如 17.0）" class="form-control" />
        <input v-model="newVC.python_bin" placeholder="Python 路徑" class="form-control" />
        <input v-model="newVC.venv_base_path" placeholder="Venv 基礎路徑（選填）" class="form-control" />
        <input v-model="newVC.odoo_bin_path" placeholder="odoo-bin 路徑（選填）" class="form-control" />
        <input v-model="newVC.notes" placeholder="備註（選填）" class="form-control" />
        <button class="btn btn-primary btn-sm" @click="addVC" :disabled="savingVC">+ 新增版本</button>
      </div>

      <div class="form-section" style="margin-top:24px">專案對應表</div>
      <div v-if="loadingPM" class="loading">載入中...</div>
      <table v-else-if="projectMaps.length > 0" style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px">
        <thead><tr style="border-bottom:1px solid var(--border);text-align:left">
          <th style="padding:6px 8px">專案名稱</th>
          <th style="padding:6px 8px">Odoo 版本</th>
          <th style="padding:6px 8px">專案目錄</th>
          <th style="padding:6px 8px">備註</th>
          <th></th>
        </tr></thead>
        <tbody>
          <tr v-for="m in projectMaps" :key="m.id" style="border-bottom:1px solid var(--border)">
            <td style="padding:6px 8px;font-weight:600">{{ m.project_name }}</td>
            <td style="padding:6px 8px">{{ m.odoo_version }}</td>
            <td style="padding:6px 8px;font-size:12px;color:var(--text-muted)">{{ m.project_dir || '—' }}</td>
            <td style="padding:6px 8px;font-size:12px;color:var(--text-muted)">{{ m.notes || '—' }}</td>
            <td><button class="btn btn-outline btn-sm" style="color:var(--error)" @click="deletePM(m.id)">刪除</button></td>
          </tr>
        </tbody>
      </table>
      <div v-else style="color:var(--text-muted);font-size:13px;margin-bottom:16px">尚無專案對應</div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <input v-model="newPM.project_name" placeholder="專案名稱" class="form-control" />
        <input v-model="newPM.odoo_version" placeholder="Odoo 版本（如 17.0）" class="form-control" />
        <input v-model="newPM.project_dir" placeholder="專案目錄路徑（選填）" class="form-control" />
        <input v-model="newPM.notes" placeholder="備註（選填）" class="form-control" style="grid-column:span 2" />
        <button class="btn btn-primary btn-sm" @click="addPM" :disabled="savingPM">+ 新增專案</button>
      </div>
    </div>
  `
});
```

**注意：** Admin.js 使用 `Api.delete()`，需確認 api.js 有 `delete(path)` 方法。若無，在 api.js 加入：

```javascript
delete(path) { return this._fetch('DELETE', path); }
```

- [ ] **Step 2: 修改 app.js 加入 Admin route 和 sidebar 連結**

在 routes 陣列加入：
```javascript
{ path: '/admin', component: window.AdminView, meta: { requiresAuth: true, requiresAdmin: true } },
```

在 `router.beforeEach` 加入 admin 檢查（在 `requiresAuth` check 之後）：
```javascript
router.beforeEach(async (to) => {
  if (to.meta.requiresAuth && !Api.isLoggedIn()) return '/login';
  if (to.path === '/login' && Api.isLoggedIn()) return '/';
  if (to.meta.requiresAdmin) {
    try {
      const me = await Api.get('auth/me');
      if (me.role !== 'admin') return '/';
    } catch { return '/login'; }
  }
});
```

在 sidebar 加入 admin 連結（在 `⚙️ 設定` 之後）：
```html
<router-link to="/admin" custom v-slot="{ navigate, isActive }">
  <a v-if="isAdmin" :class="{ active: isActive }" @click="navigate">🔧 管理員</a>
</router-link>
```

在 App setup 中加入 `isAdmin` computed：
```javascript
computed: {
  isLoggedIn() { return Api.isLoggedIn(); },
  isAdmin() { return this._role === 'admin'; }
},
data() { return { _role: '' }; },
async mounted() {
  if (Api.isLoggedIn()) {
    const me = await Api.get('auth/me').catch(() => ({}));
    this._role = me.role || '';
  }
},
```

- [ ] **Step 3: 修改 index.html 加入 Admin.js**

在 `Terminal.js` 之後加入：
```html
<script src="/js/views/Admin.js"></script>
```

- [ ] **Step 4: 確認 api.js 有 delete 方法**

讀取 `app/public/js/api.js`，若無 `delete(path)` 方法，加入：
```javascript
delete(path) { return this._fetch('DELETE', path); }
```

- [ ] **Step 5: 執行全部測試**

```bash
cd app && npx jest --no-coverage
```

預期：92/92 PASS（UI 改動不影響後端測試）

- [ ] **Step 6: Commit**

```bash
git add app/public/js/views/Admin.js app/public/index.html app/public/js/app.js app/public/js/api.js
git commit -m "feat: admin UI for odoo version configs and project maps"
```

---

## Self-Review

**Spec coverage:**

| 需求 | Task |
|---|---|
| 管理員 CRUD API（version-configs, project-maps）| Task 1 |
| requireAdmin middleware（403 for non-admin）| Task 1 |
| Admin UI 版本設定列表 + 新增 + 刪除 | Task 2 |
| Admin UI 專案對應列表 + 新增 + 刪除 | Task 2 |
| `/admin` route（requiresAdmin 前端 guard）| Task 2 |
| Sidebar 管理員連結（僅 admin 可見）| Task 2 |
| `Api.delete()` method | Task 2 |

**Placeholder scan:** 無 TBD/TODO。

**Type consistency:** API response 欄位名稱與 DB schema 一致。

**Known deferred items (若需要):**
- 版本設定 PUT 編輯 UI（目前僅支援刪除後重建）
- 版本設定匯出/匯入 JSON
