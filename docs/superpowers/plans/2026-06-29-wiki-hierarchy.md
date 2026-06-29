# Wiki 階層分類（專案 > 模組 > 功能）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把扁平的專案 wiki 升級為三層階層（專案概論 > 模組 > 功能），init 建骨架、任務完成自動補齊功能頁、每個節點可手動重生，並在建置時顯示階段式進度條。

**Architecture:** 單表 `wiki_pages` 加 `parent_id`（自參考 FK）+ `node_type` 表達三層。後端 `library-agent.js` 負責 init 建骨架、漸進補齊、節點重生；`wiki-routes.js` 新增 refresh 端點；進度透過既有 `notify.emitToUser(userId, 'wiki:progress', …)` websocket 推送。前端 `WikiView.js` 改樹狀側欄 + 進度條 + 節點更新鈕。

**Tech Stack:** Node.js / Express、PostgreSQL (pg)、js-yaml、Vue.js 3（無 build step，global component）、socket.io（既有 `window._socket`）、pg-mem + Jest。

## Global Constraints

- 伺服器端程式碼放 `app/server/`，前端放 `app/public/js/views/`。
- Vue component 以 `window.XxxView = Vue.defineComponent(...)` 導出，無 build step。
- 測試用 pg-mem + Jest；測試檔放 `app/server/tests/`；執行 `cd app && npm test`。
- DB migration 寫進 `app/server/db.js` 的 `colMigrations` 陣列（欄位）與其後的 index 區塊。
- 不引入新前端套件；圖表/進度條用原生 HTML/CSS。
- `callClaude(prompt, signal, opts)` 回傳 `{ text, usage, durationMs }`；走本機 `claude` CLI，**不需 ANTHROPIC_API_KEY**。
- 節點 slug 規則：概論 `overview`；模組 `module-<模組名>`；功能 `<功能主題>`。
- `node_type` 列舉：`overview` | `module` | `function`。

---

## Task 1: DB migration — wiki_pages 加 parent_id + node_type

**Files:**
- Modify: `app/server/db.js`（colMigrations 陣列末尾 + index 區塊）
- Test: `app/server/tests/db-migration.test.js`

**Interfaces:**
- Produces: `wiki_pages.parent_id INTEGER REFERENCES wiki_pages(id) ON DELETE CASCADE`、`wiki_pages.node_type TEXT NOT NULL DEFAULT 'function'`、index `idx_wiki_parent`。

- [ ] **Step 1: 新增兩個 colMigrations**

在 `app/server/db.js` 的 `colMigrations` 陣列末尾（`service_respondent_name` 那行之後）加：

```js
    { table: 'wiki_pages', col: 'parent_id', sql: 'ALTER TABLE wiki_pages ADD COLUMN parent_id INTEGER REFERENCES wiki_pages(id) ON DELETE CASCADE' },
    { table: 'wiki_pages', col: 'node_type', sql: "ALTER TABLE wiki_pages ADD COLUMN node_type TEXT NOT NULL DEFAULT 'function'" }
```

（注意：把上一行 `service_respondent_name` 結尾補上逗號。）

- [ ] **Step 2: 新增 index**

在 db.js 的 token_usage indexes 區塊之後加：

```js
  await query('CREATE INDEX IF NOT EXISTS idx_wiki_parent ON wiki_pages (parent_id)').catch(() => {});
  await query('CREATE INDEX IF NOT EXISTS idx_wiki_project ON wiki_pages (project_id)').catch(() => {});
```

- [ ] **Step 3: 寫失敗測試**

在 `app/server/tests/db-migration.test.js` 末尾加：

```js
test('wiki_pages has parent_id column', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='wiki_pages' AND column_name='parent_id'"
  );
  expect(rows.length).toBe(1);
});

test('wiki_pages has node_type column', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='wiki_pages' AND column_name='node_type'"
  );
  expect(rows.length).toBe(1);
});
```

- [ ] **Step 4: 執行測試**

Run: `cd app && npm test -- --testPathPattern=db-migration`
Expected: 既有測試 + 2 個新測試 PASS。

- [ ] **Step 5: Commit**

```bash
git add app/server/db.js app/server/tests/db-migration.test.js
git commit -m "feat(db): add parent_id and node_type to wiki_pages"
```

---

## Task 2: GET /wiki 回傳 parent_id + node_type

**Files:**
- Modify: `app/server/wiki-routes.js`（`app.get(base, …)` 的 SQL）
- Test: `app/server/tests/wiki-routes.test.js`

