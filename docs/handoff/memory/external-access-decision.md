---
name: external-access-decision
description: "測試區對外曝露方案——已定「雙池 + 按需子網域(模式A)」,規格書在 docs/spec-subdomain-mode.md"
metadata: 
  node_type: memory
  type: project
  originSessionId: 7bb31009-1a12-4e7d-8081-c83eb62f58fd
---

使用者目標：Odoo 測試環境**外網可瀏覽**。DNS 在 **Wix,無萬用字元、無 ACME DNS API**。拓樸見 [[deployment-topology]]。**完整規格書：`docs/spec-subdomain-mode.md`(動工前讀它,已整份定案)。**

**最終方案(2026-07-29)：雙池 + 按需曝露,觸發模式 A。**
- **內部埠池(21000–21019,上限 20——保守起點,主機 187G RAM/149G 可用、Odoo 容器輕,餘裕大可再放大)**：每個 running 環境都拿一個,綁 10.0.0.1、**不對外、不進 nginx、零 DNS/憑證**。pipeline 全靠這池。`odoo_envs.port`。
- **對外子網域池(小,slot 0–9,N=10)**：**只有人要看某環境時才臨時借**,看完/閒置(EXTERNAL_IDLE_MIN≈20分)就還。pipeline 不碰。新增欄位 `odoo_envs.external_slot`(+partial unique index)。
- 命名 `odoo-ai-test-{slot}.ideaxpress.biz`(slot=0–9,獨立值不由 port 推導,故**不需 SLOT_BASE**)。10 筆 A record 全指 `220.132.45.229` 走 443,nginx 靠 server_name 分流。三處(Wix DNS／template／SAN `-d`)逐字一致。

**為何雙池**：pipeline(deploy/E2E)是 `docker exec` 進既有容器、不用環境對外埠(E2E 內部 8169),但它要環境 running → 若「所有 running 都曝露」會讓純 pipeline 環境白佔 slot。雙池後 **pipeline 併發幾十個都不吃那 10 個對外 slot**;N=10 = 同時最多幾人在看,與 pipeline 脫鉤。

**要改的碼(規格 §5)**：`db.js`(加 external_slot 欄+index)、`port-alloc.js`(新增 acquireExternalSlot/releaseExternalSlot、envPublicUrl 改吃 slot、leasePort 內部埠維持大池)、`nginx-map.js`(RUNNING_SQL 只選 external_slot 非空、listen 443、server_name 用 slot、proxy_pass 用 port)、`env-agent.js` sweepIdleEnvs(對外閒置還 slot)、「開啟測試區」端點改成有狀態(借 slot→回網址,非靜態連結)。

**不受影響**：Windows(NGINX_SYNC_CONF_FILE gate)、pipeline(不觸發 acquireExternalSlot)。

**開啟測試區落點已勘查**：借 slot 塞進既有 `env-routes.js:45 GET /env/sso`(本來就每點一次現簽 SSO token 的有狀態端點)。前端 `openEnv()`(`ProjectDetail.js:153`/`TaskList.js`/`TaskDetail.js`)不改,只把按鈕 `v-if="env.url/env_url"` 改成 `env.status==='running'`(`ProjectDetail.js:323,341`、`TaskList.js:510`、`TaskDetail.js:658`)。`odoo_envs.url` 開機不再存對外網址(`env-agent.js:529`),改開啟當下算。還 slot 在 `sweepIdleEnvs`(`env-agent.js:349`)+`stopEnv`(`:315`)。

