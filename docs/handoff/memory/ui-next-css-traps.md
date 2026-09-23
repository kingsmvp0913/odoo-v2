---
name: ui-next-css-traps
description: 動 ui-next 版面前必看的坑：全域 reset 吃掉清單縮排、真正在捲的是 .ui-next-main、位移動畫一律用 FLIP、邊框百分比在我們底色下等於沒有、頁面有兩套外殼選錯不報錯、--radius-md 不存在會變方角、外殼帶 zoom 所以 rect ≠ CSS px
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 46056b69-a0d7-4b7d-84a3-d928da532aea
---

2026-09-01 一輪版面修正撞出來的，每一個都「看起來沒事、實際失效」。

## 1. `app.css` 第一行的 `*{margin:0;padding:0}` 會吃掉 markdown 清單的縮排

`ol`/`ul` 的 `padding-left` 被清成 0 → 數字／項目符號畫在內容框外面被截掉，第二行也不對齊。
**每一個新的 markdown 顯示區都要自己補回來**，沒補也不會報錯。目前全站只有兩處：
`.ui-next-message`（專案對話）、`.ui-next-conv-list article > div:first-child`（任務對話）。
新增第三處 `v-html` 時記得一起補。

## 2. 捲軸統一到最外面之後，真正在捲的是 `.ui-next-main`

`.ui-next-thread-messages` 已被覆寫成 `overflow:visible`。任何 `element.scrollTop = ...` 綁在內層容器上等於什麼都沒做，
**而且完全不報錯**——症狀是「進對話要自己往下滾才看得到最新訊息」。
一律 `document.querySelector('.ui-next-main')`。同理，捲動事件也要綁在它身上。

## 3. 位移動畫用 FLIP，不要自己算 px

`.ui-next-question` 是垂直置中的容器：內容一變高，該移多少 px 就跟著變。
先量後套的寫法**實測固定差 35px**，而且改 padding/margin 校正沒用（`align-items:end` 碰到內容溢出會靜默退回靠上對齊，`padding-bottom` 0→31px 只換來 3px 位移）。
正解：**先量 → 套上最終狀態 → 再量 → 用差值把它拉回原位 → 放掉讓 CSS 過渡走完**。兩端都是實測值，天生免疫版面變化。
落點若要和另一頁接縫，最終狀態用 `position:absolute` 釘死，別靠 grid 對齊。

## 4. 照 AskMe 取樣的邊框百分比在我們的底色下等於沒有邊

我們的 `--surface`（#1B1B1E）和 `--bg`（#232326）幾乎同色，`color-mix(... 12%)` 的邊框肉眼看不見，
**尤其下緣**（下方沒有內容可對比，整條線消失）。實測要 22%（focus 36%）才看得出來。
**取樣別人家的數值時要連底色一起換算，不能照抄百分比。**

## 5. （2026-09-02 起）CSS 已拆檔，`ui-next-pages.css` 不再存在

改成 `app/public/css/ui-next-pages/01-…09-*.css`。**檔名前綴的數字就是層疊順序，不可重排、不可按字母排序**——
`09-later-patches.css` 整份是靠排在最後才生效的補丁，順序一動樣式就默默變掉且沒有任何測試會叫。

**同一個 selector 跨檔重複定義目前有 28 組**（`frontend-ui-next.test.js` 的 `CROSS_FILE_DUP_BASELINE` 鎖住上限）。
所以「改了一條規則卻不生效」的第一個假設仍然是**它在後面的檔案裡被蓋掉了**，只是現在要跨檔找。
數量請自己重量，不要引用這裡的數字——它會腐爛。

## 6. 頁面有「兩套外殼」，選錯不報錯（2026-09-05 補）

- **主要頁面**：`<section class="ui-next-page">` + `<header class="ui-next-page-head">` + `.ui-next-head-tools`。
  h1 30px、離頂 46px、`width:min(1180px,100%)` 置中、按鈕是裸 `<button>`（靠父容器上色）＋ `.ui-next-primary`。
  任務／專案／設定／架構圖／流程圖／用量報表都是這一套。
- **Admin 子頁**：`<div class="topbar ui-next-admin-head">` + `<div class="content">` ＋ app.css 的 `.btn btn-*`。
  h1 只有 24px、貼著頂端、多一條橫線、不受 1180px 限寬。

認證兩頁（ExamBank／ExamRun）誤用了 Admin 那套，一直到有人說「跟其他頁不一樣」才發現。
**單看每一項都像「這頁本來就長這樣」**，要並排量 `h1` 的 `font-size` 與 `getBoundingClientRect().x/y` 才看得出來。
已修（`f4ca0807`）並在 `frontend-exam-run.test.js` 釘住。

## 7. token 只有 `--radius-sm/--radius/--radius-lg`，**沒有 `--radius-md`**

寫 `var(--radius-md)` 會讓整條 `border-radius` 宣告無效 → 退回初始值 **0**（方角），
不是退回上一條規則。全站曾有一處這樣寫，那塊面板是唯一的方角面板，沒人發現。
用沒定義的 var 之前先 `grep -- "--名稱:"`。

## 8. ui-next 外殼帶著 `zoom`，量到的 px 不是 CSS px

`getBoundingClientRect()` 的 39px ≈ CSS 的 35.5px。**照量到的數字寫死 `height` 會比鄰居高一截**。
對齊尺寸要複製鄰居的 `padding`/`font-size` 讓它自己算，不要抄 rect。
另外 `.ui-next-primary` 自帶 `height:34px`，跟它並排時要 `height:auto` 才齊。

## 驗證方式

CSS 改動 Jest 測不到（`.claude/rules/frontend.md` #30）。用 Playwright 量 computed style ＋ 截圖，
但**探針要驅動真的程式路徑**——我一度用 evaluate 自己複製一套動畫來量，量了半天都是在測自己寫的假動畫。
要測送出流程就用 `ctx.route()` 攔掉 API（避免燒 token），然後真的 `fill` + `click`。

**09-08 新增：卡片的 `overflow:hidden` 會把浮層下拉裁成一條輸入框。** `.ui-next-repos`（Repo 卡）為了
圓角收邊寫了 `overflow:hidden`，裡面 `position:absolute` 的下拉只露出頂端那截，症狀被使用者描述成
「點下去只有輸入關鍵字、沒有清單」＋「有點跑版、下拉不是懸浮的」——**看起來像元件壞掉，其實是外層裁切**。
判別法：`getComputedStyle(卡片).overflow` ＋ 比對 panel 的 `getBoundingClientRect().top` 有沒有超出卡片 top。
修法是卡片改 `overflow:visible`、圓角交給最後一列自己 `border-radius: 0 0 14px 14px`。
另：`.ui-next-add-repo input:not([type="checkbox"])` 這種寫法特異性是 (0,2,1)，想覆蓋它的
`.ui-next-branch-picker input` 只有 (0,1,1) 會輸——又是同一個坑。

相關：[[ui-next-async-chat-contract]]、[[baseline-selfcheck-green-is-not-correct]]
