# Agent 統一化 + 管理介面 + 全站命名 — 設計文件

日期:2026-07-03
狀態:設計定稿,待實作規劃

## 1. 背景與問題

系統目前有**兩套並存的 agent 機制**,格式與可管理性不一致:

- **A. Server-side Node pipeline**(`app/server/pipeline/*`,web app「開工/同步」實際在跑的):
  透過 `claude` CLI(`callClaude` / `task-agent` 的 `spawnClaude`)呼叫,**未指定模型(吃 CLI 預設)**,
  prompt 硬寫在 JS 內。包含 triage、analysis、task-agent(分析+實作)、cs、merge、deploy-fixer、library、chat。
- **B. Claude Code subagents**(`.claude/agents/*.md` + PS1「開工」hook):
  `requirements-analyst`(opus)、`senior-software-engineer`(opus)、`qa-analyst`(sonnet),
  由主 Claude 用 Agent tool 呼叫,已是 frontmatter 格式。

痛點:
1. 格式不統一,server 端 agent 的 model 與 prompt 散落在程式碼裡,無法集中管理。
2. 沒有可視化管理:管理員無法從網頁調整 agent 的模型或提示詞。
3. 命名不一致:用量報表(TokenReport)直接顯示英文 `agent_type` key(cs/triage/deploy_fix/wiki…)。

## 2. 目標

1. **統一格式**:所有實際使用到的 LLM agent 都有一個 `.claude/agents/<name>.md` 檔,含完整 frontmatter 規範。
2. **呼叫時帶入**:server 端執行時從 `.md` 載入 model 與 prompt(不再硬寫在程式碼)。
3. **管理介面**:管理員可從網頁(放在「使用者管理」旁,`/admin/agents`)列出並編輯每個 agent 的 **model 與提示詞**。
4. **全站命名統一**:每個 agent 有中文 `label`,用量報表等處全站顯示中文。

非目標(YAGNI):
- 不做 agent 版本歷史 / diff。
- 不做新增/刪除 agent(清單固定為現有實際使用者)。
- 不改動 pipeline 狀態機、PS1 腳本邏輯(僅把 prompt/model 外部化)。

## 3. Agent 名冊(定稿,12 個)

按**角色**分組,顯示與命名以角色為準;檔案一段 prompt 一個(library 除外,已併為單一「維護 wiki」agent)。

| 角色 label | agent name(=檔名) | 來源 | 預設 model | token key(stage) |
|---|---|---|---|---|
| 分診 | `triage` | triage.js | haiku | triage |
| 分析 | `analysis-basic` | analysis.js（非專案一次性 YAML） | sonnet | analysis |
| 分析 | `analysis-project` | task-agent.js `buildAnalysisPrompt`（讀碼） | sonnet | analysis |
| 分析 | `requirements-analyst` | subagent(B) | sonnet（原 opus） | analysis |
| 實作 | `coding-project` | task-agent.js `buildCodingPrompt` | sonnet | coding |
| 實作 | `senior-software-engineer` | subagent(B) | sonnet（原 opus） | coding |
| 品質檢查 | `qa-analyst` | subagent(B) | sonnet | qa |
| 客服 | `cs` | cs-agent.js | sonnet | cs |
| 合併 | `merge` | merge-agent.js | sonnet | merge |
| 部署修復 | `deploy-fix` | deploy-fixer.js | haiku | deploy_fix |
| 知識庫 | `library` | library-agent.js（5 段併 1） | sonnet | wiki |
| 對話 | `chat` | chat-agent.js | sonnet | chat |

模型上限為 **Sonnet**(目前最新 Sonnet 4.6,別名 `sonnet`);不使用 opus。以上為預設,管理員可事後於介面調整。

> 決策紀錄:
> - 分析(3)、實作(2)**維持分開**——執行機制與輸出格式不同(subagent 走 Agent tool、server 版讀原始碼、analysis-basic 產一次性 YAML),硬併會壞。
> - library 5 段(task/init/refresh-overview/refresh-module/refresh-function)**併成 1 個** `library`——職責統一為「維護 wiki」,由程式把不同情境資料塞進 `{{context}}`。

## 4. Agent 檔案格式

`.claude/agents/<name>.md`:

```markdown
---
name: triage              # 唯一 key（= 檔名），程式碼靠此載入
role: triage              # 角色分組 key
label: 分診               # 中文顯示名（全站統一）
description: 將新任務分類為 answered/blocked/confirm/analysis
model: haiku              # haiku | sonnet
stage: triage             # 對應 token-logger 的 agent_type
---
你是 AI 開發工作流程的 Triage Agent……
（system prompt 本體，動態資料以 {{placeholder}} 標記）
```

