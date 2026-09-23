---
name: health-signal-vs-proposal
description: 健檢的 signal（候選訊號）不會開單也不會被夜間批次修，只回餵給下一輪 auditor；健檢頁已改顯示「觀察中」，待重啟
metadata:
  type: project
---

健檢 finding 有 `kind` 之分，決定它會不會被處理：

- `proposal` → `openFeedbackForFinding` 開單進改善提案頁，核准後夜間批次自動修。
- `signal` → **哪裡都不開單**。`nightly-fix.js` 的 `fetchHealthCandidates` 寫死 `kind='proposal'`，撿不到它。唯一去處是 `previousProposals()` 把它標成「候選訊號」餵回下一輪 auditor，證據夠了才升級成提案。
- `summary` / `note` → 純敘述。

**Why**：2026-09-14、09-15 兩輪 auditor 只出 signal（那兩天量太小：1 張與 4 張任務），使用者因此以為「改善提案不見了」。實際是提案根本沒產生，而健檢頁的「要不要改善」欄把 signal 也算進 `open_count`、顯示成「待處理 1」——叫人去一個沒有東西可按的地方。

**How to apply**：問「提案怎麼不見了」時先查 `health_check_findings` 的 `kind`，不是先查 `feedback` 表少了什麼。只有 `kind='proposal'` 才會在改善提案頁出現。

2026-09-16 已修並 push `e1ef9ce0`（**未重啟**）：`admin-routes.js` 的清單 API 多回 `watch_count`（signal 且 pending 且 medium 以上），`ui-next/pages/AdminHealthCheck.js` 的 `histTodo` 據此顯示「觀察中 N」，展開區每條也加 `kindLabel` 標「提案／觀察中」。全跑 4969 綠。legacy UI（`js/views/AdminHealthCheck.js`）刻意沒動。

**2026-09-16 使用者裁決：9/15 那條時區 signal 先放著，問題不大，之後再改。** 內容是 chat 用 getSQL 查 Odoo 時把 UTC 的 Datetime 欄位當台灣時間讀（差 8 小時），鴻久對話 117 裡犯兩次。已查證 `.claude/skills/getSQL/SKILL.md` 與 `.claude/agents/chat.md` 都零時區字樣，而 `getLog` skill 有寫且強制參數帶偏移——兩支工具防線不等高。要修就是補那兩處。

尚未處理：signal 目前沒有任何人工升級成提案的入口——想做只能手改 DB 或等 auditor 自己升級。相關：[[health-check-green-is-hollow]]、[[nightly-fix-verify-gate]]
