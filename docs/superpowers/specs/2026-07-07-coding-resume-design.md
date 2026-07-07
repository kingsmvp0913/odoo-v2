# 主題 B：Coding 重跑 Session 延續 — 設計文件

日期：2026-07-07
狀態：已核准（使用者選定方案一：Session Resume＋2 次上限＋fresh fallback）
健檢對應：U3（coding 重跑零上下文，任務 52 每輪 302k→877k→1,053k tokens 的元凶）

## 目標

coding 被 QA／部署／E2E 退回重跑時，不再開全新 session 從零探索 codebase。
改用 `claude -p --resume <session_id>` 續用前一輪的對話——規格理解、codebase 探索、
自己上輪的 diff 全都還在，只送一段（蒸餾後的）失敗 feedback 讓它修。

三目標關係：省 token（目標 3）是主效益；重跑更精準（目標 2，agent 看得到自己上輪的對的東西）；
不影響穩定（目標 1，有多層 fallback）。

## 架構

`spawnClaude` 捕捉 CLI init 事件的 `session_id`（目前被丟棄），存進 task。
coding 重跑時分流：可 resume 走短 prompt，否則走現行 fresh 全量 prompt。

## 元件

### 1. spawnClaude（task-agent.js）
- 新增選項 `resumeSessionId`：有值時 args 加 `--resume <id>`（其餘 args 不變，仍含 `--dangerously-skip-permissions`）。
- 解析 init 事件（`ev.type==='system' && ev.subtype==='init'`）取 `ev.session_id`。
- resolve 物件多帶 `sessionId`。

### 2. Schema（db.js colMigrations）
- `tasks.coding_session_id TEXT`
- `tasks.coding_resume_count INTEGER DEFAULT 0`

### 3. 新 agent template `.claude/agents/coding-retry.md`
短 prompt，假設 session 已有完整上下文，只含：
- 標明是哪一關退回（QA／部署／E2E）
- `{{retry_feedback}}`（蒸餾後）、`{{resolution}}`（使用者修正指示，若有）
- 重申輸出契約：修正後照原規則輸出 `---RESULT-JSON---` 並逐 repo commit（訊息同前）

### 4. runTaskCoding 分流（task-agent.js）
```
RESUME_LIMIT = 2
canResume = coding_session_id 存在
          且 coding_resume_count < RESUME_LIMIT
          且 (retry_feedback 或 resolution 非空)

canResume → RESUME 路徑：
  prompt = coding-retry.md，feedback 經 distillFeedback() 蒸餾
  spawnClaude(resumeSessionId=coding_session_id)
  成功 → coding_resume_count += 1、清 retry_feedback、續 parseResult
  失敗 → 見「錯誤處理」

否則（首次／resume 用完／resume fallback）→ FRESH 路徑：
  prompt = coding-project.md（全量，仍帶未蒸餾 retry_feedback）
  spawnClaude()（無 resumeSessionId）
  成功 → 存 sessionId、coding_resume_count 歸 0、清 retry_feedback
```
`coding_session_id` 只在 fresh 成功後寫入 → 它存在 ⟺ 前一輪 coding 成功 ⟺ 這次是被下游退回的重跑。
以此為「可 resume」的唯一信號。

### 5. distillFeedback()（純函式，只用於 resume 路徑）
- 去掉 `[部署失敗]` 等標籤前綴，保留一個詞標明關卡。
- Python traceback：只留最後例外行＋引用到模組目錄（idx_*／module 名）的 frame，砍 framework frames。
- 收斂空白、上限約 400 字。
- 附完整 log 檔路徑（止血7 已把部署 log 落地 data/logs/）——**逃生口**：蒸餾不夠時 resume agent 可自行 Read 完整檔。

## 錯誤處理（resume 失敗，依 spawnClaude 的 err.claudeStatus 分流）

| 類型 | claudeStatus | 處理 |
|---|---|---|
| session 遺失／CLI 壞掉 | `error`（快速非零退出） | 同次呼叫內 fallback fresh：清 session_id、count 歸 0、改全量 prompt 再跑一次 |
| 逾時 | `timeout` | 直接 stopped，**不** fallback（避免再燒 600s＋全量 token） |
| 手動暫停 | `aborted` | propagate，顯示「手動暫停」（現行不變） |

fallback 只發生一次，不遞迴。

## 逃生口 / 自我修正（distillFeedback 判斷錯時）
1. 完整 log 落地可讀。
2. 只有 resume 路徑蒸餾，fresh 路徑永遠全量。
3. resume 上限 2 次後強制 fresh，帶未蒸餾完整 feedback。

## 測試計畫（Rule 9：驗證意圖）

純函式：
1. distillFeedback：完整 Odoo traceback → 只留例外行＋idx_ frame、附 log 路徑；QA 自然語言 → 近原樣。

spawnClaude：
2. 從 init 事件抓 session_id 並回傳。
3. 給 resumeSessionId → args 含 `--resume`；不給 → 不含。

runTaskCoding 分流：
4. 首次（session_id NULL）→ fresh 全量、存 session_id、count=0。
5. 重跑（session 存在＋count<2）→ resume 短 prompt（**斷言不含 analysis_yaml 全文**、含蒸餾 feedback）、count+1。
6. 重跑達上限（count=2）→ 強制 fresh 全量、session_id 更新、count 歸 0。
7. resume 遇 error 快速失敗 → 同次 fallback fresh、session 清空、最終成功。
8. resume 遇 timeout → stopped，**斷言 spawnClaude 只被呼叫一次**（不 fallback）。

成敗點：測 5 證明真的省了、測 8 證明不會再燒一次 600s。

## 已知假設 / 取捨
- **--resume 上下文可能被截斷但仍 exit 0**：若 session 存在但歷史過長被 CLI 剪裁，resume agent 會以降格上下文運作且不觸發 fallback（fallback 只認非零退出）。最多 2 次後強制 fresh 是安全網，中間最多兩輪可能上下文不完整。屬可接受取捨。
- **distillFeedback frame 判定**：以「排除框架路徑」（odoo/addons、site-packages、python lib）保留使用者模組 frame，涵蓋非 idx_ 前綴的既有 module；仍保留完整 log 路徑逃生口。

## 範圍
- 只做 coding 重跑。QA 重跑（全時 0.9M）等 coding 數據驗證後再套同機制（不在本次）。
- 驗證方式：部署後比對 token_usage 中 resume 輪 vs fresh 輪的 input_tokens 差值。