- B 的三個 subagent 檔案沿用既有 `name/description/model/color`,**補上** `role/label/stage`,model 由 opus 改 sonnet。
  - 風險:Claude Code 的 Agent tool 讀取 subagent frontmatter 時是否容忍未知欄位(`role/label/stage`)。假設容忍(慣例上會忽略未知 key);實作時需實測確認,若不容忍則改為將 label/role/stage 記在獨立 registry 檔。
- Placeholder 命名對照(各 agent 需要的動態變數):
  - `triage`: `{{original_text}}`
  - `analysis-basic`: `{{original_text}}`
  - `analysis-project` / `coding-project`: `{{task_context}}`（含 task 與 repo 資訊,由 task-agent 組裝）
  - `cs`: `{{title}}`, `{{original_text}}`, `{{wiki}}`
  - `chat`: `{{wiki}}`, `{{history}}`, `{{user_message}}`
  - `merge`: `{{file_path}}`, `{{content}}`
  - `deploy-fix`: `{{error_text}}`
  - `library`: `{{context}}`

### `library` 原則(system prompt 本體)

```
你是 Odoo 專案的知識庫維護 Agent，負責維護專案 wiki。

【目標】
讓 wiki 忠實反映專案現況：結構清楚、繁體中文、精簡不冗長。

【輸入】
每次會收到一段情境資料（{{context}}），可能是：
- 某次任務的完成紀錄（標題 / 分析 yaml / 執行日誌）——用於新增/更新功能頁
- 某個 wiki 節點的原始碼或現有內容（概論 / 模組 / 功能頁）——用於重建該頁

【輸出】（嚴格遵守）
只回傳合法 JSON，無任何其他文字或 markdown code block：
{"slug":"<英文小寫加連字號>","title":"<標題>","content":"<Markdown>"}

【撰寫原則】
- 專案概論：200–400 字，敘述專案整體用途與包含哪些模組；不逐條複製 manifest。
- 模組頁：說明模組用途、主要行為、關鍵資料表/欄位；以實際原始碼為準。
- 功能頁：說明該功能的目的、操作流程、涉及的模型與方法。
- 任務增量：聚焦「這次新增或變更了什麼」，補進對應頁面，不重寫全部。
- 保留既有正確內容，只補充與修正，非必要不刪除。
- 資料不足或不確定時，產生骨架並標註「待補」，嚴禁杜撰。
```

## 5. 執行機制

### 5.1 Loader — `app/server/pipeline/agent-loader.js`(新增)

- `loadAgent(name)` → 讀 `.claude/agents/<name>.md`,解析 frontmatter(用既有 `js-yaml`,以 `---` 分隔 frontmatter 與 body),
  回傳 `{ name, role, label, model, stage, body, render(vars) }`。
- `render(vars)`:將 body 內 `{{key}}` 以 `vars[key]` 取代(缺值代空字串)。
- 快取:以檔案 mtime 或啟動載入 + 提供 `invalidate(name)`;PUT 更新後呼叫失效。
- 模型別名直接傳給 CLI(`claude --model sonnet|haiku`,CLI 支援別名)。

### 5.2 CLI 帶入模型

- `claude-runner.js` 的 `callClaude(prompt, signal, opts)`:`opts.model` 存在時,spawn 參數加入 `--model <model>`。
- `task-agent.js` 的 `spawnClaude(prompt, { ... , model })`:同樣加 `--model`。

### 5.3 各 server 檔案改寫(prompt 外部化)

每個檔案把硬寫的 prompt 常數改為:
```js
const a = loadAgent('triage');
const { text, usage } = await callClaude(a.render({ original_text }), signal, { model: a.model, ...opts });
```
涉及:triage.js、analysis.js、task-agent.js(2 處)、cs-agent.js、chat-agent.js、merge-agent.js、deploy-fixer.js、library-agent.js(5 處呼叫改為組 `context` 後呼叫單一 `library`)。

**等價性要求**:改寫後 `render(...)` 產出的完整 prompt 必須與現行硬寫 prompt 語意等價(除了刻意的模型變更)。以測試鎖定(見 §8)。

## 6. 全站命名(中文 label)

