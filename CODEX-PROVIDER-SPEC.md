# CODEX-PROVIDER-SPEC — pipeline agent 可選 AI 供應商

> 狀態：**規格草案，尚未實作**。本文件只描述「要做什麼、為什麼、怎麼驗」，不含程式碼變更。
> 目標分支：`claude/codex-workflow-integration-jeer01`
>
> **2026-08-24 實測校正**（分支 `claude/codex-env-repair`）：以 **codex-cli 0.149.1** 在平台主機實跑，校正 §3.1／§3.2，改寫 §5.5（scan-guard 從「無對等物」改為「可移植，已實測擋得住」），新增 §5.8～§5.10，更新 §6.3／§6.5／§9／§10。
> **標示「實測」的結論有實跑依據；未標示的仍是推斷，不要當成已驗證。**

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

以 **codex-cli 0.149.1**（2026-08-24 於平台主機 Windows 11 實跑）為準。原草案寫「本容器未安裝 codex、下表未經驗證」，該前提已解除：§3.1／§3.2 標註「實測」的列都跑過，未標註的仍是推斷。

### 3.1 旗標對照

| 用途 | claude | codex |
|---|---|---|
| 非互動單次執行 | `-p` | `codex exec` |
| prompt 走 stdin | 直接寫 stdin | 需帶 `-` 佔位參數 |
| 結構化事件流 | `--output-format stream-json --verbose` | `--json`（JSONL） |
| 指定模型 | `--model <alias>` | `-m` / `--model` |
| 指定推理強度 | 無此維度 | `-c model_reasoning_effort="high"`（**實測**為正確鍵名；`model_reasoning_level` 是未知欄位）。⚠ 設定載入階段**不校驗值**，`="bogus"` 照樣放行 |
| 工作目錄 | spawn 的 `cwd` | spawn 的 `cwd`（或 `-C` / `--cd`） |
| 略過權限提示 | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox`（別名 `--yolo`） |
| 限制寫入範圍 | 無對等（靠 hook） | `--sandbox read-only` / `workspace-write` / `danger-full-access` |
| 續接 session | `--resume <id>` | `codex exec resume <SESSION_ID>` |
| MCP 設定 | `--strict-mcp-config --mcp-config <json>` | config.toml 的 `[mcp_servers.*]`（`-c` 可覆寫） |
| Hook | `--settings`（PreToolUse 等） | **有對等物**：`~/.codex/hooks.json`，專案層 `.codex/hooks.json` 亦會被讀。payload 與決策 schema 與 Claude Code 相同——**實測**，見 §5.5 |
| 最終回覆強制結構 | 無 | `--output-schema <FILE>`（JSON Schema）。**本期不採用**，見 §5.8 |
| 最後訊息落檔 | 無 | `-o` / `--output-last-message <FILE>` |
| 不繼承使用者層設定 | `--strict-mcp-config` | `--ignore-user-config`（auth 仍走 CODEX_HOME） |
| 每關不同的設定組 | 每關一份 mcp-config JSON | `-p` / `--profile <name>` 疊 `$CODEX_HOME/<name>.config.toml` |

### 3.2 事件流差異

claude 的 `stream-json` 與 codex 的 `--json` 是兩套完全不同的 schema，`formatEvent()`、sessionId 擷取、`assistantText` 累積、usage 擷取全部要各寫一份。

| 語意 | claude | codex |
|---|---|---|
| session 起始 | `{type:'system',subtype:'init',session_id}` | `{type:'thread.started', thread_id}` |
| 助理文字 | `{type:'assistant',message:{content:[{type:'text',text}]}}` | `{type:'item.completed',item:{type:'agent_message',text}}` |
| 工具呼叫顯示 | `content[].type='tool_use'` | **實測**：`command_execution`（帶 `status`＝`in_progress`／`completed`、`aggregated_output`）、`error`（設定／hook 類錯誤）。`file_change` 等尚未觀測到 |
| 事件序 | — | **實測**：`thread.started` → `item.completed`(error，若有) → `turn.started` → `item.started`／`item.completed`(重複) → `turn.completed`。`turn.started`／`item.started` 是原草案沒列的 |
| 失敗收尾 | `{type:'result',subtype:'error...'}` | **實測**：`turn.failed`，帶 `error.message`、**無 `usage`**（見 §9 第 5 題） |
| 收尾與用量 | `{type:'result',usage,duration_ms}` | `{type:'turn.completed',usage:{input_tokens,cached_input_tokens,output_tokens}}` |
| 實際 model id | 第一則 assistant 事件的 `message.model` | **實測：事件流中不存在此欄位** → 一律用 `opts.model` 記帳 |

usage 欄位對應（寫進 `token_usage` 時）：

| token_usage 欄 | claude | codex |
|---|---|---|
| `input_tokens` | `usage.input_tokens` | `usage.input_tokens` |
| `output_tokens` | `usage.output_tokens` | `usage.output_tokens` |
| `cache_read_tokens` | `usage.cache_read_input_tokens` | `usage.cached_input_tokens` |
| `cache_create_tokens` | `usage.cache_creation_input_tokens` | `usage.cache_write_input_tokens`（**實測欄位存在**，原草案寫「無對等欄位」是錯的；四次實跑觀測值皆為 0，尚未見到非零） |

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
effort: medium        # 新增；僅 provider=codex 時有意義，省略時 = medium
stage: reject_classify
---
```

`effort` 是 codex 專屬維度（claude 沒有），**provider 為 claude 時此欄應不存在**；`updateAgent()` 切到 claude 時要主動移除該欄，留著會讓人以為它有作用。

