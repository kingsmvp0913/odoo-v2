---
name: token-usage-underreports-cost
description: token_usage 會系統性低估成本（失敗輪不記帳、子 agent 的 duration 明確不計入）；查成本要拿 task_events 的工具呼叫序列與階段時間戳交叉驗證
metadata: 
  node_type: memory
  type: project
  originSessionId: 15929e84-aa26-4046-be96-8fbd825d9f02
---

2026-08-10 查「token 燒很快」時發現：**`token_usage` 不是真實成本，只是「成功且被記帳的那部分」**。查成本只看那張表會漏掉最貴的情境。

兩個低估來源：

1. **失敗輪整筆消失。** 呼叫端若沒有 `logFailedUsage`，`runClaude` 一拋錯就跳過 `logTokenUsage`，那一輪等於沒發生。實測 spec_tour 跑滿 600s 逾時被砍、126 個工具呼叫、3 個子 agent，`token_usage` 裡連一列都沒有。已修（`9a20574`），但**其他關要逐一確認有沒有同款缺口**——`cs`／`analysis`／`spec-review` 本來就有，其餘沒逐個查過。
2. **子 agent 不計入。** `claude-runner.js:213` 的 `durationMs = ev.duration_ms` 取自 CLI 主 session。實測 spec_tour 記 13 秒、該關實跨 461 秒（差 448 秒全是子 agent）。duration 明確不含，usage 取自同一個事件（`:212`）故高度可疑，**未證死**。

## 查成本的正確作法

別只 `SELECT ... FROM token_usage`。交叉驗證三件事：

- **`task_events` 存了完整工具呼叫序列**（`⚙ Bash({...})` 格式，ANSI 碼要先剝）。這是唯一看得到「有沒有亂跑」的地方——掃碟、重複讀檔、遞迴開子 agent 都只在這裡現形。
- **用 `▶ <階段>` marker 切分並取 `created_at`**，得到每關真實牆鐘時間，拿去對 `token_usage.duration_ms`。**對不上就是有沒記到的執行。**
- 注意 marker 到下一個 marker 之間可能夾著等人的空檔，別把等待算成執行。

實測腳本思路留在 [[cs-resume-and-stale-rules]] 同批工作裡；當時「建立分支」關平均 112 個工具呼叫／輪，是 cs 的 4.5 倍，但報表上只值 $0.06——那個落差就是這條記憶的由來。