**Interfaces:**
- Produces: `GET /api/projects/:id/wiki` 每筆含 `id, slug, title, parent_id, node_type, updated_at`，overview 排最前。

- [ ] **Step 1: 修改 GET 查詢**

在 `app/server/wiki-routes.js` 找到：

```js
      const { rows } = await query(
        'SELECT id, slug, title, updated_at FROM wiki_pages WHERE project_id = $1 ORDER BY title ASC',
        [req.params.projectId]
      );
```

改成：

```js
      const { rows } = await query(
        `SELECT id, slug, title, parent_id, node_type, updated_at
         FROM wiki_pages WHERE project_id = $1
         ORDER BY (node_type <> 'overview'), node_type, title ASC`,
        [req.params.projectId]
      );
```

- [ ] **Step 2: 寫測試**

在 `app/server/tests/wiki-routes.test.js` 末尾加（沿用該檔既有 `app`/`token`/`projectId` 變數；若該檔以 `projectId` 建立過 wiki 頁，調整為先建一頁）：

```js
test('GET /wiki returns node_type and parent_id fields', async () => {
  // 建立一個 project 與一頁 wiki
  const pr = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name: 'WikiFieldsProj', odoo_version: '17.0' });
  const pid = pr.body.id;
  await request(app).post(`/api/projects/${pid}/wiki`).set('Authorization', `Bearer ${token}`)
    .send({ slug: 'overview', title: '專案概論', content: '# x' });
  const res = await request(app).get(`/api/projects/${pid}/wiki`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body[0]).toHaveProperty('node_type');
  expect(res.body[0]).toHaveProperty('parent_id');
});
```

- [ ] **Step 3: 執行測試**

Run: `cd app && npm test -- --testPathPattern=wiki-routes`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add app/server/wiki-routes.js app/server/tests/wiki-routes.test.js
git commit -m "feat(wiki): expose parent_id and node_type in GET /wiki"
```

---

## Task 3: library-agent — 節點 helper + initProjectWiki 建階層 + 進度事件

**Files:**
- Modify: `app/server/pipeline/library-agent.js`
- Test: `app/server/tests/library-agent-init.test.js`（新建）

**Interfaces:**
- Produces:
  - `_upsertNode(projectId, parentId, nodeType, slug, title, content) → Promise<number>`（衝突時更新 content，回傳 id）
  - `_ensureNode(projectId, parentId, nodeType, slug, title, content) → Promise<number>`（衝突時不動 content，回傳 id）
  - `_manifestSummary({module, content}) → string`
  - `initProjectWiki(projectId, userId, signal) → Promise<{ ok, slug, modules }>`（改寫：建 overview + 各 module 節點，emit `wiki:progress`）

- [ ] **Step 1: 新增三個 helper**

在 `app/server/pipeline/library-agent.js`，於 `_collectManifests` 函式之後加：

```js
async function _upsertNode(projectId, parentId, nodeType, slug, title, content) {
  const { rows: [row] } = await query(
    `INSERT INTO wiki_pages (project_id, parent_id, node_type, slug, title, content, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (project_id, slug)
     DO UPDATE SET parent_id=$2, node_type=$3, title=$5, content=$6, updated_at=NOW()
     RETURNING id`,
    [projectId, parentId, nodeType, slug, title, content]
  );
  return row.id;
}

async function _ensureNode(projectId, parentId, nodeType, slug, title, content) {
  await query(
    `INSERT INTO wiki_pages (project_id, parent_id, node_type, slug, title, content)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (project_id, slug) DO NOTHING`,
    [projectId, parentId, nodeType, slug, title, content]
  );
  const { rows: [row] } = await query(
    'SELECT id FROM wiki_pages WHERE project_id=$1 AND slug=$2', [projectId, slug]
  );
  return row.id;
}

