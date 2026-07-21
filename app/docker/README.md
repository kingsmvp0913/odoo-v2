# Docker 模式測試區（自動涵蓋 Odoo 13→20+）

把測試區建在官方 `odoo:<major>` image 上，Python／相依／gevent 全部預先編好，
徹底避開宿主的多版本 Python 相容問題（odoo13/14 的 gevent 編譯、odoo15/16 的
`pkg_resources` 缺失都不再發生）。新版本（含未來的 20）只要官方有 image 即自動支援。

## 啟用

在 **管理設定 → 測試區建置模式** 切成「Docker 模式」即可，**預設 venv**（行為不變）。
設定存 `teams_settings.env_mode`（`venv`／`docker`），改完即時生效、免重啟、免環境變數；
對「之後新建或重建」的測試區生效。平台已依賴 docker（VPN gateway 已用 Linux 容器），無需額外基礎設施。

## 運作方式

- **image**：首次為某大版本自動 `docker build` 成 `odoo-idx:<major>`（`Dockerfile.odoo` ＝
  `FROM odoo:<major>` + chromium，供 E2E tour）。同版本只建一次、之後共用。
- **常駐 server**：每專案一個容器 `odoo-test-<folder>`，`-p 127.0.0.x:<port>:8069`
  （沿用既有的 loopback host cookie 隔離）。首次啟動帶 `-i base` 裝底。
- **一次性指令**（升級／卸載／seed／tour）：`docker exec` 進常駐容器另起 odoo 進程，
  與 venv 模式「同一環境另起 odoo-bin」語意一致，並共用容器內已裝的自訂模組相依。
- **宿主 Postgres**：容器經 `--add-host=host.docker.internal:host-gateway` 連回宿主，
  `--db_host localhost/127.0.0.1` 自動改寫為 `host.docker.internal`。
- **自訂 addons**：各 repo 掛成 `/mnt/extra-addons/<name>`（唯讀），`--addons-path`
  自動補上 image 內核心 addons。
- **log**：前端「查看 log」在 docker 模式改讀 `docker logs`。

## 首跑驗證清單（實機才驗得出，程式已就緒）

這些是 image 慣例相關、無法在 CI 離線驗證的點，首次在測試機啟用時請確認：

1. **核心 addons 路徑**：預設 `/usr/lib/python3/dist-packages/odoo/addons`。若某版本 image
   路徑不同（base 找不到），用 `ODOO_IMAGE_CORE_ADDONS` 覆寫，無需改程式。
2. **宿主 Postgres 連通**：確認 `host.docker.internal` 在該 docker 版本可解析（Linux 原生
   docker 已加 `--add-host ...:host-gateway`），且 Postgres 允許來自容器網段的連線。
3. **tour chromium**：image 已裝 chromium 並設 `CHROME_FLAGS=--no-sandbox ...`；若某版本
   Odoo 的 ChromeBrowser 需其他旗標，於 `Dockerfile.odoo` 調整。
4. **pip 補件權限**：自訂模組 Python 相依以 `docker exec -u root` 裝進容器；確認 image 內
   pip 可寫 site-packages（官方 image 可）。
5. **requirements.txt 版本釘定**：docker 模式目前以「套件名」安裝宣告的相依（未逐檔 `-r`），
   版本釘定為後續強化項；若模組強依賴特定版本，先在 `Dockerfile.odoo` 補 `RUN pip install`。

## 回退

移除 `ODOO_ENV_MODE=docker`（或設 `venv`）即回到原本的 venv 建置路徑，兩者可共存、不互斥。
