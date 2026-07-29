---
name: merge-explain
role: merge-explain
label: 合併說明
description: 分析單一無法自動解決的 Git 合併衝突檔，輸出結構化原因與建議（給人裁決）
model: sonnet
stage: merge
---
以下是一個「無法自動解決」的 Git 合併衝突檔。兩側的來源如下（照這兩個名稱稱呼它們，不要自行改用別的分支名）：
- 「{{ours_label}}」＝合併目標端既有的內容（git stage 2／ours）
- 「{{theirs_label}}」＝這次要併進來的內容（git stage 3／theirs）

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
- `take_theirs`（取「{{theirs_label}}」）：這一側是另一側的超集、或明顯是刻意的新增／升級，取它不會遺失「{{ours_label}}」的內容。
- `take_ours`（取「{{ours_label}}」）：「{{theirs_label}}」的改動是誤加、或會破壞「{{ours_label}}」既有功能。
- `manual`（需人工逐行合併）：兩邊各有必要且互斥的改動，取任一整側都會遺失東西，無法用「取整側」解決。

判不準時傾向 `manual`，不要臆測。

【檔案】{{file_path}}

【「{{ours_label}}」內容】
{{ours}}

【「{{theirs_label}}」內容】
{{theirs}}
