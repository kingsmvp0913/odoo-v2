# AI 執行隔離設計（平台產品化 子專案 0）

日期：2026-09-11
狀態：設計已裁決且主要容器路徑已上線；舊無容器路徑尚未移除，實際進度以「開發順序」§0 為準
所屬：平台產品化（SaaS 多租戶）拆法 v2 的第 0 塊。後續：1 租戶隔離／2 客戶自帶 API key／3 客戶按到底／4 上線營運

---

## 1. 目標與非目標

### 目標

任何一次 AI 執行就算被提示詞注入（客戶需求、附件、退回原因裡藏指令），也**拿不到**：

- 平台總鑰匙：`APP_SECRET`、`JWT_SECRET`、`DATABASE_URL`
- 其他專案的程式碼與資料
- 客戶正式機、DB、SSH、VPN 憑證
- 平台自己的資料庫（內部 AI 只給唯讀、且遮蔽敏感欄位）

**能連的地方只有三個**：Anthropic、Context7、平台的 `/ai` 查詢入口。

客戶觸發的 AI 與內部 AI（健檢、夜間改善）都納入，權限分兩級。

不影響使用者感受的回應時間：實測每次多 0.23–0.26 秒，對問答中位數 40.6 秒約 0.6%（§2.12）。

### 非目標

- **不做**公司、角色、租戶資料隔離（子專案 1）。本期的隔離單位是「專案」。
- **不做**客戶自帶 API key（子專案 2）。本期容器內仍用平台現有的 Claude 認證，只是改走白名單注入。
- **不改**git 合併、部署、SSH 這些平台本體動作——它們本來就在平台 node 裡跑，不經過 AI。
- **不做**平台更版機制（子專案 4）。夜間改善自動合併進 master 的問題留給它。
- **不做**公司啟用開關／訂閱期間的判斷，只留檢查點 `canRun(scope)`（§4.4）。
- **不把 Codex 容器化**：客戶只用 Claude，Codex 只留內部（使用者裁決 2026-09-11）。本期只對 Codex 路徑做環境變數白名單（§4.6）。

---

## 2. 現況事實（2026-09-11 實查）

### 2.1 AI 怎麼跑

`app/server/pipeline/claude-runner.js:159` 以 `--dangerously-skip-permissions` spawn `claude`，cwd＝任務 worktree。
無沙箱、無容器，與平台同一個系統使用者（uid 1004）。

### 2.2 總鑰匙直接在 AI 的環境變數裡

- `start.sh:30-41` 把 `JWT_SECRET`、`APP_SECRET`、`DATABASE_URL`（有設時連 `ANTHROPIC_API_KEY`）export 進 node。
- `claude-runner.js:197` 以 `{ ...process.env, … }` 整包傳給 AI。

⇒ **任何一次 AI 執行 `echo $APP_SECRET` 即得總鑰匙。** 另外 `data/config.json`（權限 664）同 uid 可讀。

### 2.3 `/ai` 通行碼全平台一組

- `lib/ai-token.js` 的 `aiToken()` 是固定標籤的 HMAC，沒有參數。
- `/ai/db/query` 的專案 id 是從連線反查的，不綁呼叫者。
- 閘門＝來源必須是 loopback（`ai-token.js:70`）＋通行碼。

### 2.4 網路

- 平台容器 `NetworkMode=host`。8771 監聽 `*`；8772 監聽 `127.0.0.1` 與 `10.0.0.1`。
- 從一般 bridge 容器（`--add-host host.docker.internal:host-gateway`）實測**連得到** 8771、22、8772、21000；5416 refused。

⇒ 光把 AI 放進容器不夠，網路必須另外封。

### 2.5 可用的隔離手段

