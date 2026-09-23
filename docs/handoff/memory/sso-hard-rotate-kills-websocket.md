---
name: sso-hard-rotate-kills-websocket
description: SSO 的 should_rotate=True 會硬刪 session 弄斷自己另一個分頁的 websocket（實測成立），但**它不是使用者回報「一直斷線」的原因**——只影響同一個瀏覽器，弄不斷別人；真因仍未知
metadata:
  node_type: memory
  type: project
---

⚠ **2026-09-10 當天就被實測推翻為「真因」**，保留是因為機制本身確認存在、且示範了一個很容易犯的錯。

**推翻的證據**：由 A 帳號連按兩次「開啟測試區」，被刪掉的只有 A 自己的 session 檔，
另一個使用者 Neo 的 session 檔（`g_ohJq…`）**原封不動**。session 旋轉只作用在
**發出該請求的那個瀏覽器**，弄不斷別人。而回報斷線的是 Neo。

**更根本的錯**：使用者當場指出「他是**因為**斷線才去點測試區，不是點了才斷線」——
我把因果接反了。「每次 X 之後都跟著 Y」不等於 X 造成 Y，尤其當 Y 本來就是使用者對 X 的反應時。
**下次先問「這個動作在正常使用情境下會發生嗎」，再開始追它的後果。**

以下機制本身仍為實測成立（Odoo 17 鴻久：第二次登入後舊 session 當場被刪、websocket 隔 28 秒才重連），
只是它解釋的是「同一個人自己開第二個分頁」，不是使用者回報的症狀。

2026-09-10 原記錄：**不是** [[asset-301-loop-from-missing-filestore]] 復發，
**也不是**平台重啟（那個是另一回事，見 [[testenv-disconnect-from-platform-restart]]）。

## 故障鏈（每一環都實測過）

1. `app/docker/addons/idx_aidev_sso/controllers/main.py` 的 `_login_as()` 設 `session.should_rotate = True`。
2. Odoo `http.py:2175` 看到 `should_rotate` → `rotate(sess, env)`，**soft 參數沒帶＝硬旋轉**
   → 走 `else: self.delete(session)`（`http.py:1060`）＝**舊 session 檔直接刪掉**。
   對照組：Odoo 自己的定期旋轉是 `rotate(sess, env, True)`（soft），會在舊 session 裡留下
   `next_sid` 麵包屑並多留 `SESSION_DELETION_TIMER` 秒。**這個差別就是全部**。
3. 還開著的 websocket 每次心跳走 `WebsocketRequest._get_session()`（`addons/bus/websocket.py:945`）：
   有 `next_sid` 就跟著走到新 session；**檔案被硬刪 ⇒ 直接 `raise SessionExpiredException()`**。
4. `websocket.py:1137` 接住它 → `websocket.close(CloseCode.SESSION_EXPIRED)`，
   **這條路徑不寫任何 log**（只有 generic Exception 那條才 `_logger.exception`）。
5. 前端 `bus_monitoring_service` 把 CONNECTING→DISCONNECTED 記成 `isConnectionLost`
   → 跳「Real-time connection lost…」。websocket worker 是 **SharedWorker，全部分頁共用一條**，
   所以是**所有已開的測試區分頁一起跳**。
6. 使用者以為斷線 → 回平台再按一次「開啟測試區」→ 回到第 1 步。**自我延續的迴圈。**

平台的按鈕是 `window.open(url, "_blank")`（`ProjectList.js` / `ProjectDetail.js` 的 `openEnv`），
每按一次開一個新分頁，舊分頁不會關 ⇒ 迴圈只會越滾越大。

## 為什麼查半天查不到——它在伺服器端完全沒有痕跡

實測 13:44→15:04 這 80 分鐘：nginx 604×200／324×304／**0 個 4xx5xx**，Odoo 也零 5xx。
因為 SESSION_EXPIRED 的關閉不落 log，HTTP 又完全不受影響（cookie 已換成新的，照樣 200）。
**「伺服器全綠」在這個病上不構成任何證據。**

## 四個可照抄的驗證手法

- **session 檔的目錄 mtime ＝ 刪除時刻**：`docker exec <env> find /var/lib/odoo/sessions -type d -printf "%TH:%TM %p\n"`。
  本次留下四個**空目錄**，時間 06:23／06:26／06:40／06:44 UTC，與四次 `/aidev/sso` 一秒不差；
  五次登入只剩 1 個 session 檔。這是最硬的證據。
- **nginx access log 的 101 那行時間是「連線關閉」不是「連上」**（長連線結束才寫 log），
  拿它減 Odoo log 的 101（連上就寫）＝ 該條 websocket 活了多久。本次 4/4 都在 SSO 後 **2–9 秒**關閉。
- **「連線中斷」有兩種，查法完全不同**：RPC 那種（`error_handlers.js` 的
  "Connection lost. Trying to reconnect...")會固定去打 `/web/webclient/version_info` 輪詢
  ⇒ **log 裡搜 `version_info`，0 筆就代表不是這種**；bus 那種（"Real-time connection lost…"）零 HTTP。
- 新 websocket 要 **15–33 秒**才出現＝worker 的重連退避，不是伺服器慢；橫幅會一直掛到那時候。

## 修法方向（未動手，等拍板）

把 `should_rotate = True` 換成明確的 soft 旋轉，或「本來就已登入成同一個 user 就不旋轉」。
⚠ 硬旋轉是防 session fixation 的正解，改之前要想清楚：我們的 token 是一次性 jti（已防重放），
但 soft 旋轉會讓舊 sid 多活一段時間。**這是安全取捨，不要自己決定。**

## 順帶確認的兩件事（這兩件是真的，跟上面的推翻無關）

- **Odoo 17 完全沒有斷線提示元件**（`bus_monitoring_service`／`bus_connection_alert` 都是 19 才有）。
  ⇒ 17 的環境底層斷 28 秒，畫面上一個字都不會出現。「使用者沒抱怨」不代表沒斷。
  ⇒ **拿 17 的專案去重現 19 的畫面症狀，一定失敗**，而且失敗的原因跟你要驗的假設無關。
- 「連線中斷」在 Odoo 19 有三種不同的字，各自指向完全不同的成因，**問到確切字串等於直接定位**：
  「Connection lost. Trying to reconnect…」＝RPC 失敗（會輪詢 `version_info`，log 搜得到）／
  「Odoo Session Expired…」＝session 掉了（`error_dialogs.js` 綁 `odoo.http.SessionExpiredException`）／
  「Real-time connection lost…」＝bus 斷線，**只在討論畫面顯示**、零 HTTP 痕跡。
