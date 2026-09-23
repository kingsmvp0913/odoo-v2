---
name: prompt-effect-verification-pitfalls
description: "驗證「改的 agent prompt 有沒有真的生效」的三個陷阱：prompt_logs 的 agent_type='respec' 混三支 agent、task_id 存數字非業務 id、拿自己寫進任務的字當關鍵字會假陽性"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 96c1bc6f-f44b-49a5-83d1-2716a147d3f8
---

改完 `.claude/agents/*.md` 想確認「新規則有沒有真的送進 agent」，查 `prompt_logs` 是對的方向，但有三個坑：

1. **`agent_type='respec'` 混了三支不同的 agent**：`respec-agent.js:116`、`clarify-chat.js:164`、
   `spec-review.js:98` 都標同一個 `agentType: 'respec'`。查到的那筆很可能根本不是 respec-patch。
   分辨法：抓 prompt 內容比對各 agent body 的獨有措辭（respec-patch 有「濾網」、spec-review 有 `revise`）。
   〔更正舊記錄：[[figma-endpoint-unproven-in-pipeline]] 寫「混了兩支」，實際是**三支**。〕

2. **`prompt_logs.task_id` 存的是 `tasks.id` 的數字字串（'182'），不是業務 id（`manual_178...`）**。
   拿業務 id 去查會得到 0 筆，看起來像「這一關沒跑過」。

3. **不要拿「你自己寫進任務的字」當關鍵字**。我用 `prompt LIKE '%單引號包住%'` 驗證規則是否注入，
   結果沒改過的 coding／reject_triage 也回 true——因為那句話正是我填在 `resolve-blocker` 修正指示裡的，
   被當成任務歷史餵了進去。**關鍵字必須挑該 prompt 檔獨有、且不會出現在任務資料裡的措辭。**

另外兩件同時確認的事實：
- **agent `.md` 改動免重啟**：`agent-loader.js:385-387` 的 `loadAgent` 用 mtime 比對快取，改檔即重讀（實測）。
- **retry 關查不到新規則是正確的**：`spec-review`／`analysis-retry` 等走 `--resume` 繼承上一輪對話，
  retry body 刻意不重送首輪規則（rules/agent-prompt 104）。看到 false 別急著判定沒生效，先確認那是不是 retry 輪。

**Why**：這三個坑都會給出「看起來很像結論」的假訊號——兩次差點讓我把「已生效」報成「沒生效」、把「沒驗證過」報成「驗證通過」。
**How to apply**：驗證 prompt 生效一律「獨有措辭 + 數字 task_id + 先確認是首輪還是 retry 輪」三者齊備才下判斷。
