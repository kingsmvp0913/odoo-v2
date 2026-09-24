---
name: stage5-release-live-unconfigured
description: 09-22 階段 5 更版機制已上線並重啟；維護時段 09-24 已設定成週六日 01:00 起五小時（原本是 null 完全不會動）；含併回改善提案的版面決定
metadata: 
  node_type: memory
  type: project
  originSessionId: d3f6087f-9fd1-4b18-b7c1-56a61fb1fa49
  modified: 2026-09-24T00:00:00.000Z
---

2026-09-22 階段 5「平台更版機制」做完並上線、平台已重啟（新端點回 401、亂打的回 404，確認新碼在跑）。合併維持自動，**重啟改成等維護時段**，重啟前對 master 跑全套、紅了不重啟。

✅ **2026-09-24 維護時段已設定**：查正式 DB 得 `release_window = {"weekdays":[0,6],"startHour":1,"durationHours":5}`＝每週六、日凌晨 01:00–06:00（與 09-22 裁決的「02:00 起兩小時」不同，以 DB 實查為準）。`release_last_window` 與 `release_last_result` 都還是 null ⇒ **一次都還沒真的跑過**，第一次落在設定後的第一個週末。

⚠ 在那之前它是 null，tick 每分鐘落在 `no-window-config`、機制完全不動——這是刻意的預設（沒設定就不自動重啟）。若日後又看到 null，不是壞了，是被清掉或換了 DB。

**版面被使用者推翻過一次**：原計畫開了獨立的 `/admin/release` 頁，使用者問「為什麼要多一個管理功能出來，他應該跟改善提案一起就好」——對的，更版是改善流程的最後一步（提案→核准→夜間改碼→合併→**上線**）。整頁刪掉，四塊內容分別搬到：時段設定→系統設定「進階」、待更版清單＋稽核軌跡→改善提案頁、立刻更版→同區、**上一次更版失敗→管理員首頁**（commit `9bcfda2b`）。

**失敗通知只有畫面一條路**（這台沒有 webhook 也沒有 Teams），所以管理員首頁那條是唯一通道：不點任何東西就看得到，帶失敗原因全文＋該怎麼辦四步＋逐台列出沒重開成功的測試區。「不會有任何東西通知你」是從 `notify.channels.length === 0` 算的，哪天接了 Teams 會自動改口。

**歷史遺留已清**：28 筆 `finding_fixes` 卡在 `merged`（舊制度沒有 `released` 這個狀態），畫面顯示「已合併，待更版」是假的——程式碼早就在跑。使用者跑 `app/tools/mark-released-once.js` 改成 `released`，待更版剩 0。

**仍不可救的失敗模式**（修正輪自己寫明的）：重啟指令送出後若錯誤 callback 根本沒被呼叫（容器真的收掉＝成功，或行程先死），那與成功長得一模一樣。見 [[legacy-frontend-retired]]、[[productize-saas-decision]]。