**採「平行欄位」而非 `model: codex:gpt-5.6-terra` 前綴形式**，理由：`updateAgent()` 既有的白名單校驗、`listAgents()` 的回傳形狀、`promptVersion()` 的 hash 組成都不必改解析邏輯；前綴形式則要在每個讀 model 的地方加剝離。

### 4.2 白名單改二維

`agent-loader.js:26` 的 `ALLOWED_MODELS` 陣列改為：

```js
// codex 的 models 由 `codex debug models` 動態取得後快取，不硬寫——模型會換代（§9 第 1 題）。
// 取用規則：過濾 visibility === 'list'、依 priority 排序、每支帶自己的 efforts。
const PROVIDERS = {
  claude: {
    label: 'Claude Code', bin: 'claude',
    models: [{ id: 'haiku' }, { id: 'sonnet' }, { id: 'opus' }, { id: 'fable' }],
    // claude 沒有 effort 維度
  },
  codex: {
    label: 'OpenAI Codex', bin: 'codex',
    // 2026-08-24 實測快照，正式實作應動態取：
    models: [
      { id: 'gpt-5.6-sol',   efforts: ['low','medium','high','xhigh','max','ultra'] },
      { id: 'gpt-5.6-terra', efforts: ['low','medium','high','xhigh','max','ultra'] },
      { id: 'gpt-5.6-luna',  efforts: ['low','medium','high','xhigh','max'] },
      { id: 'gpt-5.5',       efforts: ['low','medium','high','xhigh'] },
      { id: 'gpt-5.4',       efforts: ['low','medium','high','xhigh'] },
      { id: 'gpt-5.4-mini',  efforts: ['low','medium','high','xhigh'] },
    ],
  },
};
```

⚠ **`codex-auto-review` 是 `visibility: hide`（`codex review` 專用），不得進清單。** 動態取得時務必過濾，否則使用者選得到一支不該用的模型。

- `ALLOWED_MODELS` 保留為 `PROVIDERS.claude.models` 的別名並標為 deprecated，避免既有 require 斷掉（`agent-loader.js` 的 exports 有對外）。
- `updateAgent()` 的校驗改為三段：**provider 必須存在 ∧ model 必須在該 provider 的清單內 ∧（provider 為 codex 時）effort 必須在該 model 的 `efforts` 內**。effort 的可選值**逐模型不同**（`gpt-5.4` 系列沒有 `max`／`ultra`），不可用一份全域清單校驗——那會放行 `gpt-5.4` + `ultra` 這種必定 spawn 失敗的組合。
- 校驗失敗一律 400 且訊息要指出是 provider、model 還是 effort 錯（現行訊息只講 model）。
- **fallback 指向最嚴格選項**（pipeline 規則 59）：`PROVIDERS[p] || ` 不得退到任意 provider，未知 provider 直接 throw，不得靜默退回 claude——靜默退回會讓拼錯字的 agent 帳面上顯示 codex、實際燒 claude 額度。

### 4.3 新增端點供前端取清單

`GET /api/admin/providers` → `{ claude: {label, models:[{id}]}, codex: {label, models:[{id, efforts:[...]}]} }`

**`efforts` 必須逐模型附在該模型上**，前端第三段下拉才能依所選模型動態換選項。回傳扁平的全域 effort 清單會讓 UI 給出後端會擋掉的組合。

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
- **認證失效偵測**：`auth-signature.js` 的 `looksLikeAuthFailure()` 目前只認 Claude 的字面（如 `Not logged in`）。補 codex 的字面（§9 第 5 題已取得）：比對 `401 Unauthorized` 與 `Missing bearer or basic authentication`。不補的話 codex 憑證過期會被歸成泛用 `exited with code N`，分類器判不出 transient → 直接停等人工。
- **收尾事件有兩種**：`turn.completed`（帶 `usage`）與 `turn.failed`（帶 `error.message`、**無 `usage`**）。記帳路徑必須容許沒有 usage 的情形，否則認證失敗那輪會拋錯或被記成 0。
- **stderr 必須一起收**：工具執行失敗只出現在 stderr，不進事件流（§5.9）。不收的話工具全掛的那一輪在平台上看起來是成功的。
- **逾時要涵蓋 codex 自己的重試**：認證失敗時 codex 會 `Reconnecting... N/5` 重試五次（先 `wss://` 後退 `https://`），實測約 12 秒才放棄。
- **推理強度**：`opts.effort` 存在時附 `-c model_reasoning_effort="<effort>"`。值的合法性由 `updateAgent()` 把關（§4.2）——codex 端不擋，傳錯不會在設定階段報錯。
- **sandbox**：原訂「`opts.cwd` 存在時用 `--sandbox workspace-write`，否則 `--sandbox read-only`」。⚠ **`--sandbox read-only` 在平台主機（Windows）實測連工具都 spawn 不起來**（§9 第 6 題，疑似 Defender 未加排除項）。在該題解決前只能用 `--dangerously-bypass-approvals-and-sandbox`，防線改由 scan-guard hook 承擔（§5.5）。
- **hook**：無人值守需 `--dangerously-bypass-hook-trust`，否則專案層 `.codex/hooks.json` 不會執行。

### 5.2 `pipeline/agent-runner.js`（新增）

```js
runAgent(prompt, opts)   // opts 多 provider（預設 'claude'）與 effort（僅 codex 用）
```
依 provider 分派到 `runClaude` / `runCodex`，並 re-export `abortError`、`stopReason`（現由 claude-runner 提供，與供應商無關）。

19 個呼叫端逐一改為 `require('./agent-runner').runAgent`，並在既有的 `model: agent.model` 旁補 `provider: agent.provider` 與 `effort: agent.effort`。`claude-runner.js` 本身除了移出 `abortError`／`stopReason` 外不動。

