---
name: tests-wipe-real-nginx-conf
description: 跑平台測試會把真的共用 nginx 設定檔寫成 0 bytes 並 reload，正在用測試區的客戶當場連不上；已修（jest.setup.js 清掉 NGINX_* 變數＋守衛測試），commit 0926168e
metadata:
  node_type: memory
  type: project
---

2026-09-10 追「萊峰19 一直斷線」的最終答案。**跑一次 `npm run test:quiet` 就會讓正在用測試區的
真人當場斷線。不是偶發，是每次都會。**

## 故障鏈（每一環都實測，時間戳對得到秒）

1. 容器的環境變數裡有 `NGINX_SYNC_CONF_FILE=/nginx-conf/odoo-envs.conf` 與
   `NGINX_CONTAINER=agency-NginxUI-1`，**jest 會整組繼承**。
2. `env-routes.test.js` 這類測試會真的打 `/env/sso`，那支端點裡有 `await syncNginxMap()`，
   **當時沒有任何一支測試 mock 掉 nginx-map**。
3. 測試用 pg-mem 空資料庫 ⇒ 算出「沒有環境在跑」⇒ **把真的 conf 寫成 0 bytes**＋`nginx -s reload`。
4. 測試區網域失去自己的 server 區塊。443 上**沒有任何人宣告 `default_server`**，收容站＝
   **載入順序第一個** 443 區塊；`conf.d/odoo-envs.conf`（我們的）排在 `sites-enabled/AICEO` 前面，
   我們的檔案一空，收容站就換成 AICEO——而 AICEO 憑證的 SAN **只有 `aiceo.ideaxpress.biz`**。
5. 瀏覽器拿到名字對不上的憑證 → 送 `alert 46 certificate_unknown` 並中止握手。
6. **握手失敗從來沒變成 HTTP 請求** ⇒ nginx access.log 與 Odoo log **一個錯都沒有**。
   前端則是 Odoo 的 service worker 接住失敗的導覽，端出 `/odoo/offline` 這頁 Odoo 自己的離線頁，
   或跳「連接中斷，正在嘗試重新連接」。

**實測時間軸（我自己造成的那次）**：15:35:06 開始跑基線測試 → 15:35:17~36 reload ×8 →
15:35:50~16:36:26 使用者 alert 46 ×23（同一個 IP，沒有第二個客戶端）→ 15:36:24 測試跑完 →
15:36:28 使用者回平台重進。當天更早的 14:21／14:25／14:39／14:43 四次則是**使用者自己在跑測試**。

## 修法（commit `0926168e` 已 push）

- `app/jest.setup.js`（新增，掛 `jest.setupFiles`）：開跑就 `delete` 那兩個變數 ⇒ gate 關閉，
  任何沒 mock 的 `syncNginxMap` 都變成 no-op。**測試端的修正，不需要重啟平台就生效。**
- `app/server/tests/nginx-real-conf-guard.test.js`：斷言測試進程裡那兩個變數必須是 undefined。
  沒有它的話，防護被拿掉不會有任何徵狀。
- 順手讓 `syncNginxMap` 少 reload：內容與磁碟相同 → 完全不動作；純移除（環境關掉、沒人在等）
  → 寫檔＋`nginx -t` 但不 reload。**這半需要重啟平台才生效。**

驗證：跑全套前後 `stat` 真 conf，2325 bytes／mtime 完全沒變；測試 4749→4753 綠、零紅燈。

## 判讀教訓（這輪連錯三次才找到）

1. **「伺服器端零錯誤」在 TLS 層失敗時完全不構成證據**——請求根本沒發生。我因此兩度宣告「測試環境
   沒問題」。查斷線一定要看**共用 nginx 的 error.log**，而且**別只用 upstream 埠號 grep**
   （我第一次只搜 `21001`，只撈到 proxy_temp 的 warn，整條線漏掉）。要用 `server: <網域>`
   與**客戶端 IP** 兩個角度各搜一次。
2. **「每次 X 之後都跟著 Y」不等於 X 造成 Y**——我把「使用者重進測試區」當成原因，但他是**因為**
   斷線才去點。使用者當場指出來。先問「這個動作在正常使用情境下會發生嗎」。
3. **自己的動作也要列入嫌疑**。真兇是我在背景跑的測試；我卻花了很久在找「第三方」。
   判別法：`docker events --format '{{json .}}'` 抓 `exec_create` 看得到指令原文，
   而 conf 的 mtime 跟著 reload 一起跳＝寫檔的是我們自己。

## 仍未關的門

443 沒有 `default_server` 這個結構弱點還在：**只要我們的 conf 因任何原因少了某個區塊**，
同樣的憑證錯誤就會重演。備案是「永遠輸出全部 slot 的區塊，沒開的回 503」（未做）。
更糟的情境：測試若寫出**語法壞掉**的檔，nginx 容器一重啟會整台起不來＝全公司站台一起掛。
（產生器只會產出合法內容或空檔，但那道門在這次修正前是開的。）
