---
name: open-loops-2026-09-01
description: 2026-09-01 收工時沒收尾的六件事：一件必做（重啟）、三件未驗證、兩件等使用者拍板；每件都寫了怎麼驗、驗不過代表什麼
metadata: 
  node_type: memory
  type: project
  originSessionId: 46056b69-a0d7-4b7d-84a3-d928da532aea
---

2026-09-01 收工。碼已 push 到 `origin/master`（HEAD `725b6035`），工作區乾淨。以下是**沒做完**的，不是已知風險而是真的還沒做。

## 必做 1 件 —— ✅ 2026-09-02 使用者已重啟

停止鈕的 404 已解。（原因：09-01 動了 `app/server/chat-routes.js` 與 `pipeline/chat-agent.js`，常駐進程載的是舊碼。）

⚠ **但 09-02 又動了一批 `app/server`**（新增 `search-routes.js`、`pipeline/chat-title.js`，並改了 `chat-routes.js`）
⇒ **要再重啟一次**，否則側欄搜尋按下去拿不到結果、對話也不會自動命名。見 [[ui-next-production-cutover]]。

重啟一律請使用者在主機 `docker restart`，**不可在容器內 kill node**（會連 postgres 一起收掉、整個容器退出，見 [[platform-restart-kills-container]]）。

## 未驗證 3 件

1. **停止鈕沒真的跑過一輪。** 只有 `chat-routes.test.js` 三支單元測試（abort 有傳到、沒在跑時回 `stopped:false`、別人的對話回 404）。
   驗法：重啟後在專案對話送一則會跑久的問題，按停止 → 對話裡要出現「⏸ 你取消了這則回覆」而**不是**「⚠️ 伺服器重啟或連線異常」（措辭不同代表走的分支不同）。
2. **`main_contact`（主要聯絡人）比對沒實測。** 需要一張「只填主要聯絡人、回饋帳號留空」的真工單才驗得到；欄位名是連上 eService 問 `fields_get` 查的，不是猜的，但**沒有實際比中過一次**。
3. **執行中的藍色流動色標沒在真的執行中任務上看過**——是注入 `.running` class 驗外觀的。

## 等使用者拍板 2 件（已回報，他沒說要不要修）

- **sync 綁不到專案時完全不吭聲**（裸 `continue`，回傳的 `found/added` 也分不出「已存在」還是「綁不到」）。這是 08/27→09/01 五天沒人發現同步停擺的唯一原因。
- **來源對應表單會把空欄位當「請幫我清空」存進去**（`saveProjectMapping` 一次送三欄、伺服器 `val || null`），表單沒載完就按儲存即洗掉，無確認無警告、無操作紀錄可回溯。

兩件的完整脈絡見 [[sync-silent-skip-on-unmapped]]。

## 雜項

- **DEMO 任務 220–229 要刪**：我建來給使用者審「各種任務狀態長什麼樣」的假資料，審完了，還躺在任務列表裡。
- 測試基線 **3471 passed**；`cron.test.js`、`frontend-ui-next-frozen-copies.test.js` 兩支**在我動手前就是紅的**，不要當成自己弄壞的（別在規則檔寫死紅燈清單，見 `.claude/rules/always.md` #2）。

相關：[[session-2026-09-01-handoff]]、[[ui-next-async-chat-contract]]、[[ui-next-css-traps]]
