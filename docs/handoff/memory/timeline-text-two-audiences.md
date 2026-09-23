---
name: timeline-text-two-audiences
description: 使用者反映「AI 回話看不懂」的根因是同一字串同時餵 agent 與貼時間軸，不是 prompt 沒寫白話；cs／deploy／E2E 已修，qa-agent、reject-triage、verdict-router 三處仍未修
metadata: 
  node_type: memory
  type: project
  originSessionId: dccb669a-3e26-4adb-a70a-8e3960ce32f4
---

平台使用者長期反映「看不懂 AI 回的話」。2026-08-08 查證後確認：**不是 prompt 缺白話指示**——`app/server/pipeline/plain-language.md` 早已注入 11 個 agent，且 agent 完全照它做。真正的原因是程式端把「本來就寫給下游 agent 吃的字串」原文貼進使用者時間軸（`task_logs`）。

`plain-language.md` 開頭的分流表把「內部分類理由」明確歸在「給 AI 看 → 不必白話」，所以那些長技術文是**合規產出**。加禁令沒用，要在程式端拆成兩個欄位。

實測時間軸最長的訊息（`SELECT SUBSTRING(content FROM '^\[[^]]+\]') ... FROM task_logs WHERE role='ai'`）：
- `[客服判定：需改程式]` 15 筆／平均 906 字 ← 最嚴重
- `[部署測試區 asset 檢查失敗]` 4 筆／1177 字（原始 Python traceback）
- `[QA 未通過]` 4 筆／725 字

全部已修並 push（`357fffa`→`fcf273f`，master）。修法**依訊息性質分三種，別套錯**：

1. **能改內容的** → agent 契約拆兩個欄位。`cs.md` 加 `reason_plain`（給人）與既有 `reason`（給分析關），`cs-agent.js` 分流寫入。
2. **不能改內容的** → 內容不動，前端收合。`[QA 未通過]` 與 `[分診—需調整規格]` 都是**機器輸入**：前者被 `qa-agent.js` 直接 `LIKE '[QA 未通過]%'` 查回去當下一輪未解清單（strip 前綴後**整段**當 findings，所以前後補人話都會汙染）；後者以 `role='user'` 偽裝成使用者澄清餵給 analysis。改內容會讓 QA 漏驗、規格走歪。做法是 `TaskDetail.js` 的 `MACHINE_LOG_HINTS` 前綴比對 → 收合成一句人話 chip。
3. **純措辭太滿的** → 改 prompt。chat／cs 的長不是一稿兩用，是 `cs-capability.md` 職責句要求「完整」與 `plain-language` 的「簡潔」衝突，agent 折中成又長又技術（Rule 7 的實例）。已改成「查證要徹底、回答要短」＋五條可逐項檢查的守則。

`[需要你裁決]`（`verdict-router.js`）**不是**這類問題——它搬運的 questions 本來就寫給人看，實測已是白話。光看「程式碼把 agent 產物直接 join」的形狀會誤判，要看實際輸出。

**Why**: 這類 bug 會被誤診成 prompt 問題，於是不斷加「請說白話」的禁令卻毫無效果，浪費數輪。

**How to apply**: 診斷「AI 講話看不懂」先查寫入 `task_logs` 的那行程式，看那個變數是不是同時被寫進 `cs_findings`／`retry_feedback`／`blocker_content` 這類機器欄位。是的話就是一稿兩用，改程式不是改 prompt。改 agent 契約欄位前先讀 [[agentPrompt skill]]（`.claude/skills/agentPrompt/SKILL.md`）。