function _manifestSummary(mod) {
  const grab = key => {
    const m = mod.content.match(new RegExp(`['"]${key}['"]\\s*:\\s*['"]([^'"]*)['"]`));
    return m ? m[1] : '';
  };
  const name = grab('name') || mod.module;
  const version = grab('version');
  const summary = grab('summary');
  return `# ${name}\n\n`
    + (version ? `**版本：** ${version}\n\n` : '')
    + (summary ? `${summary}\n\n` : '')
    + `> 模組目錄：\`${mod.module}\`。功能頁將於相關任務完成時自動補齊，或按「⟳ 更新」手動生成。`;
}
```

- [ ] **Step 2: 改寫 initProjectWiki**

把現有 `initProjectWiki` 整個函式替換為：

```js
async function initProjectWiki(projectId, userId, signal) {
  const { rows: [project] } = await query('SELECT * FROM projects WHERE id=$1', [projectId]);
  if (!project) { const e = new Error('Project not found'); e.status = 404; throw e; }

  const { rows: readyRepos } = await query(
    "SELECT id, label, local_path FROM project_repos WHERE project_id=$1 AND clone_status='done' AND local_path IS NOT NULL",
    [projectId]
  );
  if (!readyRepos.length) {
    const e = new Error('尚未有已 clone 完成的 Repo，請先新增並等待 clone 完成'); e.status = 400; throw e;
  }

  const emit = (stage, percent, message) =>
    notify.emitToUser(userId, 'wiki:progress', { projectId, stage, percent, message: message || '' });

  emit('scanning', 10, '掃描模組');
  const manifests = [];
  for (const repo of readyRepos) _collectManifests(repo.local_path, manifests, 15);

  // 1) 專案概論（CLI 一次）
  emit('overview', 40, '產生專案概論');
  const prompt = `你是 Library Agent，負責為 Odoo 專案建立 wiki 的「專案概論」。
根據以下模組的 __manifest__.py，產生一段精簡的專案概論（200-400 字）。
回傳 JSON（不要其他文字）：{"slug":"overview","title":"專案概論","content":"<Markdown>"}

要求：
- content 用繁體中文，說明專案整體用途與包含哪些模組
- 不要逐一複製 manifest 原文，用敘述方式

專案：${project.name}（Odoo ${project.odoo_version}）

${manifests.map(m => `=== ${m.module} ===\n${m.content}`).join('\n\n')}`;

  let overviewTitle = '專案概論';
  let overviewContent = `# ${project.name}\n\n（概論生成失敗，可按「⟳ 更新」重試）`;
  try {
    const { text, usage, durationMs } = await callClaude(prompt, signal, { userId, notify });
    await logTokenUsage({ projectId }, userId, 'wiki', usage, durationMs);
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { const p = JSON.parse(m[0]); overviewTitle = p.title || overviewTitle; overviewContent = p.content || overviewContent; }
  } catch (err) {
    console.error(`[LIBRARY-AGENT] init overview error project ${projectId}:`, err.message);
  }
  const overviewId = await _upsertNode(projectId, null, 'overview', 'overview', overviewTitle, overviewContent);

  // 2) 模組分類骨架（無 AI）
  const total = manifests.length || 1;
  for (let i = 0; i < manifests.length; i++) {
    const mod = manifests[i];
    await _upsertNode(projectId, overviewId, 'module', `module-${mod.module}`, mod.module, _manifestSummary(mod));
    emit('modules', 40 + Math.round(((i + 1) / total) * 55), `建立 ${mod.module}`);
  }

  emit('done', 100, '完成');
  return { ok: true, slug: 'overview', modules: manifests.length };
}
```

- [ ] **Step 3: 更新 module.exports**

把檔尾 `module.exports = { runLibraryAgent, initProjectWiki };` 改成：

```js
module.exports = { runLibraryAgent, initProjectWiki, _upsertNode, _ensureNode };
```

- [ ] **Step 4: 寫測試（用 temp dir 提供真實 manifest）**

新建 `app/server/tests/library-agent-init.test.js`：

```js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');

const mockCallClaude = jest.fn().mockResolvedValue({
  text: '{"slug":"overview","title":"專案概論","content":"# 總覽\\n專案說明"}', usage: null, durationMs: null
});
jest.mock('../pipeline/claude-runner', () => ({ callClaude: mockCallClaude }));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));

let dbModule, initProjectWiki, tmpRepo;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ initProjectWiki } = require('../pipeline/library-agent'));

  // 建立 temp repo：兩個模組各一個 __manifest__.py
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wikirepo-'));
  for (const m of ['sale_ext', 'hr_ext']) {
    fs.mkdirSync(path.join(tmpRepo, m), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, m, '__manifest__.py'),
      `{\n 'name': '${m} 名稱',\n 'version': '1.0',\n 'summary': '${m} 摘要',\n}`);
  }
}, 30000);

afterAll(() => {
  dbModule._setPoolForTesting(null);
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

async function makeProjectWithRepo() {
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('InitProj', '17.0') RETURNING id"
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, clone_status) VALUES ($1, 'main', 'x', $2, 'done')",
    [proj.id, tmpRepo]
  );
  return proj.id;
}

