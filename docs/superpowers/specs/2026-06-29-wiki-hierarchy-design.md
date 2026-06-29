# Wiki 階層分類（專案 > 模組 > 功能）+ 漸進補齊 + 建置進度 設計

**日期：** 2026-06-29
**狀態：** 設計定案，待實作

## Goal

把目前**扁平**的專案 wiki 升級為三層階層：**專案概論 > 模組 > 功能**。

- **Init（手動）**：掃 `__manifest__.py` → 產「專案概論」+ 為每個模組建分類骨架。建置全程顯示階段式進度條。
- **漸進補齊（自動）**：任務走到 library 階段時，依其 module + 功能主題，在對應模組底下新增/合併功能頁。
- **手動更新**：概論 / 模組 / 功能每個節點都可單獨重新生成。

## Context（現況）

- `wiki_pages(id, project_id, slug, title, content, updated_at, UNIQUE(project_id, slug))` —— 扁平，無階層。
- `library-agent.js`：
  - `initProjectWiki(projectId, userId, signal)` —— 掃 manifest，CLI 產**一頁** overview，upsert 扁平。
  - `runLibraryAgent(taskId, userId, signal)` —— 任務 library 階段，CLI 依任務分析+日誌產**一頁主題頁**，upsert 扁平。
- `wiki-routes.js`：CRUD + `POST /wiki/init` 委派 `initProjectWiki`。
- `WikiView.js`：側欄扁平頁面清單 + Markdown 檢視/編輯。
- `notify.emitToUser(userId, event, payload)`：既有 websocket 推送（pipeline 已用 `terminal:output` / `task:updated`）。

## 資料模型（方案 B：parent_id 自參考，單表）

在 `wiki_pages` 加兩欄（`app/server/db.js` 的 `colMigrations`）：

```sql
ALTER TABLE wiki_pages ADD COLUMN parent_id INTEGER REFERENCES wiki_pages(id) ON DELETE CASCADE;
ALTER TABLE wiki_pages ADD COLUMN node_type TEXT NOT NULL DEFAULT 'function';  -- overview | module | function
```

節點規則（每個 project 一棵樹）：

| node_type | slug 規則 | parent_id | 內容來源 |
|-----------|-----------|-----------|----------|
| `overview` | `overview` | `NULL`（根） | CLI 產生專案概論 |
| `module` | `module-<模組名>` | 指向 overview 節點 id | manifest 摘要（init 時不呼叫 AI） |
| `function` | `<功能主題>`（如 `sales-order-flow`） | 指向所屬 module 節點 id | CLI 依任務分析+日誌產生 |

- 載入整棵樹：**一次查詢** `SELECT id, parent_id, slug, title, node_type, updated_at FROM wiki_pages WHERE project_id=$1`，JS 依 parent_id 組樹。
- 刪除模組節點 → `ON DELETE CASCADE` 自動刪其功能頁。
- 為什麼選 B：固定三層不需要通用樹/拆表；單表單查詢讀取最省（拆表需 JOIN），又有 FK 完整性與「模組改名只改一列」的正規化好處。

> 既有資料相容：migration 後舊頁 `node_type` 預設 `'function'`、`parent_id=NULL`。不做自動搬遷；重跑一次 init 會建立新骨架。

## Init 流程（建骨架）

改寫 `initProjectWiki(projectId, userId, signal)`：

1. 驗證 project 存在、有 `clone_status='done'` 的 repo（否則丟 `err.status` 404/400，沿用現況）。
2. **掃描模組**：`_collectManifests` → 模組清單。emit `wiki:progress {stage:'scanning', percent:10, message:'掃描模組'}`。
3. **產生概論**：CLI 一次，prompt 要求精簡專案概論 JSON `{slug:'overview', title, content}`。upsert overview 節點（`node_type='overview', parent_id=NULL`）。emit `{stage:'overview', percent:40}`。
4. **建立模組分類**：對每個模組 upsert module 節點：
   - `slug='module-<name>'`, `title='<name>'`, `node_type='module'`, `parent_id=<overview.id>`
   - `content` = 直接組 manifest 摘要 Markdown（name / version / summary / depends）——**不呼叫 AI**。
   - 逐模組 emit `{stage:'modules', percent:40→95 線性, message:'建立 <name>'}`。
5. **完成**：emit `{stage:'done', percent:100}`。回傳 `{ ok, slug:'overview', modules:<count> }`。

> init 全程只 1 次 AI 呼叫（概論）。模組層骨架、功能層留空。

## 漸進補齊流程（自動）

改寫 `runLibraryAgent(taskId, userId, signal)` 的 wiki 寫入段：

