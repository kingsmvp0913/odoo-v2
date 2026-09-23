---
name: upload-entry-points-map
description: 平台所有上傳／貼圖入口與各端點有沒有 multipart，決定「補貼上」是純前端還是要動後端
metadata: 
  node_type: memory
  type: project
  originSessionId: 09f2dc67-2bc6-48a6-b82a-319bd60e96b3
  modified: 2026-09-08T02:08:43.852Z
---

2026-09-08 全平台盤點（UI Next＝正式介面）。**判斷「某個框能不能加貼上」先看它送去哪支端點有沒有掛 `uploadAttachmentFiles`**，沒掛就是後端工。

**有上傳中介層（純前端就能加貼上）**：`POST /api/tasks`（新增任務）、`/api/tasks/:id/messages`（留言）、`/api/tasks/:id/answer`（回答＋澄清逐題）、`/api/tasks/:id/clarify-ask`（追問）、`/api/tasks/:id/reject`（人工退回）、對話訊息、`/api/feedback`、`exam/banks/:id/read-sections`（成績單）。

**沒有中介層（要先改後端）**：`/api/tasks/:id/spec-revise`（規格審核意見）、`/api/tasks/:id/cs-confirm`（客服回覆確認）、`/api/tasks/:id/cs-data-submit`（補充資料）。

**Why:** 前端把 FormData 送到沒掛 multer 的端點，`req.body` 會整個空掉——症狀不是「圖沒上傳」而是「連文字都不見」。

**How to apply:**
- 貼上的 target 一定要對到**送出時真正讀的那個陣列**。實例：TaskDetail 回答面板貼上寫進 `newMessageFiles`，但 `submitAnswer` 送的是 `answerFiles` ⇒ 貼的圖被靜默丟掉，畫面零徵狀、送出照樣成功（2026-09-08 已修）。
- placeholder 寫「可直接貼上截圖」不代表綁了 `@paste`（留言框就是這樣說了做不到）。要驗就用 Playwright 派 `ClipboardEvent` 看 `defaultPrevented`。
- 澄清「有題目」模式（逐題輸入框）**整區沒有任何附件入口**，要附圖只能切到「提問」頁籤（走 askFiles）。未修。
- 任務詳情的面板由 `timelineActionMode` 決定：`done`→封存面板（所以 done 任務看不到留言框，驗證要挑執行中的任務，例：`cs_running`）。

**看圖（2026-09-08 統一）**：全平台共用 `js/image-preview.js` 的 `window.previewImage({src, alt, onDownload})`，兩套 shell 都渲染 `<image-preview-host />`，template 靠 `app.config.globalProperties.previewImage` 直接叫得到。統一前有三套：對話／意見回饋是 `window.open(objectURL)` 另開分頁、任務詳情附件是直接下載、題庫自己養一個 lightbox。
- ⚠ **新增全域元件檔一律包 IIFE**：classic script 的頂層 `const` 會落在全域，`dialog.js` 已經有 `const { reactive } = Vue`，撞名＝SyntaxError 整支不執行，症狀是「點圖沒反應」而畫面其餘完全正常（實際踩到）。
- 跳窗底色刻意深底白字寫死、不跟主題走：跟著 `var(--text)` 走的話淺色模式會白底白字。版面用 flex 直排置中，用 grid 會把圖和檔名列拆成兩個等分 row、中間空一大塊（實際踩到）。

相關：[[deadcode-guard-regex-blindspot]]
