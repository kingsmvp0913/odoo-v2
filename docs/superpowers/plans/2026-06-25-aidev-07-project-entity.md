# AI Dev Web Platform — Sub-plan 7: Project Entity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立完整的 Project 實體，取代現有的 `project_maps`。每個 Project 可綁定多個 Git repo（各自獨立），tasks 可關聯至 project。

**Architecture:** 新增 `projects` 和 `project_repos` 兩張表；`tasks` 加 `project_id` FK；新增 `/api/projects` CRUD + repos 子路由；新增 Projects UI（列表 + 詳情）；TaskDetail 可設定所屬 project。

**Tech Stack:** Express 4、Vue 3 options API CDN、pg、pg-mem（測試）

## Global Constraints

- Port: **3939**
- 所有 `/api/projects` 路由需 `verifyToken`（不需 admin）
- `project_repos.is_primary` 每個 project 最多一個（不在 DB 層強制，在 API 層確保）
- Vue 3 options API，CDN 模式
- **後端測試**：project routes 需有測試；93/93 現有測試必須繼續通過
- `project_maps` 保留在 DB（不刪除），Admin UI 的 project_maps 區塊改顯示 `projects`
- task 的 `project_id` 為 nullable（現有 task 不強制關聯）
- column migration 使用 information_schema 檢查（同 coding_cmd/qa_cmd 模式）

---

## Task 1: DB Migration

**Files:**
- Modify: `app/server/db.js`
- Modify: `app/server/tests/db-migration.test.js`

**Interfaces:**
- Produces: `projects` table（id, name, odoo_version, description, created_at, updated_at）
- Produces: `project_repos` table（id, project_id FK→projects, label, repo_url, local_path, is_primary, created_at）
- Produces: `tasks.project_id` column（INTEGER REFERENCES projects(id)，nullable）

- [ ] **Step 1: 在 db.js migrate() 的 statements 陣列末尾加入兩個新表**

在 `odoo_version_configs` CREATE TABLE 之後加入：

