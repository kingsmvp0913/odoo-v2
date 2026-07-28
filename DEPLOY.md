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

## 掛在既有網域的子路徑下（反向代理）

平台可掛在既有網域的子路徑（本機為 `https://web-test.ideaxpress.biz/odooAiDev/`）。前端會從
`document.baseURI` 推導前綴，**伺服器端與 `config.json` 皆不需任何設定**——Windows 本地開在根
路徑時前綴自動為 `/`，行為與未反代時逐字相同。故本節只需在反向代理端設定。

於既有 server block 內加入（本機的 nginx 跑在容器 `agency-NginxUI-1`，設定檔為
`sites-available/IDX`；改完 `nginx -t` 通過再 `nginx -s reload`）：

```nginx
location /odooAiDev/ {
    proxy_pass http://host.docker.internal:8771/;   # 尾斜線＝剝掉前綴，後端看到的路徑與本地相同
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 50m;
    proxy_read_timeout 600s;
}
location = /odooAiDev { return 301 /odooAiDev/; }
```

兩個踩到才會發現的前提，且**本地無 nginx 的環境完全重現不了**：

- **`client_max_body_size` 必須在此覆蓋**。`nginx.conf` 的 http 層全域值為 `2m`，不覆蓋則任務
  附件超過 2MB 會被 nginx 擋成 413，請求根本到不了 App。
- **`Upgrade`／`Connection` 標頭必須帶**。缺了 socket.io 會在 websocket 握手失敗後**靜默**退回
  polling——功能全部正常，只有即時通知變慢，不會有任何錯誤訊息。驗收時要確認
  `_socket.io.engine.transport.name === 'websocket'`，不能只看畫面會動。

不需要 `app.set('trust proxy')`：App 全程未使用 `req.ip`／`req.protocol`／`req.secure`。

### 測試區也要一起反代（否則「開啟測試區」點不開）

平台掛上網域後，使用者的瀏覽器不再位於宿主機上，但測試區預設綁在宿主的 `127.0.0.x:<port>`
——那個位址在使用者的電腦上指向他自己，連結看起來正常、點下去連不上。**本機開發永遠重現不了**
（瀏覽器就在宿主上）。

**採 port 模式**（同網域不同埠）：所有測試區共用一個裸網域、靠 port 區分，例
`https://odoo-ai-dev.ideaxpress.biz:21000`、`:21001`…。為何不用 wildcard 子網域——DNS 若託管在
不支援 `*` 記錄、也無 ACME DNS API 的商（如 Wix），wildcard 起不來；port 模式只需**裸網域一張
HTTP-01 憑證**（可一鍵簽、自動續期），憑證只認主機名不認 port、一張蓋全部埠，且新專案自動配埠、
**零人工 DNS/憑證**。

> Odoo 不支援掛子路徑（`/web`、`/odoo`、asset 皆 root-absolute），故只能子網域或 port、不能子路徑。
> cookie 依 host 隔離、不看 port——同網域多埠共用 cookie；但真人一次只操作一個測試區、E2E 各跑在
> 獨立瀏覽器 context，故實務上不受影響。

設定（`data/config.json`，全 opt-in，未設＝維持 loopback、Windows／未反代機不受影響）：

| key | 值 | 用途 |
|-----|----|----|
| `ENV_BIND_HOST` | docker0 閘道（本機 `10.0.0.1`；`ip -4 addr show docker0`） | 測試區容器改綁此位址，讓另一容器的 nginx 連得到（綁 loopback 必 502） |
| `ENV_PUBLIC_URL_TEMPLATE` | `https://odoo-ai-dev.ideaxpress.biz:{port}` | 對外網址；SSO 導向亦沿用此值 |
| `NGINX_CONTAINER` | `agency-NginxUI-1` | 平台 `docker exec` 對它 `nginx -t`／`-s reload` |
| `NGINX_SYNC_CONF_FILE` | 共享 conf 路徑（例 `/etc/nginx/conf.d/odoo-envs.conf`） | **同步總 gate**；平台自動寫入每 port 的 ssl server block |
| `ENV_TLS_CERT` / `ENV_TLS_KEY` | 裸網域憑證／私鑰路徑（nginx 容器內） | 每段 server block 共用 |

平台依 running 測試區自動產生（`lib/nginx-map.js`；寫檔後 `nginx -t` 過才 reload、壞就 rollback），
每個 port 一段：

