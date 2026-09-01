# UI Next 左側 Menu 改版規格

- 狀態：待實作
- 日期：2026-09-01
- 參考介面：AskME 左側導覽
- 實作範圍：`app/public/js/ui-next/UiNextApp.js`、`app/public/css/ui-next.css` 與對應前端測試

## 1. 目標

把 UI Next 左側 Menu 改為較接近 AskME 的單層選單外觀與漸進展開結構：移除多餘小標題、讓「專案 → 專案清單 → Chat 清單」形成同一棵導覽樹、清楚標示目前 Chat，並縮小視覺密度。

成功條件：

1. 側欄不再顯示「工作區」與「專案 Chat」兩個小標題。
2. 專案清單直接隸屬於「專案」，Chat 清單直接隸屬於各專案。
3. 進入 Chat 頁時，父層自動展開，且目前 Chat 有明確 selected/focus 樣式。
4. 「新對話」不再呈現卡片／主按鈕外觀，改為與 AskME 相同的普通 Menu row。
5. 所有 Menu row 的 hover、selected、字重、間距與 AskME 的低對比風格一致，並支援深淺色模式。
6. 不改變既有專案篩選、排序、Chat 排序、路由與 API 行為。

## 2. 核心假設

1. 「focus」是指目前 Chat 的視覺 selected 狀態，不是每次換頁都強制把鍵盤焦點移到側欄。
2. 「按目前規則列出專案」是指完整保留現有 `sidebarProjects()` 規則；本次不重新定義「近期專案」。
3. 「比照 AskME」指互動與視覺語言，不照抄 AskME 的品牌、色碼或英文文案。
4. 「字小一點」以實際視覺大小為準。專案目前有全站 `body { zoom: var(--ui-zoom) }`，桌面預設為 `1.1`；因此 CSS 的 `14px` 實際看起來約為 `15.4px`。本次應縮小 Sidebar row 的 CSS 字級／高度，而不是調整全站 zoom。
5. 本次只改左側導覽；Chat 內容區、Composer、專案頁、任務頁與後端 API 均不在範圍內。

## 3. 導覽結構

改版後的視覺階層：

```text
Odoo AI
新對話
搜尋
────────────
問答
任務列表
專案                         ▾
  鴻久 ★                      ▾
    目前 Chat 標題             ← selected
    另一個 Chat
    查看全部對話
  odoo17                      ›

更多工具
帳號與設定
用量資訊
```

具體要求：

- 刪除「工作區」小標題。
- 刪除「專案 Chat」小標題。
- 保留搜尋下方既有分隔線。
- `.ui-next-projects` 必須移到「專案」row 的直屬下方，視覺上不可再像另一個獨立 section。
- 專案下縮排一層，Chat 再縮排一層；以縮排、細左側 guide line 與 chevron 表達階層，不增加新的 section label。
- 「專案」右側既有未讀數量必須保留；chevron 與未讀數量不得重疊。
- 專案的 favorite 星號、Chat 的「查看全部對話」入口均保留。

## 4. 專案與 Chat 資料規則

不得因重排 DOM 而改變以下既有規則：

### 4.1 側欄專案清單

1. `GET /api/chats/sidebar-projects` 只回傳至少有一則訊息的 Chat metadata，依 `last_message_at DESC` 排序。
2. 前端取回傳資料前 5 筆 Chat，映射成專案後以 project id 去重。
3. 再加入所有 `is_favorite` 專案。
4. 最終排序為 favorite 優先，其次依專案名稱使用 `zh-Hant` 排序。
5. 不得改成「所有專案」、不得在 mounted 時逐專案讀 Chat，避免 N+1。

目前路由若屬於一個未被上述規則選中的舊專案，允許把該「目前專案」作為唯一例外補入側欄，目的只是讓目前 Chat 能顯示 selected；其餘專案仍遵循原規則。

### 4.2 專案內 Chat 清單