**例外：`agent-result.js:66` 的 `repair` 呼叫**不走 agent-loader，model 硬寫 `'haiku'`（`<result>` 解析失敗時的補救呼叫）。本期**維持硬寫 claude/haiku**，不隨被修補的那關切換供應商——它只做「把散文修回契約格式」的文字整形，與原關的推理無關，跟著切換只是多一個變數。在該行補一行註解說明此為刻意決定，避免日後被當成漏改。

### 5.3 認證：`lib/codex-auth.js`（新增）

完全比照 `lib/claude-auth.js`：

- `loadCodexToken()` 啟動時從 `teams_settings.openai_api_key_enc` 解密進模組變數（`index.js` 呼叫）
- `getCodexAuthEnv()` **必須是同步的** — `claude-auth.js:9-11` 已寫明理由：runClaude 若改 async 再 await 查 DB，spawn 會晚一個 microtask，而既有測試多是「呼叫後同步對 mock child 發事件」，會整片失效。
- 無設定時回 `{}`，不得回 `{ OPENAI_API_KEY: '' }`（會蓋掉手動設的環境變數）
- `resetCodexTokenCache()` 供管理員存檔後呼叫
- `shadowingEnvVar()` 對等物：若環境已有 `OPENAI_API_KEY`，回傳變數名供介面警告
- **本模組不得把 token 寫進任何 log**

端點比照 `admin-routes.js:45/53/81` 新增 `GET/POST/DELETE /api/admin/codex-token`，GET 一律**只回布林 `configured`**，不回明文也不回密文（`teams-routes.js:13-14` 已為此明列欄位而非 `SELECT *`，新欄位必須一併排除）。

### 5.4 session / resume 的兩個硬約束（**必修，否則會靜默壞掉**）

session id 不跨供應商通用。以下兩件事都會產生「不報錯、但每輪白燒一次失敗呼叫」的症狀。

#### 約束一：切換 provider 必須讓指紋失效

`with-resume.js:28` 的指紋 `combinedVersion()` 只 hash prompt 內容，**不含 provider 與 model**。後果：一支 agent 從 claude 改成 codex 後，`promptVer` 不變 → 護欄判定「可以續接」→ 拿 claude 的 session id 去 `codex exec resume` → 必定失敗。

失敗後 `with-resume.js:39-46` 會清 session 並同輪降級 fresh，所以**不會讓使用者拿不到回覆**，但每次切換都白燒一次失敗呼叫、並在報表留下一筆假的失敗。

修法（擇一，建議前者）：
1. `promptVersion(name)` 的 hash 材料加入 `provider` 與 `model`。改一處，`with-resume` 與 `qa-agent`／`chat-agent` 等所有用指紋的地方同時生效。
2. `updateAgent()` 偵測 provider 有變時，主動清掉所有帶該 agent session 的欄位。要動的欄位散在 `tasks.qa_session_id`、`merge_conflict_data` JSONB 等多處，遺漏風險高。

#### 約束二：resume 配對的兩支必須同 provider

比約束一更硬——約束一是「切換的那一瞬間」會白燒一次，約束二是**只要配對兩端 provider 不同就永遠壞著**。

| fresh（產 session） | resume（用 session） | session 存放處 | 呼叫點 |
|---|---|---|---|
| `qa` | `qa-retry` | `tasks.qa_session_id` | `qa-agent.js:109` |
| `chat` | `chat-retry` | JSONB | `chat-agent.js:66` |
| `spec-review` | `spec-review-retry` | JSONB | `spec-review.js:66` |
| `clarify-chat` | `clarify-chat-retry` | JSONB | `clarify-chat.js:131` |
| **`analysis-project`** | **`playwright-spec`** | 直接傳遞（跨關卡） | `task-agent.js:383` |

前四對是同名 retry，UI 上相鄰、整對一起改的機率高。**最後一條是跨關卡的**：`playwright-spec` resume 的是 analysis 的 session，名字上完全看不出來，是本表最容易被漏掉的一條。

`writeSpecTour`（`task-agent.js:367`）整段刻意是 best-effort（註解：tour 是加值產物，任何失敗都不該讓已產出的規格或關卡推進跟著壞掉），所以配對破損時**失敗會被靜默吞掉**——症狀只有「tour 沒產出」，log 裡沒有任何指向 provider 的線索。

**修法**：`updateAgent()` 增加配對校驗，兩端 provider 不一致直接 400，訊息點名是哪一對。校驗表與上表同一份常數，不得各自維護。

不採「自動連動改另一端」：一次改兩支 agent 的設定而使用者只點了一支，屬於未經同意的隱式變更，且在 UI 上看不出來。擋下並要求使用者明確改兩次，比較誠實。

### 5.5 scan-guard：**可移植**（原草案寫「無對等物」是錯的）

2026-08-24 於平台主機（Windows 11、codex-cli 0.149.1）實測結論：

- **專案層 `.codex/hooks.json` 會被讀**（codex 的錯誤訊息直接點名該檔的絕對路徑）→ 不必動使用者層設定，也不必污染開發機。
- 格式與 Claude Code 的 hooks 相同：`{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"..."}]}]}}`
- **PreToolUse 的 payload 與 Claude Code 逐欄相同**：`session_id`／`turn_id`／`transcript_path`／`cwd`／`hook_event_name`／`model`／`permission_mode`／`tool_name`／`tool_input`／`tool_use_id`。codex 的 shell 工具對 hook **就叫 `Bash`**，指令在 `tool_input.command`。
  → `hooks/scan-guard.js` 的判斷邏輯（攔 workspace 外的 `find` 與遞迴廣掃）**可原樣沿用**，不需重寫。
