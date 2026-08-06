# CODEX-PROVIDER-SPEC — pipeline agent 可選 AI 供應商

> 狀態：**規格草案，尚未實作**。本文件只描述「要做什麼、為什麼、怎麼驗」，不含程式碼變更。
> 目標分支：`claude/codex-workflow-integration-jeer01`

---

## 1. 目標

讓 `.claude/agents/*.md` 定義的每一支 pipeline agent，能各自選擇**由哪個 AI CLI 執行**（Claude Code 或 OpenAI Codex），以及該供應商底下的**哪個模型**。管理頁的 agent 編輯畫面由現在的單一「模型」下拉，改為「AI 供應商 → 模型」兩段連動。

不在本期範圍：
- 把整條 pipeline 搬離 Claude。預設值一律維持現狀（`claude`），未明確指定 provider 的 agent 行為零變化。
- 讓 codex 取代 Claude 的用量閘門（見 §5.6）。
- 第三方供應商（Gemini／本地模型）。資料模型雖為多供應商設計，但本期只實作兩家。

---

## 2. 現況盤點

### 2.1 只有一個出口

24 支 agent 全部經由 `app/server/pipeline/claude-runner.js:105` 的 `runClaude()` spawn `claude` CLI。呼叫端共 19 處，散在 `task-agent.js`、`qa-agent.js`、`merge-agent.js`、`library-agent.js`、`cs-agent.js`、`chat-agent.js`、`with-resume.js`、`failure-classifier.js`、`classify-rejections.js`、`respec-agent.js`、`reject-triage.js`、`chat-to-task.js`、`wiki-drift.js`、`health-check-runner.js`、`agent-result.js`、`clarify-chat.js`、`admin-routes.js`。

**這是本案成立的前提**：分派點只有一個，不需要逐關改寫。

現行 spawn 參數（`claude-runner.js:114-125`）：

```
claude -p --output-format stream-json --verbose --dangerously-skip-permissions
       [--model <alias>]
       --strict-mcp-config --mcp-config <path>
       --settings <scan-guard settings>
       [--resume <sessionId>]
```
prompt 走 stdin，cwd 由 `opts.cwd` 指定，認證與 `/ai/*` 通行碼由 `getClaudeAuthEnv()` ＋ `aiTokenEnv()` 注入 env。

### 2.2 model 的來源與可改處

| 位置 | 內容 |
|---|---|
| `.claude/agents/<name>.md` frontmatter | `model: sonnet` 等，實際值 |
| `agent-loader.js:26` | `ALLOWED_MODELS = ['haiku','sonnet','opus','fable']` 白名單 |
| `agent-loader.js:251` | 未指定時 fallback `'sonnet'` |
| `agent-loader.js:308` `updateAgent()` | 寫回 .md，校驗白名單 |
| `admin-routes.js:398` `PUT /api/admin/agents/:name` | 管理頁存檔端點 |
| `AdminAgents.js:10` | 前端硬寫的同一份清單（**與後端白名單重複，沒有單一來源**） |

「選模型」現在已經可用；缺的只有「選 AI」。

---

## 3. codex CLI 介面對照

以 2026-08 的 `codex exec` 為準。**本容器未安裝 codex（`which codex` 為空），下表未經實跑驗證；實作第一步必須在平台主機跑一次 `codex exec --json` 並以實際輸出校正 §3.2。**

### 3.1 旗標對照

