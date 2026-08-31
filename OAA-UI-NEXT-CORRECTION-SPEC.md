# OAA UI Next 規格書（唯一執行版本）

| 欄位 | 內容 |
|---|---|
| 文件版本 | 0.11.0（2026-08-31 換機續作檢查點） |
| 文件地位 | 本檔為唯一可執行規格；已整併舊版基準與其後續修正決策。 |
| 文件狀態 | 已完成第一輪現況稽核；已開始 P0／P1 修正。下列「本次實作進度」為目前唯一有效進度，不代表整份規格驗收完成。 |
| 稽核目標 | 確認原站既有功能在對應 Next UI 中可正常操作、顯示，且 Next UI 符合原規格的獨立介面要求 |
| 視覺參考 | AskMe 僅作資訊層級、側欄與對話輸入體驗參考，不照搬 OAA 沒有的產品功能 |
| 本文件限制 | 此為執行中規格：可修改本機 Next UI 與測試；不得提交正式資料，亦不得以正式資料試錯、刪除或佈署。 |
| 追加需求效力 | 本文件第 5.17 節 `NEXT-UX-001`～`NEXT-UX-009` 為最新產品決策；與本文件較早段落衝突時，以第 5.17 節為準 |

---

## 1. 修正目標與成功條件

本次修正不是重做外觀，而是讓 Next UI 真正成為可獨立使用、功能不退化的新介面。

完成後必須同時符合：

1. 原站可用的登入、任務、專案、Chat、Wiki、環境、DB、SOP、Token、Pipeline、設定與管理功能，在對應 Next UI 皆有可操作入口。
2. 同一路由、同一身分與同一後端資料下，Next UI 不得缺少原站關鍵操作，也不得顯示過期或錯誤狀態。
3. Next UI 不得以包住 Legacy View、展開 `window.*View` 的 `data/computed/watch/methods`，或依賴 Legacy DOM 結構來假裝完成功能。
4. 所有頁面必須具備 loading、empty、error、success 與 retry 狀態；互動錯誤不得讓主內容白屏。
5. 360、768、1024、1440px 均不得裁切操作區、產生頁面級橫向捲動，或讓主要操作變成不可辨識的直排文字。
6. 深色、淺色模式下都必須可讀；不得出現 Legacy 白底欄位嵌在深色頁面的情形。
7. Keyboard、焦點、Dialog、Drawer、Popover 與螢幕閱讀器語意符合 WCAG 2.1 AA 的基本操作要求。
8. 自動測試必須能抓到本輪已重現的 runtime 錯誤，不得只比對檔案內是否存在某段字串。

### 1.1 核心假設

- 本輪只修 Next UI；Legacy 原站保留作為功能行為基準，不要求同步改版。
- 後端既有 API、Socket、權限、資料表與 Pipeline 行為原則上不變；若前端無法完成既有功能，才另列後端缺口。
- 共用 `Api`、Socket broker、Markdown renderer、附件 helper、狀態 registry 與純函式可以；共用 Legacy View 的畫面、生命週期或方法不可以。
- 狀態顯示以共用 `status-labels.js` 為唯一來源，不得在頁面另建互相矛盾的 mapping。
- Deploy SOP 統一為七步：檢查、備份與差異、Git 目錄、Runner、sudoers、deploy workflow、驗證。原規格的「六步」應在定稿時改正。
- AskMe 的價值是「問題優先、安靜的版面層級、清楚的對話入口」；資料夾、模型選擇、分類推薦等 OAA 後端未支援的能力不納入。
- 「舊對話」指已存在且可由 Sidebar、對話歷程或 deep link 開啟的 Chat；「新對話」指尚未有訊息或剛建立的 Chat。兩者只可有資料狀態差異，不可使用兩套版型或 Composer。
- 「兩個按鈕區塊」依現行 Sidebar 結構明確指「更多工具」與「帳號與設定」。
- 本次追加不改變現有 route、API 權限或 Token report 的 admin gate；若產品要讓一般使用者查看 Usage，需另行確認權限規格。

### 1.2 不在本輪範圍

- 不新增原站沒有的新商業流程或 Model。
- 不因視覺重整改變任務狀態機、審核權限或 Pipeline 順序。
- 不用假資料掩蓋 API 缺口。
- 不在正式資料上測試建立、刪除、上正式、重建環境或送出審核決策。

---

## 2. 稽核方法與證據界線

第一輪已使用目前開啟的 AskMe 與本機 Next UI，搭配程式碼與既有測試進行以下檢查：

- 桌機實際路由、內容顯示、主要互動與深淺色切換。
- 360px 手機寬度的側欄、任務列表、任務詳情與操作區。
- 任務篩選、Chat 專案／對話切換、空 Chat、Command Palette、Release Modal、Wiki Modal、行動側欄等互動。
- Next router、View 組合方式、CSS scope、Legacy View 依賴與既有測試斷言。
- 原站功能與 Next UI 對應入口的初步 parity 檢查。

為避免污染資料，本輪沒有送出：建立任務、回答問題、接受規格、合併衝突、上正式、環境重建、DB 寫入、刪除專案／Chat／Wiki、帳號或密碼變更。這些列入第二輪的隔離環境或 mock 驗證。

### 2.1 嚴重度

| 等級 | 定義 | 發布門檻 |
|---|---|---|
| P0 | 阻斷使用、白屏、權限錯誤、資料與路由錯置、手機主要操作不可達，或測試錯誤放行 | 全部修正才可擴大使用 |
| P1 | 主要功能缺漏、顯著狀態錯誤、無障礙阻斷、深淺色或 RWD 明顯失效 | 正式切換前全部修正 |
| P2 | 可用但資訊層級、文案、效率或一致性不足 | 正式切換前完成或有核准的延期單 |

---

## 3. P0 阻斷問題

### NEXT-P0-001：非管理員會被整體踢回 Legacy

**已重現／程式證據**

`app/public/js/app.js` 的 router guard 對所有 `requiresAuth` Next 路由額外檢查 `me.role !== "admin"`，非管理員會被 `window.location.replace(...)` 退回 Legacy。這直接違反原規格「只有管理功能需 admin」的要求。

**修正契約**

- 移除 Next UI 的全域 admin gate。
- `requiresAuth` 只驗證已登入；`requiresAdmin` 才驗證 admin。
- 非管理員可使用其在 Legacy 已有權限的任務、專案、Chat、Wiki、Token 與設定頁。
- 無權限路由顯示 403 狀態頁，不得無聲切回 Legacy。
- 登出或 session 過期保留原目標 route，重新登入後回到該 route。

**驗收**

- admin 與一般使用者各跑一次完整 route matrix。
- 一般使用者進 `/tasks`、`/projects`、`/task/:id` 不得被改寫網址。
- 一般使用者進 `/admin` 才顯示 403 或導向安全頁。

### NEXT-P0-002：任務列表開啟「篩選」會讓主內容白屏

**已重現**

`/tasks` 點擊「篩選」後主畫面消失，Console 出現：

```text
TypeError: Cannot read properties of undefined (reading 'STATUS_LABELS')
```

原因是 template 使用 `window.STATUS_LABELS`，但 `window` 不在 Vue component template scope。

**修正契約**

- 在 component setup/computed 中注入已驗證的 status options，不得從 template 直接存取 `window`。
- 狀態選項、顏色與文案全部取自同一 registry。
- 任一 filter option 失敗時只讓 filter 區顯示錯誤，不得卸載整個 route view。
- Filter 開關、套用、清除及 URL query 同步都必須有 browser test。

### NEXT-P0-003：Chat 同 component 路由切換後仍顯示上一個專案

**已重現**

由 `/projects/:projectId/chat` 在側欄點另一個專案的 Chat，URL 已變成新的 project/chat id，主畫面仍保留上一個專案的空狀態；完整 reload 才取得正確資料。

**修正契約**

