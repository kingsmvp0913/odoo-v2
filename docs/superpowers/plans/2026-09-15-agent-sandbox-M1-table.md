# 子專案 0 前置量測結果（M1／M2／M3）

> 執行日：2026-09-16。worktree `.claude/worktrees/agent-sandbox`（分支 `feat/agent-sandbox`），base＝`a0cfc6e1`。
> 本檔不進版控（`docs/` 在 `.gitignore`）。

**Task 0 基線（worktree 內實跑）**

```
Test Suites: 1 skipped, 319 passed, 319 of 320 total
Tests:       3 skipped, 4964 passed, 4967 total
EXITCODE=0
```

---

## M1：AI 呼叫點 × agentType × cwd × env

### Step 5 判定：**全部相符，繼續**

- 碼裡的 `agentType` 字面共 **23 個**，與計畫 Task 1.1 `AGENT_PROFILES` 預期的清單**完全一致**，沒有多出新的 agentType。
- 各呼叫點的 `cwd` 與計畫表一致（逐列見下）。
- 帶 `env:` 的呼叫點只有 **2 處**，與計畫預期相同。
- 只有**行號位移**，不構成「表與碼不符」：`chat-agent.js` 142→**164**、`spec-review.js` 119→**92**、`clarify-chat.js` 202→**171**。

### Step 2：`token_usage` 實際跑過的 agentType（近全期）

`chat` 502、`coding` 286、`qa` 258、`cs` 242、`analysis` 238、`respec` 173、`reject_triage` 141、`wiki` 136、
`workflow_health` 95、`reject_classify` 72、`platform_fix` 44、`repair` 35、`chat-to-task` 35、`fix_review` 34、
`feedback_triage` 31、`fix_verify` 19、`feedback_merge` 15、`spec_tour` 10、`merge` 6、`deploy_fix` 3、`merge-explain` 1。

- `feedback_triage`（31 筆，最後 09-09）：碼裡已無此呼叫點（09-09 拿掉的關卡）→ **不登記**，照計畫辦。
- 碼裡有、帳面沒有：`chat-title`、`wiki_drift_classify`、`merge-clarify`、`auth_probe`（`admin-routes.js:76` 現無 agentType）。不影響 profile 表。

### Step 1／3：呼叫點對照（2026-09-16 實查）

| agentType | 呼叫點 | cwd | env |
|---|---|---|---|
| analysis | `task-agent.js:345,375` | `wtParent` | — |
| coding | `task-agent.js:637` | `cwd` | **`{...gitEnv}`** |
| spec_tour | `task-agent.js:590,604` | 同 runOpts | — |
| qa | `qa-agent.js:155,187` | `cwd` | — |
| respec | `respec-agent.js:117` | `work ? work.cwd : undefined` | — |
| reject_triage | `reject-triage.js:143` | `cwd` | — |
| cs | `cs-agent.js:97`（withResume） | 未傳 | — |
| chat | `chat-agent.js:164`（withResume） | 未傳 | — |
| merge／merge-explain／merge-clarify | `merge-agent.js:83,157,217` | 未傳 | — |
| wiki | `library-agent.js:201,304,423` | 未傳 | — |
| chat-to-task | `chat-to-task.js:61` | 未傳 | — |
| chat-title | `chat-title.js:55` | 未傳 | — |
| deploy_fix | `failure-classifier.js:93` | 未傳 | — |
| reject_classify | `classify-rejections.js:26` | 未傳 | — |
| wiki_drift_classify | `wiki-drift.js:56` | 未傳 | — |
| repair | `agent-result.js:89,113` | 未傳 | — |
| auth_probe（新名） | `admin-routes.js:76` | 未傳 | **`{CLAUDE_CODE_OAUTH_TOKEN}`** |
| workflow_health | `health-check-runner.js:94,335` | `REPO_ROOT` | — |
| fix_review | `fix-review.js:105` | `os.tmpdir()` | — |
| feedback_merge | `feedback-merge.js:44` | 未傳 | — |
| platform_fix | `finding-fix.js:338` | `worktree` | — |
| fix_verify | `fix-verify.js:79` | `fix.worktree` | — |
| （考試）challenge／review／evidence | `lib/exam/challenge.js:191`、`review.js:401`、`evidence.js:368` | `cwd`／`runCwd` | 整包繼承 `process.env`（X2） |

另：`lib/codex-app-server.js:43`、`pipeline/codex-runner.js:52` 為 Codex 通道（不容器化，只做 env 白名單）。

### ⚠ 給 Task 1.4（env 白名單）的新觀察

`buildGitEnv`（`lib/git-identity.js:19-42`）回傳 **11 個 key**：