test('initProjectWiki creates one overview + one module node per manifest', async () => {
  const projectId = await makeProjectWithRepo();
  const result = await initProjectWiki(projectId, 1);
  expect(result.modules).toBe(2);

  const { rows: ov } = await dbModule.query(
    "SELECT * FROM wiki_pages WHERE project_id=$1 AND node_type='overview'", [projectId]
  );
  expect(ov.length).toBe(1);
  expect(ov[0].parent_id).toBeNull();

  const { rows: mods } = await dbModule.query(
    "SELECT * FROM wiki_pages WHERE project_id=$1 AND node_type='module' ORDER BY slug", [projectId]
  );
  expect(mods.length).toBe(2);
  expect(mods[0].slug).toBe('module-hr_ext');
  expect(mods[0].parent_id).toBe(ov[0].id);
});
```

- [ ] **Step 5: 執行測試**

Run: `cd app && npm test -- --testPathPattern=library-agent-init`
Expected: PASS（1 個測試）。

- [ ] **Step 6: Commit**

```bash
git add app/server/pipeline/library-agent.js app/server/tests/library-agent-init.test.js
git commit -m "feat(wiki): build project>module skeleton with progress events on init"
```

---

## Task 4: library-agent — runLibraryAgent 功能頁掛模組節點 + 自動補骨架

**Files:**
- Modify: `app/server/pipeline/library-agent.js`（頂部 require + runLibraryAgent 的 upsert 段）
- Test: `app/server/tests/library-agent.test.js`（更新既有斷言 + 新增）

**Interfaces:**
- Consumes: `_upsertNode`, `_ensureNode`（Task 3）
- Produces: 功能頁 `node_type='function'`、`parent_id` = 所屬 module 節點 id；module 名稱取自任務 `analysis_yaml` 的 `module`（無則 `uncategorized`）。

- [ ] **Step 1: 頂部 require js-yaml**

在 `library-agent.js` 頂部既有 require 之後加：

```js
const yaml = require('js-yaml');
```

- [ ] **Step 2: 改寫 runLibraryAgent 的 wiki upsert 段**

找到 runLibraryAgent 裡的：

```js
  if (wikiUpdate?.slug && wikiUpdate?.title) {
    try {
      await query(
        `INSERT INTO wiki_pages (project_id, slug, title, content, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (project_id, slug)
         DO UPDATE SET title=$3, content=$4, updated_at=NOW()`,
        [task.project_id, wikiUpdate.slug, wikiUpdate.title, wikiUpdate.content || '']
      );
    } catch (err) {
      console.error(`[LIBRARY-AGENT] wiki upsert error task ${taskId}:`, err.message);
    }
  }
```

整段替換為：

```js
  if (wikiUpdate?.slug && wikiUpdate?.title) {
    try {
      let moduleName = 'uncategorized';
      try { moduleName = (yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {}).module || 'uncategorized'; }
      catch { /* keep default */ }

      // 確保 overview + module 節點存在（不覆寫既有內容）
      const overviewId = await _ensureNode(
        task.project_id, null, 'overview', 'overview', '專案概論',
        '# 專案概論\n\n（尚未建立，可至 Wiki 按「建立 wiki」生成骨架）'
      );
      const moduleId = await _ensureNode(
        task.project_id, overviewId, 'module', `module-${moduleName}`, moduleName, `# ${moduleName}`
      );

      // 功能頁：依主題 slug upsert，掛在模組節點下
      await _upsertNode(
        task.project_id, moduleId, 'function',
        wikiUpdate.slug, wikiUpdate.title, wikiUpdate.content || ''
      );
    } catch (err) {
      console.error(`[LIBRARY-AGENT] wiki upsert error task ${taskId}:`, err.message);
    }
  }
```

- [ ] **Step 3: 更新既有測試斷言**

在 `app/server/tests/library-agent.test.js`，找到 `with project_id → upserts wiki page and sets done` 測試的結尾：

```js
  const { rows: wikiRows } = await dbModule.query('SELECT * FROM wiki_pages WHERE project_id=$1', [projectId]);
  expect(wikiRows.length).toBe(1);
  expect(wikiRows[0].slug).toBe('test-feature');
```

改成：

```js
  const { rows: fnRows } = await dbModule.query(
    "SELECT * FROM wiki_pages WHERE project_id=$1 AND node_type='function'", [projectId]
  );
  expect(fnRows.length).toBe(1);
  expect(fnRows[0].slug).toBe('test-feature');

  // 功能頁掛在 module 節點下，module 節點掛在 overview 下
  const { rows: [modNode] } = await dbModule.query('SELECT * FROM wiki_pages WHERE id=$1', [fnRows[0].parent_id]);
  expect(modNode.node_type).toBe('module');
  const { rows: [ovNode] } = await dbModule.query('SELECT * FROM wiki_pages WHERE id=$1', [modNode.parent_id]);
  expect(ovNode.node_type).toBe('overview');
