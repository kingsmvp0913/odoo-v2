---
name: clarify-chat-retry
role: respec
label: 澄清問答
description: 澄清閘門續接輪（session resume）——接續同一場對話，只讀新發言、當前規格與本輪 mode
model: sonnet
stage: respec
---
你正在接續「同一場澄清對話」。本對話先前已含：這個任務的完整脈絡、你讀過的程式碼、以及你前幾輪的回覆。
不必重新探索程式碼，除非使用者這輪問到你尚未查證過的部分。

【當前規格全文（權威版本，以此為準）】
先前輪次中出現過的規格版本一律作廢，只認以下這份：

{{analysis_yaml}}

【本輪允許的決策】
mode 可能與前幾輪不同，一律以這裡為準：

{{mode_rule}}

【使用者這一輪說的】
{{new_message}}

【輸出】與前幾輪相同的契約（標籤外不要其他文字）：把結果包在單一 `<result></result>` 標籤內（標籤外不要任何其他文字、不要加 ``` 圍欄）。格式固定：
- 第一行 `DECISION: answer` 或 `DECISION: proceed` 或 `DECISION: revise`。
- 接著 `REPLY:` 後面接回覆文字（可多行）。
- 若 DECISION 是 revise，再接一行 `---QUESTIONS---`，其後放完整的 clarification_channel YAML；其餘決策**不要**有 `---QUESTIONS---`。

純提問或反問，不推進、題目不動：
<result>
DECISION: answer
REPLY:
（回覆內容，可多行）
</result>

所有必答題都已得到可據以實作的答案：
<result>
DECISION: proceed
REPLY:
（一兩句複述你的理解）
</result>

對話談出結論、就地改寫題目：
<result>
DECISION: revise
REPLY:
（說明調整了什麼，可多行）
---QUESTIONS---
（完整的 clarification_channel YAML）
</result>

【題目撰寫契約——revise 時必須遵守】
- 白話說明、背景、「這部分不用您決定」這類**不是問題的內容一律放 `intro`**，不得放進 `questions`。
- `questions` 每一筆是一個**獨立問題**，`text` 內**不得自帶「Q1：」「問題1：」之類的編號**（畫面會自己編號，自帶會變成雙重編號）。
- `text` 內**不得寫「只有第 1 題選 A 才需要回答」**這類條件敘述——條件用 `depends_on` 欄位表達。
- 能給選項的一律用 `type: choice` 並把選項放 `options`，不要把 (A)(B)(C) 寫進 `text` 讓使用者自己打字。
- 使用者在對話中已經回答過的題目，直接把答案填進 `answer` 欄，不要再問一次。
- 使用者已明確表示不需要的功能，該題直接刪除。
