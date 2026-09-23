---
name: session-2026-08-05-platform-tasks
description: 2026-08-05 完成並 push 的 5 個平台功能（SSO bad sig/port池網域化/chat中斷/篩選改名/我的最愛）——待重啟 server＋前端人工實測；4 個既有紅燈待決定是否修
metadata: 
  node_type: memory
  type: project
  originSessionId: 61fc147a-fc2c-480e-bb95-d9c7ea97700c
---

2026-08-05 一輪把使用者列的 5 項全做完並 **push 上 master**（`5ca9669..e386ae1`，6 個 commit，用 `[模組]` 前綴＋依任務拆）。

**已完成（碼＋後端測試綠，細節都在 commit 訊息與程式碼註解）**：
1. **測試區 SSO 隨機 bad sig**（`env-agent.js _ensureEnvCredentials`）：改「重建沿用既有 secret、缺值才產」，消除平台端 `odoo_envs.sso_secret` 與 Odoo 端 `ir.config_parameter('aidev.sso_secret')` 的脫鉤視窗。刻意不加前端自動重試（會遮真設定錯）。相關 [[seed-keyerror-resusers-two-causes]]（那是 seed 失敗的脫鉤，這是重產時機的脫鉤，兩條不同）。
2. **測試區 port 池網域化（方案 A）**：admin「port 池」頁改成顯示子網域（有 external_slot 的環境顯示 `odoo-ai-test-N`、無 slot 標「內網」）。`port-pool-routes.js` 多回 external_slot/external_url。網域模式已上線見 [[external-access-decision]]。
3. **Chat 持久動畫＋中斷留訊息**：`project_chats.reply_pending` 旗標；chatReply 用 finally 清、claude 出錯補 AI 中斷訊息（計未讀）；`index.js` 啟動修復孤兒對話；前端 ProjectChat 輪詢＋側欄小圓點。
4. **任務列表「只看自己」→「顯示全部使用者」**（TaskList.js，靜態標籤＋primary/outline 表狀態）。
5. **專案我的最愛**：新增 `project_favorites`(user_id,project_id) 表、愛心收藏、per-user、置頂排序。

**明天（2026-08-06）要收尾的**：
- ⚠️ **後端改動要重啟 server 才生效**（env-agent／chat-agent／chat-routes／index／project-routes／port-pool-routes）——常駐進程載舊碼。重啟後才驗得到。
- ⚠️ **前端 4 檔無自動測試、要瀏覽器人工實測（含深色模式）**：ProjectList 愛心、TaskList 改名、ProjectChat 動畫、AdminPortPool 子網域顯示。
- ⬜ **實地驗 SSO bad sig 是否真的不再出現**（重啟後多開幾次測試區）。
- ⬜ **4 個既有紅燈是否要修**（診斷全在 [[deployment-env-red-tests]]）——使用者傾向至少修 ensureWorktreeAtMain 的產品面 identity 問題；其餘（ensure-env hermetic、reclone race）待決定。這 4 支與本輪改動無關（已 stash 全改動在同環境重跑驗證過）。
