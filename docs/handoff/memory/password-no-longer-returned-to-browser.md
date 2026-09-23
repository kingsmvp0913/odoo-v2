---
name: password-no-longer-returned-to-browser
description: users.odoo_settings 的密碼 2026-08-12 起不再回流瀏覽器（e708c7d）——GET 只回 *_set 旗標、PUT 未提供即沿用舊值；含「共用同一顆儲存鈕會清空密碼」這個最高風險點與驗證手法
metadata: 
  node_type: memory
  type: project
  originSessionId: 7838e378-5e62-4a4d-a69e-922eea0d06fd
---

`c91e391`(08-11) 把 `odoo_password`／`service_password` 改成密文存 DB 時，**刻意沒動 API 形狀**
（GET 照回明碼），理由是 settings 頁「載入整包→存檔時原樣鋪回」，GET 不回密碼會讓使用者存一次
設定就清空自己的密碼。結果加密只擋住「翻 DB 的人」。**`e708c7d`(08-12) 把那個前提一起拆掉了。**

**現行契約（改這塊之前先看這段）**：
- `GET /api/settings` 與 `GET /api/auth/me` **不回密碼**，改回 `odoo_password_set` /
  `service_password_set` 兩個布林旗標（`lib/user-settings.js` 的 `redactSettings`）。
- `PUT /api/settings` 對這兩個欄位是「**未提供或空字串＝沿用 DB 現值**」（`preserveSecrets`），
  其餘欄位維持整包覆寫（theme／saved_views 仍靠前端鋪回，那兩支獨立端點是 read-modify-write）。
  代價：**沒辦法從這支 API 清空密碼**，刻意取捨（誤清空的代價遠高於清空的需求）。
- `verify-odoo`／`verify-service` 在 body 沒帶密碼時**改從 DB 取**。不補這條的話「只改帳號按驗證」
  會逼使用者把沒改過的密碼重打一次。
- 前端 input 留空即不變更，label 依旗標顯示「已設定，留空表示不變更」。

**最高風險點**：`Settings.js` 四個區塊**共用同一顆儲存鈕**（`@click="save"`）。GET 不再回密碼後，
「只改顯示名稱就按儲存」送上來的整包必然不含密碼——若哪天有人把 `preserveSecrets` 拿掉或改壞，
使用者每存一次設定就清空一次密碼，而且**要等到下次同步失敗才會發現**。

**驗證手法（值得複用）**：光看測試全綠證明不了它咬得住。我把 `preserveSecrets` 暫時拆掉重跑，
**19 條裡精準紅那一條、其餘 18 條照常綠**——這才證明測試不是恆真式。改動有「唯一防線」性質的碼時
都該這樣驗一次。

**仍未做**：`Login.js` 註冊精靈走同一支 PUT，但新帳號必定輸入密碼（有值就直接覆蓋），行為一致，
不需改。

相關：[[plaintext-credentials-in-odoo-settings]]（DB 加密那一半）、[[stale-memory-blocks-work]]
