---
name: auto-deploy-security-fixes
description: 自動部署啟用前的資安複查，四個缺陷已修並 commit（695fccd2，未 push、未重啟）；含「ssh-sql 還有同一顆未修的密碼外洩」與兩項刻意不修的項目
metadata:
  node_type: memory
  type: project
---

2026-09-10 對自動部署做資安複查。當下 `project_deploy_targets` 三筆全 `enabled=false`、
`deploy_runs` 0 筆，只有鴻久（project 3）開了總開關 ⇒ **還沒真的跑過，所以這些洞都還沒被利用**。
碼已 commit `695fccd2`，**未 push、未重啟 server**。

## 四個已修（各附一支會抓到它的測試）

1. **`/api/projects/:id/release`（上正式）只掛 `verifyToken`**。它會 SSH 進客戶正式機下指令，
   但專用的 `deploy-routes.js` 是 admin＋明確 confirm ⇒ 整套授權從這條路繞得過去，
   當時平台 6 個非 admin 帳號都按得到。修法：**只關「動客戶正式機」那一半**，
   合併到 main 維持開放（本來就是）；新增 `confirmDeploy` 旗標；四種「沒部署」各自回
   `deploySkipReason`（原本 `deploySkipped` 只代表「總開關關著」，語意已擴大）。

2. **ssh2 沒給 `hostVerifier` 就無條件信任任何主機**——它自己的 debug 訊息就寫著
   `Host accepted by default (no verification)`（在 `node_modules/ssh2/lib/protocol/kex.js`）。
   改 TOFU：指紋存 `db_connections.ssh_host_key`，第一次記錄、之後比對。
   **鍵是 `conn.id` 不是 host:port**——走 VPN 時 host 被改寫成 127.0.0.1、port 是動態轉發埠，
   拿它當鍵等於每次都是新主機、驗證形同虛設。SFTP 上傳那半也一起（它送的是要被執行的碼）。
   解套路徑：連線編輯表單重存一次會清成 NULL（只在送出 ssh_host/port/user/auth_type 時清）。

3. **sudo 密碼出現在遠端指令列**。SSH 執行是 `bash -c "整串指令"`，argv 落在
   `/proc/<pid>/cmdline`，Linux 上**全機可讀** ⇒ 客戶機任何本機帳號跑 `ps` 就抄得到，
   而那顆密碼同時就是 SSH 登入密碼。改走 `SUDO_ASKPASS`：密碼由 stdin 進去、落成 0600 暫存檔、
   trap 清掉。**已用 bash 實跑驗證**（含含單引號與 `$()` 的密碼，原樣通過、不觸發命令替換；
   trap 確實清掉目錄）。順帶解掉 `-p ''` 當初要處理的提示汙染（`-A` 根本不印提示）。

4. **換檔指令沒有 `set -e`，而且它的 exit code 從來沒被檢查**。tar 解檔失敗時舊模組已被搬進備份、
   新的沒解出來 ⇒ 模組從 addons 目錄消失；而 **Odoo 的 `-u` 對「找不到的模組」只印警告就 exit 0**、
   健康檢查照樣過 ⇒ 部署回報成功、`last_deployed_sha` 被推進，**那個模組從此不會再被送上去**。
   回滾也改成「沒有備份就不刪現役目錄」（原本先無條件 `rm -rf` 再看有沒有備份）。

## ⚠ 同一顆 bug 還有一份沒修

`lib/ssh-sql.js:75,82` 自己拼 `echo '${safePw}' | sudo -S`，**沒有走 `sudoPrefix`**，
所以第 3 項只修到部署與 log 那兩條路，**SQL 查詢那條（天天在用）照樣把密碼放進指令列**。
刻意留著：改它要動 `buildPsqlCmd` 的引號結構，回歸風險落在每天在用的功能上。

## 兩項刻意不修

- **資料庫不備份**（使用者裁決，理由是太耗效能／跑太久）。改為在確認視窗明寫
  「失敗時資料庫無法還原」並要勾選才送 `confirmDeploy`。後果仍在：正式區升到一半失敗 ⇒
  回滾只還原檔案 ⇒ 舊碼配新 schema，就是 [[hungjou-deploy-topology]] 講的那種壞法。
- **`/tmp/aidev-deploy.log` 固定路徑、預設權限全機可讀、永不刪**，內容是升級輸出未遮罩
  （平台只遮自己存進 DB 的那份）。連同 `.deploy-bak-<ts>` 永不清理會吃磁碟。

## 接手要做的

重啟 server（`db.js` 加了欄位，沒重啟就沒建表）→ 鴻久自動部署分頁 → 真機實跑一次。
**SSH 那半到現在一次都沒對真機跑過**，askpass 與 hostVerifier 都只有本機／單元測試證據。

相關：[[auto-deploy-ui-and-autofill]]、[[auto-deploy-remote-wip]]、[[hungjou-deploy-topology]]
