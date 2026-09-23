---
name: health-check-green-is-hollow
description: 工作流程健檢的 reentry.avg 讀的是分診時會被歸零的 reentry_count，所以幾乎恆為 0；08-06 那次 21 個 agent 給 16 個 ok（含歷來 0 次執行的 playwright）不能當作健康證明
metadata: 
  node_type: memory
  type: project
  originSessionId: 724d1cc2-0f15-49ed-8105-5b7de7526876
---

`health_check_runs` 至今只跑過一次（2026-08-06），結果 16 個 agent 判 `ok`、5 個 `error`（error 是診斷本身執行失敗，沒人回頭補）。**這份全綠不可信**：

- `health-data.js:62` 的註解自己寫明「不讀 tasks 的 `*_retry_count`／`reentry_count`：那些會在分診放行時被歸零」，但同檔 `:89`／`:98` 仍用 `reentry_count` 算 `tasks.reentry` 的 min/max/avg。
- 歸零是刻意設計（`reject-triage.js:32,159`，人介入就重給額度，見 rules/pipeline.md 規則 53），**斷路器語意不該改**。但拿當下殘值做 30 天彙總，絕大多數任務都是 0 → `reentry.avg=0` 幾乎恆真。
- 健檢 agent 的判詞大量引用「reentry.avg=0、stopped_rate 低 → 無系統性問題」，等於用一個結構上不會變的數字證明健康。
- 最直接的反例：`playwright` 被判 `ok`，但它歷來 0 次執行（見 [[e2e-disabled-runtime-errors-escape]]）。

**要真的看彈跳，改看**：`token_usage` 每 task_id 的列數（`health-data.js:67-86` 的 `repeat_calls` 已經是這個作法）、`task_rejections` 筆數。實例：2026-08-11 的 task 106，四個計數器全 0，但實際 4 輪 coding／4 輪 qa／3 筆 rejection。

修法方向：報表面全改讀 `task_rejections` ＋ `token_usage` 列數，或新增一組永不歸零的累計欄位與現有「本次嘗試」計數器並存。另 `pipeline-routes.js:140-142` 有一段過時註解，宣稱人工退回的循環由 `bumpReentryOrStop` 累加，但 `reject-triage.js:234` 明確寫著刻意不呼叫。

---

**2026-08-14 更新（run#2 實測）**：綠燈虛胖有**三個獨立來源**，別只記得 reentry 那個。

1. `reentry.avg` 恆為 0（上文，**未修**，健檢 agent 仍在拿它當健康證據）。
2. **零樣本記成 ok** —— run#2 的 14 個 ok 裡 `deploy-fix`／`wiki-drift-classifier` 都是 0 次呼叫。**已修**：runner 依 `summary.token.calls === 0` 覆寫成 `n/a`，前端顯示「未取樣」灰標。
3. **解析失敗造成的存活者偏差** —— 這是最陰的一個。輸出量大（有話要說、要附新提示詞）的診斷因為長中文塞在 JSON 裡而解析報廢，判正常的因為輸出短反而都活著，**結果結構性地偏向「一切正常」**。run#1 掛 5 個、run#2 掛 4 個，失敗名單每次都換人＝收尾契約不穩、不是特定 agent 的毛病。**已修**（commit 8babd58）：diagnosis／rationale 移出 JSON 走 `<diagnosis>`／`<rationale>` 標籤區塊。

**判讀陷阱**：`health_check_findings.severity='error'` 不代表那個 agent 有問題，是**健檢本身沒拿到診斷**。要分辨是崩潰還是解析失敗，查 `token_usage WHERE agent_type='workflow_health'`——全 `completed` 就是解析路徑；**夾在中間的 `agent_type='repair'` haiku 呼叫筆數＝首解析失敗次數**（run#2 是 7/23，遠高於檯面上的 4）。這條序列是唯一能還原真相的線索，因為原始輸出以前不留存（現在解析失敗會落 `data/logs/health-run<id>-<agent>.log`）。

**補跑注意**：續跑邏輯跳過「此 run 已有 finding」的 agent，`error` finding 也算，所以直接續跑會跳過失敗的那幾個——要補跑得先刪掉那幾筆 finding，或開新 run 重跑全部。