| 手段 | 結果 |
|---|---|
| 不同系統使用者 | 不行：容器內 `sudo: command not found` |
| Claude Code 內建沙箱（bwrap） | 不行：`bwrap: No permissions to create a new namespace`（09-08 chat 102/103）；Codex 同因（`sandbox-signature.js:4-8`） |
| tmux | 不是隔離：同 uid、同檔案、同網路 |
| **docker sibling 容器** | **可行**：`docker` 29.7.2 可用；`docker-env.js`、`odoo-core-src.js`、`vpn-gateway.js` 已在開 |

### 2.6 路徑（掛載用）

- 容器內外同路徑（同構）：`/home/odoo/odoo-v2`、`/home/odoo/odoo-envs`
- **不同構**：`/home/odoo/.claude` 是 volume `odoo-v2_claude-home` ⇒ 新的 AI 家目錄不能放這裡
- repo：`repos/<folder>/<label>`；worktree：`<專案根>/.worktrees/<task_id>/<subdir>`（`task-agent.js:75`）
- Odoo 原始碼：`data/odoo-core/{14,17,18,19}`；企業版：`enterprise/{17,19}`

### 2.7 AI 合法需要的東西

| 需求 | 來源 |
|---|---|
| 任務程式碼（讀寫） | worktree |
| commit | 主 clone 的 `.git`（worktree 的 objects／refs 寫在這） |
| 查 Odoo 原始碼（唯讀） | `data/odoo-core`、`enterprise` |
| skill 文件（唯讀） | `.agents/skills/*`（prompt 以路徑引用 healthCheck／platformDev／odooDev） |
| 查客戶 DB／log／wiki | getSQL、getLog、wikiQuery 三個 skill 走 `curl $AIDEV_AI_BASE/ai/...` |
| 呼叫模型 | `api.anthropic.com`；OAuth token 更新走 `platform.claude.com` |
| 查文件 | Context7：`context7.com`、`mcp.context7.com`（context7-mcp 以 undici `ProxyAgent` 支援 `HTTPS_PROXY`，`dist/lib/api.js:37-64`） |
| 接續對話 | `--resume` 的 session 檔 |

**兩個例外直接連平台 DB 的 skill**：`platformDB`（`DATABASE_URL`＋`query.js`，health-auditor 用）、`odooGlossary`（`query.js` 查術語表）。

### 2.8 claude 安裝

npm 全域 `@anthropic-ai/claude-code` **2.1.266**。程式本體含 `CLAUDE_CONFIG_DIR`、`DISABLE_AUTOUPDATER`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`HTTPS_PROXY` 字串。
官方文件確認支援 `HTTPS_PROXY`／`https_proxy`，不支援 SOCKS。

### 2.9 使用者層設定現在會套到每個 pipeline AI

HOME＝`/home/odoo` ⇒ 每次 `claude -p` 都載入：

- 啟用中外掛：superpowers、hookify、code-review、context7、security-guidance
- `~/.claude/CLAUDE.md`（graphify、RTK）
- PreToolUse hook：`rtk hook claude`

runner 帶 `SECURITY_GUIDANCE_DISABLE=1` 就是這些外掛確實在作用的證據。進容器後這些都不會有（§7）。

### 2.10 內部 AI 的二階注入

- 意見回饋 `POST /api/feedback` 只驗登入；要 admin 經 `PATCH /api/admin/feedback/:id` 核准才進夜間改善。
- **健檢提案**經 `nightly-fix.js:144`（`inAutoFixScope`）**自動入選，無人工閘**。
- `teams_settings.cli_push_user_id` 已設 ⇒ `adoptFix → applyFix` **自動合併進平台 master**。
- 健檢會讀任務資料，未來大部分是客戶文字。

### 2.11 停止、逾時、重啟、接續

- 停止／逾時：`killChildGracefully` 送 SIGTERM，5 秒後 SIGKILL（`lib/proc.js:71-73`）
- 重啟：`runner.js:574` 註解明寫重啟會砍掉在飛的 agent
- 接續：整條 pipeline **沒有**「`--resume` 找不到 session」的退路（grep 0 筆）

### 2.12 效能

