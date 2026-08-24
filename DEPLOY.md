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
| PostgreSQL（含 psql） | App 與 Odoo 共用資料庫 | https://www.postgresql.org/download/ |
| xmllint（libxml2） | XML view 格式驗證（`xmllint --noout`） | Linux 由 `install.sh` 自動裝 `libxml2-utils`；Windows 選用 |
| Claude Code／Codex CLI | Pipeline AI agent 與訂閱登入 | 一鍵安裝／升級時自動補裝 |

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

**採「雙池 ＋ 按需子網域」**：對外曝露與「環境活著」脫鉤，兩個池獨立配發、獨立回收。

- **內部埠池**（`PROJECT_PORT_MIN`–`MAX`，預設 `21000`–`21019`）：每個 running 環境借一個，綁
  `ENV_BIND_HOST`（如 `10.0.0.1`）。**不對公網 publish、不需 NAT 放行**——它只出現在 nginx 的
  `proxy_pass`（nginx 容器 → 宿主方向）。上限只受主機資源限制。
- **對外子網域池**（`EXTERNAL_SLOT_COUNT`，預設 `10`）：slot `0..N-1` 對應
  `odoo-ai-test-<slot>.<網域>`，全部走 443。**只有真人點「開啟測試區」時才借**
  （`GET /api/projects/:id/env/sso`），閒置 `EXTERNAL_IDLE_MIN`（預設 20）分鐘、按「關閉對外」
  （`POST /api/projects/:id/env/external/release`）或環境停機時歸還。

> pipeline 的 deploy／E2E 走 `docker exec` 進既有容器，不使用對外網址，**永遠不佔對外名額**。
> 故 `EXTERNAL_SLOT_COUNT` 的意義是「同時最多幾個人在看環境」，與 pipeline 併發無關。

為何不用 wildcard 子網域——DNS 若託管在不支援 `*` 記錄、也無 ACME DNS API 的商（如 Wix），
wildcard 憑證起不來；改建**固定 N 筆 A record ＋ 一張蓋 N 個名字的 SAN 憑證**（HTTP-01 逐一簽）。

> Odoo 不支援掛子路徑（`/web`、`/odoo`、asset 皆 root-absolute），故只能子網域或 port、不能子路徑。
> 子網域模式下每個 slot 是獨立 host，cookie 天然隔離，多人同時看不同測試區不再互蓋 session。
> slot 會重用：A 還掉 slot 3、B 借到 slot 3 後，瀏覽器對 `odoo-ai-test-3` 的舊 cookie 會落到 B，
> 但 B 是新的 Odoo session，登入即覆蓋。

設定（`data/config.json`，全 opt-in，未設＝維持 loopback、Windows／未反代機不受影響）：

| key | 值 | 用途 |
|-----|----|----|
| `ENV_BIND_HOST` | docker0 閘道（本機 `10.0.0.1`；`ip -4 addr show docker0`） | 測試區容器改綁此位址，讓另一容器的 nginx 連得到（綁 loopback 必 502） |
| `ENV_EXTERNAL_URL_TEMPLATE` | `https://odoo-ai-test-{slot}.ideaxpress.biz` | **設了就啟用子網域模式**；未設＝維持 port 模式，本機／未反代機零影響。**樣板必須含 `{slot}`**，否則同步會被守衛中止（見下） |
| `EXTERNAL_SLOT_COUNT` | `10` | 對外檢視名額數；**必須等於實際建好的 A record 筆數與 SAN 憑證涵蓋數**，多設的 slot 會產出連不上的網址 |
| `EXTERNAL_IDLE_MIN` | `20` | 對外閒置多久自動歸還名額（**環境本身不停**，pipeline 可能還要用） |
| `NGINX_SYNC_DEBOUNCE_MS` | `1500` | 批次歸還名額時合併 reload 的靜默窗口。**只有「還」走防抖**；「借」走同步版（等 `nginx -t` + reload 完成才把網址交給瀏覽器，否則使用者當下拿到 502） |
| `NGINX_CONTAINER` | `agency-NginxUI-1` | 平台 `docker exec` 對它 `nginx -t`／`-s reload` |
| `NGINX_SYNC_CONF_FILE` | 共享 conf 路徑（例 `/etc/nginx/conf.d/odoo-envs.conf`） | **同步總 gate**；未設＝整段不執行 |
| `ENV_TLS_CERT` / `ENV_TLS_KEY` | SAN 憑證／私鑰路徑（nginx 容器內） | 每段 server block 共用 |

> `ENV_PUBLIC_URL_TEMPLATE` 在子網域模式下不再作為對外網址來源——環境開機時 `odoo_envs.url`
> 存 NULL，對外網址一律在「借到名額的當下」才由 `ENV_EXTERNAL_URL_TEMPLATE` 算出。