- **拒絕的表達方式只有一種有效**：

| 方式 | 實測結果 |
|---|---|
| `exit 2` ＋ stderr（Claude Code 的舊慣例） | ❌ **不擋**，指令照常執行 |
| stdout 輸出 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` | ✅ **擋下**：事件流完全沒有 `command_execution` 項目，agent 收到「指令被安全機制阻擋」 |

移植時必須確認 `scan-guard.js` 目前用哪一種；若是 exit 2，要改成輸出 JSON decision（兩種都輸出最保險，claude 端不受影響）。

- ⚠ **hook 自己壞掉是 fail-open 且靜默**。實測放一支語法錯誤的 hook：codex 直接放行執行指令，事件流沒有任何訊息、exit code 仍是 0。因此 scan-guard 移植後**不能假設「hook 檔存在＝守衛生效」**，要有可觀測的證明（例如 hook 每次執行都留一筆記錄，或在 codex-runner 啟動時先跑一次自我測試）。
- 無人值守下需要 `--dangerously-bypass-hook-trust`，否則未經人工信任的 hook 不會執行。

**本期處置**：`CODEX_ELIGIBLE` 白名單照做（批次一那幾支本來就不碰檔案系統）。但**批次三（qa）的閘門改變了**——原本綁在「sandbox 能不能擋 workspace 外的讀取」（§9 第 6 題，目前測不到），現在改綁「scan-guard 移植後能不能擋住 `find /`」，而後者已實測可行。qa 不必再等 sandbox 那題。

### 5.6 用量閘門不隨 provider 分流（**明確的範圍外，但要知道**）

`runner.js:480-492` 的用量閘門在**派工層**：擋的是整張任務要不要被自動推進，判斷依據是全平台共用的 Claude 帳號用量（`usage-gate.js`）。

因此 Claude 額度滿時，**即使某關已改用 codex，整張任務仍然被擋**。「把部分關卡分流到 codex 以繞開 Claude 用量上限」這個效果，本期改動達不到。

要達成的話需要另一份設計：閘門下沉到 agent 層、或在派工前判斷「這張任務接下來要跑的關是不是 codex」。**本期不做**，此處僅記錄，避免驗收時誤以為是 bug。

### 5.7 命名：`claudeStatus` 不改名

err 上的 `claudeStatus` 欄位被 `token-logger.js:41`、`failure-classifier.js`、`qa-agent.js:114`、`with-resume.js:42` 等多處讀取，語意是「執行狀態」而非「Claude 的狀態」。本期**刻意不改名**——改名要動的消費端散佈太廣，收益只有可讀性。在 `agent-runner.js` 加一行註解說明即可。

---

### 5.8 `--output-schema`：**本期不採用**（已評估）

codex 有 `--output-schema <FILE>`，可強制最終回覆符合 JSON Schema——比現行的 `<result>` 文字標籤更硬，模型不可能「忘了包標籤」而導致整輪報廢。

**仍決定兩邊統一用 `<result>`**，理由：

- `parseAgentResult` 維持一份程式吃兩家，切換 provider 時行為一致、回滾容易。
- 採用的代價是每支 agent 要另備一份 schema 檔（目前契約只寫在 prompt 裡），且 `agent-runner` 要維護兩條解析路徑。
- 本期目標是「可選供應商」，不是「改造輸出契約」。

留作未來選項：若實測顯示 codex 端漏標籤的比率明顯高於 claude，再回頭採用。**採用與否要有數據，不要憑感覺**。

### 5.9 codex 的失敗有一半不進事件流（**必修**）

實測第一次跑：`--sandbox read-only` 下兩次 `exec_command` 全部失敗（`CreateProcessAsUserW: 5`），但——

```
exit code = 0
--json 事件流 = thread.started / turn.started / item.completed(agent_message) / turn.completed
agent 的回答 = "DONE 0"     （目錄裡實際有 2 個檔）
```

**工具全掛、答案是錯的、事件流乾乾淨淨、退出碼 0。** 錯誤只出現在 stderr。

進一步實測後可以分清界線：

| 錯誤種類 | 去處 |
|---|---|
| 設定／hook 類錯誤（如 hooks.json 解析失敗、hook trust 警告） | **會**進事件流，`item.completed` 的 `type: "error"` |
| **工具執行失敗**（spawn 失敗、權限拒絕） | **只在 stderr** |

平台的 `task_events` 與終端串流只吃事件流，因此這類失敗在平台上是**零訊號**——比 claude 端的任何已知失敗模式都難察覺。

**修法**：`codex-runner.js` 必須同時收 stderr，將其中的 `ERROR` 行併入事件流輸出（比照 claude 端的錯誤呈現）。這也是批次一驗收條件第 4 項（「終端串流看得到內容」）能不能算數的前提——不做的話，工具全掛的那一輪在驗收時看起來是綠的。

### 5.10 prompt 裡的 `Skill(...)` 硬呼叫（**批次一就會踩到**）

6 支 agent 的 prompt 直接寫了 Claude Code 的工具呼叫語法：

| 檔案 | 內容 |
|---|---|
| `health-auditor.md:13,21` | `Skill(healthCheck)`、`Skill(platformDB)` |
| `health-task.md:13,15` | `Skill(healthCheck)` |
| `health-triage.md:16,18` | `Skill(healthCheck)` |
| `workflow-health.md:13,15` | `Skill(healthCheck)` ← **在批次一** |
| `platform-fix.md:13` | `Skill(platformDev)` |
| `source-routing.md:16`（共用注入片段） | `Skill(odooDev)` |

其中 `health-task`／`health-triage`／`workflow-health` 三支明文寫著：

> **載不到 skill 就停下來**：在 `<diagnosis>` 寫明「無法載入判準」、`severity` 給 `ok`

codex 沒有 `Skill()` 這個工具呼叫語法，這三支會**照 prompt 的指示放棄診斷並回報 `ok`**——不報錯、不重試，指標上只看得出「健檢變安靜了」。

**但實測顯示問題比想像小**：codex **會自動載入** `.agents/skills/` 底下的 skill（含專案層），與 Claude Code 的自動探索行為等價。壞的只是「`Skill(x)` 這個呼叫語法」的措辭。

**修法（本期採用）**：改 prompt 措辭，不動程式。把 `呼叫 Skill(healthCheck)` 改成 provider 無關的講法，例如「依 healthCheck 判準……該判準在 `.agents/skills/healthCheck/SKILL.md`（Claude Code 為 `.claude/skills/`），載不到就停下來」。6 支各改一兩句。

不採「在 `agent-loader` 加 provider-aware 注入」：實測兩家的 skill 探索行為其實一致，為了一句措辭多加一層機制不划算。若未來出現真正因 provider 而異的內容，再開該機制。

> ⚠ 改 `.claude/skills/` 之後要跑 `node scripts/sync-skills.js` 同步到 `.agents/skills/`，否則 codex 讀到舊版且**沒有任何徵狀**。

---

## 6. 分批導入（24 支全數歸位）

### 6.1 決策依據

主要動機是**分開監督**，不是加速：QA／驗證類關卡若與 coding 同源，模型的盲點會系統性重複——同一家模型看不出自己會犯的錯。因此「審查方」換供應商有實質價值，而規格與實作這條主線維持單一供應商以避免風格分裂。

「codex 比較快」是**未經驗證的假設**，不得當作分批依據。`.claude/rules/infra.md` 規則 159 是實測結論：單關 2~9 分鐘來自工具迴圈與 1.5~1.8 萬 output tokens，不是冷啟動；換 CLI 不會自動變快。驗證方法見 §6.6。

### 6.2 留在 claude（不動）

| agent | 理由 |
|---|---|
| `analysis-project` | 規格主線，產出直接決定下游全部關卡 |
| `analysis-reject` | 吃 CLAUDE.md full 注入、讀 worktree 判修法，與分析同質 |
| `coding-project` | 實作主線 |
| `respec-patch` | 增量改 analysis.yaml，產出直接餵 coding，屬規格層 |
| `merge` / `merge-explain` / `merge-clarify` | 同一條職責鏈，判斷風格不一致會讓使用者困惑；且 `merge` 逐 hunk 寫檔、持鎖 |
| `playwright` / `playwright-spec` | 見 §6.6：`playwright-spec` 綁 analysis session，`playwright` 在規格 tour 模式下不再被呼叫 |

### 6.3 批次一（本期實作目標）

純文字進、`<result>` 出，無 cwd 寫檔、無 MCP、無 resume、無 hook 需求：

> ⚠ **前置**：`workflow-health` 帶 `Skill(healthCheck)` 硬呼叫且寫著「載不到就停下來、severity 給 ok」（§5.10）。**該支 prompt 措辭沒改完之前不得切 codex**，否則它會安靜地回報「一切正常」。
>
> ⚠ **`--sandbox read-only` 在平台主機（Windows 11）跑不起來**：工具全部 spawn 失敗（`CreateProcessAsUserW: 5`），詳見 §9 第 6 題。本批目前只能用 `--dangerously-bypass-approvals-and-sandbox`。這幾支不碰檔案系統，實際風險不變，但「用 read-only 當防線」這個說法不成立。

| agent | stage |
|---|---|
| `reject-classifier` | `reject_classify` |
| `deploy-fix` | `deploy_fix` |
| `wiki-drift-classifier` | — |
| `chat-to-task` | — |
| `workflow-health` | `workflow_health` |
| `library` | `wiki`（寫 wiki 頁，不碰客戶程式碼） |

驗收條件（每支都要過）：
1. 管理頁切 provider 存檔後，`.md` frontmatter 正確寫入
2. 實跑一次，`<result>` 契約能被 `parseAgentResult` 解析
3. `token_usage` 落一筆且 `provider='codex'`、token 數非零
4. 終端串流（`task_events`）看得到內容，不是空白也不是整包 JSON
5. 手動暫停能中止（`signal` 生效）、逾時能被砍
6. 切回 claude 後行為與改動前一致

### 6.4 批次二

要 context7 MCP、但不寫客戶檔。**四對 resume 配對必須整對一起改**（§5.4 約束二）：

`spec-review` ± `spec-review-retry`、`clarify-chat` ± `clarify-chat-retry`、`chat` ± `chat-retry`、`cs`

前置：`MCP_PROFILES`（`claude-runner.js:16`）要有 codex 的 toml 對等物，且 `context7ConfigPath()` 那套「優先本地依賴、退回 npx」的策略要重做一份（codex 走 `[mcp_servers.*]`，不吃 JSON）。

`cs` 與 `chat` 額外注意：這兩支直接對客戶與使用者講話，換供應商會改變語氣與判斷風格。技術風險低，但排在本批最後，且上線後人工看過數輪輸出再定案。

### 6.5 批次三

`qa` ± `qa-retry`。

前置**已改變**（原本綁 sandbox，見下）：

原草案把 qa 的閘門綁在「codex sandbox 是否限制 workspace 外的讀取」。§5.5 實測後這條路不必走了——**codex 有 hook，且 PreToolUse 的 payload 與 Claude Code 逐欄相同，`scan-guard.js` 可原樣沿用**，拒絕改用 JSON `permissionDecision` 形式即可（實測擋得下來）。

因此 qa 的前置改為：
1. `scan-guard.js` 移植到 codex 的 hook 形式，並實測擋得住 `find /`。
2. 解決 §5.5 的 fail-open 問題——hook 壞掉時 codex 靜默放行，必須有「守衛確實生效」的可觀測證明。

sandbox 那題（§9 第 6 題）降級為**加分項**：能用的話多一層 OS 級防線，但不再是 qa 的閘門。

qa 是本案「分開監督」價值最高的一支（審的正是 claude 寫的 code），值得為它優先解這一題。

### 6.6 E2E tour 兩支：整條留 claude，不納入任何批次

E2E 不退場。方向是改走**規格 tour 模式**（`projects.spec_tour_enabled = true`，目前預設 false）：tour 由分析關依 acceptance 先定稿，`playwright_running` 關不重產、只負責併入 testing 與執行。

該模式平台已完整實作，不需要新開發：

| 段落 | `spec_tour_enabled=false`（現況） | `=true`（目標） |
|---|---|---|
| 產 tour | `playwright` agent 產（`playwright-agent.js:127`） | **整段跳過**（`:121`），改由分析關的 `playwright-spec` 產 |
| 併入 testing → `odoo-bin --test-enable` | 執行 | 執行（不受開關影響） |

兩支的 provider 歸屬：

- `playwright-spec` — 綁 `analysis-project` 的 session（§5.4 約束二），**必須與 analysis 同 provider**，即 claude。
- `playwright` — 開啟規格 tour 模式後**不會再被呼叫**，provider 設定形同無效。維持 claude，不做適配。

因此 E2E 這條線整條不進 codex，tour 層沒有「分開監督」。這是可接受的取捨：**「先出考題」本身就是防止測試遷就實作的機制，比換供應商更直接**——`playwright-agent.js:116` 的註解已寫明重產 tour 會讓先定稿的意義整個消失。

#### 已知缺陷（開啟開關前應評估，本案範圍外）

`writeSpecTour`（`task-agent.js:367`）整段刻意 best-effort，失敗靜默吞掉。分析關沒寫成 tour 時的連鎖：

1. playwright 關見 `specTourMode=true` → 跳過產 tour
2. `--test-tags` 匹配 0 個測試
3. `playwright-agent.js:219` 的防假綠燈攔下 → `bounceToCoding`，訊息寫「tour 測試檔未產出」

防護本身是對的（不會變成假綠燈直達人工審核），但**歸因錯誤**：真因在分析關，卻退回 coding，且消耗一次 `reentry_count`（上限 2，跌兩次即停等人工）。

修法方向（本案不做）：`writeSpecTour` 失敗時至少落一筆 `task_logs`；或 playwright 關在 `specTourMode` 為真但 worktree 內查無 tour 檔時，改成停等人工並指向分析關，而非退 coding。

### 6.7 「codex 比較快」的驗證方法

加了 `token_usage.provider` 之後，同一個 `agent_type` 按 provider 分組比 `duration_ms` 的**中位數**（不是平均——失敗重跑會把平均拉歪）。批次一上線滿兩週、每支累積 20 次以上呼叫再看，樣本不足時不下結論。

這是決定要不要把 codex 推進批次二／三的**數據依據**，不是體感。若中位數沒有明顯改善，本案的價值就只剩「分開監督」——那也足以支撐批次三的 qa，但批次二的必要性要重新評估。

---

## 7. UI 規格（`AdminAgents.js`）

現況：右側編輯區一個「模型」下拉（`:110`），選項來自硬寫的 `models` 陣列（`:10`）。左側清單每筆右側有一個 model 藥丸（`:93`）。

改為：

1. **三段連動下拉**：「AI」（provider）→「模型」→「推理強度」（effort），同一列。
   - 切換 provider 時 model 自動重設為該 provider 的第一個模型（不可留下跨供應商的無效組合）。
   - **切換 model 時 effort 要重新驗一次**：可選值逐模型不同，從 `gpt-5.6-terra`(max) 切到 `gpt-5.4` 時 `max` 不存在，必須自動退到該模型有的值（建議 `medium`），不能留著一個後端會擋掉的組合。
   - **provider 為 claude 時，第三段整個隱藏**（不是 disabled）——claude 沒有這個維度，留一個永遠灰掉的下拉只會讓人以為是壞的。
2. 選項來源改為 `GET /api/admin/providers`，移除 `AdminAgents.js:10` 的硬寫清單。
3. 左側清單的藥丸改顯示 `provider/model:effort`（如 `codex/gpt-5.6-terra:high`）；provider 為 claude 時維持只顯示 model，避免既有畫面全部變長。
4. 不在 `CODEX_ELIGIBLE` 名單內的 agent，provider 下拉的 codex 選項 `disabled`，並在下拉旁以 `var(--text-muted)` 註明原因（掃碟守衛缺口）。**前端 disabled 只是提示，後端仍須擋**（前端隱藏 admin 功能要三處齊做的同一個道理）。
5. `dirty` 判定（`:22`）要一併比對 provider **與 effort**，否則只改其中之一時「儲存」鈕不會亮。

配色硬規則：不得寫死顏色，一律走 `app.css` 的 CSS 變數／共用 class；新增樣式前先從 `app/public/styleguide.html` 挑 token。**前端無自動化測試，這頁改完必須人工實測，含深色模式。**

---

## 8. 測試計畫

依既有慣例（`app/server/tests/`，jest + pg-mem + supertest），全跑一律 `cd app && npm run test:quiet`。

| 檔案 | 覆蓋 |
|---|---|
| `tests/codex-runner.test.js`（新增） | mock `child_process.spawn`，餵 codex JSONL 事件驗證：thread_id → sessionId、agent_message → assistantText、turn.completed → usage 對應正確、`cached_input_tokens` 落 `cache_read_tokens`、**`cache_write_input_tokens` 落 `cache_create_tokens`**（不是記 0）；**`turn.failed` 沒有 usage 時不拋錯、不記成 0**；**stderr 的 ERROR 行併入事件流**（§5.9）；非零 exit 分流（auth／error）、`code===null` 判 interrupted、timeout 觸發 kill、abort 前置檢查早退 |
| `tests/agent-runner.test.js`（新增） | provider 分派正確；未知 provider throw 而非靜默退回 claude；預設值為 claude |
| `tests/agent-loader.test.js`（既有，擴充） | provider 白名單校驗、未知 provider／跨供應商組合回 400、`CODEX_ELIGIBLE` 之外拒絕 codex、frontmatter 寫入與讀回、`promptVersion` 含 provider/model **但不含 effort**（§9 已決那段的迴歸測試） |
| 同上（effort 專項） | **`gpt-5.4` + `max` 必須被擋**——effort 可選值逐模型不同，用全域清單校驗會放行這種必定 spawn 失敗的組合。切 provider 到 claude 時 `effort` 欄要被移除。 |
| `tests/admin-routes.test.js`（既有，擴充） | `GET /api/admin/providers`；codex-token 三個端點；GET 不外洩明文 |
| `tests/token-logger.test.js`（既有，擴充） | provider 欄落地 |

**紅燈判定**：**動手前先跑一次全跑，把 `Tests:` 與 `Test Suites:` 記下來當基線**，之後的紅燈一律先假設是自己造成的。懷疑是 flaky（pgPass flake 家族）才 stash 掉自己的改動、對那一支單獨再跑——**單跑綠了才算 flaky**。

> ⚠ 本節原本寫死了一份「既有紅燈」清單（`git-integration.test.js` 兩支、`vpn-gateway-run.test.js` 一支）。那份清單是在真因修好**之前**量的，2026-08-08 實測三支都是綠的。`.claude/rules/always.md` 規則 2 明文禁止在文件裡寫死既有紅燈清單與通過數字——會教人把自己弄壞的東西當既有問題放過去。已移除，不要再加回來。

**端到端要在平台主機驗**：平台主機已安裝 codex（實測 0.149.1）。§6 的驗收條件在該機執行；開發容器若沒有 codex 則只能跑到 mock 層。

---

## 9. 未決事項（2026-08-24 實測後更新）

實測環境：平台主機 Windows 11、**codex-cli 0.149.1**、認證為 ChatGPT OAuth（`~/.codex/auth.json`，`stored API key: false`）。

### 已解答（第 1～5 題）

| # | 題目 | 答案 |
|---|---|---|
| 1 | codex model 識別字 | **已取得**（`codex debug models`，2026-08-24）。7 支，其中 6 支 `visibility: list`（可選）、1 支 `hide`。全部 `context_window` 272000、`supported_in_api: true`。依 `priority` 排序：<br>`gpt-5.6-sol`(1)、`gpt-5.6-terra`(2，目前預設)、`gpt-5.6-luna`(3)、`gpt-5.5`(7)、`gpt-5.4`(16)、`gpt-5.4-mini`(23)；`codex-auto-review`(43) 是 `codex review` 專用，**`visibility: hide`，不得放進使用者可選清單**。<br>取值方式寫進實作：`PROVIDERS.codex.models` 應由 `codex debug models` 取、過濾 `visibility === 'list'`、依 `priority` 排序，**不要在程式裡硬寫這份清單**（模型會換代）。 |
| 2 | `codex exec` 參數順序 | `codex exec - --json [其他旗標]`。prompt 走 stdin 時 `-` 是必要的佔位參數，旗標放後面。 |
| 3 | `--json` 的 item type 清單 | 已觀測：`agent_message`、`command_execution`（帶 `status`／`aggregated_output`）、`error`。完整事件序見 §3.2。寫檔類（`file_change`）尚未觀測到——批次一不寫檔，暫不阻塞，批次二之前要補。 |
| 4 | 事件是否回報 resolved model id | **否**，事件流沒有這個欄位 → 成本歸屬一律用 `opts.model`。 |
| 5 | codex 認證失敗的原始字面 | **已取得**（測法：把 `CODEX_HOME` 指到一個空目錄跑一次，**不必動到真的 `auth.json`**）。字面：<br>`unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses`<br>`auth-signature.js` 建議比對 `401 Unauthorized` 與 `Missing bearer or basic authentication`。<br>**行為與 claude 不同的三點**：<br>① 認證失敗**會**進事件流（`{"type":"error"}`），不像工具失敗只在 stderr；<br>② codex 會自己重試 **5 次**（`Reconnecting... N/5`，先 `wss://` 後退回 `https://`）才放棄——一次認證失敗會空燒約 12 秒與 11 則 error 事件，逾時設定要涵蓋；<br>③ 收尾事件是 **`turn.failed`**（帶 `error.message`），**不是** `turn.completed`——`turn.failed` **沒有 `usage` 欄位**，token 記帳必須容許這種情形，否則會拋錯或記成 0。exit code 為 1。 |

