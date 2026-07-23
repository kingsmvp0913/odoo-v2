# 部署指南

全新 Windows 或 Linux 主機，一道指令拉起 odoo-v2 AI 開發平台。

## 必需相依

腳本會自動安裝，若自動安裝失敗才需手動處理：

| 項目 | 用途 | 手動安裝 |
|------|------|----------|
| Node.js 20 LTS | 執行 App | https://nodejs.org |
| Git | clone/worktree/merge Odoo 原始碼 | https://git-scm.com/downloads |
| Python 3 | Odoo venv | https://www.python.org/downloads/ |
| Google Chrome | tour E2E 測試 | https://www.google.com/chrome/ |
| uv / uvx | 啟動 serena MCP | https://astral.sh/uv/install |
| PostgreSQL（含 psql） | App 與 Odoo 共用資料庫 | https://www.postgresql.org/download/ |
| xmllint（libxml2） | XML view 格式驗證（`xmllint --noout`） | Linux 由 `install.sh` 自動裝 `libxml2-utils`；Windows 選用 |

選用：`ssh-keygen`/`ssh-keyscan`（Git SSH 金鑰功能，多數作業系統內建）。

## 快速開始

**Windows**（PowerShell）：
```powershell
.\install.ps1
```

**Linux**（bash，Ubuntu/Debian 系）：
```bash
./install.sh
```

安裝過程中僅需：
1. 輸入 PostgreSQL 連線資訊：`PG_HOST`/`PG_PORT`/`PG_DB` 可直接 Enter 用預設值（`localhost`/`5432`/`aidev`）；**`PG_USER` 必填**（留白會導致 `DATABASE_URL` 不合法而中止，預設帶 `aidev`），`PG_PASSWORD` 建議設定。
2. 選填 `ANTHROPIC_API_KEY`（資料庫查詢 AI 功能用，可留空稍後補）。
3. 完成一次 `claude` 訂閱登入（跳出登入畫面時完成即可，此步無法自動化）。

完成後瀏覽器會自動開啟 `http://localhost:3939/setup.html`。

> **Ubuntu 首次安裝兩個常見手動點**：
> - **PostgreSQL peer auth**：`apt` 裝的 `postgres` 帳號預設無密碼、走 peer auth，腳本的 admin 連線常失敗而無法自動建 role/db。裝前先 `export PGADMIN_USER=postgres PGADMIN_PASSWORD=...`，或先 `sudo -u postgres psql` 手動建好 role＋db（腳本偵測已存在會跳過）。詳見下方「疑難排解」。
> - **Docker 群組需重登**：`install.sh` 裝完 Docker 後把你加進 `docker` 群組，但**當前 session 尚未生效**，VPN Gateway image 這關會被 `[SKIP]`。登出再登入後重跑 `node scripts/setup.js` 即補上（非必要功能可略過）。

日後啟動（不重跑安裝）：Windows 用 `.\start.ps1`，Linux 用 `./start.sh`。

## Docker 模式（Linux）

適用於「公司規定服務必須跑在容器內」或宿主低位埠已被其他服務佔滿的機器。平台本體跑在單一容器內，
測試區 Odoo 以平行（sibling）容器建立。Windows 機不適用，維持原本的 `install.ps1` 流程。

```bash
cp .env.example .env      # 依實際位置調整 HOST_REPO_DIR / HOST_ENV_BASE
mkdir -p "$HOST_ENV_BASE" # 先自己建，否則 bind mount 會由 docker 建成 root 擁有、容器內寫不進去
docker compose up -d
docker exec -it odoo-v2 node scripts/setup.js --skip-start
docker exec -it odoo-v2 claude          # 一次性訂閱登入，憑證存於 volume
docker restart odoo-v2
```

平台埠 `8771`、容器內 PostgreSQL 埠 `8772`、測試區埠範圍由 `config.json` 的
`PROJECT_PORT_MIN`／`PROJECT_PORT_MAX` 指定。

**同構掛載**：`.env` 的 `HOST_REPO_DIR`／`HOST_ENV_BASE` 會同時作為宿主與容器內的路徑。兩者必須
相同——平台在容器內 spawn `docker run -v <path>` 時，該路徑由宿主的 docker daemon 解讀，路徑不
同構會讓測試區掛到不存在的目錄、自訂 addons 全數遺失。

