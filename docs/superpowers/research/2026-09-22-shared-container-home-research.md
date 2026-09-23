# 共用專案的 AI 容器家目錄：客戶的 AI 讀不讀得到內部人員留下的東西

日期：2026-09-22　／　範圍：唯讀調查，未改任何檔案、未動任何容器
調查對象：`data/agent-home/<scope>`（容器內 `HOME`）

---

## 摘要（先講結論）

家目錄**以「專案」為單位共用、跨執行永久保留、沒有任何清理**。同一專案綁到兩家公司時，兩家的 AI 執行用的是**同一個**家目錄。裡面現在放著該專案歷來每一次 AI 執行的**完整逐字稿**（project-3 共 351 份、151 MB），其中 **85 份逐字稿逐字包含平台廠商自己的私人 `~/.claude/CLAUDE.md` 與 16 KB 的私人記憶索引 `MEMORY.md`**——那份索引點名了其他十幾家客戶、他們的事故、未修的缺陷與 commit 代號。

所以：**是，客戶的執行讀得到內部留下的東西，而且目前留下的東西比「這個專案的內容」嚴重得多。**

---

## A. 家目錄到底共不共用、什麼粒度

### A1. 路徑怎麼決定

`app/server/pipeline/sandbox-run.js:132`

```js
const home = path.join(APP_DIR, 'data', 'agent-home', scope);
```

`scope` 由 `app/server/lib/agent-profiles.js:61-65` 決定：

```js
function runScope(profile, projectId) {
  if (profile.scope !== 'project') return profile.scope;
  const id = Number(projectId);
  return projectId != null && Number.isInteger(id) && id > 0 ? `project-${id}` : 'none';
}
```

**路徑裡沒有公司、沒有使用者、沒有任務、沒有執行序號——只有 `project-<id>`。**
其餘三個固定 scope：`none`、`internal-audit`、`internal-fix`。

`resolveSandboxPlan()`（同檔 92-102 行）只解析 `projectId`，整段流程從頭到尾沒有讀過 `company_id` 或 `project_companies`。

> 粒度結論：**per-project**。不是 per-task、不是 per-run、**不是 per-company**。

### A2. 怎麼掛進容器

`app/server/lib/agent-sandbox.js:80`、`:94`

```js
const all = [{ source: home, readonly: false }, ...mounts];   // 家目錄：可寫
...
argv.push('-e', `HOME=${home}`, ...);                          // 容器內同構路徑
```

掛載目標預設等於來源（同檔 83 行），所以容器內 `HOME` 就是宿主的 `/home/odoo/odoo-v2/data/agent-home/project-<id>`，**可讀可寫**。
容器 root fs 是 `--read-only`、`/tmp` 是 tmpfs（同檔 75 行），但家目錄這個 bind 是唯一持久可寫面。

`--user` 是平台自己的 uid:gid（`sandbox-run.js:161`：`user: \`${d.getuid()}:${d.getgid()}\``）。實測宿主 `id` = `uid=1004(odoo) gid=1004(odoo)`，家目錄檔案 `-rw------- odoo odoo`（`ls -la data/agent-home/project-3/.claude/projects/-home-odoo-odoo-v2-repos-odoo17-hungjou/`）→ **權限上完全讀得到**，0600 擋不住同 uid。

唯一疊在家目錄上的唯讀覆蓋是 skill：`app/server/lib/agent-mounts.js:78-85` 把 `.agents/skills/<name>` 掛到 `$HOME/.claude/skills/<name>`。`.claude/projects/`（逐字稿所在）**沒有任何覆蓋，就是一般可讀寫目錄**。

### A3. 容器是不是每次重建

`app/server/lib/agent-sandbox.js:69`：`'run', '-i', '--rm'`，容器名 `${instanceId}-run-${runId}`（:67）。

- **容器：每次執行新建、結束即刪。** 實測 `docker ps -a --filter label=aidev.run=1` → 0 筆（此刻沒有執行中，`--rm` 已清掉歷史）。
- **家目錄：不是容器的一部分，是宿主目錄，永久留著。** 實測 `ls -la data/agent-home/` → 17 個 scope 目錄，最舊 `Sep 18 08:39`（切換日），至今持續累積。

這是刻意的：`--resume <sessionId>` 續接（`app/server/pipeline/claude-runner.js:180`）要靠 `~/.claude/projects/` 的 session 檔還在。設計文件也這樣寫：
`docs/superpowers/specs/2026-09-11-agent-sandbox-design.md:189`
`| data/agent-home/<scope> → 容器內 HOME | rw | 全部（session 檔、claude 設定） |`

### A4. 這是不是現在就已經發生的情況（不是假設題）

平台 DB 實查（`node .claude/skills/platformDB/query.js "SELECT ... FROM project_companies ..."`）：

