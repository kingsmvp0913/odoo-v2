---
name: ai-socket-silently-stolen
description: 容器模式下 AI 查不到資料庫的真因——startAiSocketServer 不檢查有沒有人在聽就砍掉重建 socket，任何第二份平台程式跑一秒就會永久奪走正式通道
metadata:
  node_type: memory
  type: project
---

2026-09-18 實際事故（開關切到 `all` 之後約兩小時）。

**症狀**：對話 AI 說「資料庫連不上」，但對話本身 `completed`、平台網頁正常、管理員無感。閘道 log 整排
`{"type":"ai-forward-error","path":"/ai/db/query","error":"connect ECONNREFUSED .../data/run/ai.sock"}`。

**機制（已確認）**：`app/server/lib/ai-socket-server.js:40-45` 只判斷「路徑上是不是 socket 檔」，
**是就 `unlinkSync` 再自己 bind**，從不檢查有沒有行程正在聽。⇒ 容器內任何第二份平台程式
（跑測試、手動 `node server/index.js`、任何呼叫 `startAiSocketServer` 的東西）啟動一秒就會：
砍掉正式的 socket 檔 → bind 自己的 → 結束時若被 SIGKILL 就留下死檔。
正式的 node **還在聽那個已被 unlink 的 inode**，而路徑上的新檔沒人聽 ⇒ 永久 ECONNREFUSED，
**且平台自己完全不知道、log 一個字都沒有**。

**判讀順序（下次直接照這個查）**：
1. `ls -la data/run/` 看 `ai.sock` 的 mtime——晚於 node 啟動時間＝被換過。
2. `docker logs -t odoo-v2 | grep AI-SOCKET` 數 `listening` 幾次、最後一次是什麼時候。**沒有新的一行就代表不是平台自己重起的**。
3. `ss -lxn | grep ai.sock` 顯示 LISTEN **不代表通**——它印的是 bind 當下的路徑字串，檔案被換掉後照樣顯示。
4. 決定性測試：`curl -s --unix-socket data/run/ai.sock http://localhost/ai/... -w '%{http_code}'`，回 `000` ＝連不上。

**⚠ 乾淨關閉 vs 被砍**：Node 正常 close 會把 socket 檔刪掉（下次連線是 ENOENT）；
**ECONNREFUSED 代表檔案在但沒人聽＝前一個佔用者是被 SIGKILL 的**。

**止血**：把 AI 容器隔離開關切回 `internal` 或 `off`（管理員設定→進階→AI 容器隔離），
AI 回到主機跑就不需要這條通道，**立即生效不用重啟**。真正修好要重啟平台（重建 socket）。

**該修（尚未修）**：`startAiSocketServer` 在 unlink 之前應該先試連一次；連得上就代表已經有正式的在跑，
應該**大聲失敗而不是搶走**。這條在容器模式下是單點故障，而且失敗完全無聲。

相關：[[productize-saas-decision]]、[[platform-restart-kills-container]]