**容器身分**：image 內的 `odoo` 使用者 uid/gid 固定 `1004:1004`（對齊宿主）並屬 gid `999`
（宿主 `docker` 群組）。若你的宿主 uid/gid 不同，需同步修改 `Dockerfile` 內的對應數值。

**修改 `docker/entrypoint.sh` 後必須 `docker compose build`**：它是 `COPY` 進 image 的，
只 `restart` 不會生效（容器會拿舊版，症狀是改動看起來完全沒作用）。

**PostgreSQL 監聽位址每次啟動重新偵測**：測試區容器經 `host.docker.internal` 連進來，該位址即
宿主 docker0 的 IP，各機 daemon 的 `bip` 設定不同（docker 預設 `172.17.0.1`，本機為 `10.0.0.1`），
故由 entrypoint 偵測後寫入 `conf.d/odoo-v2.conf` 與 `pg_hba.conf`；偵測不到時可用
`PG_BRIDGE_ADDR`／`PG_BRIDGE_NET` 覆寫。

**容器重建後需重跑 `setup.js`**：claude 的登入憑證在 `claude-home` volume 內會保留，但 MCP／
plugin 設定寫在容器檔案系統的 `~/.claude.json`，`compose up` 重建容器時會消失，重跑
`docker exec -it odoo-v2 node scripts/setup.js --skip-start` 即補回（idempotent，不會動到資料庫）。

## ⚠️ 硬限制：僅允許單一 Node 行程

App 的互斥機制（任務派工去重 `_inFlight`、專案鎖 `project-lock`、環境建置去重、approve 佔位）
全部存在 **Node 行程記憶體內**，不在資料庫。因此：

- **禁止** `pm2 -i 2`／cluster mode／同時起兩個 `node server/index.js`。
- **禁止** 兩台機器指向同一個 PostgreSQL 各跑一份 App。

違反時兩個行程各持一份互不知情的鎖：同一任務會被重複派工、同專案的 merge/deploy 併發寫壞
共用主 clone、測試環境會 spawn 兩個 Odoo 搶同一 port——症狀（git 損壞、port 衝突）看不出根因。
需要水平擴展時，先把上述互斥全數改為 PostgreSQL advisory lock 再說。

## 重跑安裝

`install.ps1`/`install.sh` 與 `scripts/setup.js` 皆為 idempotent：已安裝的系統套件、已存在的 `data/config.json`、已就緒的 PostgreSQL role/db、已登入的 Claude、已裝的 MCP/plugin 都會跳過，不會覆蓋既有資料。

只想重跑「Claude Code 環境／PostgreSQL／相依檢查」而不重開瀏覽器，可用：
```bash
node scripts/setup.js --skip-start
```

## 疑難排解

- **`claude 登入未完成`**：重新執行 `node scripts/setup.js`，在跳出的畫面完成登入。
- **`PostgreSQL` 連線失敗（Linux peer auth）**：部分 Linux 發行版 `postgres` 系統帳號預設無密碼、走 peer auth，`ensurePostgres` 的管理者連線可能失敗。此時可設定環境變數 `PGADMIN_USER`/`PGADMIN_PASSWORD` 後重跑，或改用 `sudo -u postgres psql` 手動建立 role/db 後再重跑（腳本偵測到已存在會跳過建立）。
- **找不到 Google Chrome**：`verifyRuntimeDeps()` 會在啟動前列出缺項；依提示網址安裝後重跑。
- **`APP_SECRET`/`JWT_SECRET` 遺失**：`scripts/lib/config.js` 的 `ensureConfig()` 會在既有 `data/config.json` 缺這兩個欄位時自動補產，不需手動處理。

## 環境變數清單

必需（由 `data/config.json` 載入）：`DATABASE_URL`、`JWT_SECRET`、`APP_SECRET`、`PORT`。

選用：`ANTHROPIC_API_KEY`、`PYTHON_BIN`、`REPOS_BASE_DIR`、`ODOO_ENV_BASE`、`DEPLOY_LOG_DIR`、`PIPELINE_MAX_*`、`PGADMIN_USER`、`PGADMIN_PASSWORD`。