```javascript
`CREATE TABLE IF NOT EXISTS projects (
  id           SERIAL PRIMARY KEY,
  name         TEXT UNIQUE NOT NULL,
  odoo_version TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS project_repos (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  repo_url    TEXT NOT NULL,
  local_path  TEXT,
  is_primary  BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
)`,
```

- [ ] **Step 2: 在 colMigrations 陣列加入 tasks.project_id**

在 `qa_cmd` 之後加入：

```javascript
{ col: 'project_id', sql: 'ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id)', table: 'tasks' }
```

注意：colMigrations 目前只查 users 表。需要將迴圈改為支援多表：

```javascript
const colMigrations = [
  { table: 'users', col: 'coding_cmd', sql: 'ALTER TABLE users ADD COLUMN coding_cmd TEXT' },
  { table: 'users', col: 'qa_cmd',     sql: 'ALTER TABLE users ADD COLUMN qa_cmd TEXT' },
  { table: 'tasks', col: 'project_id', sql: 'ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id)' }
];

// 按 table 分組查詢
const tableColsCache = {};
for (const { table, col, sql } of colMigrations) {
  if (!tableColsCache[table]) {
    const { rows } = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [table]
    );
    tableColsCache[table] = new Set(rows.map(r => r.column_name));
  }
  if (!tableColsCache[table].has(col)) await query(sql);
}
```

- [ ] **Step 3: 更新 db-migration.test.js，加入 3 個新測試**

```javascript
test('projects table has expected columns', async () => {
  await dbModule.migrate();
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='projects'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('name');
  expect(cols).toContain('odoo_version');
});

test('project_repos table has expected columns', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='project_repos'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('project_id');
  expect(cols).toContain('repo_url');
  expect(cols).toContain('is_primary');
});

test('tasks table has project_id column after migration', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tasks' AND column_name='project_id'"
  );
  expect(rows.length).toBe(1);
});
```

- [ ] **Step 4: 執行測試**

```
cd app && npx jest tests/db-migration.test.js --no-coverage
```

預期：全部 PASS（原有 3 個 + 新增 3 個 = 6 個）

- [ ] **Step 5: Commit**

```
git add app/server/db.js app/server/tests/db-migration.test.js
git commit -m "feat: add projects, project_repos tables and tasks.project_id migration"
```

---

## Task 2: Project Routes API

**Files:**
- Create: `app/server/project-routes.js`
- Modify: `app/server/index.js`
- Create: `app/server/tests/project-routes.test.js`

**Interfaces:**
- Consumes: `verifyToken` from `./auth`; `query` from `./db`
- Produces: REST API for projects + repos

**API Endpoints:**

```
GET    /api/projects                     → list all projects (with repo count)
POST   /api/projects                     → create { name, odoo_version, description }
GET    /api/projects/:id                 → get project + repos
PUT    /api/projects/:id                 → update { name, odoo_version, description }
DELETE /api/projects/:id                 → delete (cascades to repos)

GET    /api/projects/:id/repos           → list repos for project
POST   /api/projects/:id/repos           → add repo { label, repo_url, local_path, is_primary }
PUT    /api/projects/:id/repos/:repoId   → update repo
DELETE /api/projects/:id/repos/:repoId  → remove repo

PUT    /api/tasks/:taskDbId/project      → set { project_id } on a task (null to unlink)
```

- [ ] **Step 1: 建立 project-routes.js**

```javascript
const { query } = require('./db');
const { verifyToken } = require('./auth');

function registerRoutes(app) {
  // --- Projects ---
  app.get('/api/projects', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(`
        SELECT p.*, COUNT(r.id)::int AS repo_count
        FROM projects p
        LEFT JOIN project_repos r ON r.project_id = p.id
        GROUP BY p.id ORDER BY p.name ASC
      `);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects', verifyToken, async (req, res) => {
    try {
      const { name, odoo_version, description } = req.body;
      if (!name || !odoo_version) return res.status(400).json({ error: 'name and odoo_version required' });
      const { rows } = await query(
        `INSERT INTO projects (name, odoo_version, description) VALUES ($1, $2, $3) RETURNING *`,
        [name, odoo_version, description || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'project name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id', verifyToken, async (req, res) => {
    try {
      const { rows: [project] } = await query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
      if (!project) return res.status(404).json({ error: 'Not found' });
      const { rows: repos } = await query('SELECT * FROM project_repos WHERE project_id = $1 ORDER BY is_primary DESC, label ASC', [req.params.id]);
      res.json({ ...project, repos });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/projects/:id', verifyToken, async (req, res) => {
    try {
      const { name, odoo_version, description } = req.body;
      const { rows } = await query(
        `UPDATE projects SET
           name = COALESCE($2, name),
           odoo_version = COALESCE($3, odoo_version),
           description = COALESCE($4, description),
           updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [req.params.id, name || null, odoo_version || null, description || null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Repos ---
  app.get('/api/projects/:id/repos', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM project_repos WHERE project_id = $1 ORDER BY is_primary DESC, label ASC', [req.params.id]);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/repos', verifyToken, async (req, res) => {
    try {
      const { label, repo_url, local_path, is_primary } = req.body;
      if (!label || !repo_url) return res.status(400).json({ error: 'label and repo_url required' });
      if (is_primary) {
        await query('UPDATE project_repos SET is_primary = false WHERE project_id = $1', [req.params.id]);
      }
      const { rows } = await query(
        `INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.params.id, label, repo_url, local_path || null, is_primary || false]
      );
      res.status(201).json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/projects/:id/repos/:repoId', verifyToken, async (req, res) => {
    try {
      const { label, repo_url, local_path, is_primary } = req.body;
      if (is_primary) {
        await query('UPDATE project_repos SET is_primary = false WHERE project_id = $1', [req.params.id]);
      }
      const { rows } = await query(
        `UPDATE project_repos SET
           label = COALESCE($3, label),
           repo_url = COALESCE($4, repo_url),
           local_path = COALESCE($5, local_path),
           is_primary = COALESCE($6, is_primary)
         WHERE id = $1 AND project_id = $2 RETURNING *`,
        [req.params.repoId, req.params.id, label || null, repo_url || null, local_path || null, is_primary ?? null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id/repos/:repoId', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('DELETE FROM project_repos WHERE id = $1 AND project_id = $2 RETURNING id', [req.params.repoId, req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --- Task project assignment ---
  app.put('/api/tasks/:taskDbId/project', verifyToken, async (req, res) => {
    try {
      const { project_id } = req.body;
      const { rows } = await query(
        'UPDATE tasks SET project_id = $2 WHERE id = $1 AND user_id = $3 RETURNING id, project_id',
        [req.params.taskDbId, project_id || null, req.userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
```

- [ ] **Step 2: 在 index.js 加入 registerProjectRoutes**

在 `registerAdminRoutes` 之前加入：

```javascript
const { registerRoutes: registerProjectRoutes } = require('./project-routes');
// in createApp():
registerProjectRoutes(app);
```

- [ ] **Step 3: 建立 project-routes.test.js**

```javascript
const request = require('supertest');
const { newDb } = require('pg-mem');

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../pipeline/runner', () => ({ runPipeline: jest.fn().mockResolvedValue({ processed: 0 }), resetLoopCounter: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../pipeline/analysis', () => ({ analyzeTask: jest.fn() }));
jest.mock('../pipeline/git', () => ({ createBranch: jest.fn(), runDeploy: jest.fn(), checkoutDefault: jest.fn() }));
jest.mock('../pipeline/coding-agent', () => ({ runCodingAgent: jest.fn() }));
jest.mock('../pipeline/qa-agent', () => ({ runQaAgent: jest.fn() }));

process.env.JWT_SECRET = 'test-proj';
let app, dbModule, token;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();
  const res = await request(app).post('/api/auth/setup').send({ username: 'user1', password: 'pass1234', display_name: 'User' });
  token = res.body.token;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

let projectId, repoId;

test('GET /api/projects → 401 without token', async () => {
  const res = await request(app).get('/api/projects');
  expect(res.status).toBe(401);
});

test('POST /api/projects → 400 missing fields', async () => {
  const res = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`).send({ name: 'Proj' });
  expect(res.status).toBe(400);
});

test('POST /api/projects → 201 creates', async () => {
  const res = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name: 'TestProj', odoo_version: '17.0', description: 'A test project' });
  expect(res.status).toBe(201);
  expect(res.body.name).toBe('TestProj');
  projectId = res.body.id;
});

test('GET /api/projects → 200 lists', async () => {
  const res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBeGreaterThan(0);
  expect(res.body[0]).toHaveProperty('repo_count');
});

test('GET /api/projects/:id → 200 with repos array', async () => {
  const res = await request(app).get(`/api/projects/${projectId}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.name).toBe('TestProj');
  expect(Array.isArray(res.body.repos)).toBe(true);
});

test('POST /api/projects/:id/repos → 400 missing fields', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/repos`).set('Authorization', `Bearer ${token}`).send({ label: 'main' });
  expect(res.status).toBe(400);
});

test('POST /api/projects/:id/repos → 201 creates primary repo', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/repos`).set('Authorization', `Bearer ${token}`)
    .send({ label: 'main', repo_url: 'https://github.com/test/odoo', local_path: '/opt/odoo', is_primary: true });
  expect(res.status).toBe(201);
  expect(res.body.is_primary).toBe(true);
  repoId = res.body.id;
});

test('POST /api/projects/:id/repos → second repo loses primary when new primary added', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/repos`).set('Authorization', `Bearer ${token}`)
    .send({ label: 'plugin-hr', repo_url: 'https://github.com/test/hr', is_primary: true });
  expect(res.status).toBe(201);
  // original repo should no longer be primary
  const { rows } = await dbModule.query('SELECT is_primary FROM project_repos WHERE id = $1', [repoId]);
  expect(rows[0].is_primary).toBe(false);
});

