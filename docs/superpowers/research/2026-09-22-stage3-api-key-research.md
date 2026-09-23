# 階段 3「客戶自帶 API key」事實調查

日期：2026-09-22
性質：**唯讀調查**，沒有動任何檔案、沒有 commit、沒有跑會寫入的東西。
目的：查證「約七成是單張任務花費上限、換認證本身很小」這句估計是否屬實，並攤開兩半各自要碰什麼。

## 讀過的規格與它們的時間戳

| 檔 | 日期 | 狀態欄自述 | 待決 |
|---|---|---|---|
| `docs/superpowers/specs/2026-09-11-byok-api-key-design.md` | 2026-09-11 | 「初稿，待使用者審閱（含「待你決定」§8）」 | §8 四題 **P1～P4 全部已在 09-14 決掉**（表格裡逐列寫了「已決 09-14」），檔頭的「待審閱」字樣沒跟著更新。**沒有仍然開放的待決項** |
| `docs/superpowers/specs/2026-09-11-productize-rollout-plan.md` | 2026-09-11（§0 進度表最後更新 2026-09-22） | R1～R6 全決 | §0 第 25 行就是本次要驗的那句估計 |
| `docs/superpowers/specs/2026-09-11-productize-overview.md` | 2026-09-11 | — | 2-P2（上限預設值）已決「用歷史 p90／p99 算」 |
| `docs/superpowers/specs/2026-09-11-saas-operations-design.md` | 2026-09-11 | — | O8 已決「每家公司各自一個**併發**上限」（不是花費上限，見 §C4） |

規格自報的行號在半年內漂了（例：§3.2 寫「`claude-runner.js:197` 的 `getClaudeAuthEnv()`」，實際在 `pipeline/claude-runner.js:210`；「`admin-routes.js:75`」的驗證範例實際在 `admin-routes.js:114`）。下面每一條都用**現在的**行號。

---

## A. 今天的 Claude 認證怎麼運作

### A1. spawn 點與它用的憑證

- 唯一的 AI spawn 實作是 `pipeline/claude-runner.js` 的 `runClaude()`（`pipeline/claude-runner.js:156`）。兩條路：
  - **舊路徑（無容器）**：`pipeline/claude-runner.js:417` `spawn('claude', args, legacyOpts)`，env 在 `pipeline/claude-runner.js:210` 組成：
    `{ ...process.env, SECURITY_GUIDANCE_DISABLE, CLAUDE_CODE_PROMPT_CACHE_TTL:'5m', ...getClaudeAuthEnv(), ...aiTokenEnv(), ...aiBaseEnv(), ...(env||{}) }`
  - **容器路徑**：`pipeline/claude-runner.js:432` `spawn('docker', run.argv, { env: run.childEnv })`，參數由 `pipeline/sandbox-run.js` 的 `prepareSandboxRun()` 組（`pipeline/sandbox-run.js:104`）。
- **正式平台現在跑的是容器路徑**：`teams_settings.agent_sandbox_mode = 'all'`（實查平台 DB，2026-09-22）。舊路徑只在開關關掉時才走。

### A2. 是共用 OAuth 憑證還是 API key？

**是共用的一把訂閱 OAuth token，存 DB，不是 API key。**

- `lib/claude-auth.js:41`：`SELECT claude_oauth_token_enc, claude_oauth_token_backup_enc FROM teams_settings WHERE id = 1`，`lib/crypto.js` 解密後放行程記憶體。
- `lib/claude-auth.js:57-60` `getClaudeAuthEnv()` 只交出 `{ CLAUDE_CODE_OAUTH_TOKEN: <token> }`，**全平台一把**（主 + 一把備用）。
- 寫入者只有平台管理員：`admin-routes.js:107` `saveClaudeToken()`（端點 `PUT /api/admin/claude-token`）。存之前先拿候選 token 跑一次 `runClaude('回覆 ok')` 驗證（`admin-routes.js:114`），認證類失敗就不存（`admin-routes.js:116-118`）。這正是規格 §4.3 要照抄的樣板。
- 實查現況：`primary_set = true`、`backup_set = false`、`usage_gate_enabled = true`（門檻 90%／95%）、`usage_gate_fallback_enabled = false`。
- `data/config.json` **沒有** `ANTHROPIC_API_KEY`（實查，只有 `DATABASE_URL`／`JWT_SECRET`／`APP_SECRET`／`PORT`／埠池兩個／`PLATFORM_CONTAINER`／`TRUSTED_PROXY_IPS`）。`start.sh:61-62` 有「config 若有 `ANTHROPIC_API_KEY` 就 export」的路徑，目前是死路。
- 優先序警告機制已存在：`lib/claude-auth.js:83-88` `shadowingEnvVar()` 回報 `ANTHROPIC_AUTH_TOKEN`／`ANTHROPIC_API_KEY` 會蓋掉設定值。

