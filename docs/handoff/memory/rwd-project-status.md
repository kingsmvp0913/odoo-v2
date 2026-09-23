---
name: rwd-project-status
description: RWD C 方案 8 塊全數完成並 push（Block 1 只差真機驗 dvh）；含門禁的用法、三個已知弱點與四個踩過的坑
metadata: 
  node_type: memory
  type: project
  originSessionId: 18f38371-cde1-4afc-b4ed-9ffff585c5a9
---

規格書在 `docs/RWD-C-SPEC.md`（`docs/` 全在 .gitignore 內，只存在這台機器）。

**2026-08-07 狀態：8 塊全做完並 push**（`66bc59c` → `8876c3c`，共 8 個 commit）。最終驗收：126 組截圖、桌機回歸 0。
Block 7 的 **PWA 與底部導覽經使用者裁定不做**（service worker 快取會讓人拿到舊版前端；底部列再吃 56px）。

**唯一未完成項**：Block 1 的 `dvh`——手機捲到底會不會被動態網址列裁切，無頭瀏覽器沒有會伸縮的網址列，**只能真機驗**。過了就把規格 §4 的 Block 1 改成打勾。

**跑門禁**：`cd app && RWD_BASE_URL=http://localhost:8771/ RWD_USER=kingsmvp2 RWD_PASS=<問使用者> npm run rwd:gate`（`rwd:check` 是含小螢幕的完整版）。

## 門禁的三個已知弱點（判紅燈前先讀）

1. **渲染鏈換版＝基線全滅**。Chromium 與字型都釘在 `app/rwd/.pw-browsers`／`.fontroot`（皆不進版控）。若 42 張**全部**紅、且 diff 圖只有文字輪廓紅而版面沒移，是瀏覽器換版，只能在乾淨 HEAD 重產基線。
2. **只拍第一屏的問題已修**（`STABILIZE_CSS` 解除 app-shell 的 height／overflow）。修之前所有 app 頁面基線都是 1440x900，Block 1–4 的「diff = 0」只涵蓋捲動線以上——已回頭補驗，40/42 完全相同。
3. **主題同步競速會偶發假紅**：整片側欄顏色不同（淺色主題拍到深色側欄），重跑即綠。只紅一輪的當 flaky。

**門禁只拍頁面預設狀態**：modal、批次列、特定任務狀態的表單都拍不到。驗這類改動要自寫「改動前／後各跑一輪」的互動截圖腳本比 pixel。**比 md5 會假紅**——PNG 編碼位元會變，要用 pixelmatch 比像素。

## 四個踩過的坑（改前端 CSS 前先看）

1. **specificity：等價的不只是「值」，還有「它贏過誰」**（栽了三次）。inline style 贏過所有 class，抽成單一 class 後只有 (0,1,0)：會被 `[data-theme="dark"] .form-control` (0,2,0) 蓋掉（症狀：**淺色全綠、只有深色破功**），也會被 `.data-table tbody td` (0,1,2) 蓋掉。修法是疊寫兩個 class 或補上元素選擇器。
2. **並行 subagent 各自命名會撞名**。合併前必掃三道：新 class 互撞／撞 app.css 既有定義／被其他 view 當 markup 用。實際發生過 agent 把 modal 遮罩命名為全域既有的 `.modal-overlay`，會改掉全站所有 modal **而門禁驗不出來**。
3. **截圖環境字型只有 Noto Sans CJK＋Color Emoji**，符號類字元（`☰` U+2630、`✕` U+2715）渲染成豆腐框。判準：**沒有替代路徑的功能性圖示**不能賭字型（漢堡鈕已改純 CSS 三條線）；有替代路徑的維持原樣，改它要重產基線。
4. **量溢出要量 `.content` 自己**，不是 `documentElement`——app-shell 外層是 `overflow:hidden`，內容區撐爆了在 document 上完全看不出來（用量報表曾爆到 945px 卻回報「零溢出」）。

相關：[[baseline-selfcheck-green-is-not-correct]]、[[container-no-root-no-apt]]、[[push-with-stored-pat]]。
