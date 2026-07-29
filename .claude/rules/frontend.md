---
paths:
  - "app/public/**"
---

# 平台開發：前端

> 抽自 2026-07-29 的記憶整併。完整清單與來源見 `docs/rules-extraction-2026-07-29.md`。

30. **前端沒有任何自動化測試，改動一律需瀏覽器人工實測（含深色模式）** — Jest 不涵蓋 Vue view，頁籤／收合／modal／配色只能人工點過。
31. **新功能一律從 `app/public/styleguide.html` 挑 token／共用 class，禁目測填 px、禁寫死顏色** — 前端不一致的根因是缺 design token（曾有 278 處 inline style、零 @media），換框架治不了病因。
32. **寫死的淺色系顏色在深色模式會維持亮底** — 語意色一律走 app.css 共用 class（`.blocker-card`／`.pill-danger`／`var(--danger)`）。
33. **`app.css` 從未定義 `.btn-secondary`，用它等於裸按鈕** — 全站既有多處用法都是失效的。
34. **Vue 3 Options API 中放在 `computed` 的東西，呼叫端不能加括號** — 加括號直接 TypeError 白畫面。
35. **前端全域元件一律仿 `showToast` 模式**：全域函式＋reactive state＋App template 渲染 host。載入序須在 `store.js` 後、`app.js` 前。
36. **寫計畫時引用到的前端 helper 名稱必須先讀 `api.js`／`dialog.js` 核實** — 憑印象寫（`Api.del` 實際只有 `delete`；`confirmDialog` 只吃物件不吃字串）會讓功能完全失效且不報錯。
37. **前端表單送出時只取「當前題目」的鍵值，不要送整包累積 state** — 以問題文字為 key 的 answers 在 `refresh()` 跨輪 merge 只增不減。修在送出端而非 refresh，避免打字中被 realtime 清掉。
38. **前端隱藏 admin 功能要三處齊做**：nav `v-if="isAdmin"`、router `requiresAdmin` guard、後端 endpoint 403。缺一都是破口。
39. **擴充既有 JSON 欄位時保留舊形狀欄位與新的 `details` 並存** — 舊任務與 rebuild 路徑會讀舊形狀；前端需要「無 detail 就退回舊介面」的分支。

