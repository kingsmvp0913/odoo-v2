# 一鍵安裝 + Repo 瘦身設計

日期：2026-07-08
狀態：設計定稿，待轉 implementation plan
本文件為 design-time 草稿，`docs/` 將移出 git 追蹤，故本檔本機留存、不 commit。
給新主機用的部署說明另以 tracked 的 `DEPLOY.md` 交付（見「交付物」）。

## 1. 目標與成功條件

在**全新 Windows 或 Linux 主機**上，以一道指令把整個 odoo-v2 AI 開發平台拉起來，涵蓋：
系統依賴 → PostgreSQL → App → **Claude Code 環境（CLI + MCP + plugin + skills）** → 啟動，
讓網頁 pipeline 能實際運行。

**成功條件**：
1. 在乾淨 Windows 11 與乾淨 Linux（Ubuntu/Debian 系）各跑一次入口腳本，中途只需：
   互動輸入 PG 連線與 API key（選填）、完成一次 `claude` 訂閱登入。
2. 完成後 `http://localhost:3939` 可開，且能成功觸發一個專案的「建立測試環境」
   （代表 git/python/odoo-bin/chrome/PG 皆到位）。
3. `git status` 不再含個人/環境相依檔（notice.wav、ppt、C:\odoo 路徑、serena-online 死設定）。
4. 重跑入口腳本為 idempotent：已裝的階段跳過，不破壞既有 config/資料。

## 2. 環境相依盤點（換機會缺什麼）

現有 `install.ps1/.sh` 只做 Node → npm → 互動 config → 啟動，**未涵蓋**下列執行期相依：

**外部 CLI（pipeline 會 spawn）**
| 指令 | 出處 | 用途 |
|------|------|------|
| `claude` | `app/server/pipeline/claude-runner.js:52`（帶 `-p --dangerously-skip-permissions`）| 執行各階段 agent，核心 |
| `git` | `app/server/pipeline/git.js`（40+ 處）、`env-agent.js:166` | clone/worktree/merge；clone odoo 原始碼 |
| `python`/venv | `app/server/pipeline/env-agent.js:144,168`（`PYTHON_BIN` 可覆寫）| Odoo venv |
| `odoo-bin` | 動態 clone `github.com/odoo/odoo`（`env-agent.js:166`）| 升級/測試 |
| Google Chrome | `app/server/pipeline/env-agent.js:83`（缺則環境報 error）| tour E2E |
| `uv`/`uvx` | serena MCP 啟動指令 | 跑 serena |
| PostgreSQL | `app/server/db.js`、`env-agent.js:64` | App 與 Odoo 共用同一台 |
| `ssh-keygen`/`ssh-keyscan` | `app/server/admin-routes.js:210,216` | Git SSH 金鑰（選用）|

**環境變數**：必需 `DATABASE_URL`、`JWT_SECRET`、`APP_SECRET`、`PORT`（由 `data/config.json` 載入）；
選用 `ANTHROPIC_API_KEY`、`PYTHON_BIN`、`REPOS_BASE_DIR`、`ODOO_ENV_BASE`、`DEPLOY_LOG_DIR`、`PIPELINE_MAX_*`。

**Claude Code 環境**：MCP `serena`（user-scope，經 `--context claude-code`）；
plugins `superpowers`/`hookify`/`code-review`/`context7`/`security-guidance`（對齊 `settings.json` `enabledPlugins`）；
skill `getSQL`（repo 內 `.claude/skills/getSQL`）；agents `.claude/agents/*.md`（已 tracked）。

**gitignore 現況良好**：`/odoo-envs/`、`/repos/`、`data/config.json`、`.env` 已排除，執行期產物不進 git。

## 3. 架構：native bootstrap → 共用 Node setup

現有 `install.ps1` 與 `install.sh` 重複了 config/啟動邏輯；跨平台又要全自動，重複會 drift。改為：

