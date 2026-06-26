# Pipeline 自動調度詳細規格 (V8.3)

## Blocker 類型
| 檔名 | 情境 |
|------|------|
| `blocker.spec.txt` | 規格不清，需使用者澄清 |
| `blocker.tech.txt` | 技術上無法以標準 Odoo 擴展實現 |
| `blocker.agent.txt` | Agent 執行錯誤（含 MCP 工具失敗） |
| `blocker.loop.txt` | Pipeline 循環超出安全上限 |

## MCP 工具失敗處理
（Agent 可操作規則見 CLAUDE.md §2；本節為 pipeline 層彙總）

| 工具 | 失敗行為 | 阻斷？ |
|------|---------|--------|
| Graphify (wiki) | 檔案不存在 → 跳過，繼續用 Serena | 否 |
| Serena | `tool_use_error` 或無回應 → 立即 `blocker.agent.txt` → STOP | **是** |
| Context7 | 任何錯誤 → 跳過，用已知資訊繼續；session 上限 5 次 | 否 |

**Session 內查詢上限**：
- Serena：每個 Agent session 最多 **3 次** distinct query。超限仍不足 → 寫 `blocker.agent.txt` → STOP。
- Context7：每個 Agent session 最多 **5 次**；超限後跳過（非阻斷），改用已知資訊繼續。

> 原因：`_LOOP_COUNTER.json` 的 `loop_count` 只計跨 session 的 pipeline 循環，無法防護 session 內部的 MCP 重試迴圈，必須在 Agent 層自我截斷。

遇到任何 blocker：立即 STOP，向使用者報告**檔案路徑**（不顯示內容）。

## Loop 安全上限（防死循環）

持久化計數器：`kingsmvpsplan/_LOOP_COUNTER.json`
```json
{
  "run_started_at": "2026-01-01T00:00:00",
  "loop_count": 0
}
```

規則：
- 同一 pipeline run：`loop_count > 20` 時寫 `blocker.loop.txt`（`loop_count` 從 0 起算，PS1 以 `-gt 20` 判斷，即允許最多第 21 圈）
- 同一 `task_id` 的重入次數：持久化於各 task 的 `system/_reentry_count`（**不存入此 JSON**），最多 **2**；超限將該任務改判 `blocker.loop.txt`
- run 正常結束時刪除 `_LOOP_COUNTER.json`

## 處理循環（全程不得請求手動確認）

每次進入循環前讀取並更新 `_LOOP_COUNTER.json`。

1. **掃描**：收集所有 `kingsmvpsplan/*/system/pending_prompt.txt`
2. **讀 stage**：每個任務目錄的 `system/` 下找 `.pending_<stage>` flag 檔；stage = 去掉 `.pending_` 前綴。
   有效 Claude-facing stage：`analysis` / `final` / `coding` / `qa`
3. **分批**：依 `analysis → final → coding → qa` 順序。
   `final/` 目錄為 QA 通過歸檔，不是 stage（注意：stage 名 `final` 與歸檔目錄 `final/` 同名；掃描時必須明確只掃 `confirm/` / `analysis/` / `coding/` 下的 task，排除歸檔目錄）。
4. **WIKI 快取注入**（PS1 已在 pending_prompt.txt 內 prepend，主調度無需重複注入）：
   - `coding.ps1` / `qa.ps1` / `analysis.ps1 STEP 3b` 呼叫 `Get-WikiCache`，自動讀取
     `<online_addons_root>/graphify-out/wiki/index.md` 並 prepend `[WIKI-CACHE]...[/WIKI-CACHE]` 區塊（最多 60 行）
   - wiki 不存在 → 跳過注入（返回空字串）
   - 子 Agent 收到 `[WIKI-CACHE]` 後**不得重複讀取** wiki
5. **並行 spawn**（同 stage 內）：
   - `analysis` / `final`：最多 **5** 個並行；超過分批
   - `coding` / `qa`：最多 **5** 個並行（PS1 Module 序列鎖已保證不同模組；超過 5 個時分批）