```

- [ ] **Step 4: 新增測試 — analysis_yaml 的 module 決定歸屬**

在同檔末尾加：

```js
test('function page is attached under the module from analysis_yaml', async () => {
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id, analysis_yaml) VALUES ($1, 'T100', 'odoo', 'Feat', 'wiki_updating', $2, $3) RETURNING id",
    [userId, projectId, "module: sale_ext\nsummary: x"]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [mod] } = await dbModule.query(
    "SELECT * FROM wiki_pages WHERE project_id=$1 AND node_type='module'", [projectId]
  );
  expect(mod.slug).toBe('module-sale_ext');
});
```

- [ ] **Step 5: 執行測試**

Run: `cd app && npm test -- --testPathPattern=library-agent.test`
Expected: 3 既有（含改寫）+ 1 新 = PASS。

- [ ] **Step 6: Commit**

```bash
git add app/server/pipeline/library-agent.js app/server/tests/library-agent.test.js
git commit -m "feat(wiki): attach task function pages under their module node"
```

---

## Task 5: library-agent — refreshWikiNode + POST /wiki/:slug/refresh

**Files:**
- Modify: `app/server/pipeline/library-agent.js`（新增 `_collectModuleSource` + `refreshWikiNode`，更新 exports）
- Modify: `app/server/wiki-routes.js`（新增 refresh route）
- Test: `app/server/tests/wiki-routes.test.js`

**Interfaces:**
- Consumes: `_collectManifests`（既有）、`callClaude`、`logTokenUsage`
- Produces: `refreshWikiNode(projectId, slug, userId, signal) → Promise<{ ok, slug }>`；`POST /api/projects/:id/wiki/:slug/refresh`。

- [ ] **Step 1: 新增 _collectModuleSource 與 refreshWikiNode**

在 `library-agent.js` 的 `_manifestSummary` 之後加：

```js
// 蒐集某模組目錄下最多 limit 個 .py 檔的檔名 + 前 300 字，作為 refresh 的上下文
function _collectModuleSource(readyRepos, moduleName, limit = 8) {
  const out = [];
  for (const repo of readyRepos) {
    if (!repo.local_path) continue;
    const modDir = path.join(repo.local_path, moduleName);
    if (!fs.existsSync(modDir)) continue;
    const walk = dir => {
      if (out.length >= limit) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= limit) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.')) walk(full);
        else if (e.name.endsWith('.py') && e.name !== '__manifest__.py') {
          try {
            const rel = path.relative(modDir, full);
            out.push(`# ${rel}\n${fs.readFileSync(full, 'utf8').slice(0, 300)}`);
          } catch { /* skip */ }
        }
      }
    };
    walk(modDir);
  }
  return out.join('\n\n');
}

