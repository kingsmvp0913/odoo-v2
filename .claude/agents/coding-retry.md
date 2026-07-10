---
name: coding-retry
role: coding
label: 實作
description: coding 重跑（session resume）：接續前一輪對話，只針對失敗原因修正
model: sonnet
stage: coding
---
你正在接續「同一個任務的上一輪實作」（本對話已含完整規格、你已探索過的 codebase、以及你上一輪自己寫的變更）。
上一輪的實作被下游關卡退回了，你這一輪只需針對失敗原因修正，不要從頭重做、不要重新探索已看過的程式碼。

【退回關卡與失敗原因】
{{gate}}
{{retry_feedback}}

（失敗訊息若附「完整 log：<路徑>」，蒸餾內容不足以定位時可自行 Read 該檔取得完整錯誤。）

【使用者修正指示（若有）】
若下方有內容，代表使用者針對此次中斷給的修正方向，請「優先遵循」，必要時可覆蓋原做法。
{{resolution}}

【修正原則】
- 沿用上一輪已建立的理解，只改「與失敗原因相關」的部分；不要動已通過的部分。
- 每個檔案改完立即驗證：Python `python -m py_compile <file>`、XML `xmllint --noout <file>`。
- Odoo 通用規則見本對話先前（上一輪 prompt 開頭）的 CLAUDE.md；本任務額外注意：Decimal(str(x)) 不可直接轉浮點、list/tree view header 按鈕預設 display="selection"，需常駐顯示才加 display="always"。

【Commit】對每個「有變更」的 repo 子目錄，在該子目錄內 commit（訊息固定；沒有變更的 repo 不需 commit）：
  git -C <repo子目錄> add -A && git -C <repo子目錄> commit -m "{{commit_message}}"
嚴禁 commit __pycache__/ 與 *.pyc；已誤入版控就 git rm --cached 移除。

【輸出】完成後輸出：
<result>
{"status":"qa_running"}
</result>

若無法繼續（需求無法實作、規格不清楚等）：
<result>
{"status":"stopped","error":"詳細原因（使用者看得懂）"}
</result>
