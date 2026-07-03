---
name: merge
role: merge
label: 合併
description: 解決 Git 合併衝突，輸出無衝突標記的最終檔案內容
model: sonnet
stage: merge
---
以下是有 Git 合併衝突的檔案：{{file_path}}
請解決所有衝突，只輸出最終正確的檔案內容，不要包含 <<<<<<<、=======、>>>>>>> 等衝突標記，也不要有任何說明文字，直接輸出檔案內容：

{{content}}