| 量測 | 結果 |
|---|---|
| `docker run --rm node:22-slim`＋bridge 網路＋bind mount（5 次） | 226–259 ms |
| 同上，不接網路 | 125–164 ms |
| chat 回覆（近 30 天 322 次） | p50 40.6 s／p90 141.8 s |
| cs 回覆（170 次） | p50 76.0 s |

### 2.13 AI 呼叫點

程式碼中字面出現的 agentType 共 22 種：
`analysis`、`coding`、`qa`、`respec`、`merge`、`merge-explain`、`merge-clarify`、`wiki`、`spec_tour`、`reject_triage`、`reject_classify`、`deploy_fix`、`cs`、`chat-to-task`、`chat-title`、`repair`、`wiki_drift_classify`、`workflow_health`、`platform_fix`、`fix_verify`、`fix_review`、`feedback_merge`。

⚠ `token_usage` 裡有 `chat`，但不在上面的字面清單（是用變數帶的）⇒ **字面 grep 不完整**，實作計畫要另從 `token_usage.agent_type` 與 `runAgent` 呼叫端補齊。

---

## 3. 設計總覽

```
平台 node（host 網路，持有全部憑證；git 合併／部署／SSH 都在這裡做）
   │
   │ docker run -i --rm（每次 AI 執行開一個）
   ▼
AI 容器 ──── 網路 aidev-agent-net（--internal，本身出不去）
   │  HTTPS_PROXY 與 AIDEV_AI_BASE 都指向閘道
   ▼
出口閘道 aidev-gw（同時接 aidev-agent-net 與預設 bridge，不持有任何憑證）
   ├─ CONNECT 白名單 → api.anthropic.com / platform.claude.com / context7.com / mcp.context7.com
   └─ /ai/* 轉發 → unix socket data/run/ai.sock → 平台 node（平台代查，再回傳結果）
```

**為什麼 `/ai` 走 unix socket**：平台是 host 網路。閘道在 bridge 上，連回 8771 時來源 IP 是 bridge gateway（172.x），而 nginx 反代進來的請求也長這樣——**用 IP 分不出是閘道還是外面**。改走只有閘道容器掛得到的 socket 檔，這個問題就不存在。

---

## 4. 元件

### 4.1 AI 映像檔 `aidev-agent:<claude 版本>`

- 基底 `node:22-slim`（本機已有）
- 裝 `git`、`ripgrep`、`curl`、`ca-certificates`
- `npm i -g @anthropic-ai/claude-code@2.1.266`——**與平台同版**，升版兩邊一起升
- **不裝** rtk，**不含**任何使用者層外掛
- 以 `--user 1004:1004` 執行（與宿主檔案 owner 相同，避免 git dubious ownership 與寫入權限問題）

### 4.2 每次執行的容器參數

寫成純函式 `buildAgentRunArgs(run)`，放 `app/server/lib/agent-sandbox.js`。

**scope**：客戶觸發的 agent＝`project-<id>`；內部 agent＝`internal`。

#### 掛載（全部同構路徑）

路徑一律由既有變數推導（`APP_DIR`、`ODOO_ENV_BASE`、`CORE_SRC_ROOT`、`enterprise_sources.local_path`、`project_repos.local_path`），**不寫死** `/home/odoo/...`（CLAUDE.md §0）。本文件出現的絕對路徑只是 2026-09-11 這台機器的實查值。

| 來源 | 模式 | 給誰 |
|---|---|---|
| 本任務 worktree 父目錄 `<root>/.worktrees/<task_id>` | rw | project scope（有 worktree 的 agent） |
| 各 repo 主 clone 的 `.git` | rw | 同上 |
| ↳ 其中 `.git/config`、`.git/hooks` | **ro 覆蓋** | 同上（見下方⚠） |
| 該專案主 clone | ro | project scope（沒有 worktree 的 agent，如 chat／cs） |
| `data/odoo-core/<該專案版本>`、`enterprise/<該專案版本>` | ro | project scope |
| `.agents/skills` | ro | 全部 |
| `app/server/pipeline/hooks/scan-guard.*`、`app/server/pipeline/mcp/<profile>.json` | ro | 全部 |
| `data/agent-home/<scope>` → 容器內 `HOME` | rw | 全部（session 檔、claude 設定） |

