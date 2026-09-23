---
name: qa-resume-stale-spec
description: QA 走 session resume 卻不比對規格＝規格被 respec 換掉後拿舊規格審新實作，退回理由永遠相反直到熔斷（task 184 真因，已修 b02c9fe，待重啟）
metadata: 
  node_type: memory
  type: project
  originSessionId: 5cc421fe-c4b7-4e1a-b626-966dbe732674
---

2026-08-25 查 task 184（鴻久 IDX-2026070081）卡死的真因。**不是那張單的問題，是平台的。**

QA 重驗走 `--resume`，而 `qa-retry` 的 prompt **一個字的規格都不帶**（那是它省 token 的前提，fresh 8~10 分鐘／$3 對照 resume 19 秒／$0.27）。但 `qa-agent.js` 的 `canResume` 只比對 `qa_prompt_ver`（prompt 檔版本）與次數，**不比對 `analysis_yaml`**。規格中途被換掉時，續接到的 session 仍嵌著舊規格 ⇒ 拿舊規格審依新規格寫出來的實作 ⇒ 退回理由永遠與現行規格相反 ⇒ coding 怎麼改都不對 ⇒ 輪次熔斷。

已修：把規格 sha1 折進 `qa_prompt_ver`（比照 `with-resume` 的 `extraVersion`／`cs-agent` 的 `ctxVersion`）。commit `9d5e634`＋`a92b851`（健檢出口），**已 push 進 master**，測試 3173 全綠零回歸。**⚠ server 尚未重啟＝尚未生效**，見 [[session-2026-08-24-pending]]。

**為什麼修在讀取端**：`analysis_yaml` 有四個寫入點——`respec-agent.js`、`runner.writeAnalysisYaml`、`clarify-chat.js`、`spec-review.js`——**只有 respec-agent 記得清 `qa_session_id`**，它的註解甚至逐字寫著「否則 resume 舊 session＝用舊規格審查」。作者知道這個坑，還是漏了另外三個。靠每個寫入端自律必然再漏一個。

**判讀陷阱（下次查同類線一定再遇到）**

1. **agent 為「對不上」編的解釋會被下游當證據往下傳。** QA 拿舊規格審不通後，宣稱「commit message 標的是別張單號 IDX-2026070081，疑似跨工作區 commit 污染」——**任務 184 的標題就是 `IDX-2026070081`，完全對得上**。健檢又把它收成「候選訊號」。差點去追一條不存在的污染。**agent 說「這是別人的東西／環境問題」時，自己核一次**，它有系統性動機把矛盾推給外部。同一個型態見 [[health-fix-channel-verified]] 的 `test_result` 自報。

2. **`prompt_logs` 的長度就是最快的判讀工具。** resume 輪的 prompt 短一截（本例 3834 vs fresh 11211）。用 `position('關鍵字' in prompt)>0` 逐筆掃「這輪到底有沒有拿到新規格」，比讀 agent 的結論可靠得多。但**先確認那筆是不是同一張任務**——`prompt_logs` 沒有 task 欄位，只能用 prompt 內文的 `task_service_XXXX` 比對，我第一次就撈錯到隔壁任務去了。

3. **`repeat_calls`／`reentry_count` 全是 0 不代表沒事。** 184 的所有 retry 計數都是 0，真正的震盪要看關卡序列（`coding→qa→coding→qa`）與 `token_usage` 的逐關次數。

相關 [[health-check-green-is-hollow]]、[[prompt-effect-verification-pitfalls]]。