6. **Agent 失敗處理**：
   - 任一 Agent 返回 `status: error` → 寫 `<task_root>/log/agent_error.txt`（用 `.claude/templates/agent_error.txt` 格式）
   - `retry_count < 1`：主調度自動重試一次，`retry_count` +1
   - `retry_count >= 1`：升級為 `system/blocker.agent.txt`，不中斷其餘任務
   - 當前 stage 所有 Agent 完成後，統一向使用者報告失敗清單
7. **完成標記順序**（原子保證）：
   - 先寫 done marker 到 `system/`（對照 Unified Marker Table）
   - 再 `mv system/pending_prompt.txt log/done_prompt.txt`
   - 再刪除 `system/.pending_<stage>` flag
   - 絕對不先刪後寫
8. **推進**：全 stage 完成後執行 `pwsh -NoProfile -File ".claude/scripts/_pipeline_run.ps1"`
   （Linux 上若無 pwsh：寫 `system/blocker.tech.txt` 並 STOP；通知使用者須在 Windows 端手動執行後觸發「開工」）
9. **繼續**：若步驟 8 執行後出現新 `pending_prompt.txt` → 回步驟 1，`loop_count` +1
10. **結束**：無新 pending 任務 → 刪除 `_PIPELINE_WAITING` 和 `_LOOP_COUNTER.json`

## Module 序列鎖（PS1 負責，主調度無需額外排隊）

```
coding.ps1 / qa.ps1 執行時：
  收集 coding/ 中已存在任務的 module 清單 → activeModules
  ↓
對每個 analysis/ 任務（coding 階段）：
  若 module 已在 activeModules → SKIP（下輪 pipeline run 處理）
  否則 → 寫 pending_prompt.txt，加入 activeModules
  ↓
結果：每次 pipeline run，同一模組至多一個新 coding/qa pending
```

主調度收到的 pending 任務已保證**不同模組**，可直接並行 spawn（上限 5 個）。
子 Agent **不需自鎖**。

## Sub-Agent 回傳格式（強制）

每個 sub-Agent 的最終回傳必須以此區塊結尾（`files_written` 條目不計入行數；其餘欄位合計最多 20 行）：

```
---AGENT-RESULT---
status: ok | blocker | error
task_id: task_<N>
stage: <stage>
mcp_used:
  wiki_cache_hit: true | false
  serena_queries: 0          # 實際使用次數（超過 3 視為異常）
  context7_queries: 0
files_written:
  - <relative_path>   # 僅列新建或修改的檔案；done_prompt.txt 和 .pending_* 不列入
message: <最多 1 行說明>
---END-RESULT---
```

主調度只解析此區塊。若 `serena_queries > 3` → 主調度升級為 `blocker.agent.txt`。需要細節時直接讀對應檔案。

## Stage 專用 Prompt 規則（Token 效率）

PS1 生成 `pending_prompt.txt` 時只注入該 stage 真正需要的部分：

| Stage | 應包含 | 不應包含 |
|-------|--------|---------|
| analysis | original.txt 內容、[MCP-BUDGET] | analysis.yaml 全文 |
| final | analysis.yaml 的 questions + user_answer 區塊 | technical_specification |
| coding | technical_specification 區塊、[MCP-BUDGET]、[WIKI-CACHE] | bug_analysis 等其他欄位 |
| qa | implementation_summary.txt、[MCP-BUDGET] | analysis.yaml 全文 |

## _PIPELINE_WAITING TTL 清理（過期清旗，非觸發）

flag 檔內容為建立時的 ISO 8601 時間戳（由 `_pipeline_run.ps1` 與 `Open-ClaudeTerminal` 寫入）。

> **重要**：TTL 過期僅清除旗標，**不觸發任何 pipeline 流程**。Claude 對此旗標的唯一合法動作是「不行動」。