### A3. 有沒有任何「每人／每公司」的憑證概念？

**有，而且形狀剛好可以照抄——但只在 GIT，不在 Claude。**

- `companies` 表：`app/server/db.js:795-814`。欄位有 `git_pat_enc`／`git_login`／`git_name`／`git_email`、`is_active`、`is_internal`、`active_from`／`active_until`；另有一個後加的 `features JSONB`（`db.js:1251`）。
- **`companies` 沒有任何 Anthropic 欄位、也沒有 `task_budget_usd`**（規格 §4.1 要求的五個欄位一個都沒有）。
- `users.company_id`：`db.js:1247`；索引 `db.js:1547`。
- 「個人 → 公司」的憑證解析已經實作在 `lib/git-identity.js:45-84` `buildGitEnv(userId)`：先看 `users.github_pat_enc`，沒有就退到 `companies.git_pat_enc`，而且會先問 `isUserCompanyUsable(userId)`（`lib/git-identity.js:60`）。**`buildClaudeAuthEnv(userId)` 就是這個形狀。**
- 公司憑證的存檔端點樣板：`company-admin-routes.js:166-202`（`PUT /api/admin/companies/:id/git`）——存之前對該公司綁到的每個 repo 跑 `git ls-remote` 驗證，一個失敗就整批不存，回應刻意不回 PAT 也不回密文。規格 §4.3／§4.1 要的「先驗證再存、永不回傳原文」在這裡已有現成寫法。
- ⚠ **`company-admin-routes.js` 全檔都是 `requirePlatformAdmin`**（`company-admin-routes.js:19`）。`company_admin` 這個角色存在且 `req.actor.isCompanyAdmin` 有被填（`auth.js:40`），但**今天沒有任何「公司管理員自助設定」的端點或頁面**。規格 §4.2「公司管理員在新的公司設定頁填 key」＝全新面。09-14 P1「平台管理員可代填」則可以直接照 `/git` 那支加一支。

### A4. 憑證失敗時今天會怎樣

1. **辨識**：`pipeline/auth-signature.js:15-24` 的 8 條 regex（`not logged in`／`invalid api key`／`authentication_error`／`API Error: 401`／`OAuth token expired`／`401 Unauthorized`／`Missing bearer or basic authentication`／`please run /login`）。刻意不收籠統詞。
2. **歸因**：`pipeline/claude-runner.js:342` 掃**非 JSON 的 stdout 行**（CLI 把 `Not logged in` 印在 stdout、stderr 空），`pipeline/claude-runner.js:360-362` 把泛用退出碼改寫成可讀訊息並標 `claudeStatus='auth'`。
3. **分類**：`pipeline/failure-classifier.js:69` → `'transient'`。
4. **重試**：transient 在關卡內**自動重跑一次**（例：`pipeline/qa-agent.js:226-227`），再失敗就把任務轉 `stopped` 並寫 `blocker_type`（`pipeline/qa-agent.js:234-238`）。`stopped` 不在可派工狀態，所以不會無限重試。
5. 對話類關卡另有人話翻譯：`pipeline/clarify-chat.js:145`。

**與規格 §4.6 的落差**：規格要求「key 無效或被撤銷 → 停下、**不重試**、通知客戶管理員、清空 `anthropic_key_verified_at`」。今天是「重試一次 → 停下 → 沒有針對公司的通知、沒有 verified_at 可清」。要改的點就是 `failure-classifier.js:69` 這一行的語意分岔（平台憑證仍當 transient、客戶 key 當終局），**以及規格 §4.6 自己寫的那句「實際錯誤字面要拿真 key 實測取得，不猜」——那是還沒做的前置工作。**

### A5. 要讓某一關改用「任務所屬公司的憑證」，得動哪些檔

憑證**必須**進容器（正式環境 `agent_sandbox_mode='all'`）。今天憑證進容器的方式：

- `pipeline/sandbox-run.js:126-130`：
  ```js
  const auth = { ...d.getClaudeAuthEnv() };
  if (callerEnv.CLAUDE_CODE_OAUTH_TOKEN) auth.CLAUDE_CODE_OAUTH_TOKEN = callerEnv.CLAUDE_CODE_OAUTH_TOKEN;
  if (!auth.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error('容器模式需要管理員在設定頁存入 Claude token…；不退回平台主機的憑證檔');
  }
  ```
  這是**唯一**的注入點，也是唯一要換的地方。