### 未解答（第 6、7 題）

| # | 題目 | 現況與測法 |
|---|---|---|
| 6 | sandbox 是否限制 workspace 外的讀取 | **測不到**：`--sandbox read-only` 在本機連工具都 spawn 不起來（`CreateProcessAsUserW: 5 存取被拒`）。但 `codex doctor` 顯示 `sandbox provisioning complete`，同時警告 **Microsoft Defender 未加 Codex 排除項**——所以這很可能是 Defender/ASR 擋的，不是 codex 在 Windows 上沒有 sandbox。**先加排除項再測，不得據現況下結論。** 已由 §6.5 降級為加分項（qa 的閘門改走 scan-guard 移植）。 |
| 7 | `--sandbox` 與 `--dangerously-bypass-approvals-and-sandbox` 是否互斥 | 未直接測；bypass 單獨可用。§6.3 既已改用 bypass，本題優先度下降。 |

### 新增待決：codex 的 reasoning effort 維度（**規格沒設想到**）

`codex debug models` 顯示每支模型另有一組 `supported_reasoning_levels`，而且**各模型不同**：

| 模型 | 可選 effort |
|---|---|
| `gpt-5.6-sol` / `gpt-5.6-terra` | low / medium / high / xhigh / max / **ultra** |
| `gpt-5.6-luna` | low / medium / high / xhigh / max |
| `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` | low / medium / high / xhigh |

