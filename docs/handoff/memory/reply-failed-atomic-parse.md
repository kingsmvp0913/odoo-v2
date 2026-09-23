---
name: reply-failed-atomic-parse
description: 「AI 回覆失敗」根因＝回覆與附載 YAML 綁在同一次解析；已改成三層自癒（未重啟未實跑），含「整段補救會照抄壞資料」與壞輸出唯一查證管道
metadata: 
  node_type: memory
  type: project
  originSessionId: e7597823-b9ad-4d37-9072-e103eea3dcff
  modified: 2026-09-09T07:07:29.644Z
---

2026-09-09。task 254（鴻久／出貨標籤）在澄清關看到「AI 回覆失敗，請再送出一次。（未回傳有效結果）」。

**根因**：`parseClarifyChat` 把「給使用者看的回覆」和「題目 YAML」當成同一顆原子解析。那一輪 sonnet 跑了 285 秒／22.6k output，DECISION 與回覆完全正確，只有題目 YAML 最後一行 `user_answer: ''` 縮排 2（該是 0），`yaml.load` 丟 `bad indentation of a mapping entry (84:3)` → 整包判失敗。`spec-review.js` 是同形狀，附載還是整份 analysis.yaml，失敗還直接 `status='stopped'` 關掉對話入口。

**關鍵教訓：整段補救等於叫它逐字重抄**。原本失敗後把整段 3.7k 字（大半是中文散文）丟給 haiku 改一個縮排，實測它花 92 秒照抄同一份壞資料回來。**補救的成功率取決於要它重抄多少字**——只送壞掉的那段 YAML，任務就回到它做得到的尺寸。

**修法**（`app/server/pipeline/agent-result.js` 新增 `repairYamlPayload`；clarify-chat／spec-review 接上），順序改成「先免費、再便宜、最後才貴」：
1. 嚴格解析
2. `lenientParse`（零成本）：附載壞掉就先撈出回覆＋壞掉的原文
3. **只把那段 YAML 送 haiku 修** → 修好照常套用，流程自己往下走
4. 都失敗才降級：回覆照送＋明講「這次沒有更新」，既有規格絕不被覆蓋

原本的「整段丟 haiku」退居第 3 順位之後，只在連 DECISION／REPLY 都讀不出來時才跑。

⚠ **未重啟**（改的是 `app/server/**.js`），⚠ **未實跑驗證**。剩下唯一會停的情況＝agent 吐出完全不成形的東西（連 `<result>`／DECISION／REPLY 都沒有）且整段補救也失敗——**正式站歷來 0 筆**，刻意沒為它加 agent 重跑（避免投機式功能）。

**判讀線索（下次查同類問題直接用）**：
- 使用者看到的失敗字串只有 `clarify-chat.js` 產得出來；`task_logs` 全表搜 `回覆失敗` 即可定位，不必翻 log。
- **壞掉的原始輸出唯一留存處＝`prompt_logs` 裡 `agent_type='repair'` 那一列的 `prompt` 欄**（補救 prompt 把 raw 整段夾帶進去）。該列 `task_id` 是 **NULL**（repair 呼叫不帶 taskId），用 task_id 查會查不到——照時間找。`prompt_logs` 只留約一天。
- token_usage 的 `agent_type='repair'` 筆數＝歷來 `<result>` 解析失敗次數（至 09-09 共 33 次，只有 1 次演變成整輪報廢）。
- task 254 那輪的正確產出仍在 `prompt_logs` id 2203，補那一行縮排就能直接併回 `clarification_channel`。

**順帶發現、未修**：09-08 專案對話 chat 102/103 全程 `bwrap: No permissions to create a new namespace`，chat agent 一個工具都跑不動，卻照樣生出回覆（使用者問的正是同一個出貨標籤 barcode）。與本 bug 無關，另案。

相關：[[qa-resume-stale-spec]]、[[yaml-colon-breaks-spec-parse]]、[[platform-restart-kills-container]]
