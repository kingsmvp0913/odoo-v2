---
name: spectour-fixes-pending-restart
description: 2026-08-11 的三個 SpecTour/E2E commit（9d89d2e/bfdc02c/b5c1acb）已隨 12:33 重啟生效，但重啟後尚無任何任務跑過 → 修正仍未經實測驗證
metadata:
  node_type: memory
  type: project
  originSessionId: 724d1cc2-0f15-49ed-8105-5b7de7526876
---

**狀態（2026-08-11 13:40 更新）**：常駐 server 已於台北 **12:33:41 重啟**（pid 32，`node app/server/index.js`），晚於最後一個 commit `b5c1acb`（11:39）→ 三個修正**都已載入生效**。但 `token_usage` 最後一筆是 UTC 03:39（台北 11:39），重啟後**零執行** → 生效但**尚未經任何真實任務驗證**。

已生效的三個 commit：

- `9d89d2e` 09:56 — spec_tour 補進 `MCP_PROFILES`（context7）、`writeSpecTour` 加 `e2e_disabled` 判斷、timeout 600s→1200s
- `bfdc02c` 10:45 — E2E 關首航實測修正
- `b5c1acb` 11:39 — `spec_tour_enabled` 與 `e2e_disabled` 併成一個旗標、E2E 關改純程式關

**原症狀（重啟前）**：8 個專案裡 7 個 `e2e_disabled=true`，這些專案每張任務走到「先寫 E2E 考題」都會固定燒滿 600s 逾時、零產出、`token_usage` 記 model=NULL/tokens=0（實例：task 106 於 09:23，`token_usage` id 498）。原因是舊碼只看已退役的 `spec_tour_enabled`，且 spec_tour 沒掛 context7 → 只剩 WebSearch/WebFetch 抓 Odoo core 一條路。

✅ **2026-08-11 13:45 前端已人工實測通過**（使用者確認）。曾一度回報「還是看到兩個開關」，實為 SPA 分頁未重載的舊 JS——server 回傳的 `ProjectDetail.js` 早已是新版（`editSpecTour` 0 次命中）。此類回報一律先叫 Ctrl+Shift+R 再查碼。

**仍待驗證**：跑一張任務確認 (1) 不再出現 600s 逾時的零產出記錄，(2) `token_usage` 該關有正常 model/tokens。⚠ 8 個專案裡 **7 個 `e2e_disabled=true`，只有 `odoo19`（id 4）會走 E2E 關**，實跑驗證只能在它身上做。

相關：[[e2e-disabled-runtime-errors-escape]]、[[token-usage-underreports-cost]]、[[platform-restart-kills-container]]
