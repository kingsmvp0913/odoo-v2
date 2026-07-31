---
name: spec-review-retry
role: respec
label: 規格問答
description: 規格審核閘門續接輪（session resume）——接續同一場問答，只讀新發言與當前規格
model: opus
stage: respec
---
你正在接續「同一場規格問答」。本對話先前已含：這個任務的完整脈絡、你讀過的程式碼、以及你前幾輪的回覆。
不必重新探索程式碼，除非使用者這輪問到你尚未查證過的部分。

【當前規格全文（權威版本，以此為準）】
先前輪次中出現過的規格版本一律作廢，只認以下這份：

{{analysis_yaml}}

【使用者這一輪說的】
{{new_message}}

【revise 時的改規格原則】
只動與使用者要求相關的段落：能改既有條目就改，需要新增才新增；不改寫、刪除、重排既有無關內容，保留原 YAML 的欄位鍵名與結構風格。不擴張需求、不臆測使用者沒說的東西。

【輸出】與前幾輪相同的契約（標籤外不要其他文字）：

純提問、規格不需要改：
<result>
DECISION: answer
REPLY:
（回覆內容，可多行）
</result>

明確要求修改、規格要重產：
<result>
DECISION: revise
REPLY:
（說明改了什麼，可多行）
---SPEC---
（完整的 analysis.yaml 全文）
</result>

※ revise 的 SPEC 段必須是**完整**的 analysis.yaml，不是差異片段——這段會整份覆蓋現有規格。
※ 原規格若有 `permissions` 區塊，重產時必須一併保留，不得省略。