`NGINX_SYNC_CONF_FILE` 一旦設了，`ENV_BIND_HOST`／`ENV_TLS_CERT`／`ENV_TLS_KEY`／
`ENV_EXTERNAL_URL_TEMPLATE` 缺任一個都會讓同步 **throw 並 loud log、不寫檔**（`lib/nginx-map.js`）。

平台依「running **且持有對外名額**」的測試區自動產生（`lib/nginx-map.js`；寫檔前先過 server_name
白名單守衛，寫檔後 `nginx -t` 過才 reload、壞就 rollback），每個名額一段：

```nginx
server {
    listen 443 ssl;
    server_name odoo-ai-test-3.ideaxpress.biz;   # slot 決定名字
    ssl_certificate     /etc/nginx/ssl/<SAN>/fullchain.cer;
    ssl_certificate_key /etc/nginx/ssl/<SAN>/private.key;
    location / {
        proxy_pass http://10.0.0.1:21047;          # 內部埠決定後端，與 slot 無關
        proxy_set_header Upgrade $http_upgrade;    # 缺了 Odoo bus/longpolling 靜默退化
        proxy_set_header Connection "upgrade";
        # Host／X-Forwarded-*／client_max_body_size 50m／proxy_read_timeout 600s
    }
}
```

> **守衛（`assertServerNames`）**：這份 conf 被 include 進與正式站（AICEO／IDX…）共用的同一台
> nginx，server_name 推導出錯等於把測試區蓋到正式站網域上。故寫檔前逐段斷言「主機名最左標籤
> 以 `-<slot>` 結尾」——樣板漏了 `{slot}` 時 N 個名額會產出 N 段同名 server_name，守衛會直接
> **中止本次同步、不寫檔、loud log**。

一次性人工（平台不自動）：簽 SAN 憑證（見下方上線步驟）；`nginx.conf` 的 `include conf.d/*.conf`
需在 `http{}` 內（才放得下 server block）。**不再需要**重建 `agency-NginxUI-1` 去 publish 埠段。

> **埠池為租約制**，載體是 `odoo_envs.port`。內部埠不對外，**port 模式時代「池範圍必須等於
> nginx publish 段 ∩ NAT 放行段」的硬性約束已解除**；要擴充併發只需把上限往上拉，對外不受影響。
>
> ⚠️ **上限的真正生效點是資料庫**：優先序 **DB（`teams_settings.port_pool_min/max`）> env
> （`PROJECT_PORT_MIN`／`MAX`）> 程式預設（21000–21019）**。正式機 DB 已存 `21012`，
> 光改 `config.json` 或程式預設**不會生效**、且會被 DB 值靜默蓋掉——症狀是併發卡在 13 個環境
> 且錯誤完全不指向埠池設定。要改請到**管理員 → 埠池**介面（執行期讀取，改完免重啟）。
>
> 埠池專屬：這段埠不得再給機器上其他服務使用。閒置測試區會自動停機並歸還埠
> （`ENV_IDLE_TIMEOUT_MIN`，預設 60 分；池滿時徵收門檻 `ENV_IDLE_TIMEOUT_PRESSURE_MIN`，預設 15 分；
> 壽命上限 `ENV_MAX_LIFETIME_HOURS`，預設 8 小時）。對外名額另有一套較短的門檻
> （`EXTERNAL_IDLE_MIN`，預設 20 分），到期只收名額、不停環境。

#### 切換到子網域模式的上線步驟

1. **DNS**：建 `EXTERNAL_SLOT_COUNT` 筆 `odoo-ai-test-0..9.<網域>` A record，全指同一公網 IP。
2. **憑證**：簽一張 SAN 蓋滿這 N 個名字：
   ```bash
   acme.sh --issue \
     -d odoo-ai-test-0.<網域> -d odoo-ai-test-1.<網域> ... -d odoo-ai-test-9.<網域> \
     --webroot <acme webroot 路徑>
   ```
   **續簽需 port 80 的 acme-challenge**（Wix 無 DNS-01，此路不可省）：另加一段 `listen 80`
   涵蓋全部 `odoo-ai-test-*`，`location /.well-known/acme-challenge` 導到 acme webroot。
3. **設定**：`data/config.json` 填上表的 key（至少 `ENV_EXTERNAL_URL_TEMPLATE`、
   `EXTERNAL_SLOT_COUNT`、`EXTERNAL_IDLE_MIN`、`ENV_TLS_CERT`／`KEY`），重啟平台。
4. **⚠️ 內部埠池上限要手動調**：見上方警語——優先序是 DB > env > 程式預設，正式機 DB 已存
   `21012`。到「管理員 → 埠池」把上限改成 `21019`（或更高）。**漏了這步的症狀是併發卡在 13
   且不指向成因。**
5. **低流量時段驗證**：`nginx -t` → 開 2–3 個環境、各自按「開啟測試區」拿到不同的
   `odoo-ai-test-N`、確認可達且 session 互不互蓋 → 確認同一台 nginx 上的正式站
   （AICEO／IDX／…）無異常。