**上線進度(2026-07-30，正式機=本機 ai-server/192.168.10.110)**：
- ✅ 程式碼 §5 全數已 commit(`[子網域模式]` 系列)；DB migration 開機自動跑(`db.js:543` external_slot 欄 + `:632` unique index)。
- ✅ Wix 10 筆 A record 已建、DNS 已生效(使用者確認)。
- ⚠️ 開關實作用 **`ENV_EXTERNAL_URL_TEMPLATE`**(非規格書寫的 `ENV_PUBLIC_URL_TEMPLATE`)：`.env` 設它才啟動子網域模式。此新變數**尚未加進 `docker-compose.yml` 的 `environment:` 傳遞清單**，步驟3 要一起補。`EXTERNAL_SLOT_COUNT`/`EXTERNAL_IDLE_MIN` 程式有預設 10/20。
- ⚠️ **憑證改走 acme.sh、不再用 nginx-ui**(2026-07-30)：使用者實測 nginx-ui Certificates 頁簽這張一定爆錯／卡住(它 HTTP-01 靠內部 9180 challenge server，那條掛了)。改由**容器內 acme.sh v3.1.5**(`agency-NginxUI-1:/root/.acme.sh`，`--nocron` 失敗故走預設安裝、acme.sh 自帶 6h cron 續簽)簽，`--server letsencrypt --keylength ec-256`，account email `ideaxpress2000@outlook.com`。其他 13 張站仍走各自 nginx-ui vhost、不受影響。
- ✅ **2a vhost 已改 webroot**(取代原 proxy→9180)：`agency-NginxUI-1:/etc/nginx/sites-available/odoo-ai-test-acme`(+sites-enabled symlink) 的 `location ^~ /.well-known/acme-challenge/` 改成 `root /var/www/acme-challenge; try_files`。備份在同目錄 `.bak-20260730`。`/var/www`＋`/etc/nginx` 都是 host↔容器共用掛載，故 acme.sh 在容器內寫 challenge、nginx 讀檔即可，繞開壞掉的 9180。此檔**永久保留**(續簽也走它)。
- ✅ **憑證已簽好並安裝**(2026-07-30 18:46)：SAN 一張蓋滿 odoo-ai-test-0..9，有效 2026-07-30→**2026-10-28**。裝在 `agency-NginxUI-1:/etc/nginx/ssl/odoo-ai-test-0.ideaxpress.biz_P256/{fullchain.cer,private.key}`(reloadcmd=`nginx -t && nginx -s reload`)。acme.sh cron 自動續簽(ARI window 2026-09-28)。簽發時其他服務全驗過 200/正常、零影響。
- ✅ **已上線(2026-08-05 使用者確認：「現在已經是網域模式在跑了」)**——子網域模式實際運作中，容器重建與 odoo17 驗收已過。下方步驟3 細節保留作重建操作參考。
- 🔄 **步驟3(2026-07-30，重建那刻對話會斷，靠本記憶交接)**：
  - ✅ 設定已改好並驗證：`.env`(第16行 `ENV_EXTERNAL_URL_TEMPLATE=https://odoo-ai-test-{slot}.ideaxpress.biz`、第22/23行 `ENV_TLS_CERT/KEY` 已指 `/etc/nginx/ssl/odoo-ai-test-0.ideaxpress.biz_P256/{fullchain.cer,private.key}`)；`docker-compose.yml` environment 已補 `ENV_EXTERNAL_URL_TEMPLATE: ${ENV_EXTERNAL_URL_TEMPLATE:-}`。
  - ⚠️ **env 覆蓋陷阱**：odoo-v2 容器 baked env 仍有舊 `ENV_TLS_CERT=odoo-ai-dev…`(因我這 session 在容器內、`env` 讀到的就是它)；docker compose 優先序 shell/baked env > .env。**重建務必用「乾淨 env 的行程」跑 compose**(fresh helper 容器天生乾淨，會讀 .env 新值)，否則新 cert 不生效。
  - ⚠️ **我(claude session)跑在 odoo-v2 容器內**，與平台 node(pid 33)同為 entrypoint(PID1)的子行程；`entrypoint.sh` 用 `wait $APP_PID` 監工→node 一停整個容器就重啟。故：只能**重建**(compose up)才能吃新 env；`docker restart` 吃舊 env 無效；重建=殺掉本 session(claude-home 是 persistent volume，session jsonl 在 `/home/odoo/.claude/projects/-home-odoo-odoo-v2/`，可 --resume)。
  - ⚠️ **compose 工具**：本機(host 帳號)原本沒 `docker compose`/`docker-compose`；我在**容器內** `~/.docker/cli-plugins/` 裝了 v5.3.1(container 可寫層，重建後會消失、不影響重建)。odoo-v2 原本就是 compose 5.3.0 建的。Volumes：`odoo-v2_pgdata`(平台 PG)、`odoo-v2_claude-home`，重建用 `-p odoo-v2` 必重用勿新建。
  - 重建指令(detached helper，survive session 死)：`docker run --rm -d -v /var/run/docker.sock:/var/run/docker.sock -v /home/odoo/odoo-v2:/home/odoo/odoo-v2 -w /home/odoo/odoo-v2 docker:cli sh -lc 'docker compose -p odoo-v2 -f docker-compose.yml -f docker-compose.override.yml up -d odoo-v2'`。
  - ⬜ **重建後驗證(重連後做)**：①`docker inspect odoo-v2` env 應含 `ENV_EXTERNAL_URL_TEMPLATE` 且 `ENV_TLS_CERT` 指 odoo-ai-test-0；②平台起來後**啟動一個 odoo17 測試區**(aidev DB `projects` id=1 folder `odoo17`／id=3 folder `odoo17_hungjou`，皆 odoo_version 17，現 idle)；③開啟(`GET /api/projects/:id/env/sso` 借 slot→`syncNginxMap` 寫 443 block→回 `https://odoo-ai-test-<slot>.ideaxpress.biz/aidev/sso?token=…`)；④`curl` 該子網域 `/web/login` 應 200＋Odoo 登入頁＋憑證有效。這就是使用者要的「odoo17 能不能開」驗收。
  - aidev DB 連法：`psql -p 8772 -U odoo -d aidev`(本機 trust 免密；DB 名 aidev 非 claude)。重啟後首次有人開環境，nginx-map 會把 `conf.d/odoo-envs.conf` 從 port 模式(listen 21001)改寫成 443 子網域模式。
- 共用 nginx reload 風險：使用者要求逐步確認；每步 `nginx -t` 過才 reload。
