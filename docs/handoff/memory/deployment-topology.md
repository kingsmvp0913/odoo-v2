---
name: deployment-topology
description: 正式機的實際部署拓樸——平台容器、測試區綁定、共用 nginx、埠池對外方式
metadata: 
  node_type: memory
  type: project
  originSessionId: 7bb31009-1a12-4e7d-8081-c83eb62f58fd
---

生產機（`192.168.10.110`，對外走 `ideaxpress.biz`）的實際部署（非 repo 內、屬 host-specific，`data/config.json` + 外部容器）：

- **平台本體**：跑在 `odoo-v2` 容器，node 監聽 **8771**（`config.json` `PORT`）。基底網域 `odoo-ai-dev.ideaxpress.biz:443 → host.docker.internal:8771`。
- **測試區（odoo-envs）**：`ENV_BIND_HOST=10.0.0.1`（docker 網路閘道），容器 `docker run -p 10.0.0.1:<port>:8069`。`ENV_PUBLIC_URL_TEMPLATE=https://odoo-ai-dev.ideaxpress.biz:{port}`（**埠模式**：單一裸網域，靠埠號區分）。
- **埠池**：`PROJECT_PORT_MIN/MAX=21000-21099`（100 個，`config.json` 蓋掉預設 21000-21012）。租約制見 [[port-pool-lease-model]]。
- **共用反向代理**：`agency-NginxUI-1`（uozi/nginx-ui v2.1.5），佔對外 80/443/9000，並 publish `192.168.10.110:21000-21099`。**此 nginx 與多個正式站共用**（sites-enabled：AICEO、IDX、IDX_API、register、starlight、Registry、odoo-ai-dev），改設定會波及它們。
- **測試區 nginx 段是平台自動產生**：`app/server/lib/nginx-map.js` 的 `syncNginxMap` 讀 DB `status='running'` 的埠 → 寫 `conf.d/odoo-envs.conf`（每埠一段 `listen <port> ssl; proxy_pass 10.0.0.1:<port>`）→ `nginx -t` 過才 reload、不過 rollback。由 `NGINX_SYNC_CONF_FILE`/`NGINX_CONTAINER`/`ENV_TLS_CERT`/`ENV_TLS_KEY` 這組 env 啟用。**使用者不需手動在 nginx-ui 加測試區 vhost**，只手管 `odoo-ai-dev` 基底那條。
- 80/443 已對公網開（`odoo-ai-dev` 憑證用 HTTP-01 acme-challenge 簽得出來即為證）。

**平台容器的自我身份與重啟能力**（2026-08-21 實測）：
- 容器名 `odoo-v2`，但 **hostname 是 `ai-server`**——兩者不同，`docker inspect $(hostname)` 查不到。可靠的反查是「比對每個容器的 `Config.Hostname` 與 `os.hostname()`」（已實作在 `finding-fix.js` 的 `pickSelfContainer`）。
- `RestartPolicy=unless-stopped`；容器內**有** `docker` CLI 且 `/var/run/docker.sock` 掛得進來，列得到 host 上所有容器。
- 所以平台能對自己下 `docker restart odoo-v2`（交給 host daemon，node＋postgres 一起乾淨回來），不必賭 [[platform-restart-kills-container]] 那條容器內自殺的路徑。健檢修正的「合併並套用」按鈕就走這條，**2026-08-21 已實跑驗證**（見 [[health-fix-channel-verified]]）。
- **平台自我重啟不會把 Claude Code session 帶走**（同日實測跨過兩次容器重啟）：工具呼叫每次新起，最多是重啟那幾十秒指令失敗。所以要驗「會重啟平台的按鈕」不必先請使用者代跑。
- **判「只重啟 node」還是「整個容器重啟」**：比對 `docker inspect --format '{{.State.StartedAt}}'`（UTC）、容器內 `ps -p 1` 與 node 的啟動時間。三者同一秒＝整個容器重啟；只有 node 較新＝有人單獨重啟了 node。