過期清旗邏輯（供 PS1 參考）：
```python
import os
from datetime import datetime, timezone

flag = 'kingsmvpsplan/_PIPELINE_WAITING'
if os.path.exists(flag):
    content = open(flag).read().strip()
    try:
        created = datetime.fromisoformat(content)
        age = (datetime.now(timezone.utc) - created).total_seconds()
    except ValueError:
        import time
        age = time.time() - os.path.getmtime(flag)
    if age > 1800:  # 30 分鐘後清旗；不觸發任何流程
        os.remove(flag)
```

## QA 失敗退回流程（Smart Rollback）

QA `status = FAILED`：
1. 讀 `qa_report.yaml` 的第一個 error description
2. **判斷 analysis.yaml 是否含 `technical_specification` 或 `analysis_result`**（PS1 以子字串比對判斷；注意：僅能偵測欄位名稱出現，無法驗證值非空）：
   - **是（分析已完整）→ Smart Rollback**：
     - 移至 `analysis/<task_id>/`（不回 confirm/）
     - 清除 `.final_done` `.implement_done` `.qa_done` `.pending_*` `pending_prompt.txt` blocker.*
     - **保留** `.analysis_done` `.answer_done`（省略重跑分析）
     - 下一輪 `_pipeline_run.ps1` 執行時，`coding.ps1 STEP 4`（若含 `technical_specification`）或 `analysis.ps1 STEP 3b` 掃描 `analysis/` 目錄，自動重建 `.pending_coding` / `.pending_final` 與 `pending_prompt.txt`
   - **否（分析未完成）→ 完整退回**：
     - 移至 `confirm/<task_id>/`，清除所有 markers
     - **必須重建** `.pending_analysis` 與 `pending_prompt.txt`（否則下一輪掃描無法撿到此任務）
3. 寫 `log/back_reason.txt` 說明退回原因與模式
4. 若 task_id 符合 `^task_(\d+)$` → 通知 Odoo 任務

## Blocker Resume 機制

blocker 後人工修復流程：
1. 修復問題（Serena port、Graphify 路徑等）
2. `touch <task_dir>/system/.blocker_resolved`
3. 觸發「開工」
4. `_pipeline_run.ps1` 啟動時自動掃描 `.blocker_resolved`：
   - 若存在 `blocker.loop.txt`：**必須同時確認 `_LOOP_COUNTER.json` 已刪除或 `loop_count` 已重置**，否則拒絕 resume（避免立即再觸發上限）
   - 若存在 `blocker.spec.txt`：驗證 `analysis.yaml` 的 mtime > blocker 建立時間，確認使用者已回填規格（未回填則輸出警告，仍可繼續但風險自負）
   - 刪除所有符合條件的 `blocker.*.txt`
   - 刪除 `.blocker_resolved`
   - 保留 `.pending_<stage>`（原 stage 重試）
   - 輸出 `[RESUME] task_N blocker 已清除，重新加入佇列`

## Pipeline Run Summary

每次 `_pipeline_run.ps1` 結束時自動寫入 `kingsmvpsplan/log/pipeline_run_summary.yaml`：

```yaml
run_id: '<ISO 時間戳>'
run_ended_at: '<ISO 時間戳>'
loop_count: 3
tasks_pending_ai: 2
tasks_in_pipeline:
  - task_id: 'task_9001'
    stage: 'coding'
    status: 'pending_ai'
  - task_id: 'task_9004'
    stage: 'confirm'
    status: 'blocker'
```

## 診斷速查

一行查所有 blocker：
```bash
find kingsmvpsplan -name "blocker.*.txt" -exec echo "==={}" \; -exec grep -E "error_code:|tool:" {} \;
```

## 路徑翻譯（Linux 執行環境）

PS1 腳本現已使用 `$PSScriptRoot` 自動適應平台，不再寫死路徑。
若 `pending_prompt.txt` 內仍含舊版 Windows 絕對路徑：

| Windows | Linux |
|---------|-------|
| `C:\odoo` | 專案根目錄（git root / `$PWD`）|
| `C:\online_addons` | `/online_addons` 或 `$ONLINE_ADDONS_DIR` |
| `C:\odoo\.claude` | `.claude/` |
