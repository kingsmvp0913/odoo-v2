# 主題 A：失敗分類與歸因 — 設計文件

日期：2026-07-07
狀態：已核准（使用者選定方案丙：程式分類器優先，unknown 才叫 haiku agent 純分類，不自動修）
健檢對應：根因 B（部署失敗一律怪 coding）、U5（deploy-fix agent 從未接線）、
資料層 P2（transient 不分類）、流程層 P2（夜間 shutdown 誤歸因）、流程層 P3（cs-agent 錯誤混淆）

## 目標

把失敗分「transient／env／code」三類，各退給對的地方——明確非程式問題時不動 coding 計數、不重跑 coding。
這是準確率（目標 2）核心，也連帶省 token（目標 3，誤歸因＝白燒一輪 coding）。

## 分類法（驅動不同動作的最小集合）

| 類別 | 判定訊號 | 動作 |
|---|---|---|
| transient | 被 kill、ECONNRESET/ETIMEDOUT、could not resolve host、socket hang up（快速失敗） | 自動重試一次，不佔計數器 |
| env | could not connect（DB）、ModuleNotFoundError、Permission denied、port 佔用、env 未運行 | stopped＋blocker_type='env'，不退 coding、不加計數 |
| code | Python Traceback（ParseError/ValidationError/Field/Model）、XML parse、py_compile | 現行：退 coding＋計數（滿上限 stopped） |
| unknown | 以上皆非 | → agent 分類 |

timeout（跑滿 600s 才死）不進分類器，維持現行「stopped 不重試」（重試太貴），由 claudeStatus 先攔。

## 元件

### 1. classifyFailure(text, opts) 純函式
回傳 `'transient'|'env'|'code'|'unknown'`。regex／訊號判定，確定性、可單測、零 token。
opts 可含 claudeStatus（'timeout'/'aborted' 由呼叫端先處理，不進此函式的重試判斷）。

### 2. classifyFailureWithAgent(text) 包裝
先跑 classifyFailure；回 unknown 才叫 deploy-fix agent（haiku）分類。
agent 出錯／仍判不出 → 預設 'code'（安全，等於現況）。

### 3. 改寫 deploy-fix.md
拿掉 fix_bin/fix_args（不自動修）；只回 `{"type":"code|env|transient"}`。接上線（由元件 2 呼叫）。

## 套用點

### A. deploy-testing.js doDeploy catch
依 classifyFailureWithAgent 分流：
- transient → 同次 doDeploy 內重試 upgrade 一次（不加計數）；再敗 → 重新分類（多半 env）照 env 走
- env → stopped、blocker_type='env'、blocker 寫「環境問題：…」＋log 路徑；deploy_retry_count 不動、不退 coding
- code → 現行（退 coding＋計數、blocker_type='code'）
- unknown → agent 分類後照上面走

### B. playwright-agent.js
E2E verdict='fail' 先檢查 env 是否仍 running：
- env 已非 running（被夜間 shutdown 砍／掛了）→ 判 env、stopped、不退 coding、不加 pw 計數
- env 正常但 verdict fail → 真 bug → 現行退 coding
- spawnClaude throw → classifyFailure（transient 重試／env stop／code 退 coding）

### C. env-agent nightlyShutdown
砍 env 前跳過「該專案有任務在 deploy_testing 或 playwright_running」的 env。
雙保險：即使沒跳過，套用點 B 的 env 檢查也擋下誤歸因。

### D. cs-agent（P3 小修）
CLI/API 錯誤與 JSON 解析失敗分開寫 blocker 訊息（現混成同句）。

## 測試計畫（Rule 9 驗證意圖）

純函式：
1. classifyFailure：各類代表錯誤 → 正確類別；模糊 → unknown；timeout 不誤判。

deploy：
2. env 失敗（DB 連不上）→ stopped、blocker_type='env'、deploy_retry_count 不變、不退 coding（＝根因 B 修好）。
3. code 失敗（ParseError）→ 退 coding＋計數（現行不破）。
4. transient → 自動重試一次；第二次成功 → 進 playwright（upgrade 呼叫兩次、計數不變）。
5. unknown → 呼叫 deploy-fix agent；agent 回 env → 走 env 路徑。

E2E：
6. verdict fail 但 env 非 running → 判 env、不加 pw 計數、不退 coding（夜間 shutdown 不再誤歸因）。
7. verdict fail 且 env 正常 → 退 coding＋pw 計數（現行不破）。

nightly：
8. 有任務在 deploy_testing 的專案 env → nightlyShutdown 跳過不砍。

成敗點：測 2、測 6＝「明確非程式問題時 coding 計數不動、不重跑」。

## 範圍
- 不含自動修（pip install）——安全面，且掩蓋「模組該宣告相依」的真問題，defer。
- 不含 cs/analysis 的 claude transient 重試（那些不誤歸因 coding，僅 stopped，價值低），defer。
- 驗證：跑真實任務，觀察 env/transient 失敗不再累加 deploy_retry_count / pw_retry_count。