| project_id | 專案 | company_id | 公司 | is_internal |
|---|---|---|---|---|
| 3 | 鴻久 | 1 | 內部 | true |
| **3** | **鴻久** | **2** | **測試公司** | **false** |

其餘 16 個專案都只綁內部。**project 3 已經是「內部 + 一家非內部公司」共用**，而 `data/agent-home/project-3` 正是本機最大的那一個（151 MB、351 份逐字稿）。
`users` 表也已有 company 2 的使用者（`kingsmvp3`，role `company_admin`）。

容器隔離是全開的：`teams_settings.agent_sandbox_mode = 'all'`（changed_at 2026-09-18T01:15Z）→ 每一次 AI 執行都走容器、都掛這個家目錄。

**來源標註**：A1~A3 來自程式碼；A2 的權限、A3 的目錄狀態、A4 全部來自這台機器實查。

---

## B. 裡面現在實際有什麼

### B1. 目錄結構（實查 `find data/agent-home/project-3 -maxdepth 2`）

```
project-3/
├── .claude.json                 666 B
├── .claude/
│   ├── projects/                151 MB  ← 逐字稿，全部內容都在這
│   ├── backups/                  24 KB  (.claude.json 的歷史備份)
│   ├── session-env/              25 個 session 目錄（空）
│   ├── shell-snapshots/          空
│   ├── skills/                   （唯讀掛載點）
│   ├── remote-settings.json      {}（空）
│   ├── policy-limits.json        Anthropic 政策旗標，無機密
│   └── .last-cleanup             2026-09-22T02:42:39.708Z
├── .cache/claude-cli-nodejs/    188 KB  （44 份 context7 MCP log）
└── .npm/_logs/                    8 KB
```

### B2. 逐字稿：這是主體

- **351 份 `.jsonl`，151 MB**，散在 55 個 cwd 目錄下（任務 worktree、manual worktree、主 clone、以及家目錄自己）。
- 檔案日期 2026-09-17 ~ 2026-09-22，**一份都沒少**。
- 粗分類（依開頭 prompt 特徵）：analysis/coding/qa 類 286 份、cs（客服）56 份、wiki 7 份、chat 2 份。
- 內容就是 Claude Code 的完整對話紀錄：**系統提示詞全文、任務需求原文、每一次 Bash 指令與其輸出、每一次檔案讀取的內容、AI 的全部推理與回覆**。
- **123 個 base64 內嵌圖片**散在 37 份逐字稿裡（單檔最大 5.3 MB）——AI 對測試環境畫面的截圖，含畫面上的實際資料。

### B3. ⚠ 最嚴重的一項：廠商自己的私人記憶被複製進了專案家目錄

`data/agent-home/project-3` 底下 **85 份逐字稿**逐字包含一個 `attachment / type: instructions` 區塊，內容是這五個檔案的**全文**：

| 路徑 | 類型 | 大小 |
|---|---|---|
| `/home/odoo/.claude/CLAUDE.md` | User（廠商全域私人指令） | 236 B |
| `/home/odoo/.claude/RTK.md` | User | 954 B |
| `/home/odoo/odoo-v2/.claude/CLAUDE.md` | Project（平台本體規則） | 8,199 B |
| `/home/odoo/odoo-v2/.claude/rules/always.md` | Project（平台開發常駐規則） | 2,655 B |
| **`/home/odoo/.claude/projects/-home-odoo-odoo-v2/memory/MEMORY.md`** | **AutoMem（廠商私人記憶索引）** | **16,463 B** |

那份 `MEMORY.md` 是平台廠商自己的工程記憶索引。實際抽讀到的片段（已節錄）包含：

- 其他客戶的公司名與事故：**萊峰、慈雲、凌越、kangyue、raifong、超淨** 等（`grep -rlI` 計數：萊峰 86 檔、kangyue 85 檔、raifong 85 檔、超淨 85 檔、慈雲 57 檔、凌越 57 檔）
- 各客戶的事故細節與結論（「萊峰19 丟掉 634 個附件檔的全鏈」、「多 repo 首航一次撞出 5 個缺陷…task 186 卡死」）
- **平台自己未修的缺陷與其成因**、哪些修正「已 push 未重啟未實測」
- commit 代號、分支策略、內部部署拓樸的指涉

跨專案盤點（`grep -rlI "/home/odoo/.claude/projects/-home-odoo-odoo-v2/memory/MEMORY.md" <每個 home>`）：

| home | 帶有廠商 MEMORY.md 的逐字稿 |
|---|---|
| **project-3** | **85** |
| project-19 | 6 |
| project-6 | 5 |
| project-18 | 4 |
| project-11 | 2 |
| project-10 / 13 / 2 / 8 | 各 1 |
| 其餘 project-* | 0 |
| internal-audit / internal-fix | 0 |