test('PUT /api/projects/:id → 200 updates', async () => {
  const res = await request(app).put(`/api/projects/${projectId}`).set('Authorization', `Bearer ${token}`)
    .send({ description: 'Updated desc' });
  expect(res.status).toBe(200);
  expect(res.body.description).toBe('Updated desc');
});

test('DELETE /api/projects/:id/repos/:repoId → 200', async () => {
  const res = await request(app).delete(`/api/projects/${projectId}/repos/${repoId}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
});

test('DELETE /api/projects/:id → 200 and cascades repos', async () => {
  const res = await request(app).delete(`/api/projects/${projectId}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const { rows } = await dbModule.query('SELECT * FROM project_repos WHERE project_id = $1', [projectId]);
  expect(rows.length).toBe(0);
});

test('GET /api/projects/:id → 404 after delete', async () => {
  const res = await request(app).get(`/api/projects/${projectId}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 4: 執行新測試**

```
npx jest tests/project-routes.test.js --no-coverage
```

預期：12/12 PASS

- [ ] **Step 5: 執行全部測試**

```
npx jest --no-coverage
```

預期：全部 PASS（96+）

- [ ] **Step 6: Commit**

```
git add app/server/project-routes.js app/server/index.js app/server/tests/project-routes.test.js
git commit -m "feat: project routes API with repo management"
```

---

## Task 3: Projects UI

**Files:**
- Create: `app/public/js/views/ProjectList.js`
- Create: `app/public/js/views/ProjectDetail.js`
- Modify: `app/public/index.html`
- Modify: `app/public/js/app.js`

**Interfaces:**
- Consumes: `Api.get/post/put/delete` from api.js
- Consumes: `showToast` from app.js

- [ ] **Step 1: 建立 ProjectList.js**

```javascript
window.ProjectListView = Vue.defineComponent({
  name: 'ProjectListView',
  data() {
    return {
      projects: [],
      loading: true,
      newProject: { name: '', odoo_version: '', description: '' },
      saving: false
    };
  },
  async created() { await this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try { this.projects = await Api.get('projects'); }
      catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    async add() {
      if (!this.newProject.name || !this.newProject.odoo_version) return showToast('請填寫專案名稱和版本', 'error');
      this.saving = true;
      try {
        await Api.post('projects', { ...this.newProject });
        this.newProject = { name: '', odoo_version: '', description: '' };
        await this.load();
        showToast('已新增專案', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.saving = false; }
    },
    async remove(id) {
      if (!confirm('確定刪除此專案及所有 repo？')) return;
      try {
        await Api.delete(`projects/${id}`);
        await this.load();
        showToast('已刪除', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    go(id) { this.$router.push(`/projects/${id}`); }
  },
  template: `
    <div class="topbar"><h1>專案管理</h1></div>
    <div class="content" style="max-width:760px">
      <div v-if="loading" class="loading">載入中...</div>
      <div v-else>
        <div v-if="projects.length === 0" style="color:var(--text-muted);margin-bottom:16px">尚無專案</div>
        <div v-for="p in projects" :key="p.id" class="task-card" style="cursor:pointer" @click="go(p.id)">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-weight:600">{{ p.name }}</div>
              <div style="font-size:12px;color:var(--text-muted)">Odoo {{ p.odoo_version }} · {{ p.repo_count }} 個 repo</div>
              <div v-if="p.description" style="font-size:12px;color:var(--text-muted)">{{ p.description }}</div>
            </div>
            <button class="btn btn-outline btn-sm" style="color:var(--error)" @click.stop="remove(p.id)">刪除</button>
          </div>
        </div>

        <div class="form-section" style="margin-top:24px">新增專案</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <input v-model="newProject.name" placeholder="專案名稱" class="form-control" />
          <input v-model="newProject.odoo_version" placeholder="Odoo 版本（如 17.0）" class="form-control" />
          <input v-model="newProject.description" placeholder="說明（選填）" class="form-control" style="grid-column:span 2" />
        </div>
        <button class="btn btn-primary" @click="add" :disabled="saving">+ 新增</button>
      </div>
    </div>
  `
});
```

- [ ] **Step 2: 建立 ProjectDetail.js**

```javascript
window.ProjectDetailView = Vue.defineComponent({
  name: 'ProjectDetailView',
  data() {
    return {
      project: null,
      repos: [],
      loading: true,
      newRepo: { label: '', repo_url: '', local_path: '', is_primary: false },
      savingRepo: false
    };
  },
  async created() { await this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try {
        const data = await Api.get(`projects/${this.$route.params.id}`);
        this.project = data;
        this.repos = data.repos || [];
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    async addRepo() {
      if (!this.newRepo.label || !this.newRepo.repo_url) return showToast('請填寫標籤和 repo URL', 'error');
      this.savingRepo = true;
      try {
        await Api.post(`projects/${this.$route.params.id}/repos`, { ...this.newRepo });
        this.newRepo = { label: '', repo_url: '', local_path: '', is_primary: false };
        await this.load();
        showToast('已新增 repo', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingRepo = false; }
    },
    async removeRepo(repoId) {
      try {
        await Api.delete(`projects/${this.$route.params.id}/repos/${repoId}`);
        await this.load();
        showToast('已移除 repo', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    }
  },
  template: `
    <div v-if="loading" class="loading">載入中...</div>
    <template v-else-if="project">
      <div class="topbar">
        <button class="btn btn-outline btn-sm" @click="$router.push('/projects')" style="margin-right:12px">← 返回</button>
        <h1>{{ project.name }}</h1>
        <span style="font-size:13px;color:var(--text-muted);margin-left:12px">Odoo {{ project.odoo_version }}</span>
      </div>
      <div class="content" style="max-width:760px">
        <div v-if="project.description" style="color:var(--text-muted);font-size:13px;margin-bottom:16px">{{ project.description }}</div>

        <div class="form-section">Git Repositories</div>
        <div v-if="repos.length === 0" style="color:var(--text-muted);font-size:13px;margin-bottom:16px">尚未綁定任何 repo</div>
        <div v-for="r in repos" :key="r.id" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <span style="font-weight:600">{{ r.label }}</span>
            <span v-if="r.is_primary" style="font-size:11px;background:var(--primary);color:#fff;border-radius:4px;padding:1px 6px;margin-left:6px">主要</span>
            <div style="font-size:12px;color:var(--text-muted)">{{ r.repo_url }}</div>
            <div v-if="r.local_path" style="font-size:12px;color:var(--text-muted)">本機：{{ r.local_path }}</div>
          </div>
          <button class="btn btn-outline btn-sm" style="color:var(--error)" @click="removeRepo(r.id)">移除</button>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
          <input v-model="newRepo.label" placeholder="標籤（如 main、plugin-hr）" class="form-control" />
          <input v-model="newRepo.repo_url" placeholder="Git URL" class="form-control" />
          <input v-model="newRepo.local_path" placeholder="本機路徑（選填）" class="form-control" />
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">
            <input type="checkbox" v-model="newRepo.is_primary" /> 設為主要 repo
          </label>
        </div>
        <button class="btn btn-primary btn-sm" style="margin-top:8px" @click="addRepo" :disabled="savingRepo">+ 新增 Repo</button>
      </div>
    </template>
    <div v-else style="padding:24px;color:var(--text-muted)">專案不存在</div>
  `
});
```

- [ ] **Step 3: 在 index.html 加入 ProjectList.js 和 ProjectDetail.js**

在 `Terminal.js` 之前加入：

```html
<script src="/js/views/ProjectList.js"></script>
<script src="/js/views/ProjectDetail.js"></script>
```

- [ ] **Step 4: 在 app.js 加入路由和 sidebar**

routes 陣列加入（在 `/settings` 之後）：

```javascript
{ path: '/projects', component: window.ProjectListView, meta: { requiresAuth: true } },
{ path: '/projects/:id', component: window.ProjectDetailView, meta: { requiresAuth: true } },
```

sidebar 加入（在 `⚙️ 設定` 之前）：

```html
<router-link to="/projects" custom v-slot="{ navigate, isActive }">
  <a :class="{ active: isActive }" @click="navigate">📁 專案</a>
</router-link>
```

- [ ] **Step 5: 執行全部測試（UI 改動不影響後端）**

```
cd app && npx jest --no-coverage
```

預期：全部 PASS

- [ ] **Step 6: Commit**

```
git add app/public/js/views/ProjectList.js app/public/js/views/ProjectDetail.js app/public/index.html app/public/js/app.js
git commit -m "feat: projects UI with repo management"
```

---

## Self-Review

**Spec coverage:**

| 需求 | Task |
|---|---|
| Project 完整實體（DB）| Task 1 |
| 多 repo 綁定（project_repos）| Task 1, 2 |
| tasks.project_id FK | Task 1 |
| CRUD API for projects + repos | Task 2 |
| is_primary 單一主要 repo 保證 | Task 2 |
| Projects UI 列表 + 詳情 + repo 管理 | Task 3 |
| Sidebar 專案連結 | Task 3 |

**Placeholder scan:** 無。

**Type consistency:** `project_id` 在 API 和 DB 均為 INTEGER（nullable）。