- watch `route.params.projectId` 與 `route.params.chatId`，或對 route view 設定穩定且正確的 key。
- route 改變時取消舊請求、清空與新路由不相容的暫存狀態，再載入專案、Chat 清單與訊息。
- 慢回應不得覆蓋新路由資料；使用 request id 或 abort signal 防止 race condition。
- 直接貼 deep link、側欄切換與瀏覽器上一頁／下一頁結果必須一致。

### NEXT-P0-004：沒有既有 Chat 時形成無法開始的死路

**已重現**

`/projects/:id/chat` 在專案沒有 Chat 時只顯示「選擇一段對話／或建立新對話」，但頁面沒有可見的建立按鈕或可用 composer。

**修正契約**

- Empty state 必須包含主要按鈕「開始新對話」。
- 使用者可先輸入第一則訊息，送出時自動建立 Chat；或先建立有名稱的 Chat，兩條路徑至少完成一條。
- 建立失敗保留輸入內容並顯示 inline retry。
- Sidebar「新對話」與頁面 Empty CTA 必須落到相同流程。

### NEXT-P0-005：360px 任務詳情操作區遭裁切

**已重現**

360px viewport 下，右側 action panel 寬度約 417px，超出可視範圍且被頁面裁切；部分回答與送出控制無法觸及。

**修正契約**

- 小於 768px 時 detail 與 action panel 改單欄，panel 寬度固定為容器 `100%`、`min-width: 0`。
- 所有按鈕、Field、diff 與附件列不得超出 viewport；長字串只在內部 code/diff 容器捲動。
- 自動檢查所有可互動元素的 bounding box 均落在 viewport 內。

### NEXT-P0-006：既有測試把 Legacy 包裝誤判為 Next 完成

**已確認**

`app/server/tests/frontend-ui-next.test.js` 目前以字串存在為主，甚至明確期待 Next component 使用 `window.ProjectDetailView.methods` 或 legacy wrapper。CSS 測試也只檢查檔案包含 `.ui-next-*`，無法阻止未 scope selector。現況因此可在測試綠燈時發生篩選白屏與路由資料錯置。

**修正契約**

- 移除所有「Next 必須重用 Legacy View」的正向斷言，改為禁止清單。
- 新增實際 mount 與 browser interaction test；Console error、pageerror、未處理 Promise rejection 一律使測試失敗。
- 將本節 P0 的重現步驟固化成 regression tests。
- CSS gate 必須解析 selector，逐條確認 scope，而不是搜尋一個合法字串就通過。

---

## 4. 全域架構修正契約

### 4.1 Next View 必須獨立

以下模式一律禁止：

```js
...window.LegacyView.data()
methods: window.LegacyView.methods
computed: window.LegacyView.computed
watch: window.LegacyView.watch
window.LegacyView.created.call(this)
```

也禁止用外層 Next 標題包住完整 Legacy component。現在 Terminal、DB、Architecture、Pipeline Flow、Admin 及多個 admin tool 因這種包裝產生雙標題、雙返回按鈕、Legacy 配色與不一致 RWD。

允許抽出的共用層：

- API client 與 endpoint adapter。
- Socket 訂閱／取消訂閱 broker。
- 純資料 normalizer、formatter、status registry。
- Markdown、attachment 與下載 helper。
- 不含 DOM、不持有 Vue instance 的純函式。

建議結構：

```text
app/public/js/ui-next/
  app/
  components/
  composables/
  adapters/
  pages/
  registries/
```

不要求一次搬完檔案，但每個頁面改寫完成後不得再引用對應 Legacy View。

### 4.2 Route 與狀態生命週期

- 所有 params 與 query 都要有明確 source of truth。
- 頁面內狀態必須在 route identity 改變時 reset 或重新取得。
- Search、tab、filter、sort 等可分享狀態同步到 query；返回頁面可還原。
- 非必要不得 full-page reload。
- API race、abort、Socket 重連與 visibility pause/resume 都要測試。

### 4.3 共用 Overlay

建立共用 Next Modal、Drawer、Popover、Command Palette primitive，統一處理：

- 掛載在 Next root overlay layer。
- `role="dialog"`、`aria-modal="true"`、標題關聯。
- 開啟時焦點進入 overlay，Tab/Shift+Tab 不可逃出。
- Escape 關閉可取消 overlay；破壞性確認 Modal 不可點 backdrop 關閉。
- 關閉後焦點回到觸發按鈕。
- Drawer 開啟時鎖定背景，route change 自動關閉。
- Popover 支援 Escape、outside click 與正確 `aria-expanded`。
- Sidebar「更多工具」與「帳號與設定」視為 Popover：點擊選單以外的 Sidebar 或主內容即關閉；點擊選單內部不得誤關；兩者互斥，同一時間只能展開一個；route change、Escape 與行動版 Sidebar 關閉時一併收合。

第一輪已發現：Command Palette 關閉後焦點掉到 `body`；Release Modal、Wiki Modal 與 mobile sidebar 不支援 Escape／focus trap；mobile sidebar 導航後仍可能遮住新頁面。

### 4.4 導覽與圖示

- 可導向頁面的項目使用 link/router-link，保留開新分頁與 deep link 能力。
- 當前頁使用 `aria-current="page"`。
- Sidebar 專案展開狀態存入 `oaa.next.sidebar.projects`；「專案 Chat」區只列符合 `NEXT-UX-001` 的專案，每專案最多列最近五個 Chat。沒有 Chat 時不得顯示「查看全部對話」；有 Chat 時該入口必須開啟實際含資料的完整對話清單，詳見 `NEXT-UX-002`。
- Account caret 必須反映實際展開狀態。
- 禁止用 `↑`、`×`、`←`、`⌄`、`⌃`、`★`、emoji 當正式圖示；全部經過可主題化的 SVG icon registry。
- 純裝飾 icon 設 `aria-hidden`；icon-only button 必須有可理解的 accessible name。
- 加入 Skip link，直接跳到主要內容。

### 4.5 主題與 CSS 隔離

- `html[data-theme]` 為現有 ThemeManager 的單一真相；Next root 同步可測試的 theme 狀態，但不得產生第二套互相漂移的儲存。
- Next CSS selector 必須從 `[data-ui="next"]` 或其專用 root 起始。
- 不得使用 `.ui-next-main .task-card` 之類 selector 去修飾 Legacy DOM 作為最終解法。
- Next asset 僅在 `?ui=next` 載入，Legacy 不應承擔 Next CSS/JS 成本。
- 所有色彩使用既有 CSS variables；禁止深色模式中的硬編碼白底 input/table。

### 4.6 狀態與錯誤處理

每個 route 與可變區塊都必須具有：

- Loading：骨架或清楚的進度狀態，不保留會誤導的舊資料。
- Empty：說明為何無資料，並提供可執行的下一步。
- Error：inline error、重試與錯誤識別；不得只靠四秒後消失的 toast。
- Success：更新畫面與必要 toast；避免重複提交。
- Pending：按鈕 disabled、顯示進度，並防止 double click。

Error toast 預設不可自動消失；使用者需能手動關閉與複製必要的錯誤識別資訊。

---

## 5. 逐頁修正規格

### 5.1 登入與身分

**現況問題**

- `/login` 仍直接使用 Legacy LoginView，未形成獨立 Next 登入頁。
- 第一輪在既有登入狀態下無法完整驗證註冊、GitHub、Odoo、eService 與 session expiry。

**修正要求**

- 建立 `UiNextLoginView`，保留原站所有可用登入／註冊方式、驗證訊息與返回目標。
- 密碼欄位、送出 pending、錯誤、鎖定與 retry 狀態完整。
- 已登入進 `/login` 的 redirect 行為需明文化。
- 不得載入 Legacy Login DOM 或依賴 Legacy selector。

### 5.2 首頁問答

**現況問題**

- 視覺已接近 AskMe 的問題優先層級，但預選專案固定為第一筆，未保存上次使用專案。
- 環境顯示為靜態「正式／測試依專案設定」，並非真實環境狀態。
- 專案下拉只顯示名稱，缺少 Odoo 版本。
- Composer 缺少自動增高、貼上截圖、檔案限制／預覽／錯誤及 macOS `Cmd+Enter`。
- 建立 Chat 成功但訊息失敗時可能留下 orphan chat，重試可能再建一個。
- 沒有專案時只有 disabled select，沒有建立專案入口。