使用者層 `~/.codex/config.toml` 目前是 `model_reasoning_effort = "medium"`。

claude 端沒有這個維度（`haiku`／`sonnet`／`opus`／`fable` 就是全部），所以 §4.2 的「白名單改二維」與 §7 的「供應商 → 模型」兩段連動**對 codex 是不夠的**——同一支模型配 `low` 與配 `max`，成本與品質差距可能比換模型還大。

**已決（2026-08-24）：UI 加第三段下拉**，供應商 → 模型 → 推理強度，依所選模型動態給可選值。§4.1／§4.2／§4.3／§7 已依此更新。

未採「展平成 `gpt-5.6-terra:high`」：白名單會膨脹成 6×4~6 項，且 frontmatter 的 `model` 值變得不像模型名、模型換代時舊值全部失效。
未採「本期不做」：effort 的成本與品質影響可能大過換模型，而且設定會落在使用者家目錄、不進版控也不 per-agent。

⚠ **`promptVersion()` 的 hash 材料要加 provider 與 model（§5.4 約束一），但*不要*加 effort**：effort 不改變 prompt 內容、也不會讓 session id 失效，加進去只會在調 effort 時無謂地作廢所有 resume session、白掉 prompt cache。

### 實測新增（原草案沒有的題目）

| 題目 | 答案 |
|---|---|
| 專案層 `.codex/config.toml` 會不會生效 | **會**，疊在使用者層之上（同一台機器：repo 內 4 個 MCP server、repo 外 2 個，差額正好是 repo config 的兩支）。 |
| 專案層 `.agents/skills/` 會不會被載入 | **會**（放一支缺 YAML frontmatter 的探針，codex 直接報出該檔的絕對路徑）。這是 §5.10 改用「改措辭」而非「加注入機制」的依據。 |
| 專案層 `.codex/hooks.json` 會不會生效 | **會**，見 §5.5。 |
| codex 有沒有 hook 機制 | **有**，payload 與決策 schema 與 Claude Code 相同，見 §5.5。原草案的「無對等物」是錯的。 |

