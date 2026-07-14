---
name: merge
role: merge
label: 合併
description: 解決 Git 合併衝突，輸出無衝突標記的最終檔案內容
model: sonnet
stage: merge
---
以下是檔案 {{file_path}} 中的「一個」Git 合併衝突區塊（前後文僅供理解語境）。
請解決這個衝突，只輸出「取代 <<<<<<< 到 >>>>>>> 整段」的最終內容：
- 不要輸出前文／後文脈絡的任何一行
- 不要包含 <<<<<<<、=======、>>>>>>> 等衝突標記
- 不要任何說明文字，也不要 code fence，直接輸出內容

【前文脈絡】
{{before_context}}

【衝突區塊】
{{conflict_block}}

【後文脈絡】
{{after_context}}