**修正要求**

- 記錄最後成功使用的 project id；不存在或無權限時才回退第一筆。
- 選定專案後讀取真實 env 狀態，以「未建立／已停止／運行中／錯誤」顯示；不得用模糊占位文案。
- Project option 顯示專案名稱與 Odoo 版本。
- 原生單列 `<select>` 改為 AskMe 式 Project combobox：Trigger 與 option 都要清楚分開「專案識別」及「連線資訊」兩層；專案識別至少含名稱與 Odoo 版本，連線資訊使用既有真實資料顯示測試環境與資料庫連線狀態，不顯示密碼、Token、完整連線字串等 Secret。
- Combobox 支援 Keyboard 開啟、方向鍵移動、Enter 選取、Escape 關閉與 outside click；loading、無權限、狀態未知、無專案必須可區分。資料來源與詳細顯示依 `NEXT-UX-007`。
- Composer 支援文字自動增高、選檔、貼圖、預覽、移除、大小與數量限制；Enter 換行，Ctrl/Cmd+Enter 送出。
- 建立流程拆成 create chat 與 send first message 兩階段；第二階段失敗保留已建立 chat id，只重試訊息或安全清理，不得重複建立。
- 無專案 Empty state 對 admin 提供「建立專案」，對一般使用者說明需聯絡管理員。

### 5.3 Chat

**現況問題**

- 直接重用 Legacy data、created 與 methods。
- 同 component 路由切換資料不更新；無 Chat 專案形成死路。
- Chat history 是小型 popover，不是規格要求的右側 Drawer，缺少搜尋與焦點管理。
- AI 訊息使用大型卡片，與 AskMe 式連續閱讀層級不符。
- Code block 缺語言與複製；非圖片附件缺檔名、大小與下載。
- Pending 僅有跳動點，沒有耗時、失敗重試或回到最新。
- 「建立任務」曾只短暫顯示摘要中，未出現 draft Modal 或可恢復錯誤。

**修正要求**

- 先完成 NEXT-P0-003、004。
- Chat history 使用 380px 右 Drawer；包含搜尋、新 Chat、選取、刪除 dropdown，手機改全寬。
- 使用者訊息可有 bubble；AI 訊息採主要內容欄，不使用大面積 bordered card。
- Markdown code block 顯示語言與 Copy；附件列顯示檔名、大小、下載與圖片預覽。
- 已存在 Chat 與新 Chat 共用同一個 Thread component、訊息 renderer、附件顯示與 Composer；不得因是否有歷史訊息切換成 Legacy 版型或另一套操作。
- Composer 採 AskMe 式底部浮起／sticky 佈局，在 Thread 可捲動時仍固定可見於 viewport 底部；需保留 safe-area、不得遮住最後一則訊息，手機鍵盤開啟時仍可輸入與送出。
- Code block 的 Copy 必須複製未經裝飾的原始 code，不包含語言標籤、行號或按鈕文字；成功與失敗都有可感知回饋，並可用 Keyboard 操作。
- Pending 顯示已耗時；失敗提供 retry，並保留使用者輸入。
- 新訊息只在使用者接近底部時 auto-scroll；否則顯示「回到最新」。
- 建立任務流程：摘要 pending → draft Modal → 可編輯標題／描述／專案／附件 → 建立 success。任一步驟失敗均顯示 inline retry，不得靜默重置。

### 5.4 任務列表

**現況問題**

- Filter 白屏，見 NEXT-P0-002。
- Summary 使用「本頁完成」但數字與目前可見內容不一致，範圍不清。
- Task card 只有暫停／恢復，缺 archive、unarchive、delete 與 More。
- Card 是 click article，Keyboard 無法像 link 操作。
- 批次列不 sticky，checkbox 缺逐任務 accessible name，封存頁缺批次 unarchive。
- Search/filter/sort 未完整同步到 URL query。
- 建立任務為 inline panel，必填欄位多依賴 placeholder，附件缺預覽與限制。
- 360px 下三個 header action 變窄直排，五個 tab 擁擠，summary 堆疊占滿多屏。

**修正要求**

- 移除 `/tasks` 頁面最上方所有統計／Summary 區塊，包括「需回覆、進行中、等待審核、失敗待確認」；不得換成另一組指標卡。任務數量只可作為 tab、filter 或清單結果的輔助文字，不得形成頁首統計區。
- Task title 為可聚焦 link；次要操作放 More，破壞性操作需確認。
- 批次模式顯示 sticky/floating toolbar，支援 pause/resume/archive/unarchive；每個 checkbox 以 task title 命名。
- `tab/project/status/q/sort` 與 route query 雙向同步，上一頁可還原。
- 建立任務改共用 Modal，使用可見 label、必填、最多五檔、預覽／移除與 per-file error。
- 手機 header 保留一個主要 CTA，其餘收進 More；tab 可橫向捲動或改 select。移除統計後，第一屏應直接進入 filter／任務清單。
- 無資料與 filter 無結果分開；filter 無結果提供「清除篩選」。

### 5.5 任務詳情與九種 Action Mode

**現況問題**

- Question 的相依問題可顯示，但缺推薦選項、推薦原因、label note 與高成本警示。
- 缺「規格書 QA／提問」tab 與 clarification action。
- Spec review 只顯示 summary/acceptance，缺 module、requirements、permissions 與可收合區段。
- Review diff 被以 ` | ` 串成單一 `<pre>`，缺 repo 分區、截斷提示與附件限制。
- Conflict 缺分類、原因、AI 建議、per-file followup、manual input 與 merge clarification。
- `cs_data` 缺 Enter 下一步。
- 技術 `events` 被放在主要 action sidebar，形成巨量 YAML／result 文字，壓過決策。
- Timeline 直接輸出原始 content，缺 Markdown 與結構化摘要。
- 手機版 action panel 裁切，見 NEXT-P0-005。

**修正要求**

- 完整支援九種 action mode，逐一建立 normal/pending/success/error/double-submit 測試。
- 任務詳情主內容改為三個頁籤，固定順序為「需求內容／對話／執行歷程」；選中頁籤同步至 route query，重新整理、上一頁與下一頁可還原。小螢幕允許頁籤列自身橫向捲動，不得造成頁面級橫向捲動。
- 「需求內容」包含原始需求、主附件及可用時的規格內容；「對話」包含人工／AI 溝通與九種 action mode；「執行歷程」只放 Pipeline event、技術 log、終端輸出與完整終端機入口，不得把機器 log 混進對話。
- 技術 events 移到「執行歷程」，預設以結構化摘要呈現並可展開原始內容；Action sidebar 不再作為永久第二欄，當下需要人決定的 action 以 AskMe 式對話卡／Composer 放在「對話」頁籤中。
- 「對話」頁籤共用 Chat 的訊息 renderer、Code Copy、附件列、auto-scroll／回到最新與底部 sticky Composer；不得維護第二套 Markdown 或 Code block 行為。
- Question 顯示推薦、原因、備註、成本警示與附件限制；相依題在選擇後即時更新。
- Spec review 顯示 module、requirements、acceptance、permissions，長內容以 accordion 管理。
- Review diff 依 repo/file 分段，長內容內部捲動；標示是否截斷並提供附件 chip。
- Conflict 提供 AI 建議但不自動替人決策；必須能逐檔選擇與補充說明。
- 所有動作按鈕依狀態 disabled，request id 防重送。

### 5.6 Terminal

**現況問題**

- Next 外層包 Legacy Terminal，形成雙標題與雙返回按鈕。
- 狀態仍含 Unicode 圖示，視覺與 Next 不一致。

**修正要求**

- 建立獨立 Next Terminal page，只保留一組 page header。
- 可共用 xterm instance adapter，但 connection、reconnect、ANSI、follow-scroll 與歷史載入由 Next controller 管理。
- 明確區分「等待新輸出」「連線中斷」「任務已結束」；不得把歷史輸出與目前狀態混為一談。
- 手機只允許 terminal viewport 內橫向捲動，頁面本身不捲動。