- `lib/agent-sandbox.js:99`：祕密值只走 `childEnv`、`argv` 只寫 `-e KEY`（`/proc/<pid>/cmdline` 同 uid 讀得到）。
- **擋路的兩行**：
  - `lib/agent-sandbox.js:12` `SECRET_ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'AIDEV_AI_TOKEN', 'E2E_PASSWORD']`
  - `lib/agent-sandbox.js:13-21` `ENV_WHITELIST` ——**`ANTHROPIC_API_KEY` 不在白名單**，`lib/agent-sandbox.js:97` 會直接丟例外。這兩個常數各加一個字串即可，是整個「換認證」中最小的一步。
- 出口閘道已放行 `api.anthropic.com:443`（`app/server/agent-gateway/gateway.js:13`），不必改。
- 「發起的人」已經有現成通路：`prepareSandboxRun` 拿得到 `opts.userId`（`pipeline/sandbox-run.js:122`），而 runner 的每個 handler 都帶 `task.user_id`。
- 「公司沒設 key 就不准跑」的掛點已經在程式裡被**預先註記**：`lib/agent-run-token.js:70-71`
  > 檢查點（§4.4）：公司停用或不在使用期間就不發通行證、不開容器。
  > **子專案 2 之後會在同一個地方再接「公司已設 key、未超花費上限」。**

  `canRun(scope, actorUserId)`（`lib/agent-run-token.js:85-87`）現在只呼叫 `isUserCompanyUsable`。

**換認證這一半的清單**：`companies` 加欄位＋migration、一支存檔端點（照抄 `/git`）、一支驗證（照抄 `admin-routes.js:114`）、`buildClaudeAuthEnv(userId)`（照抄 `git-identity.js:45`）、`sandbox-run.js:126` 改用它、`agent-sandbox.js:12-13` 兩行、`canRun` 補「有沒有 key」、`failure-classifier.js:69` 分岔、前端一個公司設定面。**規格 §5 的注入矩陣測試是這一半最花時間的部分，不是程式本身。** 這個判斷與「換認證本身很小」一致。

---

## B. 花費今天怎麼記

### B1. 表與寫入者

- 表：`token_usage`，建表在 `app/server/db.js:359-375`，後續加欄在 `db.js:1041-1057`（`chat_id`／`status`／`model`／`resumed`／`provider`／`error_message`）。
- 索引：`db.js:1486-1489`（`recorded_at DESC`、`task_id`、`user_id`、`project_id`）——**依 task 加總很便宜**。
- 唯一寫入者：`pipeline/token-logger.js:13` `logTokenUsage()`；失敗路徑包一層 `logFailedUsage()`（`pipeline/token-logger.js:53`）。全 repo 共 94 處 require／呼叫。
- **沒有 `cost_usd` 欄位。** 金額一律是用 `lib/token-cost.js` 的 `costSql()`（`lib/token-cost.js:33-47`）在查詢時**估算**：加權顆數 × 每 model 倍率 ÷ 1e6。倍率表 `lib/token-cost.js:28-31`（sonnet 3.0／opus 5.0／haiku 1.0／fable 10.0；codex 3.0 **標明未查證**）。
- ⚠ `cache_create` 係數 1.25 與 `claude-runner.js` 的 `CLAUDE_CODE_PROMPT_CACHE_TTL='5m'` 綁死（`lib/token-cost.js:11-15`）。

### B2. 記到什麼粒度？公司拿得到嗎？

`token_usage` 的歸屬欄位是 `task_id`（TEXT，**業務 id**）、`project_id`、`chat_id`、`user_id`、`agent_type`。

- **每次 AI 執行一列** ＝ 粒度是「單次 agent 呼叫」，比「關卡」還細（一關可能跑兩次）。
- **沒有 `company_id`**。公司只能經 `user_id → users.company_id` 推導（`db.js:1247`）。推導得出來，但每次都要 JOIN，而且 `user_id` 可為 NULL（`db.js:363` `ON DELETE SET NULL`，且內部批次本來就傳 null）。
- ⚠ **`task_id` 的唯一性是 per-user，不是全域**：`tasks` 表 `UNIQUE(user_id, task_id)`（`db.js:102`）。而報表與健檢一律只用 `t.task_id = tu.task_id` 這種**不帶 user 的 JOIN**（`token-report-routes.js:90`、`:139`、`:195`；`pipeline/health-data.js:120`）。手動建的任務是 `manual_<Date.now()>`（`tasks-routes.js:281`），但同步進來的外部任務 id 是外部系統給的數字。**實查正式庫今天 0 筆碰撞**（`SELECT task_id, COUNT(DISTINCT user_id) FROM tasks GROUP BY task_id HAVING COUNT(DISTINCT user_id) > 1` → 0 rows）。多租戶之後每家客戶帶自己的外部編號進來，這個結構性風險會變成實際風險，而且**症狀是「A 公司的預算被 B 公司的花費吃掉」**。

