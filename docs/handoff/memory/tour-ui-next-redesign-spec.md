---
name: tour-ui-next-redesign-spec
description: 新手教學對齊 UI Next 已完工並 push（HEAD f9e72e6a）；留存「靜態測試說錨點都在、實跑 60 步有 15 步指不到」的教訓與可重跑的逐步驗證腳本
metadata: 
  node_type: memory
  type: project
  originSessionId: a11aa8b2-919b-48a3-a5fb-1fc5ae08ef45
  modified: 2026-09-07T10:31:01.256Z
---

2026-09-07 完工並 push（`origin/master` HEAD = `f9e72e6a`，五個 commit）。規格書
`docs/superpowers/specs/2026-09-07-tour-ui-next-redesign-design.md`（在 .gitignore，只在這台）。
測試 4360 → 4392，0 failed；逐堂實跑 60 步 60 OK。

**留存價值：四個「畫面正常＋測試全綠＋零訊號」的實例**

1. **錨點存在 ≠ 指得到。** 補完 38 個 `data-tour` 後靜態測試全綠，實跑卻有 **15 步**指不到——
   UI Next 把大量內容收進分頁與跳窗，元素在 DOM 裡但 `height: 0`（個人設定 3 分頁、用量報表 4、
   管理員設定 4、專案頁 7、執行歷程改跳窗）。教學遇到只會退成置中說明框，不報錯。
   ⇒ **要驗落點只能實跑**：`~/.claude/nightshift-ref/verify-tour.js` 可直接重跑（自簽 JWT，
   比對 `.tour-ring` 與目標元素的 rect 中心差）。
2. **寫死檔案清單的守衛會腐爛成零防護。** `tour-isolation.test.js` 原本掃一份舊介面檔名清單，
   於是 38 步壞掉它全綠，撐了整個改版週期。已改成遞迴掃 `js/ui-next/`。
   同理，動態拼接的錨點（`:data-tour="'set-tab-' + item.key"`）要**從原始碼撈 key 清單**，
   寫死的 key 會在改分頁時腐爛。
3. **色票是 scoped 的。** ui-next 的變數定義在 `[data-ui="next"]` 子樹上，而 toast／確認視窗／
   教學三個浮層**刻意**掛在 shell 外面（登入頁也要有它們）⇒ 整組吃 `app.css` 舊色票。
   已包一層 `display:contents` 的 wrapper 帶進去。
4. **叫不出來的功能 grep 函式名找不到。** `openTour()` 一直在，只是沒有任何 UI 呼叫它。
   同一手法查到 **`ProjectChat.js` 的「對話紀錄」抽屜也叫不出來**（`toggleHistory` 全檔只出現
   一次＝定義本身，template 沒綁）——**這個未修，等使用者拍板那顆鈕放哪**。
   `frontend-ui-next-deadcode.test.js` 沒抓到。

**兩個實測陷阱**：`export X=$(cd 別處 && ...)` 失敗時 export 仍回 0 ⇒ 空 token 截到登入頁而腳本
報 OK（要自己檢查 token 長度）；深色模式 `--primary`/`--success` 是亮色，寫死 `color:#fff` 讀不到。

相關：[[ui-next-css-traps]]、[[ui-next-frontend-verify-loop]]、[[nightshift-idle-98-rounds]]