### 5.7 專案列表

**現況問題**

- 1440px 以上仍只顯示兩欄，原規格要求三欄。
- 卡片沒有真實 env 狀態、More、DB/SOP/release 與 admin delete。
- Favorite 使用 `★` 且 accessible name 不明。
- 建立專案為 inline panel，缺可見 label、即時 folder regex validation 與明確取消。
- 搜尋無結果沒有清除行動；缺 skeleton、error retry。
- 額外的工作原則／快捷操作區造成焦點分散。

**修正要求**

- ≥1440px 三欄、1024px 兩欄、<768px 一欄。
- 卡片顯示名稱、版本、repo、真實 env status；More 依權限顯示 Chat/Wiki/DB/SOP/release/delete。
- Favorite 改 SVG 並提供「加入／移除最愛：專案名稱」。
- 新增專案使用 Modal、可見 label、即時 validation 與 server error 對應欄位。
- 環境狀態採 batch API 或 concurrency ≤4 並有短 TTL，避免 N+1 洪水。
- 移除或降級與核心操作無關的裝飾資訊。

### 5.8 專案詳情

**現況問題**

- Header 將 Chat、Wiki、SOP、Release 全部平鋪，缺主要／次要層級與測試環境入口。
- Overview 缺未讀 Chat、E2E、source mapping 與待發布摘要。
- Repo 缺 local path、明確 branch probe 狀態與禁用原因。
- Env 顯示「未建立」，但同時呈現可重新啟動的 built 環境，狀態語意矛盾。
- 設定 mutation 的 optimistic update 缺 rollback 證據；Enterprise 變更缺 rebuild 警告。
- Release Modal 顯示 raw English status，缺受影響 repo，且焦點與 Escape 失效。

**修正要求**

- Header 只保留主要 Chat CTA；Wiki、SOP、DB、Release、環境工具進 More，並保留依權限顯示。
- Overview 顯示 repo/env/E2E/unread/pending-release/source mapping 的摘要與可到達入口。
- Repo Field 都有 label；branch probe 有 idle/loading/success/error；remove disabled 時顯示原因。
- Env 狀態矩陣：

| 後端狀態 | 顯示 | 主要動作 |
|---|---|---|
| absent 或 `idle + built=false` | 未建立 | 建立環境 |
| `idle + built=true` | 已停止 | 啟動環境 |
| `setting_up` | 建立中與進度 | 無，允許查看 log |
| `running` | 運行中 | 開啟／停止／外部連線 |
| `error` | 錯誤且保留 built 事實 | retry 或 rebuild，依後端能力 |

- 同時顯示 port、external slot、addons drift、setup/runtime log；禁用控制必須說明原因。
- E2E、edition 等 optimistic mutation 失敗要 rollback 並顯示 inline error。
- Release Modal 只列已核准且未發布項目，狀態中文化，顯示受影響 repo；無項目時 primary disabled；衝突或失敗保留 Modal 與 retry。

### 5.9 Wiki

**現況問題**

- 直接重用 Legacy View。
- 預設選中「專案備註」，與原規格預設首頁不一致。
- Tree row 不是語意化 link/button，emoji/Unicode 圖示與永遠可見的刪除叉號不合規。
- Add Modal 不支援 Escape；手機 Drawer、未儲存離開保護尚未完整驗證。

**修正要求**

- 建立獨立 Next Wiki View；預設順序明確為首頁，再回退最近頁面。
- Tree node 可 Keyboard 展開／選取；刪除收進 More 並確認。
- Desktop 左樹右內容，手機樹狀區為可關閉 Drawer。
- Notes/Page 編輯具 dirty state；換頁、返回與關閉前必須確認。
- Add/Edit/Delete 均使用共用 overlay 與 inline error。

### 5.10 DB 工具

**現況問題**

- Next 外層包 Legacy DB，造成雙標題／雙返回。
- 深色模式仍有硬編碼白底 input。
- VPN、連線、probe、query 功能存在，但 RWD 與錯誤隔離未達 Next 契約。

**修正要求**

- 建立獨立 Next DB View，保留原站所有 VPN、連線 CRUD/test/probe/query 能力與權限。
- Secret 只顯示是否設定，不回填原值。
- Table 在手機改 card row，SQL 結果只在結果容器內橫向捲動。
- 每個連線與 query 有獨立 pending/error，不得一個錯誤讓整頁失效。

### 5.11 Deploy SOP

**現況問題**

- 畫面雖為 Next markup，資料與方法仍直接取自 Legacy。
- 現況為七步，原規格文字寫六步。
- 未解析 placeholder 仍可 Copy，容易把錯誤指令帶到正式環境。

**修正要求**

- 正式採七步流程，資料由 Next adapter 取得。
- 頁首說明依賴的 DB connection 與相同連線限制；不符時顯示具體 inline error。
- 未解析 placeholder 高亮，必要值缺失時 Copy disabled；不得複製含未知 token 的命令。
- Copy success 顯示短 toast，失敗顯示可持續 error。

### 5.12 Token Report 與 Sidebar Usage

**現況問題**

- 報表基本內容已顯示，但 filter/custom date 的 query 同步與錯誤流程仍待補。
- API 資料不足時 trend 標題可能空白；per-user breakdown 未呈現。
- quota 一處偏「已用」、一處偏「剩餘」，語意不一致。
- Sidebar 目前只呈現 Codex 類 quota，未完整反映 Claude/Codex，且 Usage 位於「更多工具／帳號」上方。

**修正要求**

- 日期、專案、Agent、使用者 filter 同步 query；custom range 有 validation。
- 無資料、API 不支援與真正的零必須分開顯示。
- Sidebar 只顯示 Claude 與 Codex 各自的 5 小時用量，不顯示週用量；兩列都統一呈現 Provider、已用或剩餘百分比及 reset 時間，並使用同一 normalized source。
- Sidebar 底部順序改為「更多工具」→「帳號與設定」→「Usage」；Usage 是最下方區塊，前兩個按鈕區塊整體上移，不得被 Usage 或 viewport 裁切。
- 點擊 Usage 進入 `/token-report` 後才顯示週用量與其他明細；週用量不得在 Sidebar 以展開列或第二條 quota 出現。

### 5.13 Pipeline Monitor

**現況問題**

- Empty state 已能區分無執行項目，但缺明確最後更新時間。
- 文案「進行中的排障對話」過度限縮用途。
- Polling visibility 與個別 block error isolation 尚待自動化驗證。

**修正要求**

- 標題改為一般「進行中的 AI 問答／互動」。
- 顯示最後更新時間、連線狀態與手動重試。
- 頁面隱藏時暫停 polling，恢復時立即 refresh；單一 block 失敗不影響其他區塊。

### 5.14 Architecture 與 Pipeline Flow

**現況問題**

- 仍是 Legacy diagram wrapper。
- 缺 fit/zoom/reset，node 不是可 Keyboard 操作，並混用 emoji。

**修正要求**

- 獨立 Next Diagram View，資料取自現有結構化來源；Pipeline Flow 必須以 `pipeline-spec.js` 為單一真相。
- 提供 fit、zoom in/out、reset、Keyboard 可到達 node 與對應 detail panel。
- 所有 icon 經 registry；小螢幕允許 diagram canvas 內 pan，不允許整頁溢位。

### 5.15 個人設定

**現況問題**

- 所有 section 長列在單頁，缺 desktop 左側 section nav 與 mobile select。
- GitHub 只有移除，缺更新／重新連結與官方 PAT 說明。
- Odoo/eService 欄位與儲存邊界不足；密碼即時 validation、通知 denied 狀態待驗證。

**修正要求**

- Desktop 使用 sticky section nav，mobile 使用 section select。
- Account、Password、GitHub、External Connection 各自獨立 form 與 pending/error/success。
- Secret 欄位永不回顯；保留「已設定，留空不變更」語意。
- GitHub 提供 reconnect/update 與安全說明連結。
- Notification denied 顯示瀏覽器設定指引，不反覆要求 permission。