**怎麼進去的**：這些檔案的 mtime 全部是 `2026-09-18 08:39`，也就是容器化切換日。
`app/server/lib/agent-session-migrate.js:42`

```js
if (wtExists) add('dir', path.join(src, encodeProjectDir(wt)), path.join(dest(t.project_id), encodeProjectDir(wt)), `task ${t.id} worktree`);
```

切換工具（`tools/copy-agent-sessions.js`）把切換前「在宿主上直接跑」的 session **整個目錄**複製進各專案的家目錄。那些宿主執行會由 Claude CLI 自動載入 `~/.claude/CLAUDE.md` 與 auto-memory，所以逐字稿裡就帶著全文。

**現在還會不會繼續發生**：不會。切換後的執行在容器裡，`/home/odoo/.claude` 根本沒掛進去。實測「含 `/home/odoo/.claude/CLAUDE.md` 的逐字稿」最新一份是 `2026-09-18 08:39`，之後（到 09-22）沒有新增。**但已經複製進去的 85 份還在原地，沒有被清掉。**

### B4. 憑證與 token（沒有明文外洩，但要講清楚）

於 `data/agent-home/project-3` 全樹掃描（只數命中檔數，不輸出值）：

| 樣式 | 命中 |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | 0 |
| `sk-ant` | 0 |
| `CONTEXT7_API_KEY` / `ctx7sk` | 0 |
| `PGPASSWORD` | 0 |
| `BEGIN RSA` / `BEGIN OPENSSH` | 0 |
| `AIDEV_AI_TOKEN` | 114 檔，**全部只是 shell 裡的變數名**（`-H "X-AIDEV-AI-TOKEN: $AIDEV_AI_TOKEN"`），無字面值 |
| `admin_passwd` | 2 檔，**是 grep 的搜尋字串**，不是值 |

`.claude.json`（666 B）只有 `machineID`、`userID`、遷移旗標等；**沒有 `projects` 區塊、沒有 prompt history**。
`.claude/backups/` 是同一個小檔的 5 份歷史備份。
`shell-snapshots/`、`session-env/` 皆空。

> 也就是說：**家目錄裡沒有可直接盜用的憑證**。風險全部在「內容」而不是「金鑰」。

### B5. 其他可帶內容的東西

- `.cache/claude-cli-nodejs/**/mcp-logs-context7/*.jsonl`（44 份）：context7 MCP 的查詢紀錄，透露查過哪些函式庫／主題。
- `.npm/_logs/*.log`：兩份，只有安裝失敗訊息。
- 逐字稿裡的檔案路徑本身就洩漏了專案的 repo 結構、worktree 命名、任務編號序列。

---

## C. 有沒有東西會清

**平台自己：沒有。一行都沒有。**

- 全 repo 搜 `agent-home` 的寫入／刪除引用：只有三處會產生它（`sandbox-run.js:132` 建目錄、`agent-session-migrate.js:26` 複製進去、`tools/copy-agent-sessions.js`）。**沒有任何 rm / rmSync / 保留期掃描指向 `data/agent-home`。**
- `app/server/cron.js` 的清理只涵蓋兩件事：`data/logs/*.log`（`DEPLOY_LOG_RETENTION_DAYS`，預設 14 天，cron.js:64-81）與 `token_usage`（180 天）。與家目錄無關。
- `app/server/lib/agent-orphans.js`：平台啟動時 `docker rm -f` 殘留**容器**（依 label），**不碰家目錄**。
- `app/server/lib/agent-objects.js:153,161` 的 `rmSync`：清的是每任務 git 物件庫，不是家目錄。
- 容器映像（`docker/agent/Dockerfile`）不含任何 entrypoint 清理，明寫「容器內家目錄由 --mount 掛入…不在映像內建任何設定檔」。

**Claude CLI 自己：有，但形同沒有。**
`.claude/.last-cleanup` = `2026-09-22T02:42:39.708Z`，代表 CLI 內建的 session 保留期清理有在跑。但家目錄裡沒有任何 `settings.json` 設定 `cleanupPeriodDays`（`--settings` 只併入 scan-guard 的 hook 設定，`claude-runner.js:88-102`，內容實查只有一個 PreToolUse hook）。以 CLI 預設保留期計，目前**最舊的檔案才 5 天**，等於至今一份都沒被刪。

