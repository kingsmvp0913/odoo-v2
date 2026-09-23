---
name: vpn-sibling-mount-homomorphic
description: 容器化平台叫宿主 daemon 起 sibling 容器時，bind-mount 來源檔必須落在同構掛載路徑(APP_DIR/ODOO_ENV_BASE)，不能用 /tmp
metadata: 
  node_type: memory
  type: project
  originSessionId: c92cdb16-061f-42df-8c97-67e18791c58f
---

平台本體跑在 `odoo-v2` 容器內、掛宿主 `/var/run/docker.sock` 走宿主 docker daemon 起 sibling 容器。此時 `docker run -v <src>:<dst>` 的 `<src>` 由**宿主 daemon** 解析，不是平台容器內。若 `<src>` 是平台容器私有路徑（如 `os.tmpdir()`＝`/tmp`），宿主看不到 → Docker 靜默把 `<dst>` 建成**空目錄**（不是報錯）。

實例(2026-08-04)：VPN gateway 的 `.ovpn` 寫在 `/tmp/vpn-proj-<id>.ovpn` → 掛進容器變空目錄 → openvpn 讀空 config → `Options error: You must define TUN/TAP device (--dev)` → 容器 Exit(1) → 就緒檢查報「[VPN] 撥號失敗，容器已結束」。**根因不是帳密/設定檔錯**（訊息會誤導），是 mount 落點。修法：`vpn-gateway.js` 的 `defaultTmpFilePath` 改寫到 `APP_DIR/data/vpn-tmp/`（compose 以 `${HOST_REPO_DIR}:${HOST_REPO_DIR}` 同構掛載，host===container），APP_DIR 未設時退回 os.tmpdir()。

**通則**：任何「平台寫檔→餵給 sibling 容器 bind-mount」都必須落在 compose 的同構掛載清單（現為 `${HOST_REPO_DIR}`＝APP_DIR、`${HOST_ENV_BASE}`＝ODOO_ENV_BASE）底下。測試區 mount 一直正常正是因為走這兩個 base；VPN 是唯一漏網的（寫 /tmp）。

除錯線索：`docker logs` 空 + 容器 Exit(1)，openvpn 真正 log 在容器內 `/tmp/openvpn.log`（`--daemon --log`，見 infra.md rule 139）；exited 容器可 `docker cp <c>:/tmp/openvpn.log`。驗證 mount 是否空目錄：容器內 `[ -d /config/client.ovpn ]`。相關 [[deployment-topology]]。
