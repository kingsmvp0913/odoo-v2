---
name: prevent-agent-prompt-injection
enabled: true
event: prompt
conditions:
  - field: user_prompt
    operator: contains
    pattern: 開工
---

**[Pipeline 防護] 禁止向 Agent Prompt 注入對話答案**

開工前強制確認：若本次對話中使用者已回答過 `clarification_channel` 的問題，必須先執行以下步驟，**再** spawn agent：

1. 將答案寫入對應 `analysis.yaml` 的 `user_answer` 欄位（立刻，現在）
2. 用**原始 `system/pending_prompt.txt` 不加任何修改**作為 agent prompt
3. 讓 pipeline STEP 3a 自然偵測答案完整後推進

**嚴禁**在 agent prompt 中加入：「已回答」、「Additional context」、「user_answer: <內容>」或任何從對話中摘取的業務答案。

違反此規則 → agent 跳過 MODE_B SHORTCUT → 執行全量 codebase 探索 → 浪費約 45,000 tokens。