### 5.16 Admin 與子工具

**現況問題**

- Admin 首頁與多數子工具是 Legacy wrapper，畫面形成雙層 chrome、過長表單與深色欄位失效。
- 首頁缺狀態摘要與工具卡資訊架構；User table 缺原規格要求的 approved 狀態。

**修正要求**

- Admin root 改為摘要＋工具卡，不直接渲染所有設定表單。
- 每個子工具逐頁改成獨立 Next View；未改完不得標示 Next parity 完成。
- User 管理保留原站新增、編輯、啟用、角色、approved 等能力與權限限制。
- Secret 類設定只顯示 configured/not configured。
- Desktop table、mobile card、批次與 destructive confirm 都需獨立驗收。

### 5.17 使用者追加 UX 契約（2026-08-31）

本節將本次九項需求編成可追蹤的實作單位。實作者不得只改文字或 CSS 截圖，必須完成對應資料狀態與互動驗收。

#### NEXT-UX-001：Sidebar 專案只保留近期有 Chat 或我的最愛

- 「專案 Chat」不再列出所有有權限的專案；顯示集合固定為「依 Chat 最後互動時間排序的前 5 個不同專案」與「我的最愛專案」的聯集。
- 最近互動專案與我的最愛以 Project ID 去重；同一專案同時符合兩者時只顯示一次，仍保留最愛標記，不得因分組而產生兩列。
- 最愛專案即使沒有 Chat 仍顯示；非最愛且不在最近互動前 5 名者只從 Sidebar 隱藏，不影響 `/projects` 清單、deep link、權限或資料。
- 篩選必須由可批次取得的 metadata 完成；不得為每個專案各打一次 Chat API 造成 N+1。
- Loading、真正無符合專案、API error 必須分開；error 不得被當成「沒有近期 Chat」。
- 「最後互動時間」以該 Chat 最新一則訊息時間為準；尚無訊息的空 Chat 不計入最近互動，但其專案若為我的最愛仍照常顯示。

#### NEXT-UX-002：專案展開與「查看全部對話」

- 展開後 Chat 數量為 0：不顯示「查看全部對話」，也不得用可點擊的「尚無對話」冒充 Chat row；建立對話由既有「新對話」或專案 Chat Empty CTA 負責。
- Chat 數量大於 0：顯示最近 Chat 與「查看全部對話」。點擊後開啟該專案的完整對話歷程，至少能看到剛才 Sidebar 已列出的同一筆 Chat，不能進到空白主畫面。
- 完整清單須有 loading、empty、error、retry；刪除或建立 Chat 後 Sidebar 與完整清單一致更新。

#### NEXT-UX-003：舊／新對話一致與 Composer 永遠置底

- 從 Sidebar、完整歷程、重新整理或 deep link 打開舊 Chat，與剛建立的新 Chat 使用同一版型與操作。
- Composer 固定在 Chat viewport 最底部並有浮起層級；訊息區獨立捲動，底部 padding 至少等於 Composer 實際高度加 safe-area。
- 短對話、長對話、等待 AI、錯誤重試、手機虛擬鍵盤與 360px viewport 都不能讓 Composer 離開畫面或遮住最新訊息。

#### NEXT-UX-004：AskMe 式訊息閱讀與 Code Copy

- AI 內容採單欄、低邊框、以字體與留白建立層級的 AskMe 式閱讀；使用者訊息可保留 bubble，但不得讓 AI 長回答變成巢狀大卡片。
- Heading、list、quote、table、inline code、code block、link 與附件在深淺色都可讀；table/code 只在自身容器橫向捲動。
- 每個 code block 右上提供 Copy 與語言標籤；複製內容是原始 code，成功狀態可見且不只靠顏色，失敗提供可持續錯誤。
- 對話頁與任務詳情的「對話」頁籤共用同一 renderer 與 Copy 行為。

#### NEXT-UX-005：更多工具與帳號 Popover 可點外部關閉

- 點擊 Popover 以外任意可見區域會關閉；點擊內容內部不會因事件冒泡提早關閉。
- 開啟其中一個會關閉另一個；再次點 Trigger、Escape、route change、登出或關閉行動 Sidebar 也會關閉。
- 關閉後焦點回 Trigger，`aria-expanded` 與實際狀態一致。

#### NEXT-UX-006：移除任務頁首統計

- `/tasks` 的頁首統計卡／Summary 完整移除，桌機與手機都不保留空白高度。
- 搜尋、tab、filter、sort、建立任務與任務卡本身不受影響；原本統計 API 若沒有其他 consumer，實作時才評估移除請求，不得在本需求順手改後端統計語意。

#### NEXT-UX-007：首頁問答 Project combobox

- 參考 AskMe 的緊湊、兩層資訊選單，不直接照搬其資料夾或模型功能。
- Trigger 顯示目前專案；option 第一層顯示專案名稱與 Odoo 版本，第二層另列既有可取得的連線狀態，最少區分「測試環境」與「資料庫連線」。
- 連線狀態只能來自真實 API；未載入、未設定、已連線、錯誤需使用不同文字，不得以「—」把未知與未設定混為一談。
- 不顯示 Secret、帳密、Token 或完整 DSN。選取後仍保存最後成功使用的 Project，並更新 Composer context 與環境狀態。

#### NEXT-UX-008：Sidebar Usage 順序與內容

- Sidebar 自上而下為「更多工具」「帳號與設定」「Usage」；Usage 貼齊 Sidebar 最下方並納入 safe-area。
- Usage 只顯示 `Claude 5hr` 與 `Codex 5hr`，不混入週用量、專案 Token 花費或其他 Provider。
- 任一 Provider unavailable 時保留另一列；不可因 Claude 失敗而隱藏 Codex，反之亦然。Stale／無權限／API error 不得冒充 0%。
- 點擊整個 Usage 區塊進用量報表查看週用量；Keyboard 可操作並具 link 語意。

#### NEXT-UX-009：任務詳情三頁籤

- 頁籤固定為「需求內容」「對話」「執行歷程」，各自只有一個清楚的 H2／panel 起點；不得在三頁籤外再重複完整內容。
- 「對話」採 `NEXT-UX-003`、`NEXT-UX-004` 的 Thread／Composer，並承載九種 action mode；需要回答、審核或裁決時不能只藏在另一個永久側欄。
- 「執行歷程」保留時間、stage、狀態、技術 log、終端輸出與完整終端機入口；預設先顯示人可讀摘要，原始輸出按需展開。
- 頁籤寫入 `?tab=requirements|conversation|history`；無效值安全回預設頁籤，瀏覽器歷程可還原。
- 預設頁籤依共用的「需要使用者處理」判定：任務需要回答、審核、裁決或補充資料時進「對話」；其他狀態進「需求內容」。不得在頁面另列一份 status mapping，避免與 Sidebar／任務列表的 needs-action 判定漂移。
- 使用者仍可手動切換頁籤；已有合法 `tab` query 時尊重使用者選擇。任務在頁面開啟期間新轉為需要處理時，顯示明確提示並將首次自動焦點導向「對話」，不得每次即時更新都強制搶回頁籤。

### 5.18 已確認決策與安全邊界

1. `NEXT-UX-001` 已定案為最近互動的 5 個不同專案加上我的最愛，以 Project ID 取聯集並去重。
2. `NEXT-UX-009` 已定案為：需要使用者處理時預設「對話」，其餘預設「需求內容」。
3. `NEXT-UX-007` 的「資料庫連線」若一般使用者依現有權限無法讀取，不得為了顯示狀態放寬 Secret 或 DB API 權限；此時只顯示其可讀的測試環境狀態，或使用不含敏感資料的布林 metadata API。

---

## 6. 原站功能對應驗收矩陣

下表是「原站有什麼，Next UI 就要能做什麼」的最低驗收清單。第一輪只代表入口／顯示初查，不代表 mutation 已安全提交。