```
install.ps1 ┐ 各自 native bootstrap  ┌ 只做「裝系統套件」(winget / apt|brew)
install.sh  ┘ （唯一必須平台化的段）─┤   Node/Git/Python/Chrome/uv/PostgreSQL
                                      └→ 交棒 scripts/setup.js（跨平台共用）
                                           ├ ensurePostgres（起服務、建 role+db，存在則跳過）
                                           ├ npm install（app/）
                                           ├ ensureConfig（互動產 data/config.json，沿用現有邏輯）
                                           ├ ensureClaudeEnv（CLI/login 引導/MCP/plugin/skills）
                                           └ start（載 config env → node app/server/index.js → 開瀏覽器）
```

**理由**：Node 於 bootstrap 裝妥後，所有跨平台邏輯集中在單一 `setup.js`，
Windows/Linux 差異縮到只剩「裝系統套件」這段本就必須平台化的部分（符合 CLAUDE.md
「Surface Conflicts, Don't Average」——不再維護兩份會分歧的 config 邏輯）。

## 4. 元件與介面

每個模組單一職責、可獨立測試，`setup.js` 只做編排：

| 模組 | 職責 | 依賴 | 對外介面 |
|------|------|------|----------|
| `install.ps1` / `install.sh` | 平台系統套件安裝（含 Node），然後 `node scripts/setup.js` | winget / apt\|brew | 入口 |
| `scripts/setup.js` | 編排各階段、idempotent、fail-loud | 下列 lib | `node scripts/setup.js [--skip-start]` |
| `scripts/lib/postgres.js` | 確保 PG 服務起、建 role/db（存在則驗證不覆蓋）| `pg`（app 已有）| `ensurePostgres(cfg)` |
| `scripts/lib/config.js` | 互動產 `data/config.json`、自產 JWT/APP secret | node crypto | `ensureConfig()` → cfg |
| `scripts/lib/claude-env.js` | 裝 CLI、引導 `claude login`、`claude mcp add serena`、`plugin marketplace add`＋`plugin install`、校驗 getSQL skill | `claude` CLI | `ensureClaudeEnv()` |
| `scripts/lib/checks.js` | 偵測 chrome/git/python/uv 是否就緒，缺則 fail-loud 指引 | fs | `verifyRuntimeDeps()` |

**跨平台系統套件對照**（bootstrap 內）：
| 套件 | Windows(winget id) | Linux(apt) |
|------|--------------------|------------|
| Node LTS | `OpenJS.NodeJS.LTS` | `nodesource setup_20.x` |
| Git | `Git.Git` | `git` |
| Python | `Python.Python.3.12` | `python3 python3-venv python3-pip` |
| Chrome | `Google.Chrome` | `google-chrome-stable`（或 chromium）|
| uv | `astral-sh.uv` | `curl -LsSf astral.sh/uv/install.sh \| sh` |
| PostgreSQL | `PostgreSQL.PostgreSQL` | `postgresql` |

## 5. Claude 環境階段（ensureClaudeEnv 細項）

1. **裝 CLI**：`npm i -g @anthropic-ai/claude-code`（Node 已備妥）。已存在則跳過。
2. **引導訂閱登入**：偵測未登入 → 提示並跑互動 `claude`／`claude login`（訂閱額度）。
   **此步無法全自動**，腳本停下等使用者完成，明確標示。
3. **註冊 MCP**：
   `claude mcp add --scope user serena -- uvx --from git+https://github.com/oraios/serena serena start-mcp-server --context claude-code --project-from-cwd`
   （帶對 `--context claude-code`，關掉重複的 file/shell 工具）。已註冊則跳過。
4. **裝 plugins**：`claude plugin marketplace add <official>` →
   `claude plugin install superpowers@… hookify@… code-review@… context7@… security-guidance@…`
   （對齊 `settings.json` `enabledPlugins`）。逐一 idempotent。
5. **skills**：確認 repo 內 `.claude/skills/getSQL/SKILL.md` 可被載入；不再依賴 repo 外 `C:\odoo` 複本。