### B3. 「失敗輪不記帳」這條舊說法——已經對一半，要改寫

記憶 `token-usage-underreports-cost`（2026-08-10）說失敗輪整筆消失。**今天不是這樣了，但也還沒解決。**

- `pipeline/token-logger.js:6-7` 明文：「失敗/中斷的執行也要記帳（usage 為零、留 status 與耗時）」。
- `pipeline/token-logger.js:14`：`if (!usage && status === 'completed') return;` ——只有「成功但沒 usage」才跳過。
- **實查正式庫近 30 天**：

  | status | 列數 | 總 token |
  |---|---|---|
  | completed | 1349 | 1,147,749,070 |
  | aborted | 34 | **0** |
  | error | 28 | **0** |

**結論：失敗輪現在「有列、但 token 全是 0」。** 真因在 `pipeline/claude-runner.js:262`——`fail()` 只把 `claudeStatus`／`durationMs`／`sessionId` 掛到 error 上，**沒有把已經累積的 `usage` 帶出來**（`usage` 在 `claude-runner.js:332` 只在成功分支被 resolve 出去）。所以近 30 天有 62 輪（4.4%）完全沒有金額。這些正是「跑很久才逾時／被砍」的貴輪次。

**另一個規格自己寫的漏記**：`ev.result` 事件帶的 `total_cost_usd` **完全沒被讀**——全 repo grep `total_cost_usd` 零命中；`claude-runner.js:330-339` 只取 `ev.result`／`ev.usage`／`ev.duration_ms`。規格 §4.5 想用它來提高準確度，等於還沒開始。

（記憶裡第二條「子 agent 不計入」本次沒有重新驗證，維持「未證死」。）

### B4. 現有的花費閘門

**有一道，但它管的是「訂閱用量百分比」，不是錢。**

- `pipeline/usage-gate.js:64` `getGateState()`：讀 `teams_settings.usage_gate_enabled`／`usage_gate_5h_threshold`（預設 90）／`usage_gate_7d_threshold`（預設 95）／`usage_gate_fallback_enabled`，跟 Anthropic usage API 回的 5 小時／7 天視窗**利用率百分比**比較（`usage-gate.js:42-59`）。另有一條免費的補強來源：串流裡的 `rate_limit_event`，只加擋不放行（`usage-gate.js:17-39`）。
- 觸發時做兩件事：①主帳號超標且備援開著 → 切備用憑證（`usage-gate.js:114-115`）；②沒有備用 → `blocked: true`。
- **`blocked` 只影響自動推進**：`pipeline/runner.js:622-624`，而且只在 `auto` 分支內（`runner.js:614`）。註解寫得很直白：「手動入口 auto:false，不查、不擋——使用者自己點『繼續』自負用量後果」。
- 副作用一處：`pipeline/stale-running.js:53-54` 閘門 blocked 時整支殘留回收跳過。
- 通知：cron 每分鐘 `evaluateAndNotify()`（`cron.js:307`、`usage-gate.js:193`），邊緣觸發一次，走 socket＋webhook＋Teams。

**與 BYOK 的關係**：客戶自帶 key 沒有「訂閱視窗百分比」這回事，所以這道閘門對客戶執行完全無效（規格 §4.4 最後一行也這麼說）。也就是說——**今天平台對「金額」沒有任何閘門，一個都沒有。**

**唯一的既有金額型保險絲在別的地方**：`pipeline/nightly-fix.js:104-124`。`tokensSince(batchStartedAt)` 用 `SUM(input+output+cache_create)`（**刻意不含 cache_read**，理由寫在 `nightly-fix.js:100-103`：實測某批 97% 是 cache_read，算進去會用「讀了幾次快取」在限制花費）對上 `NIGHTLY_FIX_TOKEN_BUDGET`（預設 15M，`nightly-fix.js:29`）。這支是 §C 要照抄的東西。

---

## C. 「單張任務花費上限」到底要什麼

### C1. 跑到一半時，累計花費在哪裡讀得到