**有沒有東西擋 AI 去讀？**
`app/server/pipeline/hooks/scan-guard.js` 是唯一的讀取面守衛，但：
- 它只掛在 `Bash`（`matcher: 'Bash'`），**Read / Grep / Glob 工具完全不經過它**；
- 它擋的是「掃根目錄」（`isBroadRoot`：`/`、`/home`、`~`、`odoo-envs`…，scan-guard.js:7-23）。`$HOME/.claude/projects` 不在名單內，`ls ~/.claude/projects`、`cat <某份 jsonl>`、`grep` 該目錄**全部放行**。

> C 結論：**沒有任何機制會在兩次執行之間清掉家目錄，也沒有任何機制阻止容器裡的 AI 去讀它。**

---

## D. 裁決

### 問題：專案由內部公司＋客戶公司共用時，客戶的執行讀不讀得到內部執行留下的東西？

**讀得到。而且不需要任何繞過技巧——`ls ~` 就看得到。**

客戶公司的使用者在共用專案上觸發任何 AI（chat 排障、cs 客服、或任務 pipeline），`runScope` 算出的 scope 就是 `project-<id>`，家目錄就是內部人員先前所有執行寫過的同一個目錄，以同一個 uid 可讀可寫掛進容器。

### 具體讀得到什麼（照 project-3 的實際內容，不是理論）

按嚴重度排序：

1. **廠商的私人工程記憶索引（16 KB）與私人全域指令，完整存在 85 份逐字稿裡。**
   內含**其他十幾家客戶的公司名、他們的事故經過與結論、平台自己未修的缺陷、哪些修正沒重啟沒實測、commit 代號**。
   這一項不只是「跨公司」，是**跨客戶**——客戶 A 的 AI 讀得到客戶 B、C、D 的事故。這遠超出「共用專案」本來要共用的範圍。

2. **該專案歷來全部 351 份 AI 逐字稿（151 MB）**：內部人員問過什麼、AI 執行過的每一條指令與輸出、讀過的每一段程式碼、內部對這個客戶案子的技術判斷與抱怨、尚未交付／被退回的方案。
   客戶看得到的平台畫面只呈現定稿結果；逐字稿是**過程全紀錄**，兩者落差就是曝險面。

3. **123 張內嵌截圖**，含測試環境畫面上的實際資料。

4. 次要：context7 查詢紀錄、repo/worktree 結構、任務編號序列。

### 嚴重度評分

- **機密外洩面：高。** 主因是第 1 項——它把「單一共用專案的邊界」變成「全客戶群的邊界」。而且這不是推論，是實查到的檔案內容。
- **可利用性（取得憑證／橫向移動）：低。** 家目錄裡沒有任何明文 token、金鑰、密碼、私鑰（B4 實查）。`AIDEV_AI_TOKEN` 是每次執行新發、有 TTL，且只以變數名出現。
- **觸發難度：極低。** 不必是惡意攻擊——客戶方使用者只要在 chat 裡叫 AI「看看你的家目錄有什麼」，或 AI 自己為了找脈絡去翻 `~/.claude/projects`，就會讀到。逐字稿內容還會被 AI 摘要進回覆裡，**變成畫面上的文字交給客戶**。
- **目前實際曝險：尚未發生，但門是開的。** project 3 已經綁了非內部公司（測試公司）且已有該公司的使用者帳號。目前這家是「測試公司」不是真客戶，所以還沒真的出事。

### 信心水準

**對「共用」與「讀得到」：高。** 路徑組法、掛載旗標、uid、檔案權限、cleanup 缺席，五項都各自從程式碼與這台機器上驗過，彼此一致。

**對「已經有 85 份逐字稿帶著廠商私人記憶」：高。** 直接解析 jsonl 的 `attachment/instructions` 區塊，五個檔案路徑與位元組數都印出來了，跨 17 個 home 盤點過。

**我沒查、因此不敢斷言的兩件事：**
1. 是否有「非 `project-` scope」的路徑也會被客戶觸發到（我只確認 `chat`／`cs`／pipeline 各關的 profile 都是 `scope: 'project'`，`internal-audit`／`internal-fix` 家目錄客戶碰不到，因為沒有客戶可觸發的 agentType 用那兩個 scope——但這是從 `AGENT_PROFILES` 表推的，沒有實跑驗證）。
2. 前端／API 是否已經擋住客戶公司使用者在共用專案上觸發 AI（租戶範圍檢查第 2 部剛合併）。**就算擋住了也只是把時間點往後推**：只要「共用專案」這個功能真的要用，這條路就會通。

---

## 第一家客戶進來之前，這件事需不需要先處理

**需要，而且是硬前置條件。** 不是因為機制本身（per-project 家目錄配 `--resume` 是合理設計），而是因為**目前那 85 份逐字稿裡躺著點名其他客戶的廠商私人記憶**——共用專案一旦對真客戶開啟，客戶的 AI 一句話就讀得到別家客戶的事故清單，這是客戶資料跨公司邊界，不是內部整潔問題。
