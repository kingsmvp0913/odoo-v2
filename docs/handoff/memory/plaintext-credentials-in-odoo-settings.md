---
name: plaintext-credentials-in-odoo-settings
description: users.odoo_settings 的 odoo_password／service_password 原為明碼，2026-08-11 已改成 APP_SECRET 加密存放（API 形狀不變）；正式 DB 的 4 筆既有明碼要等重啟跑 migrate 才轉
metadata:
  node_type: memory
  type: project
  originSessionId: f67467ed-ef4b-4119-bb27-cd1c8e0790c1
---

`users.odoo_settings`（jsonb）裡的 `odoo_password` 與 `service_password` 原本是**明碼**，而同一張表的
`github_pat_enc` 早就用 `APP_SECRET` 加密（`lib/git-identity.js`）——同一張表兩套標準。2026-08-07 回報，
2026-08-11 處理。

**修法（本地 commit 未 push）**：新增 `lib/user-settings.js` 的 `encryptSettings`／`decryptSettings`，
只在「進出 DB 的那一刻」轉換。**刻意不改 API 形狀**（GET 照回明碼、PUT 照收明碼）——settings 頁是
「載入整包 → 存檔時原樣鋪回」的設計，GET 一旦不回密碼，使用者存一次設定就會把自己的密碼清空，
那要連 PUT 的語意一起改，風險高得多。所以本次只解決「DB 裡是明碼」，**沒有**解決「密碼會回流到瀏覽器」。

接線點（全庫盤過）：
- 加密：`settings.js` 的 `PUT /api/settings`
- 解密：`settings.js` 的 `GET /api/settings`、`auth.js` 的 `/api/auth/me`、`pipeline/sync.js` 的
  `resolveUserOdooSettings`（sync 取憑證的單一出口）
- 不用改：`PUT /settings/theme`／`/settings/views`（read-modify-write，密文原樣進出）、
  `verify-odoo`／`verify-service`（密碼來自 req.body）、`runner.js` 的 `getUserSettings`（只取
  `git_repo_path`）、`teams.js`（只取 `teams_user_id`）、`db.js` 那支取 URL+DB 的一次性 migration

**三個設計決定**：
1. **以「decrypt 成功」判定是否已加密**，不比對 `a:b:c` 字面格式——密碼本身可能剛好含兩個冒號，
   用格式判斷會把明碼誤認成密文而跳過加密。
2. **解密失敗一律當舊明碼原樣回**。既有資料才不會壞；代價是 `APP_SECRET` 被換掉時會拿密文去登入
   （見 rules/infra #121：搬 DB 要一起搬 APP_SECRET）。
3. **`APP_SECRET` 未設時保留明碼並告警，不擋存檔**。加密設施缺失不該把安全問題換成可用性故障。

**既有資料**：`db.js` 的 `migrate()` 加了一次性遷移（idempotent，內容沒變就不寫）。正式 DB 原有
**4 個帳號有 odoo_password、3 個有 service_password**。**2026-08-12 複驗：4 筆全數已轉密文**
（`odoo_settings->>'odoo_password'` 皆為 `b64:b64:b64` 三段、長度 58~62）→ 這半已結案。

⚠ **複驗時別用 hex regex**：`encrypt()` 輸出的是 **base64** 三段（`iv:tag:enc`），不是 hex；
我第一次用 `~ '^[0-9a-f]+:...'` 判斷，全回 false，差點誤判成「migration 沒跑」。
長度也別當明碼指標——12 byte 明文加密後才 58 字元，看起來跟長密碼難分。

**查 DB 時仍要避免整欄 select `odoo_settings`**（會把值印進對話記錄）；改用
`odoo_settings->>'x' IS NOT NULL` 這種只問「有沒有」的寫法。