- **讀法**：`SELECT ... FROM token_usage WHERE task_id = $1`，套 `costSql('')`。`idx_tu_task_id` 存在（`db.js:1487`），成本可忽略。現成範例：`pipeline/health-data.js:377`、`token-report-routes.js:40-42`（`/api/token-report?task_id=` 已經支援）。
- **粒度上限**：列是在**每次 runClaude 回來之後**才寫的（例 `pipeline/qa-agent.js:216`）。所以「跑到一半」的實際意思是**「上一次 AI 呼叫結束、下一次還沒開始」**。單一關卡跑到一半時（coding 逾時上限 2400 秒，`claude-runner.js:152`）這張表對它是零。
- **在飛的資訊**：`pipeline/runner.js:143` `getInflightInfo()` 有 `startedAt`／`status`／`userId`，但**沒有任何 token／金額**。要在關卡內部即時知道花費，唯一的來源是 CLI 自己（`--max-budget-usd`，見 C3）。
- **精度**：如 B3，近 30 天有 4.4% 的輪次金額是 0；`total_cost_usd` 沒接。所以平台算出來的累計是**下限**，不是實際。

### C2. 執行點：誰決定「這張任務要不要往下一關走」

三個候選，由粗到細：

1. **派工迴圈 `pipeline/runner.js:647-658`** —— 最像「兩關之間」的那一點。裡面已經有一模一樣形狀的先例：
   ```js
   const { isUserCompanyUsable } = require('../lib/tenant-access');
   if (!await isUserCompanyUsable(task.user_id)) continue;   // runner.js:655-656
   ```
   **重點**：這段在 `auto` 判斷之外，所以**自動與手動都會過**。相對地，用量閘門在 `runner.js:614` 的 `if (auto)` 裡面——**只照抄用量閘門的位置，會被大約 20 個 `runPipeline(userId)`（auto:false）的手動入口整個繞過**（`pipeline-routes.js` 十處、`tasks-routes.js` 六處、`index.js` 三處）。
2. **`runTask` 的關後檢查 `pipeline/runner.js:493-539`** —— 已經有「每次成功推進就攔一次、把任務改道」的完整先例（`ABSORB_ON_ADVANCE`，`runner.js:513-539`，把有未吸收留言的任務轉去 `respec_running`）。要在這裡把任務轉 `stopped` 並寫白話 blocker，程式形狀是現成的。
3. **`canRun`（`lib/agent-run-token.js:85`）** —— **每一次 AI 呼叫**都會經過（容器路徑），粒度最細，而且程式裡已經預留給子專案 2（`agent-run-token.js:71`）。代價：`canRun(scope, actorUserId)` 現在拿不到 taskId，要改簽章（`prepareSandboxRun` 手上有 `opts.taskId`，`sandbox-run.js:143`）。

⚠ **`canRun` 有一個已被程式碼自己記錄的結構缺陷**（`lib/agent-run-token.js:74-84`）：它唯一的呼叫端是 `prepareSandboxRun`，**凡是不進容器的路徑就整段跳過**（`agent_sandbox_mode='off'` → `claude-runner.js:419` 直接 `startLegacy()`；mode 不涵蓋該專案 → `claude-runner.js:426` 同樣 `startLegacy()`）。註解原話：「正式環境目前開的是 `mode='all'`，這道檢查點才真的每次都會擋到；但這是『現在剛好開對開關』，不是結構上的保證。」**把花費上限掛在 `canRun` 上，等於把客戶的錢包綁在一個開關的當前值上。**

### C3. 停在半路會不會留下不一致的東西

**在「兩關之間」停 ＝ 安全，這一點有三組現成證據；在「關卡中間」停 ＝ 會留髒東西，這一點也有現成證據。**

安全側：

- `pipeline/stale-running.js:71-84`：把卡住的任務轉 `stopped` ＋ 寫 blocker ＋ 通知，**`resume_status` 刻意不動**，使用者按「解決阻塞」就從同一關續跑（`stale-running.js:18`）。這就是「停下、可續」的標準做法。
- `pipeline/runner.js:468-475`：每進一關就把 `resume_status` 寫成當關，本來就是為了「失敗轉 stopped 後回得來」。
- 用量閘門 blocked 時的語意是**任務原地不動、什麼都不寫**（`runner.js:624` 直接 `return`），下一輪自己恢復。
- `odoo_envs` 是 **`UNIQUE(project_id)` 的常駐環境**（`db.js:322-325`，並見 `db.js:1079-1081` 的註解），不是每張任務起一個。**停一張任務不會留下孤兒測試環境**；測試區的生命週期由回收政策管，與任務停不停無關。
- 分支狀態：`pipeline/runner.js:105-130` `abortCompanyTasks()`（公司停權時立刻中止在跑的 AI）的時間軸原話就是答案——**「改到一半的程式碼留在任務分支，沒有合併。」**

危險側：

- `pipeline/nightly-fix.js:116-118` 的註解是這個問題最直接的答案：
  > ⚠ 一律在「開跑之前」問，不是跑到一半砍掉——**半途中斷會留下髒 worktree 與半套 diff**。
