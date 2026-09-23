---
name: cs-resume-and-stale-rules
description: cs 關補上 session resume 已 push(b35b9ed) 待重啟＋量測；並記「.claude/rules/ 條目可能記載已修掉的舊行為」這個會重複踩的坑
metadata: 
  node_type: memory
  type: project
  originSessionId: 15929e84-aa26-4046-be96-8fbd825d9f02
---

2026-08-10 早上查「token 燒很快」查出來的：`cs` 是**唯一沒有 session resume 的關**（`tasks` 早有 coding／qa／spec／clarify／analysis 五組 session 欄位）。兩條重跑路徑（追問 `cs_reply_pending`→`cs_running`、補資料 `cs_data_needed`→`cs_running`）都是全新 session，前一輪查過的正式區 DB／程式碼只剩一段草稿文字傳下去，agent 只好整包重查。實測 `task_service_3907` 追問輪為此燒 2.4M cache_read／262 秒，兩輪 cs 合計 $3.12，比同日走完整條 pipeline 的任務還貴。

已修並 push：`b35b9ed`（接既有 `pipeline/with-resume.js`，新增 `cs_session_id`／`cs_prompt_ver` 與 `.claude/agents/cs-retry.md`）。測試 2565→2571 全綠。

同一次調查還查出更大的一筆：spec_tour 關兩張注入名單都漏了、全根掃碟、失敗輪完全不記帳，已修並 push（`9a20574`）。詳見 [[token-usage-underreports-cost]]。

**待辦兩件**（與 [[pipeline-chat-panel-and-today-range]] 同批等重啟）：
1. 主機 `docker restart`（容器內 kill node 會連 postgres 一起收掉，見 [[platform-restart-kills-container]]）才生效，新欄位也要 migrate。
2. 重啟後跑過一輪真實追問，回 `token_usage` 比對同類 cs 執行，確認降幅——**目前省多少純屬預期、未實測**。spec_tour 那條同理，且因為以前失敗輪不記帳，改完後報表數字**會變高**，那是可見性變好不是變貴，別誤判。

## 會重複踩的坑：規則檔條目可能是已修掉的舊行為

我這次拿 `.claude/rules/pipeline.md` 第 78 條（「cs 花 40 個工具查出的根因全丟掉、分析再重查」）當現況講，被使用者當場糾正。實際上 `cs_findings` 早就通了：`cs-agent.js` 寫入 → `task-agent.js` 注入 analysis 的 `{{cs_findings}}`，當天四張任務全有值（456~1208 字）。

同檔第 53 條自己就掛著 2026-08-07 的更正註記，[[deployment-env-red-tests]] 是同一類（過期的紅燈豁免清單）。**規則檔描述的是「寫下當時」的狀態，引用任何一條當現況之前先驗碼**，尤其是那種「某某東西被丟掉／沒有做」的負面斷言——那正是最可能已經被修掉的。