⚠ **`.git/config` 與 `.git/hooks` 必須唯讀**：可寫的話，AI 能在 config 設 `core.fsmonitor`、filter driver，或在 hooks 放腳本；之後**平台在主機上**對同一個 repo 跑 git（merge、checkout）時就會執行它們——等於從容器逃到主機。
另外，平台 node 自己跑 git 時一律帶 `-c core.hooksPath=/dev/null`，雙保險。

#### 環境變數（白名單，其餘一律不給）

| 變數 | 值 |
|---|---|
| `HOME` | 容器內家目錄（掛 `data/agent-home/<scope>`） |
| Claude 認證 | 本期為 `getClaudeAuthEnv()` 的回傳；子專案 2 換成**發起者所屬公司**的 API key（09-14：專案可掛多家公司，不能用專案決定） |
| `AIDEV_AI_BASE` | `http://aidev-gw:8080` |
| `AIDEV_AI_TOKEN` | 本次執行的通行證（§4.4） |
| `HTTPS_PROXY`、`https_proxy` | `http://aidev-gw:3128` |
| `NO_PROXY` | `aidev-gw` |
| `CLAUDE_CODE_PROMPT_CACHE_TTL` | `5m`（沿用現值） |
| `SECURITY_GUIDANCE_DISABLE` | `1`（沿用現值） |
| `DISABLE_AUTOUPDATER` | `1` |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` |
| 呼叫端自帶的 `env`（如 E2E 密碼） | **必須先列入白名單**；沒列入的 key 直接丟例外，不默默丟掉 |

**絕不放**：`APP_SECRET`、`JWT_SECRET`、`DATABASE_URL`，以及 `process.env` 的任何其他內容。

#### 其他參數

- `--rm`、`-i`（prompt 走 stdin，沿用現行）
- `--network <實例 id>-agent-net`
- `--name <實例 id>-run-<runId>`、`--label aidev.run=1`、`--label aidev.instance=<實例 id>`、`--label aidev.scope=<scope>`
- **實例 id**：取自 `PLATFORM_CONTAINER`（正式＝`odoo-v2`）。內部網路、出口閘道、AI 容器的名字與 label 全部帶它——同一台主機上若另開 staging 平台，兩套才不會互相砍到對方的容器（開發順序見 `2026-09-11-productize-rollout-plan.md` §2.1）。下文的 `aidev-agent-net`、`aidev-gw`、`aidev-run-<runId>` 皆為正式實例的簡寫。
- `--cap-drop ALL`、`--security-opt no-new-privileges`
- `--read-only`＋`--tmpfs /tmp`
- `--memory`、`--cpus`、`--pids-limit`：**三個一定要設**。數值在試跑時量 coding agent 峰值後訂（§10）；在訂出來之前，建構函式缺值就丟例外，不給「不設上限」的預設

### 4.3 出口閘道 `aidev-gw`

- 常駐容器。沿用平台映像 `odoo-v2:latest` 的 node，唯讀掛入閘道程式 `app/server/agent-gateway/`，不引入新映像。
- 接兩個網路：`aidev-agent-net`（internal）與預設 bridge。
- **本身不持有任何憑證。**

| 埠 | 功能 | 規則 |
|---|---|---|
| 3128 | HTTPS CONNECT proxy | 只放行 `api.anthropic.com:443`、`platform.claude.com:443`、`context7.com:443`、`mcp.context7.com:443`；其他拒絕並記 log（目的地、來源容器） |
| 8080 | `/ai` 轉發 | 只轉 `/ai/` 開頭的路徑到掛入的 `data/run/ai.sock`；其他回 404 |

平台啟動時確認閘道與網路存在，不存在就建。

### 4.4 平台端 `/ai` 改動

- node 另開一個 unix socket listener `data/run/ai.sock`（權限 600、owner 1004），**只掛 `/ai/*` 路由**。只有閘道容器掛得到這個檔。
- 從 socket 進來的請求**只認「每次執行通行證」**，不認舊的全域通行碼。
- **通行證**：`HMAC(派生金鑰, runId|scope|projectId|exp)`。派生金鑰比照 `lib/ai-token.js` 的做法，由 `APP_SECRET` 加一個新的固定標籤（例：`aidev:agent-run:v1`）做 HMAC 得出——不直接拿 `APP_SECRET` 簽，通行證外洩也賠不到它。平台在記憶體保存「執行中清單」（runId → scope），**執行結束立刻作廢**，不只看到期時間。
- **範圍檢查**
  - `project-<id>`：`/ai/db/connections`、`/ai/db/query`、`/ai/db/log`、`/ai/wiki/*`、`/ai/tasks/*` 一律限定該專案。拿別專案的 `connection_id` → 403。
  - `internal`：`/ai/wiki/*`、`/ai/tasks/*`、`/ai/platform/query`、`/ai/glossary` 可看全平台；**`/ai/db/*`（客戶正式 DB 與 log）一律 403**。使用者的裁決是健檢要「看得到全部任務」，沒有包含查客戶正式資料。
- **舊路徑保留**（loopback TCP＋全域通行碼），只給互動式 session 用（例如你在終端機跑 `/getSQL`）。容器本來就連不到 loopback。
- **新增兩個唯讀端點**，取代直連平台 DB 的兩個 skill：
  - `/ai/glossary`：術語查詢，給 `odooGlossary`（術語表是公開的 Odoo 字串，不含客戶資料）
  - `/ai/platform/query`：**只給 internal scope**，只准 SELECT，用唯讀 DB 角色；`*_enc`、`password_hash` 等敏感欄位不可讀。給 `platformDB`。
- **檢查點**：發通行證前呼叫 `canRun(scope, actorUserId)`（09-14 加上發起者：公司與 key 看人不看專案）。本期永遠回 true；子專案 1 接上「發起者所屬公司啟用中且在使用期間內」；子專案 2 接上「公司已設定 API key」與「未超過單張任務花費上限」。

### 4.5 內部 AI（健檢、夜間改善）

同一套容器，scope＝`internal`，權限比客戶大（使用者裁決 2026-09-11）：

| agent | 掛載 |
|---|---|
| `platform_fix`、`fix_verify` | 平台 repo 的修正 worktree（rw；`.git/config`、`.git/hooks` 同樣 ro） |
| `workflow_health`、`fix_review`、`feedback_merge` | 平台 repo 的**乾淨 worktree**（ro） |

⚠ **絕不掛正在運作的 `/home/odoo/odoo-v2` 本體**：裡面有 `data/config.json`（三把總鑰匙）與 `data/run/ai.sock`。一律從 git 開 worktree——`data/` 在 `.gitignore` 內，worktree 裡天生沒有它。

- 查平台 DB 走 `/ai/platform/query`（唯讀、遮蔽敏感欄位）——**只給 `workflow_health`**（09-15 R6-A）。`platform_fix`、`fix_verify`、`fix_review`、`feedback_merge` 的通行證**不含**這個端點：它們只該讀到平台管理員核准過、放進 prompt 的那段文字；能自己查 DB，就能在核准之後讀到新的客戶文字而被注入，而它們的產出會自動合併（總覽 §6.3）。09-15 查 `.claude/agents/*.md`，引用 platformDB 的只有 `health-auditor`（`coding-project` 那筆是「不要讀」），分級不會弄壞現有 prompt。實作上 internal scope 要拆兩級（例：`internal-audit`／`internal-fix`）
- 一樣拿不到三把總鑰匙、客戶正式機憑證
- `platform_fix` 要跑 `npm run test:quiet`：worktree 需有 `node_modules`，測試用 pg-mem 不連真 DB（計畫階段確認 `jest.setup.js` 不需要真實密鑰）

### 4.6 Codex

- 客戶觸發的 agentType **一律強制 provider＝claude＋容器**。設定成 codex 時直接報錯，不默默改用。
- Codex 只允許內部 agentType，本期不容器化。
- 本期對 `codex-runner.js` 也套用環境變數白名單（至少拿不到三把總鑰匙）。同 uid 讀檔的風險仍在，列入 §10。

---

## 5. 資料流（一次 AI 執行）

1. runner 要跑 agent → `canRun(scope)` → 產生 runId、登記執行中清單、簽發通行證
2. `buildAgentRunArgs` → `docker run -i --rm …`；prompt 走 stdin，stream-json 走 stdout——**runner 的解析邏輯不變**
3. 容器內 claude 經閘道連 Anthropic；需要資料時 `curl $AIDEV_AI_BASE/ai/...`，經閘道 → socket → 平台代查
4. 結束 → 作廢通行證、移出清單；容器 `--rm` 自動刪除

---

## 6. 錯誤處理

| 狀況 | 現在 | 改成 |
|---|---|---|
| 按停止／逾時 | SIGTERM → 5s → SIGKILL 砍 CLI | `docker kill aidev-run-<runId>`，再照原流程結算。**不能只殺子行程**：SIGKILL 送到 docker CLI 不會轉給容器，容器會繼續跑、繼續燒錢 |
| 平台重啟 | 連帶砍掉 agent | 容器會活下來 ⇒ 啟動時先 `docker rm -f` 所有 **`label=aidev.run` 且 `label=aidev.instance=<本實例 id>`** 的容器，再走現有卡住任務的處理。**一定要帶實例 label**：同一台主機若有 staging 平台，只篩 `aidev.run` 會把另一套正在跑的 AI 一起清掉。通行證清單在記憶體，重啟自然全部作廢 |
| `--resume` 找不到 session | 無退路 | 偵測到 → 改成全新執行，並在 `task_logs` 寫一行說明。偵測用的錯誤字面**計畫階段實測取得**（故意給一個不存在的 session id 跑一次），比照 `sandbox-signature.js` 只收啟動器自己印的字面，不猜。切換日先把 `~/.claude/projects/` 的現有 session 依 cwd 路徑對應專案，複製進各 scope 的 `data/agent-home/` |
| 超過記憶體上限（exit 137） | 無 | 錯誤訊息明寫「記憶體上限」；分類為 env、不重試（比照 rules/pipeline 93） |
| docker 或閘道不可用 | — | 大聲失敗、任務停下。**禁止退回無容器執行**（rules/pipeline 59：fallback 指向最嚴格） |
| 閘道拒絕某網域 | — | 閘道寫到自己的 stdout（`docker logs aidev-gw` 看得到目的地與來源容器名）；AI 端看到的是連線失敗 |
| 呼叫端帶了白名單外的 env | — | 丟例外（寫錯 key 不能靜默繞過限制） |

---

## 7. 會改變的既有行為（切換前必須知道）

- **pipeline AI 不再載入使用者層外掛**（superpowers 等）、`~/.claude/CLAUDE.md`、RTK hook ⇒ token 用量與輸出風格可能改變，要試跑比對（§8.4）。
- **AI 不能再上網查任意網站**（WebFetch／WebSearch）。現有 agent prompt 沒有引用它們，但 claude 內建工具仍可能被 AI 自行拿來用，會失敗。
- **`platformDB`、`odooGlossary` 兩個 skill 改打 `/ai` 端點。** 改完要跑 `node scripts/sync-skills.js`（rules/always.md 第 13 條）。
- 互動式 session（你在終端機裡）不受影響。

---

## 8. 測試

### 8.1 單元測試（jest，`app/server/tests/agent-sandbox.test.js`，比照 `docker-env.test.js`）

- 就算 `process.env` 裡有，產出的 env 也**沒有** `APP_SECRET`、`JWT_SECRET`、`DATABASE_URL`
- 掛載清單只含該 scope 應有的路徑；project scope 不含平台 repo、不含其他專案
- `.git/config` 與 `.git/hooks` 一定是 ro
- 網路＝`aidev-agent-net`；一定有 `--rm`、`--cap-drop ALL`、`no-new-privileges`、記憶體上限
- 白名單外的 env key → throw

### 8.2 `/ai` 範圍（supertest＋pg-mem）

- A 專案的通行證查 B 專案的連線 → 403
- 過期或已作廢的通行證 → 401
- 非 internal scope 呼叫 `/ai/platform/query` → 403
- 從 socket 進來、帶舊全域通行碼 → 401

### 8.3 攻擊實測腳本 `scripts/verify-agent-sandbox.js`（真的開容器，**切換前必須全過**）

- `$APP_SECRET`、`$JWT_SECRET`、`$DATABASE_URL` 皆為空
- 讀 `/home/odoo/odoo-v2/data/config.json` 失敗
- 讀其他專案的 repo 路徑失敗
- 寫 `.git/config`、`.git/hooks/*` 失敗
- TCP 直連宿主 8772、測試區埠失敗；8771 與 22 在 2026-09-16 實測仍可連到，已依使用者裁決接受此殘餘並補登入鎖定，**不得把兩埠寫成隔離成功**（詳見「開發順序」§0 的 M6）
- 經閘道連 `api.anthropic.com` 成功；連 `example.com` 被拒
- 用本次通行證查別專案 → 403；執行結束後再用 → 401
- 真的跑一次最小的 `claude -p`，再用 `--resume` 接續成功

### 8.4 試跑比對

挑幾種任務類型，容器內外各跑一次，比 `token_usage` 與結果（因為 §7 的行為改變）。

---

## 9. 切換步驟

1. 建映像檔、閘道、internal 網路；平台加 socket listener 與通行證（舊路徑仍在）
2. 攻擊實測腳本（§8.3）全過
3. 功能開關 `agent_sandbox`（放 `teams_settings`）預設關 → 先開內部 agent → 再開客戶 agent
4. 複製 session 檔、重啟平台
5. 試跑比對（§8.4）
6. 確認後移除舊的無容器路徑。**子專案 1 開放客戶登入之前，開關必須移除、只剩容器路徑**

---

## 10. 已知風險與未決

| 項目 | 狀態 |
|---|---|
| Context7 key 會出現在容器內的 MCP 設定檔（平台的 key） | 接受。外洩影響＝額度被用，可在後台換 key |
| 本期容器內注入的仍是平台的 Claude 訂閱 token | 客戶登入前只有內部使用；子專案 2 換成各公司自己的 key |
| 夜間改善 AI 改的平台碼仍會自動合併、在主機上執行 | 容器擋不住。**R6（09-15）接受自動合併**，改擋入口：健檢提案人工核准＋改碼的 AI 查不到平台 DB（§4.5）。剩下的風險＝核准時沒看出全文裡藏的指令（總覽 §6.3） |
| 容器內的 hook（`scan-guard.js`） | 保留、唯讀掛載，定位是輔助不是防線（總覽 §6.1） |
| Codex 路徑仍與平台同 uid（可讀 `data/config.json`） | 只給內部用；客戶 agent 禁用 Codex（§4.6） |
| `--memory`、`--cpus`、`--pids-limit` 數值 | 2026-09-18 已依實測訂為 AI 容器 2g／2 CPU／128 個程式；缺值仍須丟例外（詳見「開發順序」§0） |
| 全部 agentType 的 cwd 與掛載需求 | 實作計畫第一步逐一對照（含 §2.13 字面漏掉的 `chat`、考試系統）；對不上就停下來問 |
| `/ai/platform/query` 的敏感欄位遮蔽清單 | 計畫階段列全 |