```nginx
server {
    listen 21000 ssl;
    server_name odoo-ai-dev.ideaxpress.biz;
    ssl_certificate     /etc/nginx/ssl/odoo-ai-dev.ideaxpress.biz_P256/fullchain.cer;
    ssl_certificate_key /etc/nginx/ssl/odoo-ai-dev.ideaxpress.biz_P256/private.key;
    location / {
        proxy_pass http://10.0.0.1:21000;         # ENV_BIND_HOST:同埠
        proxy_set_header Upgrade $http_upgrade;    # 缺了 Odoo bus/longpolling 靜默退化
        proxy_set_header Connection "upgrade";
        # Host／X-Forwarded-*／client_max_body_size 50m／proxy_read_timeout 600s
    }
}
```

一次性人工（平台不自動）：於 NginxUI 簽裸網域 HTTP-01 憑證；重建 `agency-NginxUI-1` 對外 publish
`PROJECT_PORT_MIN`–`MAX`（綁公網／區網介面，與 `10.0.0.1` 的容器不同介面、不衝突）；`nginx.conf`
的 `include conf.d/*.conf` 需在 `http{}` 內（才放得下 server block）。

> **埠池為租約制**：`PROJECT_PORT_MIN`–`MAX`（或管理員介面的池範圍）**必須等於**「nginx 容器 publish 的埠段
> ∩ 對外 NAT／防火牆放行段」。平台只在池內借還，專案總數不受限，同時運行數上限＝槽數。
>
> 現況（2026-07-28）：nginx publish `21000-21099`、NAT `21000-21012` 同號一對一、池設 `21000-21012`。
> 要擴充併發只需在管理員介面把上限往上拉——但**上限超過 NAT 放行段會靜默失效**
> （nginx 收得到、外面進不來），拉之前先確認 NAT 已放行該段。
>
> 埠池專屬：這段埠不得再給機器上其他服務使用。閒置測試區會自動停機並歸還埠
> （`ENV_IDLE_TIMEOUT_MIN`，預設 60 分；池滿時徵收門檻 `ENV_IDLE_TIMEOUT_PRESSURE_MIN`，預設 15 分；
> 壽命上限 `ENV_MAX_LIFETIME_HOURS`，預設 8 小時）。

> 安全提醒：曝露的埠段務必以 **VPN／IP 白名單**擋在可信來源內——測試區跑未審程式碼，且與平台
> 共用 PostgreSQL superuser（見設計文件殘留風險），攻進一個測試區有機會跨庫觸及平台 DB。
> 測試區帳號（含 E2E）不應暴露到可信網路以外。

## ⚠️ 硬限制：僅允許單一 Node 行程

App 的互斥機制（任務派工去重 `_inFlight`、專案鎖 `project-lock`、環境建置去重、approve 佔位）
全部存在 **Node 行程記憶體內**，不在資料庫。因此：

- **禁止** `pm2 -i 2`／cluster mode／同時起兩個 `node server/index.js`。
- **禁止** 兩台機器指向同一個 PostgreSQL 各跑一份 App。

違反時兩個行程各持一份互不知情的鎖：同一任務會被重複派工、同專案的 merge/deploy 併發寫壞
共用主 clone、測試環境會 spawn 兩個 Odoo 搶同一 port——症狀（git 損壞、port 衝突）看不出根因。
需要水平擴展時，先把上述互斥全數改為 PostgreSQL advisory lock 再說。

## 日常更新

```bash
./upgrade.sh
```

腳本會自行辨識佈署模式：偵測到容器 `odoo-v2` 在跑就走 Docker 流程（`git pull` →
必要時在**容器內** `npm install` → `docker restart`），否則走原本的宿主流程。DB schema 於
server 啟動時自動 migrate，不需另外處理。

**不要在 Docker 模式的宿主上跑舊版宿主流程**：`pkill` 因 PID namespace 隔離殺不到容器內的
node（且後接 `|| true` 不報錯＝看似成功但根本沒重啟），接著又會在宿主起第二份 server，
違反下方「僅允許單一 Node 行程」的硬限制。

**改到 `Dockerfile`／`docker/entrypoint.sh` 時 restart 不夠**（它們是 `COPY` 進 image 的）：

```bash
docker compose build && docker compose up -d
docker exec -it odoo-v2 node scripts/setup.js --skip-start   # 重建容器會清掉 ~/.claude.json
```

`upgrade.sh` 偵測到這兩個檔有更動時會提示，但不自動執行——重建容器有副作用，時機由人決定。

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