1. 取任務 `module`（從 `analysis_yaml` 解析；若無則歸到 `module-uncategorized`）。
2. **確保歸屬**：找該 project 的 overview 節點；不存在則自動補建（minimal overview 根）。找 `slug='module-<module>'` 的 module 節點；不存在則建立（`parent_id=overview.id`，content 用 manifest 摘要或空）。
3. CLI 產功能頁 JSON `{slug, title, content}`（沿用現有 prompt，slug=功能主題）。
4. upsert function 節點：`node_type='function'`, `parent_id=<module 節點 id>`；**同 (project_id, slug) 已存在則更新內容**（合併＝以新內容覆寫）。
5. 記 token `agent_type='wiki'`（沿用）。

## 手動更新（節點層級）

**端點**：`POST /api/projects/:id/wiki/:slug/refresh`（`wiki-routes.js`，verifyToken）。委派 library-agent。

**`refreshWikiNode(projectId, slug, userId, signal)`**：載入節點，依 `node_type` 分支，全部走 CLI，更新後 upsert 回同列、記 token、emit `wiki:progress`（單節點：`stage:'refresh'`, percent 0→100）：

| node_type | 生成依據 | prompt 重點 |
|-----------|----------|-------------|
| `overview` | 重掃 manifest | 同 init 概論段 |
| `module` | 該模組 `__manifest__.py` + 淺層原始碼掃描（models/views 檔名與少量內容，限長度） | 產模組功能描述 |
| `function` | 所屬模組原始碼 + **該頁現有 content** | 精修既有功能說明 |

> 假設：功能頁手動 refresh 以「模組原始碼 + 現有內容」為輸入精修，不重新關聯任務。

## 前端（`WikiView.js`）

- **側欄改樹狀**：載入 pages 後依 parent_id 組樹。概論置頂 → 模組（可摺疊，預設展開）→ 功能頁縮排其下。沿用現有點擊載入頁面。
- **節點更新按鈕**：每個 overview/module/function 節點旁加「⟳」鈕 → `Api.post('projects/:id/wiki/:slug/refresh')`，該節點顯示 loading；完成後 `loadPages()` + 若為當前頁則重載。
- **Init 進度條**：按「建立 wiki」後，監聽 socket `wiki:progress`，顯示階段標籤 + 百分比 + `message`（目前模組）。完成後載入樹。
- 既有編輯/新增/刪除頁面功能保留。手動新增頁面預設 `node_type='function'`、`parent_id` = `module-uncategorized` 節點（不存在則自動建立並掛在 overview 下）。

## API 端點彙總

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/projects/:id/wiki` | 列出所有節點（含 `parent_id, node_type`） |
| POST | `/api/projects/:id/wiki/init` | 建骨架（既有，改寫） |
| POST | `/api/projects/:id/wiki/:slug/refresh` | **新**：單節點重生 |
| GET/POST/PUT/DELETE | `/api/projects/:id/wiki[/:slug]` | 既有 CRUD（GET 回傳加 parent_id/node_type） |

## 進度事件 schema

`notify.emitToUser(userId, 'wiki:progress', payload)`：

```js
{ projectId, slug, stage, percent, message }
// stage: 'scanning' | 'overview' | 'modules' | 'refresh' | 'done'
```

前端依 `projectId` 過濾、`percent` 驅動進度條、`message` 顯示目前動作。

## 測試

- **DB migration**（`tests/db-migration.test.js`）：`wiki_pages` 有 `parent_id`、`node_type` 欄位。
- **initProjectWiki**（`tests/library-agent.test.js`，mock callClaude）：
  - 產生 1 個 overview（parent_id null）+ 每模組 1 個 module 節點（parent_id=overview, node_type='module'）。
  - manifest 模組數 = module 節點數。
- **runLibraryAgent**：功能頁 `node_type='function'` 且 parent_id=對應 module 節點；未 init 時自動補 overview+module；同 slug 二次寫入為更新而非新增。
- **refreshWikiNode**：三種 node_type 各自更新對應節點 content；slug 不存在回 404。
- **wiki-routes**：`POST /wiki/:slug/refresh` 200 / 404；GET 回傳含 parent_id/node_type。
- **前端**：手動驗證（無 build step）——樹狀渲染、摺疊、進度條、節點更新鈕。

## Edge cases

- 專案無 ready repo → init 400（沿用）。
- 任務無 module → 歸 `module-uncategorized`。
- wiki 未 init 就有任務完成 → library agent 自動補 overview+module 骨架。
- 同功能主題多任務 → 合併同一功能頁。
- 舊扁平頁（migration 後 `node_type='function', parent_id=NULL`）→ 顯示在樹的「未分類」區；重跑 init 後新增骨架，不破壞舊頁。

## Out of scope

- 不做拖拉調整階層 UI。
- 不做模組原始碼的深度語意解析（refresh 僅淺層掃描＋AI 摘要）。
- 不移除 `@anthropic-ai/sdk` 套件（已無人使用，留待日後清理）。
- 不自動搬遷既有扁平頁到模組底下。
