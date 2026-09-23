---
name: testenv-disconnect-from-platform-restart
description: 測試環境的 Odoo 連的是平台容器裡的 postgres，平台一重開所有測試環境就瞬斷；bus 停 50 秒、cron 執行緒永久死掉；附「哪一層才看得到」的四層查法
metadata:
  node_type: memory
  type: project
---

2026-09-10 查萊峰19「一直斷線」。**不是 [[asset-301-loop-from-missing-filestore]] 復發**（實測缺檔 117 個
全是頭像／付款圖示，asset bundle 一個都沒缺；當天 311 個請求全 200、零 5xx、websocket 每次都 101）。

## 真正的結構問題：測試環境的 DB 寄生在平台容器裡

env 容器的 Odoo 連 `host.docker.internal:8772`，那顆 postgres 就跑在 **odoo-v2 平台容器內**（pid 19）。
所以「重啟平台」＝所有測試環境的資料庫同時瞬斷。實測 2026-09-10 一天重開 5 次（09-04／09-05 各 19 次）。

每次瞬斷的後果，**兩者嚴重程度差很多**：
- bus（訊息推播）：`Bus.loop error, sleep and retry` → 固定睡 **50 秒**（`TIMEOUT=50`）才自己接回來。會自癒。
- **cron 執行緒直接死掉且不會重生**：log 出現 `Exception in thread odoo.service.cron.cron0/cron1`，
  例外從 `_bootstrap_inner` 逃出去 ＝ 執行緒沒了。實測 06:18 死後 30 分鐘零排程，要整個 Odoo 重開才回來。
  ⇒ 「客戶說排程沒跑」先查這裡，別急著查 cron 設定。

HTTP 反而不受影響：`sql_db.py` 的 `borrow()` 對死連線會 `cnx.reset()` 失敗就丟掉重連，會自癒。

## 判讀：症狀在哪一層，就只有那一層看得到

四層都要查，缺一層就會下錯結論：
1. `docker logs <env容器>` — **只有本次啟動的內容**，容器一重開就沒了。
2. **共用 nginx 的 access log**（`agency-NginxUI-1:/var/log/nginx/access.log`）— nginx 擋掉的錯誤
   （502／憑證）不會進 Odoo log。log_format 沒有 `$host`，只能靠 referer 或 IP 認站。
3. `/var/lib/postgresql/data/postgresql.log` — 平台自己那顆。`received fast shutdown request` ＋
   `terminating connection due to administrator command` ＝ 平台被重開了。用它數一天重開幾次。
4. `docker inspect odoo-v2` — `ExitCode=0` ＋ `RestartCount=0` ＝ 人手動 `docker restart`，不是崩潰。

⚠ **nginx access log 的 101 那行，時間是「連線關閉」不是「連上」**（長連線在結束時才寫 log）。
拿它跟 Odoo log 的 101（連上就寫）對照，才能算出每條 websocket 活了多久。用這招證明了
Odoo 的 websocket **有撐過** DB 瞬斷，斷的只有平台頁面自己的 `/socket.io/`。

## 「斷了七八次」拆開來是兩件事

查詢窗口一定要收斂成「該環境本次開機到現在」（本例 13:44→15:04，80 分鐘），查一整天會混進別人的事件。
該窗口內實測：

- 測試環境本身**一次都沒斷**：604×200／324×304／0 個 4xx5xx，Odoo websocket 只在使用者自己
  重新進入後才關閉（關閉時刻永遠緊跟在 `/aidev/sso` 後 7 秒內）⇒ 是重進造成關閉，不是斷線造成重進。
- 真正斷的是**平台頁面**的 `/socket.io/`，3 次，與平台容器重開秒級吻合。
- 使用者重進測試環境 5 次。5＋3＝8，這才是「七八次」的來源。

⇒ 回報「測試環境斷線」時先分清楚**斷的是哪一個分頁**：平台頁面斷線會讓人以為是測試環境掛了。

⚠ nginx 是全公司共用的（AICEO／SCM／coworker 都在上面），使用者明確交代**不准動 nginx 設定**。
另註：下午出現過「4 次 reload、隔 20 秒再 4 次」的 SIGHUP 爆量，來源不是本平台（本平台只在借還
對外名額時 reload 一次），但 `worker_shutdown_timeout` 未設 ⇒ 舊 worker 會等 websocket 結束才退，
**reload 不會踢掉連線**，排除嫌疑。