6. **驗證雙池分離**：讓 pipeline 同時跑多個環境，確認對外名額佔用數**不變**（＝當下在看的人數）。
7. **驗證歸還**：對外閒置逾 `EXTERNAL_IDLE_MIN` 後 slot 自動釋放、nginx 段消失，環境本身不受影響。
8. **IT 收埠**：確認無誤後，把對外的 `21000`–`21099` 全部收回內網，只留 443。
   （**回滾前需先請 IT 重開**，見下。）

**回滾**：還原程式與 `data/config.json` 的新增 key（拿掉 `ENV_EXTERNAL_URL_TEMPLATE` 即關閉子網域
模式）→ 下次環境起停即回舊行為。`odoo_envs.external_slot` 欄位留著無害，DNS／憑證留著不影響。
但若已執行步驟 8 收掉對外埠段，回滾前必須先請 IT 重開。

> 安全提醒：對外面收斂成固定 N 個子網域走 443 後，仍應以 **VPN／IP 白名單**擋在可信來源內——
> 測試區跑未審程式碼，且與平台共用 PostgreSQL superuser（見設計文件殘留風險），攻進一個測試區
> 有機會跨庫觸及平台 DB。測試區帳號（含 E2E）不應暴露到可信網路以外。管制點從「逐埠」改為
> 「443 前端」。

### 企業版（Enterprise）測試區

Odoo 企業版與社群版的 server 本體是同一份程式碼，企業版只是多一包 addons 目錄
（`web_enterprise` 覆蓋社群版 `web`）。因此平台**不為企業版另建 image**，只在該專案的容器多掛一個
唯讀 volume：

```
-v <ENTERPRISE_BASE_DIR>/<大版本>:/mnt/enterprise:ro
--addons-path=/mnt/extra-addons/_platform,<專案 repos>,/mnt/enterprise,<核心 addons>
```

設定步驟：

1. 管理員 → 企業版來源 → 按大版本登記，兩種來源型態擇一：
   - **Git repo**：填 URL＋分支 → 按「同步」背景 clone。私有 repo 需操作者先在「設定」填個人
     GitHub PAT。
   - **本地目錄**：把該版本的 addons 直接放進 `<ENTERPRISE_BASE_DIR>/<大版本>/`（底下要直接看得到
     `web_enterprise/`）→ 登記時不填 URL → 按「檢查」。適合不想把有授權的專有碼推上遠端、
     或整包太大不值得走 git 的情況。目錄路徑固定不可指定——可自填會讓人指到非同構掛載的位置，
     掛進 sibling 容器會變成空目錄而毫無跡象。
2. 專案 → 建立時選「企業版」，或在專案頁的「Odoo 版本類型」切換（管理員限定）。
3. 重新建置該專案的測試區。

本地型態按「檢查」時驗兩件事，兩者都是放錯了 Odoo 也不會報錯、只會安靜跑成社群版的情境：

| 檢查 | 擋掉的情況 |
|---|---|
| `web_enterprise/__manifest__.py` 存在 | 放成社群版 addons；解壓後多包一層目錄（訊息會點名那一層） |
| 目錄 `o+rx`、manifest `o+r` | scp／unzip 進來的檔案是 600／700，容器內的 odoo 是另一個 uid，讀不到 |

**刻意不驗「這包是不是該大版本」**：官方 addons 的 manifest `version` 是模組自身版本（Odoo 17
企業版 585 個模組全是 `1.0`／`1.1`，社群版核心同樣），series 前綴是 Odoo 載入時才補上的，
包裡也沒有 `release.py`。版本以「管理員把它放進哪個目錄」為準。

| 變數 | 預設 | 說明 |
|---|---|---|
| `ENTERPRISE_BASE_DIR` | `<repo 根>/enterprise` | 企業版 addons 共用目錄，各大版本一個子目錄 |

注意事項：

- **enterprise addons 分大版本**，17 的不能給 18 用；每個要支援的版本各登記一列。
- 企業版來源**不進 pipeline**：不寫入 `project_repos`，不會被開 testing 分支、不被 AI 改動、
  不被 deploy commit／push，掛載一律 `:ro`。
- 專案標為企業版但該版本未登記或未同步成功時，**建置測試區會直接失敗**並指名版本，
  刻意不降級成社群版——降級會讓人以為在測企業版，實際不是。
- 未填訂閱碼的企業版 DB 30 天後會持續跳到期提示（功能仍可用）。測試區壽命通常遠短於此，不處理。

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

`install.ps1`/`install.sh` 與 `scripts/setup.js` 皆為 idempotent：已安裝的系統套件、已存在的 `data/config.json`、已就緒的 PostgreSQL role/db、已登入的 Claude、已裝的 Claude/Codex CLI 與 MCP/plugin 都會跳過，不會覆蓋既有資料。

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
