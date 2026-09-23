---
name: deploy-systemd-odoo-bin-path
description: 慈雲自動部署的三個真因——裸名 odoo-bin、評估把測試區填成正式資料庫、init.d 包起來的服務掃不出執行檔；全已 push（3d4579bd＋7a8cf492），只剩 prod 目標的 odoo_bin 要補
metadata: 
  node_type: memory
  type: project
  originSessionId: 219da7c2-7fc5-4ae3-a5b4-6b6113b070fd
  modified: 2026-09-18T07:23:41.784Z
---

慈雲寶塔（project 2，systemd／非 docker）自動部署踩到的兩個獨立缺陷，2026-09-18 查完並修完。

## 1. 裸名 odoo-bin

run#6 `rolled_back`，log 只有一行 `sudo: odoo-bin: command not found`。`deploy-cmd.js` 的 systemd 分支
寫死裸名，而那台機器的執行檔在 `/odoo/odoo-server/odoo-bin`、不在 PATH 上。掃描（deploy-probe）
從來沒問過這一項——`probe_json.odooVersion` 恆為 null 就是同一個病的早期訊號，被當成無關緊要放過。

已修（`432cda9b`）：`project_deploy_targets.odoo_bin` 欄位、probe 從 ExecStart 的 `path=` 帶出、
systemd 分支改用它（沒填仍退回裸名）、route 驗絕對路徑、UI 只對 systemd 目標顯示該欄。

**但存出來的目標 `odoo_bin` 仍是 null**，而 `probe_json.candidate.odooBin` 有值——因為使用者的分頁是
平台更新前開的，載到的舊畫面程式根本沒有那個欄位。`index.html` 的 cache-busting 是對的
（`?v=` 被 `sendIndex` 換成資產最新 mtime），但**治不了「分頁一直開著沒重整」**。
→ 後端改成沒帶就從同一份 payload 的 `probe_json.candidate.odooBin` 補（仍過 `validatePath`）。

## 2. 測試區被填成正式資料庫（更危險）

那台機器有兩個 DB：`ciyun`（正式，idx_ciyun 19.0.1.2.0）、`production_test`（測試，19.0.1.3.0）。
兩個部署目標（prod id 7／test id 9）**都填 `ciyun`**——啟用就是拿 ai 分支的碼升級客戶正在用的資料。

真因是刻意設計的副作用：probe 給每個候選填 `dbName: conn.db_name`（見
[[auto-deploy-ui-and-autofill]] 裡那段「看起來像 bug 但是刻意的」）。用「正式」那條連線掃，
掃到 odoo-server／odoo-test 兩個服務，兩個都套 `ciyun`。而下拉 `dbChoices` 只吃
`c.dbName`＋`linkedConns`＋`confDbNames`：conf 沒宣告 db、兩條連線的 `log_unit` 都空
（`linkConns` 完全靠 log_container／log_unit）⇒ **選項只有 `ciyun` 一個，人想改也改不了**。

已修（`3d4579bd`，全跑 5483 綠）：
- `dbChoices` 改吃**專案所有連線**登記的 db，並標出是哪條連線的
- route 擋「同專案測試區與正式區指向同一個 db」——存新目標／改 db_name／**按啟用**三個入口都擋
  （舊的壞目標只有在啟用那一刻才擋得到，所以那道最重要）
- 兩支測試檔的 fixture 本來 test／prod 共用同一個 db 名，正是現在被列為錯誤的狀態，已拆開

## 3. 舊式 init 腳本包起來的服務（同日補上，`7a8cf492`）

慈雲**正式**區的 `odoo-server.service` 不是原生 unit，是 systemd 包的 SysV 腳本
（`systemctl list-units` 顯示 `LSB: Enterprise Business Applications`），`systemctl show -p ExecStart`
回的是 `path=/etc/init.d/odoo-server`。parseOdooBin 認不出來（**正確**——那不是 odoo 執行檔），
於是重建後的 prod 目標 `odoo_bin` 還是 null。測試區是原生 unit，所以只有正式那半中招。

修法：`parseInitScriptPath`（只認 `/etc/init.d/` 底下的）＋`parseDaemonPath`（讀腳本裡的
`DAEMON=`，Debian 慣例），probe 在 odooBin 為 null 時多讀一層。讀不到維持 null＝退回裸名。
**對真機驗過**：odoo-server 從 null 變 `/odoo/odoo-server/odoo-bin`（與測試區同一支；
`ls -l` 顯示那是 88 bytes 的 shim）。全跑 5488 綠。

## 現況（2026-09-18 收尾）

使用者已重啟平台並重建兩筆目標：test id 10（conn 7／`production_test`／odoo_bin 有值／**已啟用**）、
prod id 11（conn 8／`ciyun`／停用）。**prod 的 odoo_bin 仍是 null**——要嘛手填
`/odoo/odoo-server/odoo-bin`，要嘛再重啟一次平台後重跑評估讓它自己帶出來。
兩筆都還沒真的部署過（`deploy_runs` 只有鴻久 target 1 的紀錄）。

## 其他

- docker 目標（鴻久全部）走容器內的 `odoo`，以上三件事都不受影響。
- 重啟要在宿主做，見 [[platform-restart-kills-container]]。
- 那台機器的 conf 都不宣告 `db_name`（`confDbNames` 空），所以 `dbMismatch` 永遠是 false——
  對這台客戶機來說那個警告等於不存在，別指望它擋下選錯 DB。