| 功能域 | 原站關鍵能力 | Next 第一輪狀態 | 修正／續查要求 |
|---|---|---|---|
| Login | 登入、註冊、外部認證 | 待查；仍用 Legacy | 建立獨立頁並跑匿名身分矩陣 |
| Home | 選專案、附件、開 Chat | 部分完成 | 真實 env、last project、附件與失敗重試 |
| Tasks | tab、filter、sort、建立、批次 | 阻斷 | Filter 白屏、URL state、完整 row/batch actions |
| Task Detail | 九種 action mode、歷程、附件 | 部分完成 | 完整模式與 pending/error/double-submit |
| Projects | 搜尋、最愛、新增、工具入口 | 部分完成 | env、三欄、More、CRUD 安全驗證 |
| Project Detail | Repo、Env、E2E、設定、Release | 顯示但語意錯誤 | env matrix、rollback、release overlay |
| Chat | CRUD、訊息、附件、建立任務 | 阻斷 | route reuse、empty CTA、舊／新版型一致、sticky Composer、Code Copy、Drawer |
| Wiki | Tree、Notes/Page CRUD | Legacy 包裝 | Next 獨立改寫、dirty guard、mobile Drawer |
| Terminal | 即時輸出、重連、歷史 | Legacy 包裝 | Next controller、單一 header、狀態語意 |
| DB | VPN、連線、probe、query | Legacy 包裝 | 功能 parity、secret、RWD、深色 |
| SOP | 七步與 Copy | 部分完成 | 去 Legacy methods、placeholder safety |
| Token | quota、filter、breakdown | 大致可顯示 | Sidebar 僅 Claude/Codex 5hr、週用量移至報表、順序、query、空值與 normalization |
| Pipeline | 即時區塊、對話入口 | 大致可顯示 | timestamp、visibility、error isolation |
| Diagrams | Architecture、Pipeline Flow | Legacy 包裝 | 獨立 canvas、控制、Keyboard |
| Settings | 帳號、密碼、GitHub、外部連線 | 部分完成 | 分區表單、validation、通知狀態 |
| Admin | 使用者、專案、系統工具 | Legacy 包裝 | 逐工具 parity 與 admin-only 驗收 |

任何一列仍為「Legacy 包裝」時，不能把 Next UI 宣告為完工。

---

## 7. RWD 與無障礙驗收契約

### 7.1 Viewport

固定測試 360x800、768x1024、1024x768、1440x900；必要時加 1536px desktop。

- 360：單欄、主要 CTA 可見、mobile sidebar/Drawer 可關閉。
- 768：不得卡在 desktop 與 mobile 之間造成雙欄過窄。
- 1024：表格、detail 8/4 與 sidebar 收合策略穩定。
- 1440：專案三欄；主要內容不因過寬降低可讀性。
- 全尺寸：`document.scrollWidth <= document.clientWidth`；例外只能是明確標記的 code/table/canvas 內部 scroller。
- 自動收集互動元素 rect，任何 element 不得落在 viewport 外或被 fixed layer 永久遮擋。

### 7.2 Keyboard 與焦點

- Tab 順序符合視覺順序；看得到焦點。
- Route change 後焦點移到頁面 H1 或主要內容起點。
- Command Palette 支援 ↑/↓、Home/End、Enter、Escape，並有分組「頁面／專案／最近對話」。
- 所有 Modal/Drawer focus trap、Escape、focus restore 完整。
- Skip link 可用。
- Card navigation 不以只有 mouse click 的 article 實作。

### 7.3 可讀性

- Color contrast 達 AA；焦點框不能只靠低對比色。
- Status 不只靠顏色，需同時有文字或 icon。
- Button、Field、Table header、icon-only action 都有 accessible name。
- Main landmark 不得巢狀另一個 `main`；每頁只有一個主要 landmark。

---

## 8. 測試修正規格

### 8.1 靜態 Gate

新增或改寫測試以阻止：

- Next tree 出現 `window.*View.data/computed/watch/methods/created`。
- Next route 使用 Legacy wrapper component。
- 未 scope 的 Next CSS selector。
- Unicode/emoji 作為操作圖示。
- 缺少 `requiresAdmin`／錯設全域 admin gate。
- 頁面自建狀態 label mapping。

### 8.2 Component／Unit Test

- Route params/query 改變會觸發 reset/load，舊請求不得覆蓋。
- Env state matrix 每一列的 label/action。
- 九種 task action mode 的 validation、pending、success、error。
- Composer create-chat/send-message 分段重試。
- Optimistic mutation failure rollback。
- Overlay open/close/focus restore 狀態機。
- Sidebar 專案 metadata 篩選、空 Chat 不顯示「查看全部」、有 Chat 的完整歷程一致性。
- Project combobox 的兩層資訊、Keyboard 與連線狀態矩陣。
- 任務三頁籤 query 還原，以及對話／技術事件不混流。
- Claude/Codex 5hr 正規化、單一 Provider 失敗與週用量不進 Sidebar。

### 8.3 Browser E2E

至少包含：

1. 一般使用者進 Next protected routes 不被踢回 Legacy。
2. `/tasks` 點 Filter、選條件、清除，不出現 Console/pageerror。
3. Chat 在兩個不同 project/chat route 間切換，標題與訊息同步。
4. 無 Chat 專案可從 Empty state 發起對話。
5. Command Palette、Release Modal、Wiki Modal、mobile sidebar 的焦點與 Escape。
6. 360px task detail 所有 action 均在 viewport 內。
7. 深色／淺色所有 route screenshot，DB/Admin input 不得硬白底。
8. Direct URL reload、上一頁／下一頁與 query 還原。
9. API 401/403/404/409/500、offline、Socket reconnect。
10. Double click 不得產生兩次 mutation。
11. Sidebar「更多工具／帳號」可由 outside click 關閉、互斥，並正確還原焦點。
12. 空／有 Chat 專案展開結果正確，「查看全部」開啟非空完整歷程。
13. 舊 Chat、新 Chat 與任務對話頁籤的 Composer 在 360／768／1440 viewport 置底且不遮訊息。
14. 任務列表首屏沒有統計區塊；任務詳情三頁籤可由 query、reload、back/forward 還原。
15. Sidebar 只出現 Claude/Codex 5hr，Usage 位於最下方，點入報表後才看到週用量。

E2E runner 必須監聽 `console.error`、`pageerror`、unhandled rejection；除明確 allowlist 外全部失敗。

### 8.4 Visual Regression

每個主要 route 建立 dark/light × viewport matrix。Screenshot 前需等待 loading 結束與字型穩定；差異需人工核准，不可自動更新 baseline 掩蓋錯誤。

---

## 9. 建議實作順序與 Gate

### Phase 0：阻斷修復

- NEXT-P0-001～006。
- 建立最小 browser regression suite。
- Gate：一般使用者可進、Filter 不白屏、Chat route 正確、手機 action 可達。

### Phase 1：共用基礎

- API adapters、status registry、icon registry、Overlay、page states、route lifecycle、theme scope。
- Gate：共用元件 a11y test 全綠，CSS/Legacy static gate 生效。

### Phase 2：Question、Chat、Task

- 完成最常用流程的獨立 View 與 mutation error handling。
- Gate：從首頁提問到 Chat，再建立 Task；九種 Task action mode 全測。

### Phase 3：Projects、Wiki、Terminal、DB、SOP

- 完成工作區與工具 parity，移除所有對應 Legacy wrapper。
- Gate：原站對應矩陣逐項簽核；env/release/db 以隔離環境驗證。

### Phase 4：Report、Pipeline、Settings、Diagrams、Admin

- 完成剩餘獨立 View、RWD、權限與 secret 規則。
- Gate：所有 route 無 Legacy View 依賴。

### Phase 5：最終 QA 與切換

- 全 viewport、dark/light、admin/user、happy/error path。
- 保留 `?ui=next` 灰度入口，先小範圍使用；未達 Gate 不取代 Legacy 預設入口。

---

## 10. 明日續查清單

以下項目尚未在第一輪安全、完整驗證。第二輪應依序補上並更新本文件版本為 1.0：

### 10.1 身分與權限

