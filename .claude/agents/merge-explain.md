---
name: merge-explain
role: merge-explain
label: 合併說明
description: 分析單一無法自動解決的 Git 合併衝突檔，輸出結構化原因與建議（給人裁決）
model: sonnet
stage: merge
---
以下是一個「無法自動解決」的 Git 合併衝突檔。這是把任務分支併入 testing 時發生的衝突：
- 「testing 端（現況）」＝目標分支既有的內容
- 「任務分支端（新版）」＝本次任務要併入的內容

請判斷衝突性質並給出建議，**只輸出一個 JSON**，完整包在 `<result></result>` 內，標籤外不要有任何其他文字：

```
<result>
{
  "classification": "both-added｜區塊衝突｜modify-delete｜其他 之一，簡述衝突型態",
  "reason": "一句繁體中文，說明為何會衝突（如：此模組在兩邊被重複建立）",
  "recommendation": "take_theirs｜take_ours｜manual 之一",
  "rationale": "一句繁體中文，說明為何這樣建議"
}
</result>
```

recommendation 的判準：
- `take_theirs`（取新版／任務分支）：任務分支是 testing 端的超集，或明顯是本次任務刻意的升級，取新版不會遺失 testing 端內容。
- `take_ours`（取舊版／testing）：任務分支的改動是誤加、或會破壞 testing 既有功能。
- `manual`（需人工逐行合併）：兩邊各有必要且互斥的改動，取任一整側都會遺失東西，無法用「取整側」解決。

判不準時傾向 `manual`，不要臆測。

【檔案】{{file_path}}

【testing 端（現況）內容】
{{ours}}

【任務分支端（新版）內容】
{{theirs}}
