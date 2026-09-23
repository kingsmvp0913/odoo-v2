---
name: ask-decisions-one-at-a-time
description: 要使用者裁決多個題目時一次只問一題、每題先用白話講清楚是在問什麼，不要一次列 5 題
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 91ce45c8-d4f3-4f64-bec5-83c19b4b986a
  modified: 2026-09-15T08:38:28.118Z
---

需要使用者裁決的題目，一次只問一題（用 AskUserQuestion 單題），每題先白話說明背景與影響，再給選項與建議。

**Why:** 2026-09-15 一次列了 Q1–Q5 五題，使用者對其中三題看不懂（把「內部 AI」誤會成「幫代管客戶改程式的流程」、不知道 AI 會自己 `git commit`），直接說「你一題一題問吧」。一次多題時術語沒解釋清楚，使用者只能回「不懂」，反而多來回。

**How to apply:** 題目有術語（內部 AI、ref、scope、provider）時，先用使用者熟悉的流程講清楚「這題影不影響他們平常的工作」；使用者的回答若和既有裁決衝突（例：Codex「正常要能選」vs 09-11「Codex 只留內部」），先指出衝突與後果，再給選項讓他選，不要自行折衷。相關：[[productize-saas-decision]]