- [ ] 匿名、session expired、一般使用者、admin 四種身分 route matrix。
- [ ] Next Login 的登入、註冊、GitHub、Odoo、eService 實際顯示與錯誤。
- [ ] 一般使用者按鈕級權限是否與原站一致，不能只驗路由。
- [ ] 403、401 後的 focus、返回目標與錯誤文案。

### 10.2 尚未提交的 Mutation

- [ ] 建立／編輯／封存／解封／刪除 Task。
- [ ] 九種 Task action mode 的實際 request/response。
- [ ] Chat 建立、改名、刪除、訊息附件、建立任務 draft。
- [ ] Project 建立／編輯／刪除、favorite、repo branch probe。
- [ ] Env 建立／啟動／停止／重建、E2E、log。
- [ ] Release 正常、無項目、衝突、部分失敗。
- [ ] Wiki 建立／編輯／刪除與 unsaved guard。
- [ ] DB connection test/probe/query；只在隔離資料庫執行 SELECT。
- [ ] Settings save、password、GitHub reconnect、外部連線驗證。
- [ ] Admin 每一個子工具的 CRUD 與錯誤流程。

### 10.3 Route、錯誤與即時更新

- [ ] 所有 Next route direct reload、上一頁、下一頁。
- [ ] 每頁 API 401/403/404/409/500 與 timeout/offline。
- [ ] Socket 斷線、重連、重複事件與 route 離開後 unsubscribe。
- [ ] Pipeline polling 在 hidden/visible 間暫停與恢復。
- [ ] 慢請求 race condition 與 double click。

### 10.4 RWD、主題與無障礙

- [ ] 768、1024、1440 的全 route screenshot；第一輪只有部分 desktop 與 360。
- [ ] 深色／淺色完整矩陣，特別是 Legacy wrapper 尚存的 DB/Admin/Terminal。
- [ ] Keyboard-only 全流程、Screen reader landmark/name、Skip link。
- [ ] Modal/Drawer/Popover focus trap、Escape、focus restore。
- [ ] 長專案名、長檔名、長錯誤、空值、極大量資料。

### 10.5 自動測試與效能

- [ ] 量測目前完整測試輸出大小，超過 20,000 bytes 時依專案規則建立安靜模式。
- [ ] 跑現有 Next test 建立 baseline，記錄乾淨 HEAD 的既有紅燈。
- [ ] 新增 P0 regression 後確認測試在舊碼會紅、修正碼會綠。
- [ ] 檢查 Next assets 是否只在 Next 模式載入。
- [ ] Project env N+1、Chat 大量訊息、Task 大量卡片與 Admin 大表格效能。

### 10.6 定稿輸出

- [ ] 將每個「待查」更新為已通過或具體 issue。
- [ ] 為每個 issue 補 route、身分、viewport、重現步驟與預期結果。
- [ ] 補上 API 契約差異與必要的後端缺口；沒有證據不得擴大後端範圍。
- [ ] 產出最終 issue-to-test 對照與發布簽核表。

---

## 11. 本次實作進度（2026-08-31）

本節記錄已實際修改的範圍、已驗證的證據與仍存在的問題；未列為「已驗證」者，不得視為完成。

### 11.1 已完成實作，尚待完整 E2E 驗收

| 項目 | 對應規格 | 實作狀態 | 已有證據／限制 |
|---|---|---|---|
| Next 路由權限 | NEXT-P0-001 | 已移除全域 admin gate；登入使用者可進一般 Next 路由，僅 admin route 受 `requiresAdmin` 保護；新增 403 頁與登入後返回原 route。 | 尚未完成匿名、session expired、一般使用者與 admin 的完整 browser route matrix。 |
| Next asset 載入 | 4.5 | 已改為只有 `?ui=next` 時載入 Next CSS/JS。 | 尚未以 Network/完整 route matrix 驗證所有 Legacy 情境。 |
| 任務篩選白屏 | NEXT-P0-002 | 任務列表已改為獨立 Next component，篩選選項不再由 Vue template 直接讀取 `window.STATUS_LABELS`。 | 已有靜態回歸測試；尚未完成規格要求的 browser filter／URL query E2E。 |
| 任務列表狀態流程 | 5.4、NEXT-UX-006 | 已將卡片流程列改為獨立元件，並移除頁首四格 Summary；完成／錯誤改用 SVG registry。 | 靜態回歸已覆蓋；各狀態與響應式 browser 矩陣尚未完成。 |
| 任務新增與 More 操作 | 5.4、4.6 | 建立任務 Modal 已有 title、取消、可見 label、附件預覽／移除、焦點圈限、Escape、焦點回復及 inline error；卡片 More 提供封存、解除封存、永久刪除。 | 尚未在隔離資料完成全部 mutation、double-submit 與 mobile toolbar 驗收。 |
| Chat／專案／設定等頁面 | 4.1、5.3、5.7、5.15 | Chat、任務列表、專案列表、專案詳情與設定已改用 Next component；直接委派 Legacy View lifecycle/options/component wrapper 的模式已移除。 | 部分功能仍沿用從舊頁面搬入的 markup/class，尚未完成第 4.5 節所要求的視覺與 CSS 獨立；不可宣告 Next parity。 |
| 登入與註冊 | 5.1 | `/login` 在 Next 模式已改用 `UiNextLoginView`，自行處理首次設定、登入、註冊六步流程、返回目標與 pending/error。 | 已確認已登入進入 `/login` 會安全回到首頁；因不得登出使用者既有 session，匿名登入、註冊與各外部憑證驗證仍需隔離帳號驗收。 |
| 首頁問答 | 5.2、NEXT-UX-007 | 已補 project 記憶、附件限制／預覽、重試與 AskMe 式 combobox；新增安全 env summary API，option 顯示真實測試環境與資料庫連線狀態，不回傳 URL、port、log 或 Secret。 | 尚未在隔離資料或 mock 完整驗證 create-chat/send-message 的所有失敗分支。 |
| 行動版任務詳情 | NEXT-P0-005 | 已加入小螢幕單欄與 action panel 寬度限制 CSS。 | 尚未在 360px 實際 browser 驗收所有可互動元素 rect。 |
| Chat empty state／Drawer | NEXT-P0-004、NEXT-UX-002～004 | 無既有 Chat 的 Next 專案頁提供「開始新對話」CTA；完整清單有 loading/error retry、搜尋、新對話、刪除 More；新舊 Chat 共用 Thread、sticky Composer、Markdown／Code Copy。 | 建立、刪除與第一則訊息的隔離 mutation／360px 實機驗收尚未完成。 |
| Chat route lifecycle | NEXT-P0-003 | Chat component 在 `$route.fullPath` 變更時重新載入，並以 request id 忽略舊回應。 | 尚缺兩個有資料的專案／對話之間的實機慢回應 race-condition 測試。 |
| Sidebar／Usage／Popover | NEXT-UX-001、005、008 | Sidebar 僅列最近互動五個不同專案加上我的最愛；metadata API 不含訊息內容；More／帳號可點外部關閉、Escape、互斥與焦點回復；Usage 固定置底且僅顯示 Claude／Codex 5hr。 | 尚待完整 browser interaction 驗收。 |
| 專案卡 | 5.7 | 已移除底部說明／快捷區、空描述佔位與資料夾 icon；標題、版本與右上實心我的最愛同行。卡片 More 提供 DB、Deploy SOP、Release、管理與點外關閉。 | 尚待 browser RWD 與 Release mutation 驗收。 |
| 任務 URL 與 Keyboard | 5.4、7.2 | `tab/project/status/source/q/sort/release` 會同步至 query；任務標題改為 router link，卡片可用 Enter／Space 開啟，批次 checkbox 具任務名稱。 | 已於實頁載入 query、變更排序後確認網址同步；尚未完成全 filter matrix 與讀屏驗收。 |
| 任務 Filter 白屏 | NEXT-P0-002 | 實頁開啟篩選、呈現狀態／專案／來源選項後，任務清單仍保留且未出現 inline error；不再重現白屏。 | 尚未建立規格要求的自動 browser console/pageerror regression gate。 |
| Wiki 獨立生命週期 | 4.1、5.9 | `UiNextWikiView` 已改為自身的資料、route watcher、API request id、Socket progress 訂閱與 CRUD 方法；新增頁面 Modal 已補焦點圈限、Escape、回復焦點與 inline error。 | 有資料樹、dirty guard、CRUD mutation 與 mobile Drawer 仍待隔離資料驗收。 |
| 任務詳情獨立生命週期 | 4.1、5.5、NEXT-UX-009 | `UiNextTaskDetailView` 已內聚 data、route/socket lifecycle；需求／對話／執行歷程三頁籤同步 query；技術歷程改為摘要、分類、展開原始輸出與 retry；對話操作在單欄頁籤內。 | 九種 action mode 的隔離 mutation、RWD 與 error path 尚待驗收。 |
| Deploy SOP 獨立生命週期 | 4.1、5.11 | `UiNextDeploySopView` 已內聚專案／連線資料載入、七步指令產生、placeholder 與複製邏輯，不再委派 `window.DeploySopView`。 | 已在登入中的 project 23 實頁驗證七步顯示；未解析 placeholder 的 Copy disabled 與錯誤路徑尚待補齊。 |
| Terminal 獨立頁 | 4.1、5.6 | `/task/:id/terminal` 在 Next 模式已改用 `UiNextTerminalView`，獨立處理歷史事件、Socket output/done 與 xterm dispose。 | 已在登入中的 task 184 實頁驗證為單一 Next header；斷線／reconnect 與手機內部捲動待補 browser 驗收。 |
| DB 工具獨立生命週期 | 4.1、5.10 | `/projects/:id/db` 在 Next 模式已改用 `UiNextDbView`，內聚 VPN、連線 CRUD/test/probe 與 query 操作，不再經過通用 Legacy frame。 | 已在登入中的 project 23 實頁驗證單一頁首；各連線型態、query 與 mobile table/card 尚待隔離資料驗收。 |
| Admin 使用者工具 | 4.1、5.16 | `/admin/users` 在 Next 模式已改用 `UiNextAdminUsersView`，內聚使用者清單、角色、啟用與帳號操作。 | 已在登入中的 admin 實頁驗證單一頁首與現有使用者資料；CRUD mutation、手機 card 與 destructive confirm 尚待隔離驗收。 |