## 6. Repo 瘦身（去個人化 / 去環境相依）

查證結論：
- `serena-online`（`settings.json:20`）**確認死設定**：全 repo 僅此一處引用，無 `.mcp.json`
  定義它，無程式使用；實際 serena 走 user-scope。→ 刪該行。
- `kingsmvpsplan/`：`app/**/*.js` **零引用**，僅退役 PS1 pipeline 的 docs 提到；git 只追蹤空
  `.gitkeep`。→ `git rm -r` 移除，並清掉 `.gitignore` 內 4 行相關規則。
- `docs/`：執行期 `app/**/*.js` **零引用**，純設計史料。→ `git rm -r --cached` 停追蹤 +
  `.gitignore`（本機保留參考）。

動作清單：
| 對象 | 動作 | 理由 |
|------|------|------|
| `settings.json` Stop hook（notice.wav 段）| 刪整段 hook | odoo-v2 不需提示音 |
| `.claude/tools/notice.wav` | `git rm`（連本機刪）| 同上 |
| `.claude/tools/ppt/` | `git rm -r`（連本機刪）| 不需要 |
| `settings.json:20` `serena-online` | 刪該行 | 已查證死設定 |
| `kingsmvpsplan/` | `git rm -r` + 移除 gitignore 4 行 | 退役、零引用 |
| `docs/` | `git rm -r --cached` + gitignore | 執行期零引用，本機留史料 |

**動 `settings.json` 已獲使用者明確同意**（CLAUDE.md 規範要求）。
runtime `.js` 不改（`env-agent.js` 用 `ProgramFiles`/`PYTHON_BIN` env 覆蓋已足夠）。

## 7. 錯誤處理（fail-loud，對齊 CLAUDE.md Rule 12）

- 每個系統套件安裝失敗 → 停並印手動安裝指引（含官方連結），不靜默續跑。
- `claude login` 未完成偵測到 → 明確要求登入後重跑，不假裝成功。
- Chrome/uv/git/python 任一缺 → `verifyRuntimeDeps()` 於啟動前一次列出所有缺項。
- PostgreSQL 已存在同名 db/role → 驗證連線可用即跳過；連不上才報錯，不覆蓋既有資料。
- 每階段以「已完成 marker / 既有狀態」判斷 idempotent，重跑不破壞。

## 8. 測試（對齊 Rule 9：驗證意圖）

- `scripts/lib/*.js` 各模組單元測試（沿用 repo 既有 Jest）：
  - `postgres.js`：db 已存在時**不**重建（守住「不覆蓋既有資料」意圖）。
  - `config.js`：既有 config 缺 `APP_SECRET` 時補產且不動其他欄（守住升級相容）。
  - `claude-env.js`：serena 已註冊 / plugin 已裝時跳過（守住 idempotent 意圖）。
- 手動驗收：乾淨 Windows + 乾淨 Linux 各跑一次達成 §1 成功條件。

## 9. 交付物

1. 改寫 `install.ps1` / `install.sh`（瘦成 bootstrap）
2. 新增 `scripts/setup.js` + `scripts/lib/{postgres,config,claude-env,checks}.js`
3. 更新 `.gitignore`；執行 `git rm` / `git rm --cached` 清單
4. `settings.json` 去個人化修正（刪 notice.wav hook、刪 serena-online）
5. **`DEPLOY.md`（tracked）**：新主機部署步驟、必需/選用相依、疑難排解
6. 各 lib 模組單元測試

## 10. 明確不做（YAGNI）

- 不自動化 `claude login`（訂閱登入本質需人）。
- 不動 `--dangerously-skip-permissions` / `bypassPermissions`（pipeline 無人跑刻意設計）。
- 不改 runtime `.js`（env 覆蓋已足夠）。
- 不自建 Odoo 原始碼快取（pipeline 已按專案版本動態 clone）。
