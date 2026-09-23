---
name: kangyue-filestore-uid-mismatch
description: odoo17_kangyue 測試區 asset bundle 500 的真因是 filestore 子目錄 owner=宿主1004/755、容器內 odoo(uid 101) 寫不進，非 OWL/xpath；已 chmod 修好但「為何只有它是宿主端寫的」未解
metadata: 
  node_type: memory
  type: project
  originSessionId: 1e23520d-a30c-4312-afc7-813761d5b3ea
---

2026-08-07 查 task 109（IDX-2026080013）確認：測試區後台 `/web/assets/.../web.assets_web.min.js` HTTP 500 的真因是 **filestore 權限**，與 JS／OWL template／xpath 完全無關。pipeline 前三輪照 deploy 的通用文案（「多為 OWL/QWeb template 的 xpath 對不到目標」）叫 coding 改 JS，方向從頭到尾是錯的。

**完整鏈**：`bundle.js()` → `save_attachment` → `_clean_attachments` → `_unlink_attachments` → `_file_delete` → `_mark_for_gc` → `open('<filestore>/<db>/checklist/xx/<hash>','ab')` → PermissionError。關鍵：`_file_delete` 這條的 `_mark_for_gc` **沒有被 try/except 包住**（`_file_write` 那條有，所以那個 PermissionError 只是被吞掉的 log 噪音，會誤導判讀）。asset bundle 每次重生都要刪舊 attachment，所以必炸。

**權限現況**：容器 image `odoo-idx:<major>` 最後是 `USER odoo`，`docker run` 不帶 `--user`。各版本 image 內 uid 不同——odoo:17 是 **101**、odoo:18/19 是 **100**。`env-agent.js` 建 filestore 時只 `chmod 0o777` **最上層那一層**，底下 db 目錄與 hash 子目錄的 owner 取決於誰建的。

- 正常環境（odoo17、odoo17_hungjou、odoo18_geon、odoo19、odoo19_HRM、odoo19_ciyun）：子目錄 owner = 100 或 101 = 容器自建，755 對它自己可寫，**沒問題**。
- odoo17_kangyue：子目錄 owner = **1004（宿主 odoo）**、755 → 容器內 uid 101 只有 r-x，寫不進去。**全平台唯一異類**。

⚠ **動 filestore 的 owner 前，一律先 `docker exec <容器> id odoo` 查那個 image 的 uid，不要照別的環境抄。**
2026-08-24 我從 raifong(17，uid 101) 複製檔案到 odoo19_raifong 時，照 17 的樣子 `chown -R 101:101`，
把整個 19 的 filestore（含 Odoo 自己寫的既有檔）owner 從 100 改成 101——19 的 image 內 odoo 是 **100**，
那等於親手製造本記憶描述的「容器寫不進 filestore」。發現後以 root 容器 `chown -R 100:101` 修回。
本檔第 14 行早就寫明各版本 uid 不同，我卻沒查就抄——**這條規則存在的意義就是省掉這次的來回。**

**判讀陷阱兩個**：(1) 只看「others 是否可寫」會把所有環境誤判成中招，必須比對 owner 是否等於該 image 的 odoo uid；(2) 在平台容器內 `ls` 看到 owner 顯示 `postgres:ssl-cert`，那是 uid 100 在平台容器 `/etc/passwd` 撞名，實際就是 odoo:18/19 的 odoo，不是真的 postgres 寫的。

**已做**：`chmod -R a+rwX /home/odoo/odoo-envs/odoo17_kangyue/filestore`，並以 `docker run --rm -v ... odoo-idx:17 sh -c 'touch .../checklist/a0/_probe'` 實測複驗可寫。

**未解／未做**：
- 為何只有 kangyue 的 filestore 是宿主端（uid 1004）寫的仍不明——`app/server` 全域 grep 碰 filestore 的只有 `env-agent.js` 的 mkdir+chmod 與 `env-routes.js` 的刪除，都不會建 db 子目錄。沒查清就只能治標。
- 防復發（`env-agent.js` 的 chmod 改遞迴、或改由容器自建）尚未動。

相關：[[e2e-disabled-runtime-errors-escape]]（同屬「產出在瀏覽器點下去才炸、deploy 攔不到」家族）、[[pipeline-agent-log-misdirection]]。
