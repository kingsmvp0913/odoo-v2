---
name: testenv-db-superuser
description: 測試區 Odoo 用平台的 PG 超級使用者連線，進測試區的 admin 能讀平台 DB 與別家測試資料——不經 AI，子專案 0 擋不住；修法已寫進規格未實作
metadata: 
  node_type: memory
  type: project
  originSessionId: c586d7a8-ef07-4cfa-8e65-41229602f249
  modified: 2026-09-16T01:08:55.019Z
---

2026-09-14 查產品化 3-P3（客戶進測試區的權限）時實查到：

- `pipeline/env-agent.js:193` `odooDbArgs()` 直接拿平台 `DATABASE_URL` 的帳密，經 `lib/docker-env.js` `dbEnvFlags` 以 `-e USER/PASSWORD` 傳進每個測試區容器；seed／升級／tour 的 `docker exec` 同一組。
- 那個帳號 `odoo` 是 **PG 超級使用者**（`rolsuper=true`）；同一個 PG（埠 8772）有平台 DB `aidev`＋全部 `test_*`（當天 17 個）。
- 測試區 SSO 帳號同步成 admin 群組（`docker/addons/idx_aidev_sso/controllers/main.py:54-68`），含 `base.group_system` ⇒ 能建伺服器動作跑 Python。
- `--db-filter`／`--no-database-list` 只擋網頁介面，擋不住容器內 Python 自己連 DB。

**Why**：任何進測試區的人、或 AI 寫進模組的一段碼，都能讀平台 DB、改別家測試庫，超級使用者還能 `COPY … TO PROGRAM` 在平台容器執行指令拿 `data/config.json`。這條路不經 AI 容器。

**How to apply**：使用者裁決（09-14）客戶在測試區**維持 admin**，改修 DB 帳號：每測試區一個 `NOSUPERUSER` PG 角色、擁有自己的 DB、各 DB `REVOKE CONNECT FROM PUBLIC`、缺角色大聲失敗不退回平台帳號。規格在 `docs/superpowers/specs/2026-09-11-tenant-isolation-design.md` §10、開發順序階段 2c；**尚未實作**，客戶進測試區前必完成。計畫階段要實測非超級使用者跑 `-i base`／建 `unaccent` 擴充的權限。

**09-15 實測（使用者同意在正式 PG 跑 drill_* 臨時物件，已清除）**：規格的 `REASSIGN OWNED BY odoo` **不可用**（odoo 是 bootstrap 超級使用者 oid 10，報錯；且 REASSIGN OWNED 會連其他 DB 擁有權一起轉）→ 改逐物件 ALTER OWNER；Odoo 17 非超級使用者 `-i base`、轉擁有者後 `-u base` 都 exit 0；DB 由平台先建時 Odoo 跳過建 pg_trgm，平台要自己建；REVOKE CONNECT、COPY TO PROGRAM、pg_authid、pg_read_file、CREATE DATABASE 全擋。**測試陷阱**：從平台容器 psql 連 10.0.0.1 來源 IP 是 192.168.10.110 → no pg_hba entry；要從 bridge 臨時容器（`docker run --entrypoint psql odoo-idx:17`）測才對。結果寫在 tenant spec §10.6。**09-15 已實作並 push `8ca9913d`**（計畫 `docs/superpowers/plans/2026-09-15-testenv-db-role.md`；全跑 316 suites／4931 passed，mutation 三道皆紅）：`lib/testenv-db-role.js`（testenv_p<id>、密碼存 odoo_envs.db_password_enc）、docker-env IO 邊界拒絕非 testenv_p 帳號、runEnvSetup 先 ensureTestEnvDbRole、deploy 前 dbUserDrift 擋舊容器、啟動 revokePublicConnectAll。**未重啟、Task 7 正式驗證未做**（要重建一個測試區如 liSheng project 18，再從容器內驗 aidev 連不進；隔天確認沒有 USER=odoo 的 odoo-test-* 容器）。注意 `lib/docker-env.js` 是 CRLF。

**⚠ 09-16 實測：2c 上線後測試區「完全建不起來」，真因＝漏了 `postgres` 維護庫的 CONNECT。**
`revokePublicConnectAll` 連 `postgres` 也一起撤（規格 §10.4、計畫 Task 6、`testenv-db-role.test.js:177` 三處都把這行為寫死成「正確」），但 **Odoo 非連 `postgres` 不可**：①映像 entrypoint 先跑 `/usr/local/bin/wait-for-psql.py` 連 `postgres`，連不到直接 `exit 1`——容器只吐**一行** `Database connection failure: … permission denied for database "postgres"` 就死，**沒有任何 Odoo log**，`odoo_envs.setup_log` 與 `error_msg` 全空、狀態永久卡 `setting_up`；②`bus.py:233` `Bus.loop` 的 imbus `LISTEN`、`ir_cron.py:538` `_notifydb` 喚醒 worker 也都是 `db_connect('postgres')`。
**修法**：`ensureTestEnvDbRole` 在 REVOKE 之後補 `GRANT CONNECT ON DATABASE "postgres" TO <role>`（只給該角色、不放回 PUBLIC）。實測放行 `postgres` 之後 `aidev`／別家 `test_*` 仍全擋、`COPY TO PROGRAM` 擋、`pg_authid` 擋、`rolsuper=f`——隔離沒有打折。
**為什麼 09-15 演練沒抓到**：`revokePublicConnectAll` 只在平台啟動時跑，演練時 `postgres` 還留著 PUBLIC 的 CONNECT；Task 6（全面撤銷）與 Task 7（真的建一個環境）從未在同一次執行裡碰頭。**演練用的角色若沿用預設權限，等於沒測到撤銷後的世界。**
**Task 7 驗證結果（09-16，project 18 立勝補習班）**：`USER=testenv_p18`、DB 擁有者已轉、public schema 內屬 `odoo` 的物件 0、`/web/login` 回 200、`ir_cron` 工作正常跑完。SSO 登入未由人實際點過。

相關：[[productize-saas-decision]]、[[odoo-test-env-shell-testing]]
