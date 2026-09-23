---
name: figma-endpoint-unproven-in-pipeline
description: Figma 能力已於 2026-08-14 整組移除（commit 3a211a7）——真因是 View seat 每月只有 6 次額度，不是實作壞掉；別再提議加回來或改接 MCP
metadata: 
  node_type: memory
  type: project
  originSessionId: 3acd8f87-3cc7-48a2-9f86-9dd85ce8eaf3
---

2026-08-14：`/ai/figma` 端點、`lib/figma-auth.js`、後台 token 設定、五關 prompt 的 Figma 教學**全部移除**（commit `3a211a7`，已 push master；DB 的 `teams_settings.figma_api_key_enc` 值也清空，欄位依 add-if-missing 規則保留）。使用者裁決：改用文字說明需求。

**Why（別再走回頭路）**：Figma REST 的 **Tier 1（讀檔案／讀節點）對 View/Collab seat 是 6 次／月**（Dev/Full seat 才有 10–15 次／分）。平台帳號 kingsmvp2 正是 View seat。而一張任務光是 cs→分析→respec→分析 就會全檔重抓八次（端點沒有快取），task 136 實際打了約 30 次直接燒光當月配額，`Retry-After` 回 382233 秒（≈4.4 天，實測間隔 100 秒遞減 130 確認單位是秒），分析關重試到死、任務 stopped。

- **換 token 沒用**：官方文件「rate limits are tracked on a per-user, per-plan basis, where the user is whoever generated the token」——額度綁產 token 的人，同帳號再生 N 把 PAT 共用同一份。
- **改接官方 MCP 也沒用**：MCP 的額度表同為 View/Collab 6 次／月（Starter 才 20／月），而且只認 OAuth（headless `claude -p` 授權不了）、讀取工具還要求 edit access（View seat 實測被拒）。
- **唯一的真解是把帳號升成 Dev/Full seat**。要復原功能就從 commit `3a211a7` 反推。

**How to apply**：
- 有人回報「AI 讀不到設計稿」→ 現在這是**預期行為**，不是 bug。五關 prompt 一律明講讀不到並要求把細節問成問題請使用者用文字／截圖補。
- 守衛在 `agent-loader.test.js`：原本那條「五關都教得到 /ai/figma」已反轉成「沒有任何 prompt 還在教」，加上既有的「教的 /ai/ 路徑都真的有註冊」，兩道一起擋。誰把 curl 加回來就會紅。
- 移除前的歷史教訓仍然成立、且適用於任何新端點：**端點通 ≠ agent 會打 ≠ 打得到**，修好三次都是零實跑證據就宣告結案（MCP 走不通→改 REST／prompt 漏教關卡／prompt 寫死埠 3939 而正式機 PORT=8771）。判斷某能力「現在能不能用」要查 `task_events`／`prompt_logs` 的實際呼叫紀錄，不要只打端點。同類坑見 [[context7-quota-exhausted]]。
- `prompt_logs.agent_type='respec'` 涵蓋**三支** agent（08-24 更正，原記為兩支）：`respec-agent.js:116`、
  `clarify-chat.js:164`、`spec-review.js:98` 都標同一個 type。靠 prompt 內容分辨（`【輸出】…analysis.yaml`
  ＝respec-patch；`【本次允許的決策】`＝clarify-chat；含 `revise`＝spec-review）。用 agent_type 篩會混到。
  完整驗證守則見 [[prompt-effect-verification-pitfalls]]。