- 尾巴三關 `merge_running → deploy_testing → playwright_running` 共用 `testing` 分支與測試 DB（`runner.js:591-596`）。**在 `merge_running` 成功之後、`deploy_testing` 之前停下，程式碼已經進了 `testing` 分支但沒有部署**——這不是「壞掉」，但它是「客戶付的錢用完了，可是他的碼已經在共用分支上」的狀態，要有人決定怎麼講。
- `pipeline/deploy-testing.js:375/384/407/435/524/537` 有密集的 `if (signal?.aborted) return;`——中斷是被設計過的，但它的落點是「odoo-bin 升級跑到哪算哪」。

**判斷**：**只要上限的執行點放在「派工之前／關卡之間」，這個功能是小的**——停下的機制、續跑的機制、通知的機制、時間軸白話的機制全部是現成的，照抄 `stale-running.js` 即可。**它會變大，是在有人要求「一關跑到一半、錢用完了就當場砍」的時候**——那要 `--max-budget-usd`（CLI 自己在單次執行內砍），而 CLI 被砍之後留下的半套 diff／髒 worktree 沒有人收，`nightly-fix.js` 選擇迴避這件事是有理由的。

### C4. 「兩層預算」是哪兩層？資料模型撐得住嗎？

規格 §4.5 講得很清楚，**兩層都在「單張任務」之內，不是「公司層＋任務層」**：

1. **開跑前**：`token_usage` 依 task 加總 × `costSql` ≥ 上限 → 不開跑，任務停下，客戶管理員可調高上限後按繼續。
2. **跑的時候**：把 `--max-budget-usd <上限 − 已花>` 傳給**這一次**執行。

補充查證：

- `--max-budget-usd` **在本機這版 CLI 真的存在**：`claude --version` → `2.1.267 (Claude Code)`；`claude --help` 有 `--max-budget-usd <amount>  Maximum dollar amount to spend on API calls (only works with --print)`。容器映像正是 `aidev-agent:2.1.267`（rollout plan 階段 1 Task 2.1），版本一致。pipeline 用的正是 `-p`（`claude-runner.js:165`）。
- **全 repo 沒有任何地方傳過這個旗標**（grep `max-budget-usd`／`maxBudget` 零命中）。
- **沒有「公司層月預算」這種東西**，規格裡也沒有。唯一的公司層數量限制是 saas-operations §6 O8 的**同時執行上限**（併發，不是金額），且屬於子專案 4。**如果有人以為「兩層」是公司層＋任務層，那是誤解，要先講清楚。**

**資料模型今天撐不住的地方**（全部實查）：

| 規格要的 | 今天 | 檔:行 |
|---|---|---|
| `companies.task_budget_usd` | 不存在 | `db.js:795-814`；companies 只加過 `features`（`db.js:1251`） |
| `companies.anthropic_api_key_enc`／`_last4`／`_set_by`／`_set_at`／`_verified_at` | 五個都不存在 | 同上 |
| `token_usage.cost_usd` | 不存在，金額一律估算 | `db.js:359-375`、`lib/token-cost.js:33` |
| `token_usage.company_id` | 不存在，只能經 `user_id` JOIN 推 | `db.js:359-375` |
| 失敗輪帶著 token 落帳 | 有列但 token=0（實測近 30 天 62 列） | `claude-runner.js:262`、`token-logger.js:14` |
| 讀 `result.total_cost_usd` | 完全沒接 | `claude-runner.js:330-339` |
| 報表能按公司切、只回自家（P3） | `/api/token-report` 是 **`role==='admin'` 平台管理員限定**，`company_admin` 拿 403；全檔零 `actor`／零公司概念 | `token-report-routes.js:9-11` |
| 公司管理員自助設定面 | 不存在（公司管理端點全是 `requirePlatformAdmin`） | `company-admin-routes.js:19` |

### C5. 所以，七成這個數字對不對

**方向對，但它把難度歸錯地方了。**