```
GIT_ASKPASS, GIT_ASKPASS_NODE, GIT_PAT,
GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL,
GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0, GIT_TERMINAL_PROMPT
```

兩個要在 Task 1.4／第 2 部處理：

1. **`GIT_PAT` 是真憑證**（使用者的 GitHub PAT 明文）。coding agent 在 worktree 內只做 `git add`／`git commit`，**不需要 PAT**（push 由平台 node 執行，見產品化裁決）。容器 env 白名單應排除 `GIT_PAT`、`GIT_ASKPASS`、`GIT_ASKPASS_NODE`，只留身分四欄與 `GIT_TERMINAL_PROMPT=0`。→ **需使用者確認**（會改變 coding agent 目前的能力邊界）。
2. **`GIT_ASKPASS_NODE: process.execPath` 是宿主 node 路徑**，容器內不存在（與 X8 的 context7 設定同一類問題）。

### Step 4：log 檔名的 id 型別 → **是 `tasks.id` 整數**

`saveDeployLog(taskId, …)`／`saveTourLog(taskId, …)` 的 `taskId` 與 `UPDATE tasks … WHERE id=$1`、`task_events(task_id)` 同一個變數 ⇒ 整數。**計畫 Task 1.5 的 `^(deploy|e2e)-task(\d+)-` 不用改。**

但 `count` 參數有計畫沒寫到的四種變體（`deploy-testing.js:229,241,438,450,509`）：

```
deploy-task<N>-<count>.log        deploy-task<N>-<count>_<n>.log
deploy-task<N>-timeout-<時戳>.log  deploy-task<N>-envdeath-<時戳>.log
deploy-task<N>-env-<時戳>.log      deploy-task<N>-asset-<n>.log
```

四種的 `<N>` 都仍是數字且緊接在 `-task` 後，正規式照樣抓得到 ⇒ 不影響。

---

## M2：`--resume` 找不到 session 時的字面

**Step 1／2（不存在的 session id）**

- **EXITCODE：`1`**
- **stderr**（唯一一行）：

```
No conversation found with session ID: 00000000-0000-4000-8000-000000000000
```

- **stdout**：仍有 JSON `result` 事件，關鍵欄位

```json
{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,
 "errors":["No conversation found with session ID: <id>"]}
```

→ 第 2 部 Task 2.4 的 `MISSING_SESSION` 辨識字面用 **`No conversation found with session ID:`**。
兩個來源都可用；stdout 的 JSON 更穩（`subtype==='error_during_execution'` ＋ `errors[]` 含該字面）。

**Step 3（真實 session、換一個 cwd 續接）→ 成功**

- `EXITCODE=0`、`subtype:"success"`、`result:"ok"`、`num_turns:1`。
- **結論：session 不綁 cwd**，換目錄仍續接得到。第 2 部 Task 2.16（session 複製進各家資料夾）的前提成立。
- 附帶數字：該次 `cache_creation_input_tokens` 80,988、`total_cost_usd` 0.324 ⇒ **換 cwd 會整包重建快取**（`claude-runner.js:162` 的註解已提過這件事）。容器化後每家一個 HOME，要留意這筆重建成本。

---

## M3：唯讀角色前置條件

**Step 1：`pg_hba` 與 bridge 網段 → 與規格 X20 一致**

```
local   all  all                  trust
host    all  all  127.0.0.1/32    trust
host    all  all  ::1/128         trust
host    all  all  10.0.0.0/24     scram-sha-256
```

bridge：`10.0.0.0/24`，gateway `10.0.0.1`。
⇒ 平台從 `127.0.0.1:8772` 連線不驗密碼（權限仍照角色生效）；要驗「密碼真的有用」只能從 bridge 丟棄式容器連 `10.0.0.1`，與計畫寫的一致。

**Step 2：extension → 安全，不必停下來問**

```
plpgsql
```

沒有 `dblink`／`postgres_fdw`／`adminpack`／`plpython*u`。

**Step 3**：要等 Task 1.11 合併＋重啟批次 R-A 之後才做得到，**未做**。

---

## M5：映像檔啟動時間（第 2 部，2026-09-16）

映像 `aidev-agent:2.1.267`（652 MB）。`/usr/bin/time` 在平台容器內不存在（無 root 無 apt），改用 `date +%s%N` 前後相減。

| 網路 | 5 次（ms） | 中位數 |
|---|---|---|
| `--network none` | 157, 136, 153, 156, 143 | **153 ms** |
| 預設 bridge | 253, 237, 248, 248, 252 | **248 ms** |

**判定：遠低於門檻，不必回報使用者**（計畫門檻＝中位數 > 2 秒）。

對照規格 §2.12 當初量的**空白 `node:22-slim`**（bridge 226–259 ms）：裝了 claude 與 context7-mcp 之後**啟動成本幾乎沒變**。相對 chat p50 40.6 s ⇒ 每次多約 **0.6%**。