---

## 10. 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 成本記帳失真 | codex 花費被當 sonnet 計，健檢成本訊號錯誤且**不報錯** | §4.4 的 `token_usage.provider` 必做，`health-data.js` 的 RATE 同步改 |
| session 交叉污染 | 切換 provider 的那一輪白燒一次失敗呼叫 | §5.4 約束一，改法 1 |
| **resume 配對破損** | 配對兩端 provider 不同 → **永遠**每輪白燒一次；`playwright-spec` 那條還會被 best-effort 靜默吞掉，只剩「tour 沒產出」的症狀 | §5.4 約束二的 `updateAgent()` 硬校驗，**不可只靠文件提醒** |
| 認證失敗誤歸類 | codex 憑證過期 → 判不出 transient → 任務停等人工 | §9 第 5 題 + `auth-signature.js` 補 pattern |
| 靜默退回 claude | 拼錯 provider 的 agent 帳面顯示 codex、實際燒 claude 額度 | §4.2 未知 provider 直接 throw |
| 掃碟守衛缺口 | codex 端 agent 全碟掃描 → 逾時 | §5.5 `CODEX_ELIGIBLE` 白名單，第三梯在缺口有解前不開放 |
| 用量閘門仍以 Claude 為準 | 誤以為改 codex 就能繞開額度上限 | §5.6 已記錄為範圍外 |
| **工具失敗不進事件流** | codex 工具全部 spawn 失敗時：exit 0、事件流乾淨、agent 給出錯誤答案。平台上**零訊號**，且會讓批次一驗收條件第 4 項變成假綠 | §5.9 必修：codex-runner 收 stderr 併入事件流 |
| **`Skill(...)` 硬呼叫** | `workflow-health`（批次一）等三支寫著「載不到 skill 就回報 severity=ok」，切 codex 後會安靜地回報「一切正常」 | §5.10：6 支 agent 改 prompt 措辭；改完記得跑 `node scripts/sync-skills.js` |
| **hook fail-open** | scan-guard 移植後，hook 腳本自己壞掉會讓 codex 靜默放行、事件流無訊息 | §5.5：需要「守衛確實生效」的可觀測證明，不能只看 hook 檔在不在 |
| model 清單用猜的 | `PROVIDERS.codex.models` 填錯 → 使用者在管理頁選到不存在的模型，spawn 才失敗 | §9 第 1 題：先跑 `codex debug models` |
