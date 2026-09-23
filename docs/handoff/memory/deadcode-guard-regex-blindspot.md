---
name: deadcode-guard-regex-blindspot
description: 前端碼寫 /^image\// 會讓整支 View 從兩支守衛裡靜默消失；另附「新對話」四個入口哪個按得到
metadata: 
  node_type: memory
  type: project
  originSessionId: 09f2dc67-2bc6-48a6-b82a-319bd60e96b3
  modified: 2026-09-08T01:57:52.513Z
---

`frontend-ui-next-deadcode.test.js` 與 `frontend-ui-next-duplicate-keys.test.js` 用自製的括號配對器切出每個 `window.UiNextXxxView`。它的 `skipToken` 不認得 regex literal：`/^image\//` 結尾的 `\` `/` `/` 會被當成 `//` 行註解，**整行被吃掉**，大括號失衡 → `extractBlock` 回 null → 那支 View 被 `.filter(c => c.body)` 靜默濾掉，`test.each` 根本不跑它。

**Why:** 沒有任何訊號。測試全綠、數字只少一兩條沒人會看。`UiNextProjectChatView` 就這樣長期不受檢查（2026-09-08 才發現，一掃到就抓出 `toggleHistory` 死碼）。

**How to apply:**
- 前端判圖片型別一律 `file.type.startsWith("image/")`，不要寫 `/^image\//`。
- 兩支守衛已加「解析不出來的 component 不准被濾掉」的斷言（`declared` / `unparsed` 必須為空），再犯會直接紅燈。
- 想確認某支 View 有沒有進檢查範圍：`npx jest --json` 後比對 `assertionResults` 的名字清單，別只看總數。
- 判斷「測試數變動」是不是回歸：用 `--json` 逐檔比對，`test.each` 動態產生的案例會讓總數自己變。

**「新對話」的四個入口（2026-09-08 實查）**：只有兩個按得到——側欄「新對話」（→首頁輸入框）與**專案頁「對話」分頁那顆**。對話頁那個 popover 掛在「對話紀錄」抽屜裡，而 `toggleHistory` 沒綁在任何按鈕上（已列入 deadcode ALLOWED，待拍板）；`/projects/:id/chat` 不帶 chatId 會被 `$router.replace` 重導回專案頁，所以 `ui-next-thread-empty` 那段空狀態實際上畫不出來。

相關：[[ui-next-css-traps]]、[[tour-ui-next-redesign-spec]]