### 11.2 已驗證測試

- 最近一次目標測試指令：`cd app && npm test -- --runInBand --silent --noStackTrace --no-color server/tests/frontend-ui-next.test.js server/tests/frontend-markdown-xss.test.js server/tests/frontend-status-labels.test.js server/tests/chat-routes.test.js server/tests/env-routes.test.js`。
- 結果：**5 suites、283 tests 通過**（2026-08-31）。其中涵蓋 Next UI 靜態回歸、Markdown XSS、狀態標籤、Chat metadata API 與 env summary API。
- 此測試目前仍以靜態與 API 回歸為主，**不等同**第 8 節要求的 mount/browser E2E、console error、pageerror 或未處理 rejection 驗收。
- 完整測試套件尚未綠燈；已觀察到與本輪 UI 修改無直接關係的既有失敗（enterprise-sources、VPN gateway 暫存路徑、frontend toast 在非 browser 環境讀取 `window`）。在逐支重跑並確認前，不得將其標示為本次修正已通過或既有基線。

### 11.3 目前已知未解決／回歸問題

| 優先級 | 問題 | 已確認事實 | 下一步驗收條件 |
|---|---|---|---|
| 已修正待擴大驗收 | Sidebar 的「更多工具」底部裁切 | Next shell 高度已改為以 `--ui-zoom` 補償。登入中的本機 Next 專案頁重載後，按鈕 rect 為 798.3–839.0px、viewport 高度 911px；點開後選單 rect 為 562.1–797.2px，兩者皆完整可見。 | 尚待在任務頁及 360/768/1024/1440 viewport 重複驗收。 |
| P1 | 頁面底部可能仍遭裁切 | 除各獨立頁的 safe-area padding 外，`ui-next-main` 已統一加入 32px／safe-area 的 scroll 與 padding 保護；登入中的任務頁量測主內容為 `clientHeight 777px`、`scrollHeight 1416px`，底部 padding 為 32px。 | 尚待在 360/768/1024/1440 全頁逐一測量；每頁最後一個主要操作必須可見，且無非預期頁面級裁切或水平溢位。 |
| P1 | Next 獨立化尚未完成 | 直接委派 Legacy View lifecycle/options/component wrapper 的模式已移除；但部分搬入的功能仍沿用舊版 markup 與 class，尚未成為符合第 4.5 節的獨立 Next 視覺。 | 逐頁替換殘留舊 markup/class，並以功能 parity 與 RWD 證據驗收。 |
| P1 | 測試層級不足 | 現有 22 項測試仍以靜態回歸為主，未涵蓋規格要求的實際互動與 runtime error gate。 | 補 mount 與 browser E2E，舊碼可重現紅燈、修正後綠燈。 |

### 11.4 尚未開始或未完成的主要範圍

- `NEXT-UX-001`～`NEXT-UX-009` 已有部分實作：Sidebar 集合／Chat Drawer／Code Copy／Popover／任務 Summary 移除／首頁 combobox／Usage／三頁籤均已落地；其 browser、RWD、權限與 mutation 證據仍未完成，不得宣告整組驗收通過。
- NEXT-P0-003 Chat route 切換 race condition、NEXT-P0-004 無 Chat empty CTA 的完整實機驗收。
- NEXT-P0-006 規格要求的 selector parser、mount/browser interaction test 與 runtime error gate。
- Task Detail 九種 action mode、Wiki、Terminal、DB、SOP、Token、Pipeline、Settings、Diagram、Admin 的完整獨立頁與 parity。
- 第 7、8、10 節列出的 viewport、深淺色、Keyboard/focus、身分矩陣、mutation 隔離驗證與效能驗收。

### 11.5 換機續作交接

- 唯一規格文件：本檔 `OAA-UI-NEXT-CORRECTION-SPEC.md`。
- 目前工作樹修改集中於 `app/public/js/ui-next/UiNextApp.js`、`app/public/js/ui-next/UiNextPages.js`、`app/public/css/ui-next.css`、`app/public/css/ui-next-pages.css`、`app/server/chat-routes.js`、`app/server/env-routes.js` 與相對應 tests；不得覆蓋或還原其中變更。
- 下一優先：補 Next browser route／interaction matrix（含 console error、pageerror、unhandled rejection），再依第 10 節做隔離 mutation、RWD 與權限矩陣。既有 `app/rwd/capture.js` 有 runtime error gate，但目前基線路由不是 Next 專用，不能當作 Next 驗收證據。
- 已知測試環境注意：`project-routes.test.js` 曾在測試案例通過後嘗試連外部 PostgreSQL 而使 Jest 非零結束；此問題尚未建立乾淨 HEAD 基線，不得標記為本輪既有紅燈或修正完成。

## 12. Definition of Done

只有同時滿足以下條件，才可以宣告 Next UI 修正完成：

- P0、P1 全數關閉，P2 只有經明確核准的延期。
- 原站功能對應矩陣每列都有 Next 獨立 View 與通過證據。
- Next 程式中不存在 Legacy View data/method/lifecycle/DOM wrapper。
- admin/user、dark/light、360/768/1024/1440 的核心 E2E 全綠。
- 沒有未 allowlist 的 Console error、pageerror、unhandled rejection。
- Loading、Empty、Error、Success、Retry 與 double-submit 防護完整。
- Keyboard、focus、Dialog/Drawer、landmark 與 accessible name 驗收通過。
- Mutation 已在隔離環境或可靠 mock 驗證，不以正式資料試錯。
- `?ui=next` 灰度使用期間沒有 route 資料錯置、白屏或權限退化。

本文件 v0.10 是今日檢查點：P0、多數跨頁問題與 `NEXT-UX-001`～`NEXT-UX-009` 已具備追蹤規格，第 5.18 節產品決策已確認；接續依第 8 節補實作與驗收證據。第 10 節完成並回填證據後，才升版為最終 v1.0。
