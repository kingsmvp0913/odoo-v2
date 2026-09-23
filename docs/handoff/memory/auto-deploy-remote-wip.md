---
name: auto-deploy-remote-wip
description: 自動部署（ai-dev→測試區、上正式鈕→正式區）——2026-09-08 實地探測後的完整事實，三項卡住的問題已全解
metadata:
  node_type: memory
  type: project
---

2026-08-13 起的需求：把 pipeline 產出的**客戶專案 addons** 自動部署到遠端機。
**2026-09-08 已用平台既有 SSH 通道實地探測兩台客戶機**，舊記錄卡住的三項事實全部拿到。
狀態：走 brainstorming 架構路徑，已定調方案 A、**規格尚未動筆**。

## 使用者已拍板的流程

- ai-dev 核准 → **自動**部署到測試區
- 「上正式」按鈕 → 才真的上正式
- 每個客戶環境不同（有的 docker 有的沒有）⇒ **必須先有一套「環境評估流程」**

## 定調：方案 A ＝ 接在既有 SSH 通道上（平台主動 push）

決定性理由：**憑證早就在了**。`db_connections.ssh_password_enc`／`ssh_key_enc` 現在就能開 shell，
`ssh-log.js`／`ssh-sql.js` 天天在用（內網機還有 VPN gateway 打通）。
⇒「平台被入侵＝客戶正式機被入侵」這個風險**今天已經存在**，做部署器不新增它，
只新增「指令注入」一種新破口，而 `ssh-log.js` 已有現成解法（`IDENT_RE`／`PATH_RE`／參數型別受控、自由文字不進指令）。

pull 模式（客戶機裝 agent）被否決：平台不持憑證的好處換不到，因為**接線麻煩完全沒解決**，
只是從裝 GitHub runner 換成裝我們的 agent。

## 實測結果（2026-09-08，唯讀探測）

### 慈雲 odoo-tower `34.173.226.223`（db_connections id 7/8，key auth，無 VPN）
- `ideaxpress` 是 **NOPASSWD: ALL**（GCP `google-sudoers` 群組）→ **完全不必加 sudoers 白名單**
- **沒有 docker**。systemd＋init.d 各兩個 unit
- 正式 `odoo-server` / 8069 / DB `ciyun` / addons `/odoo/custom/addons`（owner odoo:odoo 775）
- 測試 `odoo-test` / 8070 / DB `production_test` / addons `/odoo/custom/addons_test`（owner ideaxpress:odoo 755）
- conf：`/etc/odoo-server.conf`、`/etc/odoo-test.conf`（0640 odoo:odoo）
- `pg_dump` ✓ `git` ✓ **`rsync` ✗**（有 root 可自行安裝）；磁碟 40G 可用
- addons **不是 git repo**，各只含一個模組 `idx_ciyun`（乾淨）
- ⚠ Odoo 版本這次沒探到，仍待確認

### 鴻久／鴻伍 `192.168.1.233`（db_connections id 1/2/3，password auth，**vpn_enabled**）
- `arich` 在 `sudo` 群組但**要密碼**；平台已加密存該密碼 ⇒ 用 `ssh-log.js` 現成的
  `sudoPrefix()`（`echo pw | sudo -S -p ''`）即可，**一樣免人工**
- `arich` **不在 docker 群組**，所有 docker 指令都得走 sudo
- 全 docker，8 個容器；Odoo **17.0-20260324**；磁碟 412G 可用
- 鴻久正式 `odoo-prd-web` 8001→8069 / DB `odoo_prd` / addons `~arich/DockerData/odoo/Data/odoo-prd/addons`
- 鴻久測試 `odoo-tst-web` 8101 / DB `odoo_tst`（conf 的 db_name 是 `odoo_tst,hutest`）/ addons `.../odoo-tst/addons`
- 鴻伍正式 `odoo-dev-web` 8201 / DB `odoo_dev` / addons `.../odoo-dev/addons`
- 另有 `*-runner` 容器（同掛載，跑 queue_job）、`caddy-odoo` 反代、`odoo-db`（postgres:16）
- **`pg_dump` 只在 `odoo-db` 容器內**，宿主沒有 ⇒ 備份要 `docker exec odoo-db pg_dump`
- 三個 addons 目錄 **都不是 git repo**，權限 777 ⇒ 寫得進去

## 規格必須處理的三個設計點

1. **addons 目錄都不是 git repo**（5 個全不是）。轉成 repo 程式做得到，
   但動客戶正式區目錄、不可逆 ⇒ **要人按一次確認**。
2. **鴻久的 addons 目錄是混的**：10~12 個模組裡只有 `idx_hj`／`idx_scan` 等是我們的，
   其餘是 OCA（`queue_job`、`web_responsive`、`alnas_*`…）不在我們 repo。
   ⇒ **不能整個目錄變 repo**，要設計成「repo 只管我們自己的那幾個子目錄」。
   慈雲那台是乾淨的（只有 `idx_ciyun`），沒這問題——**別拿慈雲的形狀套到鴻久**。
3. **客戶 `odoo.conf` 內 `db_password`／`admin_passwd` 是明碼**（既有狀況）。
   探測與部署的輸出**一律要過 `log-parse.js` 的 `maskSecrets()`**，否則會把客戶正式區密碼寫進平台 log／DB。

## 判讀陷阱

- `ensureGatewayRunning(gw)` 吃的是 **`loadProjectVpn()` 產出的物件**（含 `targets` 陣列），
  不是 db_connections 的欄位硬拼；自己組會炸 `targets is not iterable`。
  正確做法：`loadDecryptedConn(cid, projectId)` 一次拿到解密連線＋`conn.vpn`。
- `db_connections` 裡 `sudo_user='odoo'`／`docker_container='odoo-db'` 是**查資料用的欄位**，
  不是部署用的；部署要的服務名／容器名／addons 路徑**目前一個都沒存**。
- 部署SOP 頁（`/projects/:id/deploy-sop`，commit 73d74eee）只產指令給人複製，
  刻意不入庫；自動部署器要存 profile 進 DB，與該頁的設計取捨相反，別直接沿用它的理由。

相關：[[deployment-topology]]（平台自身正式機拓樸，與此不同）、[[multi-instance-shared-ai-dev]]。