- 「換認證本身很小」——**屬實**。注入點只有 `sandbox-run.js:126` 一處，白名單兩行，公司憑證解析有 `git-identity.js:45` 可以逐行照抄，存檔＋驗證有 `company-admin-routes.js:166` 與 `admin-routes.js:114` 可以照抄，掛點連註解都已經寫好等在那裡（`agent-run-token.js:71`）。
- 「花費上限佔七成」——**如果只做規格 §4.5 寫的那兩層，它其實也不大**：停任務的機制（`stale-running.js`）、金額加總（`costSql` ＋ 已有索引）、按關卡之間攔截（`runner.js:513` 的 `ABSORB_ON_ADVANCE`）、token 預算保險絲（`nightly-fix.js:120`）全部是現成的，各照抄一份。
- **真正的工作量不在「上限」而在「上限要準」**，也就是規格自己列在 §4.5 與 §9 的那一句：今天的金額是**估算下限**，而且有三個獨立的低估來源（失敗輪 token=0、`total_cost_usd` 沒接、子 agent 未證死）。客戶拿到帳單跟平台顯示對不上，這是 BYOK 唯一會真的燒到信任的失敗方式，而規格 §7 第 3 步「對帳 Anthropic Console」就是為它而存在的。
- 另外三件在 §4.5 之外、但沒有它就不能上線的事，估計裡沒看到：**(a)** `/api/token-report` 今天對 `company_admin` 是 403 且完全沒有租戶概念（P3 整條要新做）；**(b)** 公司管理員自助面不存在；**(c)** §4.6 的錯誤字面要拿真 key 實測取得，規格明寫「不猜」——這是一段必須花真錢、且不能用測試取代的前置工作。

**我的判斷**：把「換認證 30%／上限 70%」改成「換認證約 25%／上限的機制約 25%／金額準確度與對帳約 30%／客戶看得到的面（報表租戶化＋公司設定頁）約 20%」比較貼近實際。**總量大概沒估錯，但如果照原句去排工，會把「準確度」這塊當成順手做掉的東西，而它才是會拖住上線的那塊。**

---

## D. 卡住開工的事、以及我查不出來的事

### D1. 會擋住開工的（有憑有據）

1. **`canRun` 掛在容器專屬路徑上**（`lib/agent-run-token.js:74-84`，程式自己記錄的已知耦合）。`mode='all'` 時每次都會過，但這是開關的當前值，不是結構保證；`mode` 掉回 `off`／`projects` 就整段跳過。**把「有沒有 key」和「超不超上限」掛在這裡，等於把兩條硬規則綁在一個可以被管理頁改掉的開關上。** 程式碼自己寫了正解：搬到 `startLegacy` 與容器兩條路徑的交會點。
2. **手動入口不受閘門管**（`pipeline/runner.js:614` 的 `if (auto)`）。約 20 個 `runPipeline(userId)` 呼叫點是 auto:false。照抄用量閘門的位置＝上限可被「按繼續」繞過。
3. **`token_usage.task_id` 的唯一性是 per-user**（`db.js:102` vs `token-report-routes.js:90/139/195` 的無 user JOIN）。今天實查 0 碰撞，多租戶之後會變成跨公司的金額串味。
4. **金額低估三來源**（B3）。要先修 `claude-runner.js:262` 把失敗輪的 usage 帶出來，否則「上限」擋的是一個系統性偏低的數字。
5. **`/api/token-report` 沒有租戶概念**（`token-report-routes.js` 全檔零 `actor`）。P3 不是「加一個篩選」，是整支要接上第 2 部的範圍檢查慣例。
6. **§4.6 的錯誤字面還沒實測**。規格明寫要拿撤銷的 key／額度 0 的帳戶去取真字面，比照 `auth-signature.js`／`sandbox-signature.js` 只收 CLI 自己印的字面。沒有這批字面就寫不出正確的 signature，也就分不出「客戶沒錢了」和「Anthropic 在抖」。
7. **前置依賴**：階段 3 在 rollout plan §6 的依賴鏈是 `階段 1 → 2a → 3`。1 與 2a 都已合併上線，這一條不擋。但 §0 表上「四種身分的人工驗收」仍是 0 進度，而階段 3 要新增的公司設定面會再疊一層同樣沒人在瀏覽器按過的前端。

### D2. 我查不出來的（**不要**拿這些當已知）