| 用途 | claude | codex |
|---|---|---|
| 非互動單次執行 | `-p` | `codex exec` |
| prompt 走 stdin | 直接寫 stdin | 需帶 `-` 佔位參數 |
| 結構化事件流 | `--output-format stream-json --verbose` | `--json`（JSONL） |
| 指定模型 | `--model <alias>` | `-m` / `--model` |
| 工作目錄 | spawn 的 `cwd` | spawn 的 `cwd`（或 `-C` / `--cd`） |
| 略過權限提示 | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox`（別名 `--yolo`） |
| 限制寫入範圍 | 無對等（靠 hook） | `--sandbox read-only` / `workspace-write` / `danger-full-access` |
| 續接 session | `--resume <id>` | `codex exec resume <SESSION_ID>` |
| MCP 設定 | `--strict-mcp-config --mcp-config <json>` | config.toml 的 `[mcp_servers.*]`（`-c` 可覆寫） |
| Hook | `--settings`（PreToolUse 等） | **無對等物** |

### 3.2 事件流差異

claude 的 `stream-json` 與 codex 的 `--json` 是兩套完全不同的 schema，`formatEvent()`、sessionId 擷取、`assistantText` 累積、usage 擷取全部要各寫一份。

| 語意 | claude | codex |
|---|---|---|
| session 起始 | `{type:'system',subtype:'init',session_id}` | `{type:'thread.started', thread_id}` |
| 助理文字 | `{type:'assistant',message:{content:[{type:'text',text}]}}` | `{type:'item.completed',item:{type:'agent_message',text}}` |
| 工具呼叫顯示 | `content[].type='tool_use'` | `item.completed` 的其他 item type（command_execution／file_change 等，**清單待實跑確認**） |
| 收尾與用量 | `{type:'result',usage,duration_ms}` | `{type:'turn.completed',usage:{input_tokens,cached_input_tokens,output_tokens}}` |
| 實際 model id | 第一則 assistant 事件的 `message.model` | **待確認**；查不到時退回 opts 的 model |

usage 欄位對應（寫進 `token_usage` 時）：

| token_usage 欄 | claude | codex |
|---|---|---|
| `input_tokens` | `usage.input_tokens` | `usage.input_tokens` |
| `output_tokens` | `usage.output_tokens` | `usage.output_tokens` |
| `cache_read_tokens` | `usage.cache_read_input_tokens` | `usage.cached_input_tokens` |
| `cache_create_tokens` | `usage.cache_creation_input_tokens` | **無對等欄位 → 記 0** |

---

## 4. 資料模型變更

### 4.1 agent frontmatter

新增 `provider` 欄，與 `model` 平行：

```yaml
---
name: reject-classifier
role: classifier
label: 退回分類
model: haiku
provider: claude      # 新增；省略時 = claude
stage: reject_classify
---
```

**採「平行欄位」而非 `model: codex:gpt-5-codex` 前綴形式**，理由：`updateAgent()` 既有的白名單校驗、`listAgents()` 的回傳形狀、`promptVersion()` 的 hash 組成都不必改解析邏輯；前綴形式則要在每個讀 model 的地方加剝離。

### 4.2 白名單改二維

`agent-loader.js:26` 的 `ALLOWED_MODELS` 陣列改為：

```js
const PROVIDERS = {
  claude: { label: 'Claude Code', bin: 'claude', models: ['haiku', 'sonnet', 'opus', 'fable'] },
  codex:  { label: 'OpenAI Codex', bin: 'codex',  models: [ /* 實跑 codex 後填 */ ] },
};
```

- `ALLOWED_MODELS` 保留為 `PROVIDERS.claude.models` 的別名並標為 deprecated，避免既有 require 斷掉（`agent-loader.js` 的 exports 有對外）。
- `updateAgent()` 的校驗改為「provider 必須存在 ∧ model 必須在該 provider 的清單內」。
- 校驗失敗一律 400 且訊息要指出是 provider 錯還是 model 錯（現行訊息只講 model）。
- **fallback 指向最嚴格選項**（pipeline 規則 59）：`PROVIDERS[p] || ` 不得退到任意 provider，未知 provider 直接 throw，不得靜默退回 claude——靜默退回會讓拼錯字的 agent 帳面上顯示 codex、實際燒 claude 額度。

### 4.3 新增端點供前端取清單

`GET /api/admin/providers` → `{ claude: {label, models}, codex: {label, models} }`

消除 `AdminAgents.js:10` 硬寫清單與後端白名單的雙來源。前端 `models` 陣列改由此端點取得。

### 4.4 DB schema

`app/server/db.js` 的欄位補丁清單（`db.js:518` 的同一份陣列）新增：

| 表 | 欄 | 型別 | 用途 |
|---|---|---|---|
| `token_usage` | `provider` | `TEXT`（NULL＝claude，向後相容） | 成本歸屬、報表分流 |
| `teams_settings` | `openai_api_key_enc` | `TEXT` | codex 認證憑證密文 |

`token_usage.provider` 為何必要：`health-data.js:17-21` 的單價 CASE 是拿 model 名字串 LIKE 比對（`%haiku%`／`%opus%`／`%fable%`，其餘一律 3.0 當 sonnet）。codex 的 model 名會全數落到 `ELSE 3.0`，帳面上把 codex 的花費當 sonnet 計——健檢的成本訊號會失真而且**不會報錯**。加了 provider 欄後，RATE 改為先分 provider 再分 model。

---

## 5. 程式改動清單

### 5.1 `pipeline/codex-runner.js`（新增）

export `runCodex(prompt, opts)`，**回傳形狀必須與 `runClaude` 完全一致**：
`{ text, assistantText, usage, durationMs, sessionId, model }`，失敗時 err 掛 `claudeStatus`／`durationMs`（欄名沿用，見 §5.7）。

必須照抄 `claude-runner.js` 已經踩過坑的行為，不得簡化：

| 行為 | 出處 | 為什麼不能省 |
|---|---|---|
| `signal.aborted` 前置檢查 | `claude-runner.js:110` | 已 abort 的 signal 不會再觸發 listener，不檢查會照跑燒 token |
| `child.stdin.on('error')` 吞 EPIPE | `:133` | 子行程早死時無 handler 會變 uncaughtException 拖垮 server |
| `killChildGracefully` + `KILL_GRACE_MS` | `:136` | SIGTERM 不理時升級 SIGKILL，避免殭屍佔資源 |
| timeout → kill → reject | `:172` | 無 timeout 會讓任務永久卡 `*_running`、merge 鎖不釋放 |
| 事件批次寫 `task_events` | `:158-184` | 每行一筆 INSERT 的高頻寫入 |
| `finish()` 先 flush 再 settle | `:168` | 尾段事件要排在下一關 marker 之前 |
| 累積 `assistantText`（非只末輪 result） | `:139-141` | agent 把 `<result>` 當中間步驟吐出後還繼續講話，末輪會沒有契約標籤 |
| `prompt_logs` 落地 + 只留 100 筆 | `:224-229` | 管理員稽核 |
| `code === null` 判 `interrupted` 而非 `error` | `:256` | 外部終止（OOM／重開）不算執行失敗，用量報表要排除 |
| ENOENT 依 cwd 是否存在分流歸因 | `:273-277` | 否則「worktree 未建立」會誤報成「找不到執行檔」 |

codex 專屬：
- 認證失效偵測：`auth-signature.js` 的 `looksLikeAuthFailure()` 目前只認 Claude 的字面（如 `Not logged in`）。**必須補 codex 的認證失敗字面**，否則 codex 認證過期會被歸成泛用 `exited with code N`，分類器判不出 transient → 直接停等人工。實際字面待實跑取得。
- sandbox：`opts.cwd` 存在時用 `--sandbox workspace-write`，否則 `--sandbox read-only`（見 §5.5）。

### 5.2 `pipeline/agent-runner.js`（新增）

```js
runAgent(prompt, opts)   // opts 多一個 provider，預設 'claude'
```
依 provider 分派到 `runClaude` / `runCodex`，並 re-export `abortError`、`stopReason`（現由 claude-runner 提供，與供應商無關）。

19 個呼叫端逐一改為 `require('./agent-runner').runAgent`，並在既有的 `model: agent.model` 旁補 `provider: agent.provider`。`claude-runner.js` 本身除了移出 `abortError`／`stopReason` 外不動。

### 5.3 認證：`lib/codex-auth.js`（新增）

完全比照 `lib/claude-auth.js`：

- `loadCodexToken()` 啟動時從 `teams_settings.openai_api_key_enc` 解密進模組變數（`index.js` 呼叫）
- `getCodexAuthEnv()` **必須是同步的** — `claude-auth.js:9-11` 已寫明理由：runClaude 若改 async 再 await 查 DB，spawn 會晚一個 microtask，而既有測試多是「呼叫後同步對 mock child 發事件」，會整片失效。
- 無設定時回 `{}`，不得回 `{ OPENAI_API_KEY: '' }`（會蓋掉手動設的環境變數）
- `resetCodexTokenCache()` 供管理員存檔後呼叫
- `shadowingEnvVar()` 對等物：若環境已有 `OPENAI_API_KEY`，回傳變數名供介面警告
- **本模組不得把 token 寫進任何 log**

端點比照 `admin-routes.js:45/53/81` 新增 `GET/POST/DELETE /api/admin/codex-token`，GET 一律**只回布林 `configured`**，不回明文也不回密文（`teams-routes.js:13-14` 已為此明列欄位而非 `SELECT *`，新欄位必須一併排除）。

### 5.4 session / resume 的交叉污染（**必修，否則會靜默壞掉**）

`with-resume.js:28` 的指紋 `combinedVersion()` 只 hash prompt 內容，**不含 provider 與 model**。後果：一支 agent 從 claude 改成 codex 後，`promptVer` 不變 → 護欄判定「可以續接」→ 拿 claude 的 session id 去 `codex exec resume` → 必定失敗。

失敗後 `with-resume.js:39-46` 會清 session 並同輪降級 fresh，所以**不會讓使用者拿不到回覆**，但每次切換都會白燒一次失敗呼叫、並在報表留下一筆假的失敗。

修法（擇一，建議前者）：
1. `promptVersion(name)` 的 hash 材料加入 `provider` 與 `model`。改一處，`with-resume` 與 `qa-agent`／`chat-agent` 等所有用指紋的地方同時生效。
2. `updateAgent()` 偵測 provider 有變時，主動清掉所有帶該 agent session 的欄位。要動的欄位散在 `tasks.qa_session_id`、`merge_conflict_data` JSONB 等多處，遺漏風險高。

受影響的 session 欄位（改法 1 不需逐一處理，此處僅供驗收時檢查）：`qa-retry`、`chat-retry`、`clarify-chat-retry`、`spec-review-retry`。

### 5.5 scan-guard 缺口

`claude-runner.js:44-59` 掛的 PreToolUse hook（`hooks/scan-guard.js`）攔的是「從磁碟根／worktree 外」的 `find` 與遞迴廣掃——註解寫明這是實際踩過的坑（滾成全碟掃描 → 逾時），而且 agent prompt 裡就向 agent 保證「會被平台掃碟守衛中止」。

**codex 沒有 hook 機制，這道守衛在 codex 端無法等價實作。**

本期處置：
- 第一梯 agent（§6）全部不碰檔案系統，用 `--sandbox read-only` 即可，缺口不構成實際風險。
- 第三梯（coding／qa／analysis／playwright／merge）**在缺口有解之前不得開放 codex**。`PROVIDERS` 之外另立一份 `CODEX_ELIGIBLE` 白名單，`updateAgent()` 對不在名單內的 agent 拒絕 `provider: codex`（400，訊息點明原因）。
- 待評估的替代方案（本期不做）：`--sandbox workspace-write` 只擋寫不擋讀，擋不住 `find /`；可行方向是包一層 wrapper script 限制 PATH 上的 `find`，或依賴 codex 自身的 sandbox 對讀取路徑的限制——**需先實測 codex sandbox 是否限制 workspace 外的讀取**。

### 5.6 用量閘門不隨 provider 分流（**明確的範圍外，但要知道**）

`runner.js:480-492` 的用量閘門在**派工層**：擋的是整張任務要不要被自動推進，判斷依據是全平台共用的 Claude 帳號用量（`usage-gate.js`）。

因此 Claude 額度滿時，**即使某關已改用 codex，整張任務仍然被擋**。「把部分關卡分流到 codex 以繞開 Claude 用量上限」這個效果，本期改動達不到。

要達成的話需要另一份設計：閘門下沉到 agent 層、或在派工前判斷「這張任務接下來要跑的關是不是 codex」。**本期不做**，此處僅記錄，避免驗收時誤以為是 bug。

### 5.7 命名：`claudeStatus` 不改名

err 上的 `claudeStatus` 欄位被 `token-logger.js:41`、`failure-classifier.js`、`qa-agent.js:114`、`with-resume.js:42` 等多處讀取，語意是「執行狀態」而非「Claude 的狀態」。本期**刻意不改名**——改名要動的消費端散佈太廣，收益只有可讀性。在 `agent-runner.js` 加一行註解說明即可。

---

## 6. 分梯導入

依「碰不碰檔案系統／要不要 MCP／要不要 resume」分梯。每梯驗收通過才開下一梯。

### 第一梯（本期實作目標）

純文字進、`<result>` 出，無 cwd 寫檔、無 MCP、無 resume、無 hook 需求：

| agent | stage | 現行 model |
|---|---|---|
| `reject-classifier` | `reject_classify` | haiku |
| `deploy-fix` | `deploy_fix` | — |
| `wiki-drift-classifier` | — | — |
| `chat-to-task` | — | — |
| `workflow-health` | `workflow_health` | — |

驗收條件（每支都要過）：
1. 在管理頁把 provider 切成 codex、存檔後 `.md` frontmatter 正確寫入
2. 實跑一次任務，`<result>` 契約能被 `parseAgentResult` 解析
3. `token_usage` 落一筆且 `provider='codex'`、token 數非零
4. 終端串流（`task_events`）看得到內容，不是空白或整包 JSON
5. 手動暫停能中止（`signal` 生效）、逾時能被砍
6. 切回 claude 後行為與改動前一致

### 第二梯（不在本期）

要 context7 MCP、但不寫客戶檔：`chat`、`cs`、`spec-review`。
前置：`MCP_PROFILES`（`claude-runner.js:16`）要有 codex 的 toml 對等物，且 `context7ConfigPath()` 那套「優先本地依賴、退回 npx」的策略要重做一份。

### 第三梯（不在本期，且有前置阻擋）

寫客戶 worktree、要 resume、要 scan-guard：`coding-project`、`qa`、`analysis-project`、`playwright`、`merge`。
前置：§5.5 的掃碟守衛缺口必須先有解。

---

## 7. UI 規格（`AdminAgents.js`）

現況：右側編輯區一個「模型」下拉（`:110`），選項來自硬寫的 `models` 陣列（`:10`）。左側清單每筆右側有一個 model 藥丸（`:93`）。

改為：

1. **兩段連動下拉**：「AI」（provider）在左、「模型」在右，同一列。切換 provider 時 model 自動重設為該 provider 的第一個模型（不可留下跨供應商的無效組合）。
2. 選項來源改為 `GET /api/admin/providers`，移除 `AdminAgents.js:10` 的硬寫清單。
3. 左側清單的藥丸改顯示 `provider/model`（如 `codex/gpt-5-codex`）；provider 為 claude 時維持只顯示 model，避免既有畫面全部變長。
4. 不在 `CODEX_ELIGIBLE` 名單內的 agent，provider 下拉的 codex 選項 `disabled`，並在下拉旁以 `var(--text-muted)` 註明原因（掃碟守衛缺口）。**前端 disabled 只是提示，後端仍須擋**（前端隱藏 admin 功能要三處齊做的同一個道理）。
5. `dirty` 判定（`:22`）要一併比對 provider，否則只改 provider 不改 model 時「儲存」鈕不會亮。

配色硬規則：不得寫死顏色，一律走 `app.css` 的 CSS 變數／共用 class；新增樣式前先從 `app/public/styleguide.html` 挑 token。**前端無自動化測試，這頁改完必須人工實測，含深色模式。**

---

## 8. 測試計畫

依既有慣例（`app/server/tests/`，jest + pg-mem + supertest），全跑一律 `cd app && npm run test:quiet`。

| 檔案 | 覆蓋 |
|---|---|
| `tests/codex-runner.test.js`（新增） | mock `child_process.spawn`，餵 codex JSONL 事件驗證：thread_id → sessionId、agent_message → assistantText、turn.completed → usage 對應正確、cached_input_tokens 落 cache_read_tokens、cache_create 為 0；非零 exit 分流（auth／error）、`code===null` 判 interrupted、timeout 觸發 kill、abort 前置檢查早退 |
| `tests/agent-runner.test.js`（新增） | provider 分派正確；未知 provider throw 而非靜默退回 claude；預設值為 claude |
| `tests/agent-loader.test.js`（既有，擴充） | provider 白名單二維校驗、未知 provider／跨供應商組合回 400、`CODEX_ELIGIBLE` 之外拒絕 codex、frontmatter 寫入與讀回、`promptVersion` 含 provider/model（§5.4 改法 1 的迴歸測試） |
| `tests/admin-routes.test.js`（既有，擴充） | `GET /api/admin/providers`；codex-token 三個端點；GET 不外洩明文 |
| `tests/token-logger.test.js`（既有，擴充） | provider 欄落地 |

**紅燈判定**：`git-integration.test.js` 的 `ensureWorktreeAtMain` 兩支與 `vpn-gateway-run.test.js` 的容器化那支是既有紅燈，乾淨 HEAD 也紅，不要 debug。其餘紅燈先假設是 pgPass flake 家族，一律單跑複驗才算數。

**端到端無法在開發容器驗證**：本容器未安裝 codex CLI。§6 的驗收條件必須在平台主機執行。

---

## 9. 未決事項

實作前必須拿到答案，**不得靠猜**：

1. **codex 的 model 識別字**（`PROVIDERS.codex.models` 要填什麼）— 平台主機跑 `codex --help` / 查帳號可用模型後填入。
2. **`codex exec` 的參數順序**：`codex exec - --json` 還是 `codex exec --json -`。
3. **`--json` 完整的 item type 清單**（供 `formatEvent` 的 codex 版顯示工具呼叫）。
4. **codex 事件是否回報 resolved model id**（決定成本歸屬用 opts.model 還是實際值）。
5. **codex 認證失敗的原始字面**（決定 `auth-signature.js` 要加什麼 pattern）— 這題不解，codex 認證過期會被誤歸成一般失敗、停等人工。
6. **codex sandbox 是否限制 workspace 外的「讀取」**（決定 §5.5 的缺口有沒有便宜解）。
7. **`--sandbox` 與 `--dangerously-bypass-approvals-and-sandbox` 是否互斥**（後者會強制 `danger-full-access`，若互斥則第一梯的 read-only 要改用別的方式略過核可）。

第 1～4 題靠一次 `codex exec --json` 實跑即可全部取得；第 5 題需刻意用錯誤憑證跑一次。

---

## 10. 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 成本記帳失真 | codex 花費被當 sonnet 計，健檢成本訊號錯誤且**不報錯** | §4.4 的 `token_usage.provider` 必做，`health-data.js` 的 RATE 同步改 |
| session 交叉污染 | 切換 provider 後每輪白燒一次失敗呼叫 | §5.4 改法 1 |
| 認證失敗誤歸類 | codex 憑證過期 → 判不出 transient → 任務停等人工 | §9 第 5 題 + `auth-signature.js` 補 pattern |
| 靜默退回 claude | 拼錯 provider 的 agent 帳面顯示 codex、實際燒 claude 額度 | §4.2 未知 provider 直接 throw |
| 掃碟守衛缺口 | codex 端 agent 全碟掃描 → 逾時 | §5.5 `CODEX_ELIGIBLE` 白名單，第三梯在缺口有解前不開放 |
| 用量閘門仍以 Claude 為準 | 誤以為改 codex 就能繞開額度上限 | §5.6 已記錄為範圍外 |
