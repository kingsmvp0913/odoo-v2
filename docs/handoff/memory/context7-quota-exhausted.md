---
name: context7-quota-exhausted
description: context7 匿名額度爆掉→各關靜默改用 WebSearch 抓 Odoo core；後台 key 方案 4edb9d3 ✅ 已完全結案（08-19 用 raifong #145/#149 的 task_events 實跑複驗：WebSearch 0 次、quota 0 次）；留存價值在「靜默降級」的判讀線索
metadata:
  node_type: memory
  type: project
  originSessionId: 724d1cc2-0f15-49ed-8105-5b7de7526876
---

2026-08-11 task 122 的 cs 與 analysis 關呼叫 context7，回的是：

> Monthly quota exceeded. Create a free API key at https://context7.com/dashboard for more requests.

**根因不是用量太兇**：`app/server/pipeline/mcp/context7.json` 從頭到尾只有 `npx @upstash/context7-mcp`、
**沒有任何 API key**，等於一直在用依 IP 計的匿名額度。

**為什麼比看起來嚴重**：CLAUDE.md §3 明文「pipeline 各關不自行跑 py_compile／xmllint 做本地驗證，
寫對程式碼靠 Context7＋讀既有碼」。context7 一斷，唯一的查證管道就沒了，而 `claude-runner.js` 沒設
任何 `--disallowedTools` → 各關**靜默改用 WebSearch/WebFetch** 抓 `raw.githubusercontent.com` 的 Odoo
原始碼。慢、不準，那段 token 常不記帳。**沒有任何告警**：quota 訊息只在 `task_events` 的工具回傳裡，
狀態仍是 completed。

**已做（`4edb9d3`，已 push）**：照 `claude_oauth_token_enc` 那條既成路徑做後台設定——
`teams_settings.context7_api_key_enc`（加密）、`lib/context7-auth.js`（載入／快取／失效）、
`/api/admin/context7-key` 三支端點（GET 只回布林）、Admin.js 一個設定區塊。測試 2589→2608 全綠。

## ✅ 2026-08-19 實跑複驗：已完全結案
key 仍在（`context7_api_key_enc` len=102），注入鏈完整（DB → `loadContext7Key` 啟動載入 →
`getContext7ApiKey` → `claude-runner` 依 `MCP_PROFILES` 組設定檔）。
拿 08-18 跑完的 raifong #145／#149 查 `task_events`（那是 key 生效後的真任務）：
**`quota exceeded` 0 次、`WebSearch` 0 次、`raw.githubusercontent` 0 次**，context7 提及 33 次。
零退路痕跡＝降級沒有再發生。
⚠ 本檔原本結尾寫「唯一剩下的：跑一張真實任務確認」，其實 08-18 那兩張任務就已經驗完了，只是
沒人回頭查 `task_events`。**「待驗」的項目要先查有沒有已經被順帶驗掉**，否則它會一直掛在待辦上
（見 [[stale-memory-blocks-work]]）。

**兩個實作要點**（日後改到別踩）：
- key 必須**顯式寫進 MCP 設定檔的 env**，不能靠繼承：子行程帶 `--strict-mcp-config`，MCP server 由
  claude CLI 另行 spawn，繼承與否無保證。生成檔 `context7.local.json` 已在 `.gitignore`。
- `_context7Path` 快取**連 key 一起比對**，否則換 key 要重啟才生效，後台設定的意義就沒了。

**判讀線索**：某關耗時異常且 `task_events` 裡一連串 WebSearch/WebFetch 打 github raw，先查 context7
是不是掛不上或額度爆了，別急著改 prompt。掛不上（`ToolSearch` 回 "No matching deferred tools found"）
與額度爆（有回應但是 quota 訊息）是兩個不同故障。

相關：[[token-usage-underreports-cost]]、[[spectour-fixes-pending-restart]]