- **`-p --output-format stream-json` 的 `result` 事件，在用訂閱 OAuth token 跑的時候到底有沒有 `total_cost_usd`、值是否為真實金額。** 規格 §3.3 斷言它有，但我在本機 session 紀錄裡找不到任何真實的 result 事件可以佐證（grep 到的那筆是記憶檔內容，不是事件），而且 pipeline 從來沒讀過它，所以正式庫裡也沒有痕跡。**規格 §4.5 的準確度改善整個壓在這一點上。要跑一次真的 `claude -p` 才知道。**
- **`--max-budget-usd` 用盡時 CLI 的實際行為**：是乾淨地收尾吐出 result 事件、還是非零 exit？字面是什麼？走 stdout 還是 stderr？會不會被 `auth-signature`／`failure-classifier` 誤判成別的類別？沒實測。
- **子 agent 的 usage 有沒有算進主 session 的 `ev.usage`**。記憶 `token-usage-underreports-cost` 說 duration 明確不含、usage「高度可疑但未證死」，本次沒有重新驗證，維持未知。
- **兩家公司共用同一個專案時的家目錄**：容器家目錄是 `data/agent-home/<scope>`（`pipeline/sandbox-run.js:132`），scope 對專案型 agent 是 `project-<id>`（`lib/agent-profiles.js:61-65`），而且是 **rw 掛載**（`lib/agent-sandbox.js:80`）。也就是說 A 公司的人在某專案跑出來的 Claude session 逐字稿，與 B 公司的人在同一專案跑的，**共用同一個目錄**。這在 BYOK 之前只是「同一家人的資料」，之後就是跨公司。我沒有去確認 CLI 在那個目錄裡究竟寫了什麼、以及第 2 部的範圍檢查有沒有涵蓋它——**這需要單獨查一次，別預設它沒事。**
- **對話（chat）沒有 task_id**，所以「單張任務上限」對它完全無效。一個客戶可以在問答裡無限燒自己的 key。規格沒提這件事，我也不知道是刻意還是漏掉。
- **`RATES` 的絕對值是否等於現行 Anthropic 牌價**：`lib/token-cost.js:28-31` 的數字是相對倍率，註解說 codex 那組「未查證」。claude 那幾支沒人說最後一次對價是什麼時候。§7 的對帳步驟會一次驗掉，但在那之前，平台算的金額與真實帳單的差距是未知數。

### D3. 順手撿到、與階段 3 無關但值得記一筆

- `pipeline/failure-classifier.js:69` 把所有認證失敗一律當 transient 重試一次——這在共用憑證時代是對的（併發 spawn 撞 token 輪替），在 BYOK 時代對「客戶的 key 被撤銷」是純浪費（客戶自己付的錢）。
- `lib/claude-auth.js:58` 的「切到 backup 但備用不存在就退回主憑證」邏輯，在 BYOK 之後不能套用到客戶 key 上——規格 §4.4 明文「**絕不退回用平台的認證**」。這是兩條相反的 fallback 哲學共存在同一個模組裡，要分岔時特別小心。

---

## 要你拍板的事

每一條都是二選一，附後果。**不是開放式問題。**

1. **花費上限的執行點，放在「派工迴圈」還是「每次 AI 呼叫」？**
   - 放派工迴圈（`runner.js:655` 那個位置）：自動與手動都擋得到，停下來一定在關卡邊界、不會留半套 diff，照抄現成機制。代價＝一關之內可以超出上限（coding 一關可跑到 2400 秒）。
   - 放 `canRun`（`agent-run-token.js:85`）：粒度細到每次呼叫。代價＝要先修那個「只在容器路徑生效」的已知耦合，否則上限的有效性綁在 `agent_sandbox_mode` 這個開關的當前值上。
2. **超出上限時，是「停在關卡邊界」還是「當場砍掉正在跑的那一關」？**
   - 停在邊界：安全、可續跑、零殘留，**這個功能就是小的**。
   - 當場砍：要接 `--max-budget-usd`，而 `nightly-fix.js:116` 已經寫明半途中斷會留下髒 worktree 與半套 diff，**這個功能就會變大**，而且要先實測 CLI 用盡預算時的行為（今天未知）。
3. **上限比對的金額，用「今天這個會低估的估算值」先上，還是先修準再上？**
   - 先上：可以跟換認證同一批交付。代價＝實際花費必然高於平台顯示，客戶對帳時差距無法解釋，而 BYOK 最不能出的錯就是這個。
   - 先修準（帶出失敗輪 usage＋接 `total_cost_usd`＋對帳 Console）：多一段前置，而且 `total_cost_usd` 到底存不存在要先實跑驗證。
4. **`/api/token-report` 是「開給公司管理員並強制自家範圍」還是「階段 3 先不開給客戶」？**
   - 開：要把整支路由接上第 2 部的租戶範圍慣例（今天全檔零 `actor`），是一塊獨立的工，且沒有自動化前端測試。
   - 不開：客戶看不到自己花了多少，只能看帳單。與規格 §8 P3 已決的內容相反，**要明確推翻那條裁決**。
5. **對話（chat）要不要納入花費管制？**
   - 納入：需要新的一層（每公司／每對話），規格裡沒有，等於加一個子題。
   - 不納入：客戶可以在問答裡不受限地燒自己的 key。錢是客戶的，但「平台沒有任何上限」這件事要寫進條款讓客戶知道。
6. **`ANTHROPIC_API_KEY` 進容器，要不要同時把「兩家公司共用專案時共用容器家目錄」一起處理？**
   - 一起處理：階段 3 多一塊調查與修改（今天連影響範圍都還沒查）。
   - 不處理：先確認那個目錄裡到底有什麼，若含逐字稿就是跨公司可見——**在第一家客戶進來之前必須有答案，不能留到階段 6**。
