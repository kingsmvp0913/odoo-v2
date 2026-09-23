---
name: ui-next-async-chat-contract
description: 對話送出端點會 await 整輪 AI 回覆（數分鐘）——任何 await 它才更新畫面的 UI 都會看起來當掉；改非同步後的四方契約與尚未實跑驗證的部分
metadata: 
  node_type: memory
  type: project
  originSessionId: 46056b69-a0d7-4b7d-84a3-d928da532aea
---

`POST /api/projects/:pid/chats/:id/messages` **會 await `chatReply()` 跑完整輪 agent**（`chat-agent.js`，動輒數分鐘）才回應。這是設計如此，不是 bug。

**原則：任何「送出訊息」的 UI 都不准 await 這個端點。** 送出後畫面必須立刻自己動，回覆靠輪詢帶回來。2026-09-01 已把新對話（`UiNextQuestionView.send`）與專案對話（`UiNextProjectChatView.send`）都改成不等待。

## 四方契約（改任一方都要同時看其他三方）

1. **伺服器** handler 一開頭就 `UPDATE reply_pending = true`（原子搶佔，搶不到回 409），前端據此判「回覆中」。
2. **輪詢必須重讀 chat 列，不能只 `loadMessages()`** — `loadMessages` 是拿 `this.activeChat.reply_pending` 決定要不要繼續輪詢，而 `activeChat` 是進頁面時的快照、永遠不會變。只 loadMessages 的結果不是永遠轉圈就是第一 tick 自己關掉。現在走 `pollReply()`：先 GET chats 更新 `reply_pending`，再 loadMessages。
3. **`?pending=1`** 是新對話換頁時帶的樂觀旗標——那一刻伺服器可能還沒寫進 `reply_pending`，只信 DB 會有幾秒空窗顯示成「沒事發生」。旗標在**兩個 tick（約 6 秒）後一律作廢**，否則「AI 比輪詢還快回完」會讓畫面永遠停在回覆中。
4. **停止鈕要真的砍得到行程**：`AbortController` 從 `chat-routes.js` 的 `_replyAborts` Map 一路傳到 `claude-runner` 的 `signal`。只清 `reply_pending` 而不 abort 的話，畫面回到可輸入狀態、被取消的那輪卻跑到底照燒 token，**而且沒有任何徵狀**。abort 後 `chatReply` 的 catch 依 `signal.aborted` 補「你取消了這則回覆」而非「伺服器異常」。

## ⚠ 尚未驗證

- **停止鈕沒有真的跑過一輪**（只有 `chat-routes.test.js` 三支單元測試）。
- 改動含 `app/server`，**2026-09-01 收工時尚未重啟 server**，`/stop` 端點在常駐進程裡還不存在。

相關：[[nightshift-ui-next-handoff]]、[[ui-next-css-traps]]
