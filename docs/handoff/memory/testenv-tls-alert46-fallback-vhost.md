---
name: testenv-tls-alert46-fallback-vhost
description: 測試區「一直斷線」真因＝瀏覽器在 TLS 握手就拒絕憑證（alert 46）；443 沒人設 default_server，我們的 odoo-envs.conf 少了區塊時網域會掉到 AICEO 拿錯憑證；握手失敗不產生 HTTP 請求，所以 access log 與 Odoo log 全都查不到
metadata:
  node_type: memory
  type: project
---

2026-09-10 萊峰19「下午斷了七八次」的真因。**前兩個假設都被推翻**（見 [[sso-hard-rotate-kills-websocket]]、
[[testenv-disconnect-from-platform-restart]]），真的線索在**共用 nginx 的 `error.log`**——使用者一句
「你有看過 nginx log 了嗎」直接扭轉整條調查。

## 症狀為什麼「查不到」

```
SSL_do_handshake() failed (SSL: error:0A000416:...:sslv3 alert certificate unknown:SSL alert number 46)
client: <使用者IP>, server: 0.0.0.0:443
```

`alert 46 = certificate_unknown`，**是瀏覽器送給我們的**：它拒絕憑證並中止握手。
**握手失敗 ⇒ 從來沒有變成一個 HTTP 請求 ⇒ nginx access.log 沒有、Odoo log 更沒有。**
我因此連續判定「伺服器端零錯誤、一切正常」兩次。`server: 0.0.0.0:443` 就是「連 vhost 都還沒認出來」。

實測相關性：該 IP 的 alert 46 叢集與使用者五次重新進入測試區，**5/5 全部吻合**（各差 2~20 秒）。

## 機制：443 的收容站會浮動，而備位那個的憑證是錯的

- 全部 conf **沒有任何人宣告 `listen 443 default_server`** ⇒ 收容站＝**載入順序第一個** 443 區塊。
- 順序（`nginx -T` 看得到）：`conf.d/odoo-envs.conf` → `sites-enabled/AICEO` → …
- 我們的 `odoo-envs.conf` 只寫「status=running 且 external_slot 不為 NULL」的環境。
  **一旦少了那個 slot 的區塊，`odoo-ai-test-N` 就掉到 AICEO**，而 AICEO 憑證的 SAN
  **只有 `aiceo.ideaxpress.biz` 一個名字** ⇒ 名字對不上 ⇒ 瀏覽器 alert 46 ⇒ 整頁連不上。
  （測試區自己的憑證涵蓋 test-0~9，所以掉到「別的測試區區塊」不會出事，只有掉到 AICEO 才會。）

## 可照抄的三個驗證

1. **收容站是誰**：`openssl s_client -connect <nginxIP>:443 -servername zzz-notexist.<domain>`
   → 回誰的憑證，誰就是現在的收容站。
2. **翻過去的鐵證**：`grep "server: aiceo" error.log | grep 'host: "odoo-ai-test'`
   ——2026-09-10 當天 12 筆。**只有「接受錯憑證的客戶端」（curl／掃描器）才留得下這種行**；
   瀏覽器會直接握手失敗，只留 `0.0.0.0:443` 那種行。兩種要一起看。
3. **別只用 upstream 埠號去 grep error.log**：我第一次只搜 `21001`，結果只撈到 proxy_temp 緩衝的
   warn，把整條線漏掉。要用 `server: <網域>` 和**客戶端 IP** 兩個角度各搜一次。

## 觸發源已定位到「reload 爆量」，但按的人還沒查出來（2026-09-10 收工狀態）

**每一次 alert 46 之前十幾秒，都有人連續 reload nginx 8 次**，5/5 全中，最後一次實測：

```
15:35:17~15:35:36  SIGHUP ×8（4 次一批，隔約 18 秒再 4 次）
15:35:50~15:36:26  alert 46 ×23，client 全是同一個真人 IP，沒有第二個客戶端
15:36:28           他從平台重進
15:36:58           30 秒後才接回 websocket（worker 重連退避）
```

**不是本平台做的**：那段期間 `odoo-envs.conf` 的 mtime 沒變（我們是寫檔後才 reload，寫了 mtime 一定變）。
**也不是 nginx-ui 的 AutoCert**：它 15:41 才跑，且該輪 Start/End 同一秒、什麼都沒做。
**測試區憑證檔自 07-30 起未被改過**，排除換憑證。
⇒ 是**第三方**在 reload 這台共用 nginx。

## 已布署的兩支監控（只讀，`setsid` 脫離 session，ppid=1）

- `~/.claude/tls-watch/watch.sh` → `events.log`：每 2 秒探測「`odoo-ai-test-0` 現在拿到誰的憑證」＋
  「conf 裡還有沒有那個 server_name」，只在變化時寫一行；另收 nginx 的 alert 46。
- `~/.claude/tls-watch/who-reloads.sh` → `reloads.log`：`docker events --format '{{json .}}'`
  抓 nginx 容器的 `exec_create`（reload 都走 docker exec），排掉監控自己的探測。

⚠ **平台容器一重啟兩支都會死**（跑在容器內），要手動重開。
⚠ `docker events` 的 `--format '{{.Status}}'` 會報 `can't evaluate field Status`，要用 `{{json .}}` 再自己剖。
⚠ `pkill -f <腳本名>` 會連自己的 shell 一起殺（指令列含該字串），要用 `ps` 取 pid 再逐一 kill。

## 下一次抓到就能二選一

- `cert=aiceo... block=0` → 「區塊消失」成立，修法＝永遠輸出全部 slot 的區塊。
- `cert=odoo-ai-test-0... block=1` 全程沒變 → 區塊沒消失，要改查 reload 當下的競態。

## 原本尚未查明

「萊峰19 的區塊為什麼會短暫消失」還沒定位。已排除：對外名額的背景回收（`EXTERNAL_IDLE_MIN`
未設＝預設 0＝停用）、平台開機時不重寫 conf（`index.js` 沒呼叫 `syncNginxMap`）。
下一步該盯 `odoo-envs.conf` 的內容變化與 reload 事件。
另注意當天有**非本平台**的 SIGHUP 爆量（一分鐘 8 次，`worker_shutdown_timeout` 未設所以不踢連線）。

⚠ 使用者明確交代 **nginx 設定不准動**（全公司共用）。修法要留在我們自己產的 `odoo-envs.conf` 裡，
例如「永遠至少輸出一個帶正確憑證的區塊」，讓收容站不會翻到 AICEO。