- 真相來源:各 agent 的 `stage`(token key)+ 角色 `label`。多個 agent 可共用同一 stage(如 analysis-basic/analysis-project/requirements-analyst 都是 `analysis`)。
- 提供 `GET /api/agents/labels` → `{ triage:'分診', analysis:'分析', coding:'實作', qa:'品質檢查', cs:'客服', merge:'合併', deploy_fix:'部署修復', wiki:'知識庫', chat:'對話' }`(由 registry 依 stage 去重推導)。
- `TokenReport.js`:圓餅圖圖例、明細列的 `agent_type` 顯示改用 label(`agentColor` 的色票 key 維持不變,只換顯示文字)。
- 其他顯示 `agent_type` 之處一併替換為 label。

## 7. 管理介面

### 7.1 後端 — `admin-routes.js`(掛 `auth = [verifyToken, requireAdmin]`)

- `GET /api/admin/agents` → 列出所有 agent 的 `{ name, role, label, description, model, stage }`(不含 body)。
- `GET /api/admin/agents/:name` → 單一,含 `body`(提示詞)。
- `PUT /api/admin/agents/:name` → body `{ model, prompt }`:
  - `name` 需在既有 agent 白名單內(防路徑穿越)。
  - `model` 需 ∈ `{ haiku, sonnet }`。
  - 保留原 frontmatter 其餘欄位,只更新 `model` 與 body,寫回 `.md`。
  - 成功後呼叫 loader `invalidate(name)`。

### 7.2 前端 — `AdminAgents.js`(`AdminAgentsView`)

- 路由 `/admin/agents`(`requiresAuth + requiresAdmin`),於 `app.js` routes 註冊,`index.html` 加 script 標籤。
- `Admin.js`:在「使用者管理」區塊**下方**新增「Agent 管理」區塊,按鈕 → `/admin/agents`。
- 畫面:仿 `AdminUsersView`。**按角色分組**列出 agent;每列顯示 label、model badge、description。
- 編輯:點開單一 agent → **model 下拉(haiku/sonnet)** + **提示詞 textarea**;`name/role/label/description/stage` 唯讀。存檔呼叫 `PUT`。

## 8. 測試(Rule 9 — 驗證意圖)

- `agent-loader.test.js`:frontmatter 解析正確、`render()` 正確代入 `{{placeholder}}`、缺值代空、未知 agent 拋錯。
- Prompt 等價性:對每個改寫的 server agent,測試 `render(sampleVars)` 的輸出等於改寫前的預期 prompt(以快照或關鍵字段 assert),確保外部化未改變行為。
- `admin-routes` 新增測試:list/get/put;PUT 對非白名單 name → 404/400;PUT 對非法 model → 400;PUT 後檔案內容正確且 loader 取得新值。
- `callClaude` / `spawnClaude`:`opts.model` 存在時 spawn 參數含 `--model`,不存在時不含(維持相容)。
- Labels endpoint:回傳完整 stage→label 對照。

## 9. 相容性與風險

1. **subagent frontmatter 未知欄位**:需實測 Claude Code Agent tool 是否容忍 `role/label/stage`;不容忍則改用獨立 registry 檔存這些欄位。
2. **模型 opus→sonnet**:分析/實作品質可能下降;為使用者明確選擇,可事後於介面調回(上限 sonnet)。
3. **library 5 段併 1**:5 個呼叫點行為需保持等價;輸出仍為 `{slug,title,content}`。
4. **server 寫入 `.claude/agents/`**:檔案受 git 追蹤,介面存檔會產生未提交變更(localhost 工具可接受)。
5. **CLI `--model` 別名**:假設 `claude --model sonnet|haiku` 有效;實作時先驗證。

## 10. 影響檔案清單

新增:
- `app/server/pipeline/agent-loader.js`
- `.claude/agents/{triage,analysis-basic,analysis-project,coding-project,cs,merge,deploy-fix,library,chat}.md`(9 新)
- `app/public/js/views/AdminAgents.js`
- 測試檔:`agent-loader.test.js`、`admin-agents-routes.test.js`

修改:
- `.claude/agents/{requirements-analyst,senior-software-engineer,qa-analyst}.md`(補欄位、改 model)
- `app/server/pipeline/claude-runner.js`、`task-agent.js`(帶 `--model`)
- `app/server/pipeline/{triage,analysis,cs-agent,chat-agent,merge-agent,deploy-fixer,library-agent}.js`(prompt 外部化)
- `app/server/admin-routes.js`(agent CRUD 讀取/寫入)
- 新增 `GET /api/agents/labels`(位置:admin-routes 或 index.js)
- `app/public/js/app.js`(路由)、`app/public/index.html`(script)、`app/public/js/views/Admin.js`(入口)、`TokenReport.js`(label 顯示)
