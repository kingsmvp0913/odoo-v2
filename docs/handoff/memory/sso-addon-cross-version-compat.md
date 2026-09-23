---
name: sso-addon-cross-version-compat
description: idx_aidev_sso 的三個跨 Odoo 版本坑（group_user／make_response status／request.redirect）與「測試區白屏」的正確判讀法
metadata: 
  node_type: memory
  type: project
  originSessionId: b9b082c1-ce10-4a65-916d-30abc138bf00
---

`app/docker/addons/idx_aidev_sso` 掛進**每一個**測試容器，所以它踩到的版本差異會讓「整個測試區進不去」。
2026-08-20 一次挖出三個，全部已修並實測（14 與 15 環境各跑過）：

| 坑 | 14 | 15 | 17/18/19 | 症狀 |
|---|---|---|---|---|
| `base.group_erp_manager` 隱含 `group_user` | ❌ | ❌ | ✅ | JIT 帳號 share=True → **後台整片空白** |
| `make_response(..., status=)` | ❌ | ❌ | ✅ | 每一條「拒絕」變成 500 traceback |
| `request.redirect()` | ❌ | ✅ | ✅ | **成功路徑也 500**，測試區完全進不去 |

修法：group 明確給 `[group_user, group_system]`；錯誤回應改 `_err()`（拿 Response 再設 `status_code`）；
導向改 `werkzeug.utils.redirect('/web', code=303)`。**加新 Odoo 版本前先跑一次上面三項的實測。**

## 「測試區白屏」的判讀法（我 2026-08-20 誤判過一次）

白屏**不要先猜「模組沒裝」**。只裝 base+web 的 Odoo 仍會顯示「設定」等 App，不會全白。
正確做法是抓 `/web` 回傳的 HTML 看 `odoo.__session_info__`：

- `cache_hashes` 只有 `translations`、且**沒有 `user_companies`** ⇒ 這個帳號不是內部使用者。
  web 的 `session_info()` 用 `if self.env.user.has_group('base.group_user')` 決定塞不塞
  `load_menus`／`qweb`／`user_companies`（`web/models/ir_http.py`），三者皆缺 → webclient 開機即死。
- log 裡出現 `GET /web/webclient/qweb/undefined` 是同一件事的鐵證（`cache_hashes.qweb` 取不到）。
- 交叉驗證：`SELECT share FROM res_users WHERE login=...`，`share=true` 就是外部使用者。

**改完 group 要重啟容器才生效**——`has_group` 走 ormcache，從外部進程改 DB 不會讓常駐進程失效，
「補了群組畫面還是白的」不代表修法錯。

相關 [[sso-jit-create-hr-attendance-crash]]（同一段 JIT create 的另一個坑）。
