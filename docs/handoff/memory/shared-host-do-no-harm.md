---
name: shared-host-do-no-harm
description: 這台主機 111 個容器裡只有 2 個是本平台的，其餘是別人的服務——動 docker 前的硬規則
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9728f041-702c-4382-a801-270d6d744518
  modified: 2026-09-16T02:17:23.110Z
---

2026-09-16 使用者原話：「你要記得不能影響到其他服務」。

**Why**：`docker ps` 實測 **111 個執行中容器，只有 2 個是這個平台的**（`odoo-v2`、`odoo-test-liSheng`）；其餘 109 個屬於這台機器上其他公司／服務。docker 是全機共用的，一個錯指令會打到別人，而且多半沒有 undo。

**How to apply — 動 docker 前逐條過**：

1. **絕對禁止任何 prune／全域清理**：`docker system prune`、`image prune`、`container prune`、`network prune`、`volume prune`、`builder prune` 一律不准，**即使加了 `-f` 或看起來只清「未使用」的**——別人停掉的容器與沒掛載的映像都會被當垃圾刪掉。要清只能逐個指名自己的。
2. **只碰名字前綴是自己的**：`odoo-v2`、`odoo-test-*`、以及量測用的專屬前綴（計畫用 `aidevm6-*`，刻意不用 `odoo-v2-*` 免得誤判成正式容器）。任何 `docker kill/rm/stop` 前先 `docker inspect` 確認名字。
3. **不得用「全部容器」的迴圈**：`for c in $(docker ps -q)` 這種寫法一律改成先 `grep` 自己的前綴。
4. **每個自己開的容器都要 `--rm` ＋ 資源上限**（`--memory`／`--cpus`／`--pids-limit`），且**不對宿主 publish 埠**（量測用的閘道只接 internal 網路）。
5. **新建網路要用專屬名稱**，建完量完就 `docker network rm` 指名移除；不得改動既有網路。
6. **build 前先看磁碟**：`df -h /` 與 `docker system df`。映像估 1–2 GB。
7. **平台重啟一律請使用者在主機做**（見 [[platform-restart-kills-container]]），不要自己動。

**判別「我是不是要影響到別人了」的問句**：這個指令的作用域是「我指名的那個東西」還是「所有符合某條件的東西」？是後者就停下來改寫。

相關：[[deployment-topology]]、[[container-name-collapse-chinese]]