async function refreshWikiNode(projectId, slug, userId, signal) {
  const { rows: [node] } = await query(
    'SELECT id, slug, title, content, node_type, parent_id FROM wiki_pages WHERE project_id=$1 AND slug=$2',
    [projectId, slug]
  );
  if (!node) { const e = new Error('Wiki node not found'); e.status = 404; throw e; }

  const { rows: [project] } = await query('SELECT * FROM projects WHERE id=$1', [projectId]);
  const { rows: readyRepos } = await query(
    "SELECT local_path FROM project_repos WHERE project_id=$1 AND clone_status='done' AND local_path IS NOT NULL",
    [projectId]
  );

  const emit = (percent, message) =>
    notify.emitToUser(userId, 'wiki:progress', { projectId, slug, stage: 'refresh', percent, message: message || '' });
  emit(10, '準備重新生成');

  let prompt;
  if (node.node_type === 'overview') {
    const manifests = [];
    for (const r of readyRepos) _collectManifests(r.local_path, manifests, 15);
    prompt = `你是 Library Agent。重新產生 Odoo 專案「${project.name}」的專案概論（200-400 字繁中）。
回傳 JSON：{"slug":"overview","title":"專案概論","content":"<Markdown>"}

${manifests.map(m => `=== ${m.module} ===\n${m.content}`).join('\n\n')}`;
  } else if (node.node_type === 'module') {
    const moduleName = node.slug.replace(/^module-/, '');
    const src = _collectModuleSource(readyRepos, moduleName);
    prompt = `你是 Library Agent。為模組「${moduleName}」產生功能描述（繁中 Markdown）。
回傳 JSON：{"slug":"${node.slug}","title":"${moduleName}","content":"<Markdown>"}

模組原始碼節錄：
${src || '（無原始碼）'}`;
  } else {
    const { rows: [parent] } = await query('SELECT slug FROM wiki_pages WHERE id=$1', [node.parent_id]);
    const moduleName = (parent?.slug || '').replace(/^module-/, '') || 'unknown';
    const src = _collectModuleSource(readyRepos, moduleName);
    prompt = `你是 Library Agent。精修以下功能 wiki（繁中 Markdown），保留正確內容、補充與修正。
回傳 JSON：{"slug":"${node.slug}","title":"<標題>","content":"<Markdown>"}

現有內容：
${node.content || '（空）'}

所屬模組「${moduleName}」原始碼節錄：
${src || '（無原始碼）'}`;
  }

  let title = node.title, content = node.content;
  try {
    const { text, usage, durationMs } = await callClaude(prompt, signal, { userId, notify });
    await logTokenUsage({ projectId }, userId, 'wiki', usage, durationMs);
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { const p = JSON.parse(m[0]); title = p.title || title; content = p.content ?? content; }
  } catch (err) {
    console.error(`[LIBRARY-AGENT] refresh error ${slug}:`, err.message);
    const e = new Error('重新生成失敗：' + err.message); e.status = 500; throw e;
  }

  await query(
    'UPDATE wiki_pages SET title=$3, content=$4, updated_at=NOW() WHERE project_id=$1 AND slug=$2',
    [projectId, slug, title, content]
  );
  emit(100, '完成');
  return { ok: true, slug };
}
```

- [ ] **Step 2: 更新 exports**

把 `library-agent.js` 檔尾的 exports 改成：

```js
module.exports = { runLibraryAgent, initProjectWiki, refreshWikiNode, _upsertNode, _ensureNode };
```

- [ ] **Step 3: 新增 refresh route**

在 `wiki-routes.js` 頂部 require 改成（加入 refreshWikiNode）：

```js
const { initProjectWiki, refreshWikiNode } = require('./pipeline/library-agent');
```

在 `app.post(\`${base}/init\`, …)` route 之後加：

```js
  app.post(`${base}/:slug/refresh`, verifyToken, async (req, res) => {
    try {
      const result = await refreshWikiNode(req.params.projectId, req.params.slug, req.userId);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
```

- [ ] **Step 4: 寫測試**

在 `app/server/tests/wiki-routes.test.js` 末尾加：

```js
test('POST /wiki/:slug/refresh → 404 for missing slug', async () => {
  const pr = await request(app).post('/api/projects').set('Authorization', `Bearer ${token}`)
    .send({ name: 'RefreshProj', odoo_version: '17.0' });
  const res = await request(app).post(`/api/projects/${pr.body.id}/wiki/nope/refresh`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);
});
```

> 註：成功路徑會呼叫真實 `claude` CLI，不在單元測試覆蓋；以 404 驗證路由與錯誤映射。

- [ ] **Step 5: 執行測試**

Run: `cd app && npm test -- --testPathPattern=wiki-routes`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add app/server/pipeline/library-agent.js app/server/wiki-routes.js app/server/tests/wiki-routes.test.js
git commit -m "feat(wiki): add per-node manual refresh (overview/module/function)"
```

---

## Task 6: 前端 — WikiView 樹狀側欄 + 節點更新鈕

**Files:**
- Modify: `app/public/js/views/WikiView.js`

**Interfaces:**
- Consumes: `GET /api/projects/:id/wiki`（含 parent_id/node_type）、`POST /api/projects/:id/wiki/:slug/refresh`

- [ ] **Step 1: 新增 tree computed + refresh 方法**

在 `WikiView.js` 的 `data()` 回傳物件加 `refreshing: ''`（記錄正在更新的 slug）：

```js
      saving: false,
      refreshing: ''
```

在 `computed` 加 `tree`：

```js
  computed: {
    renderedContent() {
      if (!this.current) return '';
      return window.marked ? window.marked.parse(this.current.content) : this.current.content;
    },
    tree() {
      const byId = {};
      this.pages.forEach(p => { byId[p.id] = { ...p, children: [] }; });
      const roots = [];
      this.pages.forEach(p => {
        if (p.parent_id && byId[p.parent_id]) byId[p.parent_id].children.push(byId[p.id]);
        else roots.push(byId[p.id]);
      });
      // overview 根排最前
      roots.sort((a, b) => (a.node_type === 'overview' ? -1 : 0) - (b.node_type === 'overview' ? -1 : 0));
      return roots;
    }
  },
```

在 `methods` 加 `refreshNode`：

```js
    async refreshNode(slug) {
      this.refreshing = slug;
      try {
        await Api.post(`projects/${this.$route.params.id}/wiki/${slug}/refresh`);
        showToast('已重新生成', 'success');
        await this.loadPages();
        if (this.current && this.current.slug === slug) await this.loadPage(slug);
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.refreshing = ''; }
    },
```

- [ ] **Step 2: 改寫側欄 template 為樹狀**

把 template 裡側欄的 `<div v-for="p in pages" …>…</div>`（含其空狀態）整段，替換為遞迴渲染。將原本的扁平列表區塊：

```html
        <div v-if="loading" style="color:var(--text-muted);font-size:13px;padding:8px">載入中...</div>
        <div v-for="p in pages" :key="p.slug" ... @click="loadPage(p.slug)">
          ...
        </div>
        <div v-if="!loading && pages.length === 0" ...>尚無頁面</div>
```

替換為：

```html
        <div v-if="loading" style="color:var(--text-muted);font-size:13px;padding:8px">載入中...</div>
        <template v-else>
          <wiki-node v-for="n in tree" :key="n.id" :node="n" :depth="0"
            :current-slug="current && current.slug"
            :refreshing="refreshing"
            @open="loadPage" @refresh="refreshNode"></wiki-node>
          <div v-if="pages.length === 0" style="color:var(--text-muted);font-size:12px;padding:8px">尚無頁面</div>
        </template>
```

- [ ] **Step 3: 註冊遞迴子元件 wiki-node**

在 `WikiView.js` 檔案最上方（`window.WikiView = …` 之前）加一個全域遞迴元件：

```js
Vue.defineComponent && (window.WikiNode = Vue.defineComponent({
  name: 'wiki-node',
  props: ['node', 'depth', 'currentSlug', 'refreshing'],
  emits: ['open', 'refresh'],
  template: `
    <div>
      <div style="display:flex;align-items:center;gap:4px;padding:6px 8px;border-radius:4px;cursor:pointer;font-size:13px"
        :style="{ background: currentSlug === node.slug ? 'var(--border)' : 'transparent', paddingLeft: (8 + depth*14) + 'px' }"
        @click="$emit('open', node.slug)">
        <span style="opacity:.6">{{ node.node_type === 'module' ? '📁' : node.node_type === 'overview' ? '🏠' : '📄' }}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ node.title }}</span>
        <button class="btn btn-outline btn-sm" style="padding:0 5px;font-size:11px"
          :disabled="refreshing === node.slug"
          @click.stop="$emit('refresh', node.slug)" title="重新生成">
          {{ refreshing === node.slug ? '…' : '⟳' }}
        </button>
      </div>
      <wiki-node v-for="c in node.children" :key="c.id" :node="c" :depth="depth+1"
        :current-slug="currentSlug" :refreshing="refreshing"
        @open="$emit('open', $event)" @refresh="$emit('refresh', $event)"></wiki-node>
    </div>
  `
}));
```

在 `window.WikiView` 的 component 定義加上局部註冊（在 `name: 'WikiView',` 之後）：

```js
  components: { 'wiki-node': window.WikiNode },
```

- [ ] **Step 4: 手動驗證**

啟動伺服器後：
1. 進入某專案 Wiki 頁。
2. 確認側欄呈現樹狀：🏠 概論 → 📁 模組（縮排）→ 📄 功能（再縮排）。
3. 點任一節點可載入內容；點 ⟳ 會呼叫 refresh、顯示「…」、完成後 toast 並重載。
4. Console 無 JS error。

- [ ] **Step 5: Commit**

```bash
git add app/public/js/views/WikiView.js
git commit -m "feat(wiki-ui): tree sidebar with per-node refresh button"
```

---

## Task 7: 前端 — Init 階段式進度條（socket wiki:progress）

**Files:**
- Modify: `app/public/js/views/WikiView.js`

**Interfaces:**
- Consumes: socket `window._socket` 事件 `wiki:progress` `{ projectId, stage, percent, message }`；`POST /api/projects/:id/wiki/init`

- [ ] **Step 1: data 加進度狀態 + init 方法**

在 `data()` 加：

```js
      refreshing: '',
      building: false,
      progress: { percent: 0, message: '', stage: '' }
```

在 `methods` 加：

```js
    async buildWiki() {
      this.building = true;
      this.progress = { percent: 0, message: '開始建立…', stage: 'scanning' };
      try {
        await Api.post(`projects/${this.$route.params.id}/wiki/init`, {});
        await this.loadPages();
        if (this.pages.length) await this.loadPage('overview');
        showToast('Wiki 已建立', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.building = false; }
    },
    _onProgress(data) {
      if (String(data.projectId) !== String(this.$route.params.id)) return;
      this.progress = { percent: data.percent || 0, message: data.message || '', stage: data.stage || '' };
    },
```

- [ ] **Step 2: 掛載/卸載 socket 監聽**

把 `async created() { … }` 之後加 `mounted` 與 `beforeUnmount`（若已有 created，新增這兩個 hook 並列）：

```js
  mounted() {
    const sock = window._socket;
    if (sock) sock.on('wiki:progress', this._onProgress = this._onProgress || (d => {}));
  },
  beforeUnmount() {
    const sock = window._socket;
    if (sock && sock.off) sock.off('wiki:progress', this._onProgress);
  },
```

> 註：`_onProgress` 已在 methods 定義，`mounted` 直接用 `this._onProgress.bind(this)`。改用下面穩定寫法取代上面 mounted：

```js
  mounted() {
    this._progressHandler = (d) => this._onProgress(d);
    const sock = window._socket;
    if (sock) sock.on('wiki:progress', this._progressHandler);
  },
  beforeUnmount() {
    const sock = window._socket;
    if (sock && sock.off) sock.off('wiki:progress', this._progressHandler);
  },
```

（採用第二段；移除第一段示意。）

- [ ] **Step 3: template 加「建立 wiki」按鈕 + 進度條**

在 topbar 的「+ 新增頁面」按鈕之前加建立按鈕：

```html
      <button class="btn btn-primary btn-sm" style="margin-left:auto" @click="buildWiki" :disabled="building">
        {{ building ? '建立中…' : '建立 wiki' }}
      </button>
      <button class="btn btn-outline btn-sm" style="margin-left:8px" @click="addPage">+ 新增頁面</button>
```

（把原本 `+ 新增頁面` 的 `margin-left:auto` 移到「建立 wiki」上，如上。）

在內容區頂部（`<div style="display:flex;height:calc(100vh - 56px)…">` 之前）加進度條：

```html
    <div v-if="building" style="padding:8px 16px;background:var(--surface);border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);margin-bottom:4px">
        <span>{{ progress.message || '建立中…' }}</span><span>{{ progress.percent }}%</span>
      </div>
      <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
        <div :style="{ width: progress.percent + '%', height: '100%', background: 'var(--primary)', transition: 'width .3s' }"></div>
      </div>
    </div>
```

- [ ] **Step 4: 手動驗證**

1. 進入有 ready repo 的專案 Wiki，按「建立 wiki」。
2. 進度條依序顯示：掃描模組(10%) → 產生專案概論(40%) → 建立 <模組>(逐步到 95%) → 完成(100%)。
3. 完成後側欄出現樹狀骨架、自動載入概論。
4. 無 ready repo 的專案按下會 toast 400 錯誤、進度條不卡住。

- [ ] **Step 5: Commit**

```bash
git add app/public/js/views/WikiView.js
git commit -m "feat(wiki-ui): staged progress bar for wiki build via socket"
```

---

## Self-Review

**Spec coverage:**
- ✅ 資料模型 B（parent_id + node_type）— Task 1
- ✅ GET /wiki 回傳階層欄位 — Task 2
- ✅ init 建 overview + module 骨架 + 進度事件 — Task 3
- ✅ 漸進補齊：功能頁掛模組節點、自動補骨架、依 analysis_yaml module 歸屬 — Task 4
- ✅ 手動更新（overview/module/function 三分支）+ 端點 — Task 5
- ✅ 前端樹狀側欄 + 節點更新鈕 — Task 6
- ✅ 前端 init 進度條（socket）— Task 7
- ✅ 進度事件 schema `{projectId, slug, stage, percent, message}` — Task 3/5/7
- ✅ Edge：無 ready repo→400（Task 3/7）、無 module→uncategorized（Task 4）、未 init 任務完成→自動補骨架（Task 4）、同主題合併（Task 4 `_upsertNode`）

**型別一致性：** `_upsertNode`/`_ensureNode` 回傳 id（number），三任務一致使用；`refreshWikiNode`/`initProjectWiki` 回傳 `{ ok, slug, … }`，route 直接 `res.json`；progress payload 欄位一致。

**已知注意：**
- Task 6 Step 3 的遞迴元件須在 `WikiView` 載入前定義（同檔最上方），且 `index.html` 既有載入 `WikiView.js` 不需改。
- Task 7 Step 2 採「第二段」穩定的 `_progressHandler` 寫法。
