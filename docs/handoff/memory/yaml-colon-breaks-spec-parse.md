---
name: yaml-colon-breaks-spec-parse
description: 使用者貼的錯誤訊息含「冒號＋空白」會讓規格 YAML 整份解析失敗、整輪報廢；三個產 analysis.yaml 的 agent 已補引號規則（只有 analysis 實跑驗證過）
metadata: 
  node_type: memory
  type: project
  originSessionId: 96c1bc6f-f44b-49a5-83d1-2716a147d3f8
---

任務 #182 連兩輪 respec 都死在同一個字元。agent 把使用者退回意見裡的

    unsupported operand type(s) for -: 'datetime.date' and 'datetime.datetime'

原樣寫進**未加引號**的 YAML 字串，`-: `（冒號後接空白）被 js-yaml 當成鍵值對，報
`bad indentation of a mapping entry`。兩次炸點字元完全相同（task_events 25867 的 21:172、25918 的 19:102）。

**內容其實是對的**——把那一行加單引號後整份 YAML 完全合法（5 條 acceptance、4 條 requirements 都在）。
平台的處理也是對的：規則 70「YAML 解析失敗絕不可覆蓋既有 spec」讓它 fail loud，規格沒被寫壞。

**為什麼偏偏是這幾關**：respec／spec-review／analysis 的輸入天生就是「使用者整段貼的 Odoo／Python 錯誤訊息」，
踩中機率遠高於其他關。而 prompt 原本對 YAML 只寫「必須是合法、可被解析的 YAML」，沒說引號怎麼處理；
`respec-patch.md` 更有一句「引號風格不影響判定」（本意是講規格比對忽略排版），讀起來像「引號隨便」。

**已修**（`b45cb09`）：`respec-patch`／`analysis-project`／`spec-review` 補上具體規則＋可照抄的正確寫法
（規則 100：光下禁令沒用）。`analysis-retry`／`analysis-timeout-resume` 走 `--resume` 繼承首輪，依規則 104 不重送。

**2026-09-07 複發（task #243，spec-review 關）**：規則還在（`spec-review.md:23-26` 明寫「引程式碼／錯誤訊息一律單引號」），
agent 照樣違反——這次的地雷**不是使用者貼的**，是它自己在 requirements 裡引用程式碼守衛式
`if not purchase_lines and not clear_cmds and not has_manual: return`，`has_manual: ` 就是炸點。
**新事實**：`agent-result.js` 的 haiku 補救（REPAIR_PROMPT 有帶錯誤訊息）**沒救回來**（跑了 5,208 output tokens 仍失敗），
所以「有補救機制」不等於「不會 stopped」。整輪 opus 460 秒／27k output 的產物完整但存不進去。
⇒ 光靠 prompt 規則擋不住；真正的解是**產出端自檢**（agent 送出前自己 yaml.load 一次）或解析端容錯。

**Why**：這不是「agent 偶爾出錯」，是輸入內容帶語法地雷、重跑必然再踩，會無限卡住同一張單。
**How to apply**：任何要求 agent 產 YAML 的 prompt，都要明講「引用原文一律加引號」並給範例；
看到 blocker 寫「未回傳有效 YAML」時，先把 `task_events` 裡的 `<result>` 撈出來丟 js-yaml 跑一次看炸在哪個字元，
不要當成 agent 整體失能而重跑。驗證是否生效見 [[prompt-effect-verification-pitfalls]]。
