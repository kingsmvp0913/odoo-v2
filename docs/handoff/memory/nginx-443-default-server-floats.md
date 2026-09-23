---
name: nginx-443-default-server-floats
description: 「開測試區卻看到 AICEO」根因＝共用 nginx 的 443 沒人設 default_server，收容站＝第一個載入的 block，會隨平台 conf.d/odoo-envs.conf 是否為空在 AICEO 與測試區之間浮動；使用者裁決不修
metadata: 
  node_type: memory
  type: project
  originSessionId: 7b352fad-827d-438f-b018-4ac163f2462c
---

2026-08-11 排障結論。症狀：開測試區的子網域，有時顯示的是 AICEO（別人的正式站）。

**根因**：`agency-NginxUI-1` 的 `nginx.conf` 是 `include conf.d/*.conf`（第 22 行）在 `include sites-enabled/*`（第 23 行）**之前**，而全台 18 個 `listen 443` **沒有任何一個標 `default_server`**。nginx 規則：沒人明示時，該 socket 上第一個 server block 就是 SNI 對不上時的收容站。於是收容站隨平台自己寫的 `conf.d/odoo-envs.conf` 內容浮動：

| odoo-envs.conf | IPv4 443 收容站 |
|---|---|
| 空（沒人借 slot） | AICEO（sites-enabled 第一個 443） |
| 非空 | 平台的第一個測試區（`ORDER BY external_slot` 的最小 slot） |

IPv6 `[::]:443` 恆為 AICEO——平台產的 block 只 listen IPv4。

**兩個方向是同一個坑**：使用者看到的是「測試網域當下沒有 block（slot 被回收／同步失敗／舊網址）→ 落到收容站 → 那刻是 AICEO」；反方向是「平台有人借 slot 時，未知 SNI／IP 直連 https 會被導進測試區」。後者實測證實：`curl --resolve bogus.ideaxpress.biz:443:192.168.10.110` → 303 導向 `/odoo`；同時 `aiceo.ideaxpress.biz` 帶正確 SNI → 200 正常。

**證實平台沒有動到別人**：`odoo-v2` 容器只掛載 `conf.d`（`docker inspect` 確認），`sites-enabled` 根本沒掛進來、結構上寫不到；21000-21099 是 nginx 自己 publish 的，與別人的 3000/7777/8xxx 零重疊；`nginx -t` 不過就 rollback 不 reload。

**使用者裁決（2026-08-11）：不修**。理由是帶網域名的正常流量完全不受影響，受害面只有「用 IP 直連 https」這種本來就不可靠的用法。真要修，最小動作是請 AICEO 維護者在它的 `listen 443 ssl` 加 `default_server` 一個字（雙向根治）；平台側的 B 案（未借出的 slot 也產 `return 503` block）**無法零影響**，因為它會讓 conf 永遠非空＝平台永久搶走收容站。

**下次撞到的判別法**：測試區網址顯示成別的站，先 `docker exec agency-NginxUI-1 nginx -T | grep -n "server_name\|listen.*443"` 看該子網域當下有沒有 block，不要往 DNS／憑證／Odoo 本身鑽。相關 [[deployment-topology]]、[[external-access-decision]]。

**遺留未解**：`env-routes.js:98` 的 `await syncNginxMap()` 失敗只回 `{ok:false}` 不 throw，端點沒檢查回傳值就把網址交給瀏覽器——reload 失敗時使用者照樣拿到一個 nginx 上不存在的網址。
