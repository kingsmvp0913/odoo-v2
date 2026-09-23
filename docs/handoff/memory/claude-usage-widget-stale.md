---
name: claude-usage-widget-stale
description: Claude 用量 widget 卡住的判讀法與三層來源架構；rate_limit_event 是不受限流影響的免費來源，階段二（推估％＋閘門改判）尚未做
metadata: 
  node_type: memory
  type: project
  originSessionId: 48f8d709-6943-4fe4-85e3-a514a0aade9f
---

## 現況（2026-08-27 更新，commit `d97a64db` 已 push、**尚未重啟**）

用量來源設計成三層，各司其職：

1. **`/api/oauth/usage`** — 唯一給得出 utilization 百分比的來源，但限流極兇。
2. **`rate_limit_event`** — claude CLI 串流事件。**pipeline 本來就跑 `--output-format stream-json --verbose`（`claude-runner.js:151`），事件一直流過 stdout 只是被丟掉**。攔它零成本、零 API 呼叫，**429 期間照樣有效**，而且量的正是「跑任務那把憑證」。缺點：**只有 `status`／`resetsAt`／`rateLimitType`／`overageStatus`，沒有百分比**。
3. **校準樣本** `data/claude-usage-calibration.jsonl` — API 回真值時才追加，供日後推估百分比。

`resetsAt` 是 **epoch 秒**（實測 1787809200 → `2026-08-27T05:40:00Z`，與同時間 API 回的 `five_hour.resets_at` 只差 1 秒 ⇒ 同源可信）。

**⚠ 階段二還沒做**：推估百分比顯示、以及把 usage-gate 從百分比門檻改判 `status`。目前 `usage-gate.js` 仍完全靠 `utilization` 與 `usage_gate_5h_threshold ?? 90`，API 掛掉時閘門就只能吃 stale 值。**撞限額時 `status` 回什麼值我沒驗到**（只實測過 `allowed`），拿未知值域去重寫閘門有誤停 pipeline 的風險——這是當初刻意分兩階段的原因。

## 限流門檻實測（2026-08-31，決定性）

**用本機憑證那把打 `/api/oauth/usage`：**

| 節奏 | 結果 |
|---|---|
| 每 2 秒連打 | #1–#6 全 200，#7 **429 `Retry-After=300`**（短窗 ≈ 5 分鐘 6 次） |
| **每 60 秒打，連 15 次** | **13 次 200、2 次 429 且 `Retry-After=0`**（下一分鐘就恢復，不是罰站） |

⇒ **60 秒輪詢完全可行**，端點本身沒有「每小時 6 次」那種硬限制。

**但平台那把 setup-token 同時段是持續 429 且 `Retry-After` 從 2476 逐秒倒數到 1990（≈40 分鐘罰站）**，而它才每 10 分鐘打一次。同帳號、同端點、同時段，一把每分鐘打沒事、另一把每 10 分鐘打被罰 40 分鐘 ⇒ **問題出在那把 token 本身，不在頻率**（setup-token 是否另有更嚴限流、或有別的消費端在用它，未查明）。

**⇒ 修法方向**：usage 查詢改用本機 `~/.claude/.credentials.json` 那把（primary 當備援），`CACHE_TTL_MS` 由 10 分鐘降到 60 秒 ⇒ 時間差 40+ 分鐘 → 60 秒。`lib/claude-usage.js` 註解裡「永遠打本機憑證檔會在兩者不同帳號時量到不相干的數字」的**前提已被推翻**（兩把同帳號），但仍應加**同源檢查**：比對 `resets_at`，不一致才拒用。

## 判讀法（widget 又卡住時）

1. **看 `data/claude-usage.json` 的 mtime**：只在抓取成功時更新，等於「最後一次成功」。
2. **雙 token 對打**：平台 setup-token（`teams_settings.claude_oauth_token_enc`，經 `lib/claude-auth` 的 `getTokenFor`）與本機 `~/.claude/.credentials.json`，**同一秒各打一次** `/api/oauth/usage`。2026-08-27 實測：平台 primary **429**（Retry-After=1047）、本機 **200**（32%／70%）。2026-08-31 複驗仍是平台 429（Retry-After=2476）／本機 200。**限流綁在 token 上**，不是網路也不是 IP。
   - ⚠ **更正 08-27 的「兩把不是同一個帳號」——那是錯的**。08-31 比對兩把回傳的視窗重置時刻：`five_hour.resets_at` 平台 `05:40:00.107` vs 本機 `05:39:59.709`、`seven_day.resets_at` 平台 `09-03T05:00:00.107` vs 本機 `09-03T04:59:59.709`，**兩個視窗都只差 0.4 秒 ⇒ 同一個帳號、同一個配額桶**。當初只看百分比不同就下結論，但那只是取樣時間差（平台 03:06 量到 36%，本機 03:40 量到 45%）。**判是否同帳號要比 `resets_at`，不要比 `utilization`。**
