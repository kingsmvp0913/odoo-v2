# 主題 D：可觀測性統一（U13）— 設計文件

日期：2026-07-08
狀態：已核准
健檢對應：U13（執行歷程 task_events 覆蓋嚴重不全）；連帶 U9（callClaude 無 timeout，已於止血補上，此處合併後單一實作維持）

## 背景與目標

兩套 runner 分歧是 U13 根因：
- `claude-runner.js` 的 `callClaude`：`emit()` 同時寫 socket 與 `task_events`（DB），有 timeout，但無 cwd／session／`--resume`。cs／merge／library／chat／analysis(非專案)／failure-classifier 用。
- `task-agent.js` 的 `spawnClaude`：有 cwd／session_id 捕捉／`--resume`，但**只 emit socket、不落 DB**，且只格式化 assistant text。analysis(專案)／coding／qa／playwright 用。

結果：最貴、最常失敗的 coding／qa／playwright／analysis 在 DB **零 transcript**（只有 runner 寫的階段標記），瀏覽器沒開就什麼都沒留，事後鑑識不可能。

目標（優先序 穩定 > 準確 > 省 token 中的「準確」）：單一 runner 實作，讓**所有階段**的執行歷程 best-effort 落地 `task_events`，供失敗根因回溯。

## 核心決策

### D-1. 合併為單一 `runClaude`（取代兩套）

`claude-runner.js` 新增 `runClaude(prompt, opts)`，為兩者聯集，刪除 `callClaude`／`spawnClaude`：

```
runClaude(prompt, {
  signal, cwd, taskId, userId, model,
  timeoutMs = 600000, resumeSessionId
}) → Promise<{ text, usage, durationMs, sessionId }>
```

- 事件流用既有 `formatEvent`（text／`⚙ tool_use`／`→ tool_result` 預覽）。
- `emit(text)`：有 `userId` 寫 socket（`notify.emitToUser`）；有 `taskId` 寫 `task_events`（best-effort，`.catch(()=>{})`）。兩者獨立，缺哪個就少哪個，行為與各呼叫端現況一致。
- `notify` 改由模組內 `require('../notify')`（不再透過 `opts.notify` 傳入），呼叫端更乾淨。
- 保留 timeout（掛死 kill＋reject `timeout`）、`signal` abort（reject `aborted`）、失敗標注 `claudeStatus`／`durationMs`（U12）。
- `system/init` 事件抓 `session_id` 回傳（供 coding `--resume`，主題 B）。
- 有 `resumeSessionId` 才加 `--resume`；有 `cwd` 才在該目錄 spawn。
- `abortError`／`stopReason` 維持輸出。

**簽名統一**：`callClaude` 原為 `(prompt, signal, opts)`，`spawnClaude` 為 `(prompt, opts)`。統一為 `(prompt, opts)`，signal 收進 opts。

**呼叫點（~11 處）＋測試 mock 全數改**：
- callClaude → runClaude：`analysis.js`、`chat-agent.js`、`cs-agent.js`、`failure-classifier.js`、`library-agent.js`（×3）、`merge-agent.js`（signal 由第 2 位置參數移入 opts）。
- spawnClaude → runClaude：`task-agent.js`（runTaskAnalysis／runTaskCoding）、`qa-agent.js`、`playwright-agent.js`（qa/playwright 改從 `claude-runner` import runClaude，其餘 helper 仍從 `task-agent`）。
- `task-agent.js` 移除 `spawnClaude` 定義與 export。
- 測試 mock：`analysis`／`cs-agent`／`claude-runner`／`deploy-testing`／`failure-classifier`／`library-agent`／`library-agent-init`／`qa-agent`／`playwright-agent`／`task-agent` 各 test 檔的 `callClaude`／`spawnClaude` mock 改為 `runClaude`。

### D-2. task_events 全階段落地（隨 D-1 免費得到）

coding／qa／analysis／playwright 從此在 DB 有完整 transcript。row 大小由 `formatEvent` 既有截斷控制（tool_use input→120 字、tool_result→200 字、assistant text 全留）。

**附帶行為變化（刻意）**：coding／qa 的終端輸出從「只有 text」變為也顯示 `⚙ tool(...)`／`→ 結果預覽`，與 cs／merge 一致。視為可見度改善。

### D-3. 刪除／保存政策 = 維持現狀（確認，不改碼）

使用者明確指定：**硬刪＝重置語意**（清汙染、整個任務重做），保留現行硬刪。

- 硬刪 task：連 serial row＋`task_events`＋`task_logs` 一併刪除＝刻意要乾淨重來。
- `token_usage` 以**穩定業務 `task_id`**（`task_odoo_xxx`／`task_service_xxx`／`manual_xxx`，實測確認）為 key，無 FK 到 tasks → 硬刪存活；`project_id` 為 FK 到 **projects**（`ON DELETE SET NULL`），刪 task 不受影響。
- re-sync 以同一業務 `task_id` 重新匯入（新 serial、同 task_id 字串）→ 新 `token_usage` 續 append 在同 key 下，統計無縫接續；`db.js` 的 project_id 回填以 `tu.task_id = t.task_id` join 亦自動對上。

**明確偏離健檢建議**（Rule 7）：健檢 U13 修補方向建議「刪任務改軟刪或保留 events，與 token_usage 保留政策一致」。此設計反其道：events／logs 隨任務生命週期硬刪，一致性改由 token_usage 的穩定業務 key 達成。理由：使用者的重置語意優先；失敗鑑識由 D-1 統一落地覆蓋「未刪除的存活任務」，已達 U13 目的。

## 測試計畫（Rule 9 驗證意圖）

D-1 runClaude：
1. 有 `taskId`＋`userId` → socket 與 `task_events` 皆寫入；只有 `userId` 無 `taskId` → 只 socket 不落 DB；只有 `taskId` → 只落 DB。
2. `system/init` 事件 → 回傳 `sessionId`；給 `resumeSessionId` → args 含 `--resume`，不給則不含（承接原 B-1 測試）。
3. timeout → kill 子行程並以 `timeout` reject（承接原 U9 測試）；`signal` abort → 以 `aborted` reject。
4. coding／qa 事件含 tool_use → `task_events` 落地且截斷生效（tool_result ≤ 200 字）。

D-3 保存政策（回歸確認，非新功能）：
5. 硬刪 task 後 `token_usage`（同業務 task_id）仍在；以同 task_id 再插入一列 → group by task_id 統計累加正確。

回歸：現有 cs／merge／library／analysis／coding／qa／playwright agent 既有測試不破（僅 mock 名稱由 callClaude／spawnClaude 改為 runClaude）。

## 範圍

- 單純合併＋落地，不動刪除／保存政策（D-3 確認維持現狀）。
- 不做 retention purge（YAGNI；量真的大再議）。
- 不改 `task_events` schema（維持 FK 到 tasks.id）。
