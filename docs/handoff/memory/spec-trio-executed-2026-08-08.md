---
name: spec-trio-executed-2026-08-08
description: 三份施工規格（status-registry／saved-views／inbox）2026-08-08 全數執行完並 commit，未 push；待辦只剩重啟 server ＋ 三處前端人工實測
metadata: 
  node_type: memory
  type: project
  originSessionId: ca582294-9e8a-4694-975c-4027d636c586
---

`SPEC-status-registry.md`／`SPEC-saved-views.md`／`SPEC-inbox.md` 三份**全部執行完畢**，6 個 commit
**已 push 到 origin/master**（`02286a2..1697082`，用 [[push-with-stored-pat]] 的 PAT 注入）：

| commit | 內容 |
|---|---|
| `3b78a7f` | status registry：四份手寫名單收成 `TASK_STATUSES` 單一來源＋2 條新守衛 |
| `56810a0` | 篩選持久化（localStorage）＋具名 view（`PUT /api/settings/views`） |
| `de74e18` | 收件匣後端：`user_inbox` 表／`lib/inbox.js`／兩掛載點／四端點 |
| `2f55063` | 收件匣前端：`/inbox` 頁＋側欄入口 |
| `68ba5ed` | 三份規格書補執行記錄與紅燈清單更正 |
| `1697082` | 四份執行完的規格移進 `docs/`（移出版控，本 repo 慣例）＋ `graphify-out/` 退出版控 |

**三份規格書現在在 `docs/` 底下**（`docs/` 被 gitignore，只在本機）。根目錄只剩未實作的
`CODEX-PROVIDER-SPEC.md` 與操作手冊 `DEPLOY.md`。

**測試基線：`cd app && npm run test:quiet` → 2173 passed / 0 failed / exit 0（159 suites）。**
動工前基線是 2148，新增 25 支。這台**沒有既有紅燈**——見 [[deployment-env-red-tests]]，規格書原本抄的
那份「CRLF 兩支＋vpn-gateway 一支」豁免清單在此環境是錯的（已在規格書內更正）。

> ✅ **2026-08-10 複查更正**：server 已於 **08-08 09:32** 重啟（node 啟動時間晚於最後一個 commit
> 09:30），`user_inbox`／`project_favorites`／`odoo_envs.started_at` 都已在 DB 裡。下面第 1 點
> 「server 未重啟」**已解除**，待辦只剩第 2 點的前端人工實測。判讀法見 [[platform-restart-kills-container]]。

**Why（待辦是什麼）**：使用者當時選「只 commit，先不重啟」，所以：
1. **server 未重啟** → `notify.js`／`runner.js`／`tasks-routes.js`／`db.js`／新路由全部尚未生效。
   特別注意 `user_inbox` 表要等重啟跑 `migrate()` 才會建出來。
2. ~~**前端三處未人工實測**~~ → ✅ **2026-08-11 使用者確認全部測過**（TaskList 篩選持久化與具名
   view、`/inbox` 收件匣頁、側欄未讀 badge，含深色模式）。此規格三份**已全數結案**。

**How to apply**：
- 重啟後先確認 `user_inbox` 建出來了再測收件匣，否則四個端點會 500。
- 三份規格書頂部各有一段「✅ 執行狀態」，記錄了**實際偏離**（registry 漏列第四份名單、階段 4 未做
  且說明為何、inbox 的 FK CASCADE 坑、saved-views 要求的重設按鈕已存在）。要接手先讀那段，別照
  正文再做一次。
- 執行中發現的三個規格缺口都已修掉並寫進規格書，其中最會炸的是：`user_inbox` 的 FK 不帶
  `ON DELETE CASCADE` 會讓刪使用者／刪專案／刪任務三處全部撞 FK 失敗（本 repo 無 CASCADE 慣例，
  靠呼叫端逐表手動 DELETE）。新增任何 `REFERENCES tasks(id)` 的表都要想這件事。
- `graphify-out/` 那 310 個未追蹤檔仍在，`git status` 照樣被淹（見 [[graphify-out-untracked-residue]]）。
