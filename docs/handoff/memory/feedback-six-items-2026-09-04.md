---
name: feedback-six-items-2026-09-04
description: 2026-09-04 六項使用者回饋已 push（200f9e55／0b29c429），欠一次重啟；規格版本化與換關行的實跑未驗
metadata: 
  node_type: memory
  type: project
  originSessionId: 8677bf54-ed95-4ccb-afcb-03e9d820da63
---

2026-09-04 使用者一次提六項，全部實作完並 push 到 master（`200f9e55` 格式容錯、`0b29c429` 其餘五項）。測試 3790 → 3797 全綠、零回歸。

**⚠ 還欠一次 server 重啟**（動了 `app/server`，且 `db.js` 新增 `task_specs` 表與 `tasks.last_logged_status` 欄位——重啟才會跑 migrate 建表）。重啟要請使用者在主機 `docker restart`，見 [[platform-restart-kills-container]]。

**重啟後才驗得到的兩件事**：
1. 規格改寫真的產生第 2 版＋時間軸另起一筆（前端已用 Playwright 攔 API 塞 `specs` 驗過渲染與折疊；後端只有 jest）。
2. 換關行（`task_logs.role='stage'`）真的在跑 pipeline 時出現、且不重複洗版。

**這次挖出的兩個實質缺陷**（不只是 UI）：
- 開發關的 commit 保底條件寫成 `result == null`，補救 agent 回「合法但沒用的 JSON」時整段被跳過 → task 230 已 commit 7 個檔仍 stopped。判準改成「拿不到可行動的 status」。
- 分析關的 `parseAgentResult` 一直沒給 `schemaHint`（coding 關早就有），而「Agent 未回傳有效結果」5 筆裡有 3 筆出在分析關。

**兩個判讀教訓**：
- 使用者說「很常出現」時先量。近 30 天只有 1.4% 的輪次需要格式補救、補救全成功，真正因此停下的只有 9 筆——但每一次都硬停要人工介入，所以感受上很常。量測不是用來反駁他，是用來找對修的地方。
- 使用者說「暫停時還是顯示暫停」，程式碼與截圖都顯示「恢復」。真正的問題是全站四種說法（恢復／繼續執行／已暫停／圖示）讓他記不住哪個是動作哪個是狀態。**「他描述的現象不存在」不等於「沒有問題」**。

新表 `task_specs` 的 FK 不帶 CASCADE，四條刪除路徑都已補清——新增任何 `REFERENCES tasks(id)` 的表都要做這件事，見 [[spec-trio-executed-2026-08-08]]。

相關：[[pgmem-like-bracket-charclass]]、[[ui-next-frontend-verify-loop]]