映像內容驗證（Task 2.1 Step 3）全過：claude 2.1.267（與 build arg 一致）、`context7-mcp` 有路徑、git 2.39.5、ripgrep 13.0.0、`openpyxl/docx/xlrd` 都 import 得到、**`no-rtk`**（確認沒帶使用者層工具）。

---

## M6：閘道擋得住嗎、容器碰得到宿主嗎（2026-09-16）

量測用設施全部帶 `aidevm6` 前綴、跑完即收，**零殘留**（實測確認容器與網路清單皆空）。

**對外（全部符合預期）**

| 檢查 | 結果 |
|---|---|
| `api.anthropic.com` 經閘道 | 404（通得到，非 `000`） |
| `context7.com` 經閘道 | 200 |
| `example.com` 經閘道 | `000`＝被 403 擋，閘道 log 有 `{"type":"deny","dest":"example.com:443"}` |
| 不經閘道直連 | `000`＝不通 |
| `/ai/ping` 經唯讀掛載的 unix socket | `fake-ai /ai/ping`＝**通**（證明唯讀 bind mount 上的 socket 可用） |
| `/api/tasks` 經閘道 | 404＝不轉發 |

**對主機（兩項不符，Step 4 判定＝停下回報）**

```
REACHABLE 10.0.28.1:8771   ← 平台 API
REACHABLE 10.0.28.1:22     ← 宿主 SSH
```

`10.0.28.1` 是該 internal 網路**在主機側**的位址。**`--internal` 只擋連外網，不擋連主機**；而 `ss` 實測平台 8771 聽 `*`、SSH 22 聽 `0.0.0.0`，所以容器摸得到。

**擋住的（確認仍安全）**：PostgreSQL 8772（只聽 `127.0.0.1` 與 `10.0.0.1`）、`/ai/*`（`ai-token.js:71` 要求 loopback，`10.0.28.x` 回 403）、測試區埠 21000、5416；`127.0.0.1`／`host.docker.internal`／docker0 閘道／主機 LAN IP 的五個埠也全擋。

**可實際利用的面**：8771 上不需 token 的只有 `/api/auth/login`、`/api/auth/register`、`/api/auth/status`、`/api/setup/status`（`setup` 因已有使用者恆 403）。其餘 `/api/*` 無 JWT 一律 401。**而登入原本完全沒有次數限制**——這才是真正要緊的一條。

**使用者裁決（2026-09-16）**：不改成 `--network none`（雖然實測證明 `--network none` 容器仍可經掛入的 unix socket 連主機、AI 不會斷線），改為**接受現況＋補上登入失敗次數限制**：5 次錯鎖 10 分鐘、累計 10 次永久封鎖，鎖的是 **(帳號, 來源)** 這一對，並在使用者管理頁看得到、解得掉。
理由：只鎖帳號的話，被注入的 AI 可以對 9 個管理員帳號各打錯 10 次，把所有人永久封鎖且無人能解——把機密性問題換成整個平台停擺。真人經 nginx、容器直連 8771，`remoteAddress` 不同，互不影響。

---

## M7：容器內真的跑得動 claude 嗎（2026-09-16）

三項全過，設施跑完即收、零殘留。憑證只進環境變數（`-e CLAUDE_CODE_OAUTH_TOKEN` 傳名不傳值，不進 `docker` 指令列）。

| 檢查 | 結果 |
|---|---|
| 容器內 `claude -p`（經閘道 proxy 出去） | `EXITCODE=0`、`subtype:"success"` ✓ |
| **`$HOME/.claude/skills/<name>` 在 headless 是否載入** | 探針碼 `ZEBRA-4417` 出現 3 次 ⇒ **會載入** ✓ |
| 同一個 HOME 下 `--resume` | `EXITCODE=0`、回覆含 `RESUMED` ✓ |

**第二項是計畫標明「沒出現就要停下來問使用者」的岔路**（X9：chat／cs 進容器後 cwd 變了，原生載得到的 skill 會消失）。
結果是會載入 ⇒ **Task 2.15 的做法成立**：把白名單 skill 唯讀掛進容器家目錄即可，**不需要**改 agent prompt 或把 skill 內容注入 prompt（那會動到 promptVersion）。

---

## M8：容器內跑平台全套 jest（2026-09-16）

| 項目 | 數值 |
|---|---|
| 容器內 Node | **v22.23.2**（主機平台是 Node 20） |
| 記憶體峰值 | **844 MiB** |
| PID 峰值 | **48** |
| CPU | 約 130%（給了 4 核） |

⇒ **正式上限抓 `2g／512 pids` 就綽綽有餘**（第 3 部 M10 訂正式值時用這組數字，原本暫定的 4g 是猜的）。

