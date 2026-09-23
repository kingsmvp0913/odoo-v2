---
name: backticks-eaten-in-node-e
description: "用 `node -e \"...\"` 送中文長文進平台 API 時，文字裡的反引號會被 bash 當成命令替換整段吃掉，HTTP 仍回 200，內容靜默缺字"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 445eb6a3-c4b3-457e-b101-38ac3836c7f2
---

2026-09-07 送修正指示給 task 243 時實際發生：指示裡引用了兩段程式碼

    ...引用了程式碼片段 `if not ... has_manual: return` 與 `if not existing_dedicated ...`，未加引號。

放進 `node -e "..."`（雙引號）執行，bash 把反引號當成 command substitution，
兩段程式碼**整段消失**，DB 裡只剩「引用了程式碼片段  與 ，未加引號」。
唯一徵狀是 stderr 兩行 `command substitution: line 21: syntax error`，
而 **HTTP 照樣 200、平台照樣把殘缺內容當成使用者指示往下跑**。

**Why**：訊息內容是要餵給 agent 的，缺字不會報錯、只會讓 agent 拿到不完整的指示做出錯的判斷；
而且送出後任務已進下一關，沒有原地修正的路（`resolve-blocker` 只吃 `stopped` 狀態）。

**How to apply**：任何要送進平台的長文（spec-revise 的 feedback、resolve-blocker 的 resolution、
task_logs 內容），**一律先 Write 到 scratchpad 檔，再在 node 裡 `fs.readFileSync` 讀進來**——
同一場 session 裡第一次送 spec-revise 就是這樣做的，完全沒事；第二次圖快直接內嵌就中招。
送出後養成習慣回查一次 `task_logs` 最後一筆的實際內容，別只看 HTTP 200。
相關：[[yaml-colon-breaks-spec-parse]]（同樣是「內容對、但被一個標點吃掉」的家族）。