1. 專案首次展開時才呼叫 `GET /api/projects/:projectId/chats`；同一專案已載入後沿用 `projectChats` cache。
2. API 既有順序 `created_at DESC` 不變。
3. 側欄最多顯示 5 筆 Chat，之後顯示「查看全部對話」。
4. 若目前 Chat 不在最新 5 筆內，仍須讓它出現在 5 筆可見項目中：保留目前 Chat，再以最新 Chat 補足到 5 筆並去重。
5. Chat 標題空白時維持顯示「新對話」。
6. 讀取失敗維持既有 error toast；不得靜默失敗，也不新增後端端點。

## 5. 點擊與展開行為

### 5.1 「專案」row

- 點「專案」文字區：前往 `/projects`，並展開下方專案清單。
- 點右側 chevron：只切換專案清單展開／收合，不導航。
- 位於 `/projects`、`/projects/:projectId`、`/projects/:projectId/chat` 或 `/projects/:projectId/chat/:chatId` 時，專案清單預設為展開。

### 5.2 單一專案 row

- 點專案名稱區：前往 `/projects/:projectId`，並展開該專案的 Chat 清單。
- 點右側 chevron：只切換該專案的 Chat 清單，不導航。
- 同一時間允許多個專案展開，不改成 accordion。
- 收合後不清掉已載入的 Chat cache。

### 5.3 Chat row

- 點擊後沿用既有路由 `/projects/:projectId/chat/:chatId`。
- Chat 頁載入或在 SPA 內切換路由時，必須自動：
  1. 展開「專案」清單。
  2. 確保目前 project 出現在側欄。
  3. 展開目前 project。
  4. 必要時載入該 project 的 Chat。
  5. 對目前 Chat 套用 selected 樣式與 `aria-current="page"`。
- 必須監聽路由變化，不能只在 component mounted 時做一次。
- 使用者仍可手動收合目前 project；再次展開後目前 Chat selected 狀態仍存在。

## 6. 「新對話」

- 行為不變：仍導向 `/`，不在側欄直接建立 Chat，也不新增 Modal。
- 外觀改成一般 Menu row，與 AskME 的 `New chat` 一致：
  - 透明背景。
  - 無 border。
  - 無 box-shadow。
  - 一般字重，不使用粗體主按鈕語氣。
  - plus icon 與文字維持左對齊。
- 「新對話」與「搜尋」應共用相同 row 高度、左右 padding、圓角與 hover 規則。

## 7. 視覺規格

### 7.1 AskME 實測基準

2026-09-01 以目前 AskME 桌面版比對：

- 一般 row：高度約 `32px`、圓角 `10px`、透明背景、一般字重。
- Hover：低對比底色（深色模式約白色 `5%`），並有約 `translateY(-2px)` 的輕微上浮；動畫約 `125ms`。
- Selected Chat：深色模式約白色 `10%` 底色、字重約 `500`、無左側色條、無陰影。
- AskME 的精緻感主要來自 row 高度、字重與留白，不只是 font-size。

### 7.2 本專案目標值

- 第一層 Menu（新對話、搜尋、問答、任務列表、專案）：CSS `font-size: 13px`、`font-weight: 400`。
- 專案名稱：CSS `font-size: 13px`、`font-weight: 400`。
- Chat 標題與「查看全部對話」：CSS `font-size: 12px`；selected 時 `font-weight: 500`。
- 一般 row 視覺高度以接近 AskME 的 `32–35px` 為目標；禁止維持目前「新對話」約 49px 的卡片高度。
- 圓角：`9–10px`；Chat 子項可使用同值，不必刻意縮成 6px。
- Icon 使用一致的小尺寸並對齊文字基線；chevron 固定靠右。
- 階層縮排應一致：專案比第一層多約 `12–16px`，Chat 再多約 `16–20px`。

### 7.3 Hover 與 selected

必須使用既有 dark-aware CSS 變數，不可寫死只適用深色模式的顏色：

- 一般：`background: transparent`。
- Hover：建議 `color-mix(in srgb, var(--sidebar-active) 5%, transparent)`，並 `translate: 0 -2px`。
- Hover transition：只 transition `background-color`、`color`、`translate`，約 `125ms`；不要使用籠統的 `transition: all`。
- Selected Chat：建議 `color-mix(in srgb, var(--sidebar-active) 10%, transparent)`、`font-weight: 500`。
- Selected 不使用現行 `.ui-next-nav.is-active::before` 的左側 3px 色條，也不加陰影。
- Active ancestor（「專案」與目前 project）只提高文字對比／維持展開，不與目前 Chat 同時顯示三個重底色；最明確的 selected 底色只留給最深層目前頁面。
- `:focus-visible` 必須保留可辨識的鍵盤 outline；hover 動畫不能取代鍵盤 focus 樣式。
- `prefers-reduced-motion: reduce` 下取消上浮動畫。