**判定：維持 `node:22-slim`，不需要 pull `node:20-slim`。**

第一次量到 6 個紅燈（`git-integration`／`git-identity`／`git-hardening`／`health-finding-unfixable-targets`），
逐一查證後**兩個都是量測環境造成的，與 Node 22 無關**：

1. **掛載不足（3 支 git 測試）**：錯誤是 `fatal: not a git repository: /home/odoo/odoo-v2/.git/worktrees/agent-sandbox`。
   worktree 的 `.git` 是指向主 clone 管理目錄的檔案，而我只掛了 worktree 本身。
   補掛平台 `.git`（ro）＋自己的 worktree 管理目錄（rw）後重跑 → **6 紅降到 1 紅**。
   **正式設計本來就對**：Task 1.5 `resolveSandboxMounts` 的 `platform-fix` 分支已包含這兩個掛載。

2. **`--tmpfs /tmp` 是 `noexec`（剩下那 1 支）**：實測 `tmpfs on /tmp type tmpfs (rw,nosuid,nodev,noexec,...)`，
   /tmp 裡的腳本一律 `Permission denied`。紅的是 `git-hardening.test.js` 的**對照組**
   （「不加固時 hook 會執行」——它要在暫存 repo 裡放一支 pre-commit 腳本並期待它被執行）。

**⚠ 給第 3 部 Task 3.2 的「容器內已知跑不起來的測試」清單**：
`git-hardening.test.js` 的對照組那一支。原因是容器 `/tmp` 為 `noexec`（這是刻意的隔離設定，不該為了測試放寬）。
`platform_fix`／`fix_verify` 在容器內比對基線時要把它排除，否則每次都會被當成新紅燈。

---

## M9：撞記憶體上限時的 exit code（2026-09-16）

| 情境 | exit code |
|---|---|
| 撞 `--memory` 上限（node 狂配記憶體） | **137** |
| shell 自己 `kill -KILL $$`（`sh -c` 直接殺／背景後殺，兩種寫法） | **0** |
| 主進程被外部 SIGKILL（`docker kill -s KILL`） | **137** |

**⚠ 推翻計畫的假設**：計畫寫「程序自己被 SIGKILL 也是 137 ⇒ 137 只能說『可能是記憶體上限』」——
實測**自己殺自己是 0**，不是 137。真正的語意是：**137 ＝ 容器主進程被 SIGKILL**，
而那既可能是記憶體上限、**也可能是平台自己下的 `docker kill`**（Task 2.6 的停止／逾時正是用它）。

⇒ **Task 2.6 不能只看 137 判斷 OOM**：要先排除「這次是我們主動 kill 的」（停止／逾時路徑自己知道），
剩下的 137 才歸類為記憶體上限。訊息措辭照這個口徑改，不要照計畫原文。

---

## 2.13：容器內 context7 MCP 經 proxy 查得到文件（2026-09-16）

全部符合預期，設施跑完即收、零殘留。

| 檢查 | 結果 |
|---|---|
| 容器版 MCP 設定生成 | OK（`command: context7-mcp`，key 由 `CONTEXT7_API_KEY` 帶） |
| `claude -p` 退出碼 | `0` |
| 有沒有真的呼叫 context7 | `mcp__context7__resolve-library-id` ×1 ✓ |
| 回答 | `/expressjs/express` ✓ |
| 閘道 deny 次數 | **0** |

⇒ **不需要把任何網域加進 `ALLOWED_CONNECT`**（原本列為「加白名單需使用者同意」的風險，現在確認不會發生）。
analysis／coding／qa／chat 在容器裡查得到文件，不會退回亂掃碟。

---

## 3.2：`platform_fix` 帶意見附件 id（2026-09-17）

`finding-fix.js` 的 `measureTests`（量基線／複驗）是**平台行程**在宿主跑 jest，不在容器內跑；
容器裡的是 `platform_fix` 這個 agent 自己下 `npm run test:quiet` 觀察自己改完的結果，兩者跑在不同地方，
彼此不互相比對，所以下面這份「容器內跑不起來」的清單不影響基線比對，純粹是 1.4 觀察夜間批次時，
判讀 agent 回報裡的紅燈用：

- `git-hardening.test.js` 的對照組（「不加固時 hook 會執行」）——容器 `--tmpfs /tmp` 是 `noexec`，
  這支預期會紅，不是 agent 改壞東西（見上方 M8）。

M8 目前只點名這一支；沒有其他「容器內已知跑不起來」的項目。

---

## 待使用者裁決

1. 容器 env 白名單要不要拿掉 `GIT_PAT`（見上方「給 Task 1.4 的新觀察」第 1 點）。