3. **「卡住」多半不是壞掉，是節奏慢**。08-31 實測 `data/claude-usage-calibration.jsonl` 的成功時間戳為 02:09 → 03:02 → 03:06，中間 53 分鐘空窗＝被 `blockedUntil` 冷卻擋著。實際節奏是「成功一次 → 429 → 冷卻 40 分鐘 → 再成功」，所以畫面數字約 40–50 分鐘才跳一次，與「壞掉」肉眼難分。**先看 calibration 尾幾筆的時間戳，比看 snapshot mtime 更能分辨「慢」與「死」。**
   - 為什麼平台那把先被燒光而使用者自己的 CLI 從來不卡：CLI 的 `/usage` 是人手動觸發、一天數次；平台是 24/7 每 10 分鐘 TTL 一到就打（`lib/claude-usage.js` `CACHE_TTL_MS`）＋前端輪詢＋`usage-gate` 每關評估。同帳號但不同 token，配額桶各自獨立。
3. 抓取失敗仍是靜默的（使用者 2026-08-20 明確決定不做 fail loud），所以不會有任何告警。

## 別再走的路

- **Claude Desktop 的 `plan-usage-history.json`**：`7641bc9b` 試過，在此環境是**純死碼**——路徑靠 `LOCALAPPDATA` 推導（Windows 專屬，容器內未設），且全機沒有該檔（Desktop 在另一台）。已於 `d97a64db` 移除。
- **拿 CLI 的 `/usage` 當第四個來源**（2026-08-31 實測四組對照後否決）：
  - `claude -p "/usage" --output-format json` **確實可跑**，且 `num_turns:0`／`duration_api_ms:0`／`total_cost_usd:0`——**不燒任何 model token**。
  - 但**用 `CLAUDE_CODE_OAUTH_TOKEN` env 注入時只回 session cost 摘要，沒有百分比行**。本機那把 token 經 env 注入同樣退化 ⇒ 是機制問題，不是 token 壞。要百分比必須寫成 `.credentials.json`（可用 `CLAUDE_CONFIG_DIR` 指到獨立目錄，實測成立）。
  - 決定性反證：`/usage` 讀的**就是** `/api/oauth/usage`。同一秒三方對打——平台 primary **429**（Retry-After 2476）、本機 **200**（44%／21%），而 `/usage` 顯示的 44%／21% 與本機 API 回值逐字相同。**換 client 不繞過限流**，平台 token 被限流時 `/usage` 一樣交白卷。
  - `/usage` 那段「What's contributing」（subagent-heavy ％、>150k context ％、top skills）是**本機 session 歷史算的**，與 API 無關、永遠拿得到，但那是行為分析不是配額數字。
  - statusline 的 `rate_limits.*.used_percentage` 需 CLI **2.1.251+**；本機 2.1.197 的 bundle 內 `used_percentage` 出現 **0 次**，現在沒有這條路。
- **在容器內裝 Claude Desktop**：官方 Linux 版確實存在（2026-06-30 起 Ubuntu/Debian beta，我原以為只有 Win/mac，**這點是我查證後才修正的**），但此容器無 sudo、apt 索引空、無 `DISPLAY`／Xvfb、GUI OAuth 登入走不完。**更致命的是**：Desktop 要有人互動才留取樣，掛一個沒人用的 Desktop，取樣過了 45 分鐘照樣判定不新鮮 → 白裝。

## 順帶挖到、尚未修的

`token_usage.provider` 欄位**從 2026-07-29 建立至今 1489 筆全是 NULL**，寫入端從沒填過。目前不影響用量推估（`model` 欄位有填且全為 `claude-*`，可用 `model LIKE 'claude-%'` 過濾），但這是個真缺陷。

**Why**：這 widget 壞掉時完全不出聲，症狀（數字不動）和「沒人用所以用量沒變」長得一模一樣。
**How to apply**：先看 snapshot mtime，再雙 token 對打分辨「配額問題」與「連線問題」。相關 [[token-usage-underreports-cost]]、[[jest-global-fs-mock-breaks-transform-cache]]。
