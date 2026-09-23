---
name: platform-restart-kills-container
description: 容器內 kill 平台 node 會連帶關掉 postgres 並讓整個 odoo-v2 容器退出（entrypoint 是 wait+stop_postgres），能不能自己回來取決於容器外的 compose restart policy——重啟一律請使用者在主機下 docker restart
metadata: 
  node_type: memory
  type: project
  originSessionId: 8f81dc2f-29e8-499b-b862-a16f3ec33747
---

平台 server 的重啟**不是**「kill 掉再起來」那麼單純。`/usr/local/bin/entrypoint.sh` 的收尾是：

```
"$APP_DIR/start.sh" &
APP_PID=$!
RC=0
wait "$APP_PID" || RC=$?
stop_postgres
exit "$RC"
```

而 `start.sh` 最後一行是 `exec node app/server/index.js`（exec 取代 shell，所以 node 就是 `$APP_PID`）。
於是在容器內 kill 掉那個 node ⇒ `wait` 返回 ⇒ **postgres 被關掉、entrypoint 退出、整個容器結束**。
容器會不會自己回來取決於 **compose 的 restart policy，而那在容器內看不到**（我的 shell 就在容器內，見
[[container-no-root-no-apt]]）。policy 若是 `no`，平台就整台停在那裡等人手動 `docker start`。

**How to apply**：要讓改好的 server 碼生效，一律請使用者在**主機**下 `docker restart odoo-v2`，
不要自己在容器內 kill。這也修正了 [[semantic-search-stage1-progress]] 當時寫的「kill 掉不確定有沒有
東西自動重拉，所以沒動」——不確定的其實是 restart policy，而風險比「server 沒起來」大一級：
連 DB 一起走。

**判讀**：`ps -eo pid,ppid,lstart` 看 node 的啟動時間，比對 `git log` 最後一個 commit 的時間，
就知道現在跑的碼是哪一版。實測 2026-08-10：node 啟動於 08-08 09:32、最後 commit 09:30 ⇒ 當時
所有「待重啟」的功能其實都已生效，而三則記憶都還寫著待辦。**這個比對要主動做**，否則會像那次
一樣，把早就生效的東西當成沒生效。
