---
name: sso-jit-create-hr-attendance-crash
description: 測試區點下去 500 的一類根因：SSO JIT 建帳號在裝了 hr_attendance 的環境撞 Odoo 19 核心空集合 bug；已修
metadata: 
  node_type: memory
  type: project
  originSessionId: ed221013-16d0-4ec5-a438-fb6e1c3ed6cc
---

使用者點測試區（`/api/projects/:id/env/sso` → odoo `idx_aidev_sso` `/aidev/sso`）對「尚未 seed 進該環境 res.users 的真人使用者」會走 JIT create 分支（`main.py` `Users.create`）。在**裝了 hr_attendance 的環境**（如 odoo19_HRM），建內部使用者時 base `res_users.create:590` 會自動補 initials 頭像（`user.image_1920 = ...`），這個後寫打進 hr `res_users.write` 的 image 分支 `without_image.write()`（無 `if employees` 防呆），對「此新 user 還沒有的 hr.employee 空集合」寫入 → 觸發 Odoo 19 核心 `hr_attendance._clean_attendance_officers` 在空 recordset 上的 bug：`TypeError: inconsistent models res.users() - hr.employee()` → HTTP 500。

**只在 HTTP 崩、odoo shell 重現不出來**（prefetch/context 差異），所以只能用真正的 HTTP 迴圈驗證：拿 `odoo_envs.sso_secret` 用 `app/server/sso.js` mintSsoToken 簽一個新 login → `curl .../aidev/sso?token=...`。已 seed／已存在的使用者走 search-hit、不 create，故不受影響（這就是「只有某些使用者」的原因）。

**修法（已套用並實測 303）**：`app/docker/addons/idx_aidev_sso/controllers/main.py` 的 JIT create 帶一張佔位 `image_1920`（`_PLACEHOLDER_AVATAR`，須為該版 Pillow 能解的合法 PNG——1x1 太小會被判 Truncated，用 16x16），讓 `not user.image_1920` 為 False 跳過自動補頭像的後寫。核心 Odoo 不可改（Hard Rule），故修在自家 addon。

注意：controller 改動要 `docker restart odoo-test-<folder>` 才會重載（odoo 是 PID 1，啟動帶 `-i idx_aidev_sso`）；既有 running 環境要重啟或重建才吃到新碼。seed（`env-agent.js:851`）只灌 E2E 帳號，真人一律靠 JIT create。相關 [[seed-keyerror-resusers-two-causes]]。