## 8. 響應式與可及性

- 保留既有桌面、平板 icon-only、手機 drawer 行為；本次不改 breakpoint。
- 展開控制必須是原生 button，維持正確 `aria-expanded` 與包含專案名稱的 `aria-label`。
- 目前 Chat 使用 `aria-current="page"`。
- 不把桌面 sidebar 誤標為 dialog；既有行動版 dialog/focus trap 不得退化。
- 文字過長維持單行 ellipsis，不能把 sidebar 撐寬或造成水平捲軸。

## 9. 不在本次範圍

- 不改後端 API、DB schema 或查詢排序。
- 不改專案頁與 Chat 頁的主內容版型。
- 不新增「所有專案」或全域 Chat 搜尋功能。
- 不改未讀數量定義、favorite 規則或權限。
- 不調整全站 `--ui-zoom`。
- 不順手重構 UiNextApp 其他導覽、帳號、用量或 command palette 程式。

## 10. 建議修改點

- `app/public/js/ui-next/UiNextApp.js`
  - 移除兩個 `.ui-next-section-label`。
  - 將專案清單 DOM 併入「專案」導覽樹。
  - 增加頂層專案展開狀態。
  - 依 route 自動展開目前 project、載入 Chat、計算目前 selected Chat。
  - 補上 `aria-current` 與 active class。
  - 保留既有 `sidebarProjects()`、lazy load 與 cache 原則。
- `app/public/css/ui-next.css`
  - 移除 `.ui-next-new` 卡片外觀。
  - 統一 Menu row 的 font、height、padding、radius、hover 與 selected。
  - 移除／限制目前 active 左側色條。
  - 加入 reduced-motion 規則，並確認 light/dark variables。
- `app/server/tests/frontend-ui-next.test.js`
  - 更新 sidebar 靜態契約測試。
- `app/server/tests/frontend-ui-next-a11y.test.js`
  - 視需要補 route active、`aria-current`、`aria-expanded` 與 drawer 行為不退化的斷言。

## 11. 驗收案例

1. 首頁：看不到「工作區」「專案 Chat」；新對話是普通 row，沒有框與陰影。
2. 點「專案」：進入 `/projects` 並顯示依現有規則選出的專案。
3. 點任一專案：進入 `/projects/:id` 並在其下顯示最新 5 筆 Chat。
4. 點 Chat：進入正確路由；目前 Chat 顯示 selected、`aria-current="page"`，父層保持展開。
5. 直接重新整理 Chat 深連結：不需手動展開，仍能看到並 selected 目前 Chat。
6. 目前 Chat 是第 6 筆以後：側欄仍顯示它且總 Chat 項目不超過 5 筆，「查看全部對話」仍存在。
7. 目前 project 不在近期／favorite 清單：側欄仍暫時補入它，讓目前 Chat 可見；離開後回復既有篩選規則。
8. Hover 任一 row：只有低對比底色與輕微上浮，沒有卡片陰影或劇烈位移。
9. 深色／淺色模式：hover、selected、文字均可讀，沒有寫死淺底導致文字消失。
10. 鍵盤操作：Tab 可到達所有入口；Enter 可啟動；展開按鈕回報正確 `aria-expanded`；focus-visible 清楚。
11. 平板 icon-only 與手機 drawer：版型、focus trap、背景捲動鎖定均無退化。

## 12. 驗證

先跑相關測試，再跑全套；測試輸出依 repo 規則精簡：

```powershell
cd app
npx jest server/tests/frontend-ui-next.test.js server/tests/frontend-ui-next-a11y.test.js --runInBand --silent --noStackTrace --no-color
npm test -- --silent --noStackTrace --no-color
```

最後以實際瀏覽器至少檢查：桌面深色、桌面淺色、直接開啟舊 Chat 深連結、手機 drawer 四種情境。
