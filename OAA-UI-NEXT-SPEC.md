# Odoo AI 自動開發平台 UI Next 規格書

- 產品名稱：Odoo AI 自動開發平台
- 品牌簡稱：OAA（Odoo × AI × Auto）
- 文件狀態：可交付開發
- 版本：1.0
- 日期：2026-08-28
- 主要語系：繁體中文（臺灣）

## 0. 規格的使用方式

本文件是新版前端的實作契約，不是視覺概念稿。工程實作以本規格、現有 API 契約及 `app/public/js/status-labels.js` 為準；舊 View 僅作功能盤點來源，不可當成新版 DOM 樣板。

參考來源：

- [AskME](https://askme.ideaxpress.biz/)：採用問答優先、單欄閱讀、收斂導覽與對話歷程的工作方式。公開未登入狀態僅可驗證其克制的單色、大留白、細邊框與雙區塊層級；本規格不宣稱已驗證其登入後內部細節。
- [GodUI](https://godui.design/) 與 [Components](https://godui.design/docs/components)：轉譯 Command Palette、Filter Bar、Dropdown、Drawer、Conversation Thread、Prompt Composer、Agent Timeline、Stepper、Tooltip、Toast 與 Card 的原則。GodUI 原件是 React／TypeScript／Tailwind／Motion，本專案是 Vue 3 Global Build／Vanilla CSS，因此只轉譯交互與視覺原則，不引入 React runtime。

## 1. 設計目標與非目標

### 1.1 目標

1. 登入後預設進入問答，使「提出問題／需求」成為主要工作起點。
2. 專案是 Chat、任務、Repo、測試環境、Wiki 與上正式的自然分組，不呈現成檔案總管。
3. 保留舊版除收件匣外的全部功能與權限，並以新的資訊層級重新實作。
4. 讓 Pipeline 狀態、人工介入、錯誤、額度與部署風險在正確時機清楚可見。
5. 以 `?ui=next` 實現可回退、可逐路由驗收、不污染舊版的平行介面。
6. 完整支援鍵盤、行動裝置、深色模式與 `prefers-reduced-motion`。

### 1.2 非目標

- 不重設 Pipeline 執行邏輯、權限、API 語意或資料庫 schema。
- 不把平台做成 CAD、節點編輯器、聲光展示網站或一般 SaaS 後台樣板。
- 不以更換顏色、在新殼內 mount 舊 View，或用 CSS 覆寫舊 DOM 當成完成。
- 不假造模型選擇、正式／測試目標切換、全站內容搜尋或非管理員額度 API。
- 不取消關鍵資料密度；「簡潔」是清楚分層，不是藏掉 Action。

### 1.3 可驗證成功條件

- 本文第 3 節所有 Next 路由皆可直接重整進入、返回、前進／後退，且保留 `?ui=next`。
- 第 7 節功能對照的每個 Action 皆有新位置、可用狀態與成功／失敗回饋。
- 新版 CSS 在拿掉 Next 根節點後對舊版 computed style 差異為 0；舊版資產不能選中 Next DOM。
- 360、768、1024、1440 px 四種寬度及淺／深色均無主操作遺失、不可讀或非必要橫向捲動。
- 任務所有 `actor: human` 狀態均在詳情右欄呈現唯一、可操作的主 Action。

## 2. 產品與視覺原則

1. **Question first**：首頁不顯示任務列表、捷徑牆或「你可以問」彩色卡。
2. **One reading column**：Chat 內容上限 840 px，長回答不被兩側欄切碎。
3. **Project as context**：專案選擇後，Chat、任務、Wiki、Repo 與環境連結必須維持同一 project context。
4. **Action follows status**：任務只有當前下一步的主操作可使用語意色；歷史資訊不和 Action 搖搖欲試。
5. **Depth, not decoration**：以背景／表面深淺、1 px 邊框、單層陰影、留白與字重建立層級；禁止漸層洗版、霓虹邊框與無功能 3D。
6. **Color is evidence**：品牌色只表選中／主 Action；綠黃紅藍只表成功、警告、失敗、處理中。
7. **Progressive disclosure**：對話歷程、高階篩選、技術 log、diff 與管理操作按需展開，但不可移除。

## 3. 資訊架構與路由

### 3.1 主導覽階層

```text
OAA
├─ 新對話
├─ 搜尋／Command palette
├─ 工作區
│  ├─ 問答
│  ├─ 任務列表
│  └─ 專案
├─ 專案 Chat（專案 → 對話）
└─ 底部
   ├─ Usage
   ├─ 更多工具
   │  ├─ 新手教學
   │  ├─ 進行中 Pipeline
   │  ├─ 用量報表
   │  ├─ 架構圖
   │  └─ 流程圖
   └─ 帳號選單
      ├─ 個人設定
      ├─ 深淺色切換
      ├─ 管理員（依權限）
      └─ 登出
```

收件匣不在 Next 導覽。「設定」只在帳號選單；「管理員」也只在帳號選單，不得在「更多工具」重複。

### 3.2 所有路由對照

| Path | Next 頁面 | 存取 | 主要入口 | 備註 |
|---|---|---|---|---|
| `/login` | 登入／註冊／初始連線 | 公開 | 未登入 | 保留現有登入、註冊、GitHub PAT、Odoo／eService 驗證流程 |
| `/` | 首頁／問答 | 登入 | 預設、新對話 | 不再是任務列表 |
| `/tasks` | 任務列表 | 登入 | Sidebar | 支援 route query `tab`, `project`, `status`, `q` |
| `/task/:id` | 任務詳情 | 登入 | 任務列／Chat 任務連結 | 主欄＋下一步側欄 |
| `/task/:id/terminal` | 終端機 | 登入 | 任務詳情 | 保留任務與 events |
| `/projects` | 專案列表 | 登入 | Sidebar | 卡片列表 |
| `/projects/:id` | 專案詳情 | 登入 | 專案卡／Sidebar 專案 | Tabs：總覽、Repo、測試環境、設定 |
| `/projects/:id/chat` | 專案 Chat 入口 | 登入 | 專案快捷入口 | 無 `chatId` 時顯示最近對話或空狀態 |
| `/projects/:id/chat/:chatId` | 專案對話 | 登入 | Sidebar 對話／歷程 Drawer | 單欄問答 |
| `/projects/:id/wiki` | Wiki | 登入 | 專案快捷入口 | 預設選首頁 |
| `/projects/:id/wiki/:slug` | Wiki 頁 | 登入 | Wiki 樹 | URL 可深連結 |
| `/projects/:id/db` | 資料庫查詢 | 登入 | 專案詳情 | 連線、VPN、SELECT 查詢 |
| `/projects/:id/deploy-sop` | 自動部署 SOP | 登入 | 專案詳情 | 環境對應與分步指令 |
| `/token-report` | 用量報表 | 管理員 | Usage／更多工具 | 現有 API 限 admin |
| `/settings` | 個人設定 | 登入 | 帳號選單 | 不在更多工具出現 |
| `/architecture` | 系統架構圖 | 登入 | 更多工具 | 與流程圖分離 |
| `/pipeline-flow` | Pipeline 流程圖 | 登入 | 更多工具 | 顯示泳道與節點說明 |
| `/admin` | 管理員總覽／平台設定 | admin | 帳號選單 | 系統連線、AI 訂閱、治理與工具入口 |
| `/admin/users` | 使用者管理 | admin | 管理員 | 搜尋、新增、核准、角色、刪除 |
| `/admin/agents` | Agent 管理 | admin | 管理員 | provider、model、effort、prompt |
| `/admin/schedules` | 排程 | admin | 管理員 | 週期、狀態、下次執行 |
| `/admin/pipelines` | 進行中 Pipeline | 登入；操作依權限 | 更多工具 | 任務與 AI 問答分區 |
| `/admin/health` | 工作流程健檢 | admin | 管理員 | 執行、裁決、修正流程、歷史 |
| `/admin/rejections` | 退回原因管理 | admin | 管理員 | 分頁、勾選、批次刪除 |
| `/admin/classify-samples` | 失敗分類樣本 | admin | 管理員 | 天數、分佈、高頻真因、樣本 |
| `/admin/prompt-logs` | Prompt 送出記錄 | admin | 管理員 | 最新筆數、重新整理、內容 |
| `/admin/port-pool` | 測試區 Port 池 | admin | 管理員 | 範圍、占用狀態、儲存 |
| `/admin/enterprise` | 企業版來源 | admin | 管理員 | Git／本機、版本、同步、更新、移除 |
| `/inbox` | 無 Next 日常頁 | 登入 | 無 | `?ui=next` 導向 `/tasks?tab=needs_action`；舊版仍可使用 |

## 4. App Shell 與導覽行為

### 4.1 Sidebar

- Desktop 寬 280 px，`position: fixed`，高 `100dvh`，內部三區：品牌／主導覽、可捲動專案 Chat、底部 Usage／工具／帳號。
- 品牌區顯示 OAA mark、「Odoo AI」與次行「自動開發平台」；點擊回首頁。
- 「新對話」是唯一充滿表面的側欄按鈕；導向 `/`，不在未選專案前預建空 Chat。
- 「搜尋」或 `Ctrl/Cmd+K` 開啟 Command Palette。
- 問答、任務列表、專案使用單色 icon；當前項用表面底、左側 3 px 品牌指示與 `aria-current="page"`。
- 任務 badge 顯示當前使用者的 human-action 數；專案 badge 顯示 Chat 未讀總數。`0` 不渲染。
- 專案 Chat 節點點文字直接換頁到專案；點 Chevron 只展開／收合。展開後最多顯示 5 筆最近對話，其餘由「查看全部對話」進 Chat 頁 Drawer。
- 展開狀態存 `oaa.next.sidebar.projects`，不共用舊版 key。
- Usage 顯示 Claude／Codex 可取得的額度條；值未回來時用 Skeleton，403 時不顯示數字，不以 0% 假裝。

### 4.2 Page Header／Topbar

- App 不再有一條重複全站導覽的 Topbar；每頁使用 `NextPageHeader`。
- 高度不固定，Desktop padding `28px 32px 20px`；內容為 Breadcrumb（詳情頁）、標題、一行描述、右側 1 個主 Action 與最多 2 個次 Action。
- 超過的 Action 收入 `MoreHorizontal` Dropdown；危險操作固定放最後並以 separator 隔開。
- 返回按鈕使用 `ArrowLeft`，文字要指明目的地，例「返回任務列表」；不只放箭頭。

### 4.3 Popover／Dropdown／Drawer／Modal

- Popover：關聯當前 trigger，點外、`Escape` 關閉，不鎖 body scroll；例帳號、更多工具、小型篩選。
- Dropdown：支援上下鍵、Home／End、Enter／Space，焦點循環不越出 menu；選擇後關閉並還焦點。
- Drawer：Chat 歷程 Desktop 從右側 380 px 進入；行動裝置為 92vw 全高右側 Drawer。開啟時鎖背景捲動、設 `aria-modal` 與 focus trap。
- Modal：只用於必須阻擋的建立、上正式、刪除確認。Desktop 寬 520–720 px，行動裝置貼底且上限 `calc(100dvh - 24px)`。
- 破壞性操作不可因點 overlay 關閉；如舊流程要求輸入專案名，Next 必須保留。

### 4.4 Command Palette

- 快捷鍵 `Ctrl+K` 與 `Cmd+K`；輸入框 autofocus，結果以「頁面」「專案」「最近對話」分組。
- 第一版只搜尋已載入的導覽項、專案與已取得的最近 Chat；不顯示「搜尋全部內容」假結果。
- 結果必須顯示 icon、主文字、上下文（專案名／頁面群組）與 Enter 提示。

## 5. 共用元件契約

| Component | 必要 props／狀態 | 行為 |
|---|---|---|
| `NextIcon` | `name`, `size=16`, `label?` | 統一 SVG icon registry；純裝飾 `aria-hidden` |
| `NextButton` | `variant`, `size`, `loading`, `disabled`, `icon` | loading 保留寬度、防重複送出；主 Action 每區最多一個 |
| `NextPageHeader` | `title`, `description`, `breadcrumbs`, `actions` | 響應式收斂 Action |
| `NextCard` | `interactive`, `selected`, `density` | 非交互 Card 不顯示 hover lift |
| `NextStatusChip` | `status` | 只從 `TASK_STATUSES` 取 label／actor，禁止 View 自建對照 |
| `NextQuotaBar` | `used`, `remaining`, `resetAt`, `unavailable` | 同時呈現數字＋顏色，不只靠顏色 |
| `NextFilterBar` | `primaryFilters`, `advancedFilters`, `activeCount` | 高階篩選收進 Popover／Drawer；已套用條件顯示 chip |
| `NextTabs` | `items`, `modelValue`, `counts?` | URL query 是真值；左右鍵切換，有 `role=tablist` |
| `NextDataTable` | `columns`, `rows`, `rowAction`, `selectable` | Desktop Table；行動裝置依欄位優先序轉 card rows |
| `NextEmptyState` | `icon`, `title`, `body`, `action?` | 只給一個下一步，無裝飾插圖 |
| `NextSkeleton` | `shape`, `count` | 形狀接近真實內容；加載中不閃白 |
| `NextErrorState` | `title`, `message`, `retry` | 錯誤留在原區塊；保留舊資料，不立即清空 |
| `NextComposer` | `text`, `files`, `project`, `sending`, `status` | auto-grow、paste image、attachment chips、send／stop 狀態 |
| `NextConversationThread` | `messages`, `pending`, `hasMore` | 長回答單欄、附件、AI 回覆狀態、智慧貼底 |
| `NextActionPanel` | `mode`, `task` | 根據任務狀態呈現下一步；不可用 generic slot 遺漏 Action |
| `NextToast` | `level`, `message`, `action?` | success 4s、info 6s；error 不自動消失或提供關閉 |

全站表單：Label 必須可點擊聚焦；錯誤放在 Field 下方並用 `aria-describedby`；送出失敗保留輸入；必填不只用紅色星號，並顯示「必填」文字或輔助說明。

## 6. 逐頁規格

### 6.0 全頁共通狀態

| 狀態 | 規格 |
|---|---|
| Initial loading | Page Header 可先顯示；主內容用 3–5 個符合真實排版的 Skeleton，不用單獨「載入中…」取代整頁 |
| Background refresh | 保留現有資料，只在重新整理按鈕或 live label 顯示 spinner，不重繪整頁 |
| Empty | 說明「為何是空的」與「下一步」；篩選無結果不顯示建立主 Action，改顯示清除篩選 |
| Recoverable error | 錯誤留在發生區，顯示重試；不清掉其他已成功區塊 |
| Permission denied | 顯示「權限不足」與返回上一層，不顯示假空狀態 |
| Not found | 顯示資源名稱／ID，提供返回對應列表 |
| Mutation pending | 只鎖定相關按鈕與 Field；按鈕改成動詞中狀態，不讓使用者重複送出 |
| Mutation success | 先更新本地狀態，再以 Toast 說明結果；有新資源時導向詳情 |
| Mutation failure | 回滾 optimistic state、保留輸入，錯誤文字不只放 console |

### 6.A 首頁／問答 `/`

**版面**

- 主區居中，寬度 760 px，視覺中心略高於畫面中線。
- 內容只有問候語、主標、一行說明、Composer 與鍵盤提示；Composer 下不放範例快捷按鈕。
- Composer 為一個有邊框、內外表面深淺、焦點 ring 與克制陰影的整體，不拆成一排狀態不一的框。

**Composer 欄位**

1. `prompt`：必填文字，placeholder 「描述你想釐清的問題或完成的 Odoo 工作…」；1–12 行 auto-grow。
2. `attachments`：圖片多選，支援檔案選擇與貼上截圖；以 filename chip 顯示、可個別移除。限制完全沿用 Chat API，前端不擅自放寬。
3. `projectId`：必選 Combobox，顯示專案名與 Odoo 版本；預選上次使用專案，沒有專案時 disable 送出並連到新增專案。
4. 讀取式環境資訊：「正式：不會因此對話直接上線」；「測試區：未建立／建立中／運行中／錯誤」，後者來自 `GET projects/:id/env`。不渲染可點的正式／測試 switch。
5. 送出：`Send` icon 圓形主按鈕；無專案或無文字且無附件時 disabled。`Ctrl/Cmd+Enter` 送出，Enter 換行。

**送出流程**

1. `POST projects/:projectId/chats` 建立 Chat，title 以首段去除多餘空白後截斷 28 字作為 deterministic title。
2. 有附件用 `postForm`，否則以 JSON `POST .../messages`。
3. 成功導向 `/projects/:id/chat/:chatId`；失敗保留 prompt、專案與附件。
4. 這個標題不是 AI 摘要；未來若要語意標題需後端能力。

### 6.B 專案 Chat `/projects/:id/chat[/:chatId]`

**版面與歷程**

- 整頁主區只有單欄 Conversation Thread；不保留傳統左側 Chat list。
- Thread 寬 840 px，頂部顯示專案名、自動標題、「對話歷程」、「建立任務」、有關聯任務時顯示「開啟任務 #ID」。
- 「對話歷程」開右側 Drawer，含新對話、搜尋已載入標題、未讀點、AI 回覆中、關聯任務與刪除 Dropdown。
- 切換 Chat 必須更新 URL、讀取 messages、標記已讀、更新 Sidebar badge；失敗不得把原 thread 清空。

**Message 視覺**

- User：右對齊的表面卡，最寬 72%；AI：左對齊、無大色塊，以 avatar／名稱、內容、時間分層。
- Markdown 支援段落、清單、Table、inline code、code block；code block 必須有語言與複製按鈕。
- 圖片使用 thumbnail，點擊開 lightbox；檔案顯示 filename、size（若 API 有）與下載。
- AI `reply_pending` 顯示 Agent status row：狀態點＋「AI 回覆中」＋經過時間；不用假 token streaming。
- 智慧貼底：使用者在底部 120 px 內才自動追新消息；正在看舊內容時顯示「回到最新」。

**Composer 與建任務**

- Composer sticky 於視口底部，顯示 Paperclip、textarea、attachment chips 與送出。支援 paste screenshot，保留 Enter 送出／Shift+Enter 換行的現有行為。
- 建立任務開 Modal：標題、需求內容、可選對話附件；成功後在 Header 與 Drawer 顯示任務連結，不隱藏或移除 Chat。

**空／Loading／錯誤**

- 專案無 Chat：「尚無對話」＋「開始新對話」。
- 選中 Chat 無 message：Thread 空態＋Composer，不再建第二個空白頁。
- message 載入：近底部 4 組對話 Skeleton；更早訊息載入顯示在頂部。
- AI 回覆輪詢失敗：保留 pending row，改顯示「無法更新，重試」；不自行宣告失敗。

### 6.C 任務列表 `/tasks`

**版面順序**

1. Page Header：標題＋「新增任務」主 Action；測試模式時才顯示「推進 Pipeline」。
2. 摘要指標 4 卡：需回覆、進行中、等待審核、失敗待確認；由當次已載入 tasks 依 `TASK_STATUSES.actor`計算，指標可點擊套用對應 Tab／status。
3. Tabs：需回覆、待處理、暫停中、全部、已封存；各自有數量。
4. Toolbar：專案、狀態、來源（Odoo／eService／手動）、是否上正式、搜尋、排序；admin 可切全部使用者與 owner。保留儲存／套用／刪除篩選組合。
5. 次 Action：批次模式、手動同步；批次模式開啟後顯示全選與底部 Floating Toolbar。
6. 任務列：Desktop 使用可點擊的 compact cards，每卡有標題、更新時間、來源、專案、owner（全體模式）、環境連結、status、暫停、上正式、module 與 Pipeline stepper。

**任務操作**

- 列層級保留暫停／恢復、封存、解封存、刪除；鼠標可見，鍵盤焦點時也必須顯示。
- 刪除、批次刪除必須確認；已核准任務依現有邏輯不顯示刪除。
- 新增任務 Modal：專案、標題、內容必填；附件選填最多 5 個，送出使用現有 `POST tasks` FormData。
- 批次操作保留暫停、封存、解封存、刪除；完成後顯示成功／失敗筆數，不只說「完成」。

**狀態**

- 處理中：藍色狀態點＋status label，必要時微幅 pulse；不讓整卡閃動。
- 等人：黃色左邊＋「需要你」；失敗：紅色左邊＋原因摘要（API 有時）；完成：綠色 chip，卡片不整片變綠。
- 列表 API 失敗顯示區塊錯誤與重試；不能誤顯示「沒有任務」。

### 6.D 任務詳情 `/task/:id`

**框架**

- Desktop 使用 12 欄：主欄 8、右側「下一步操作」4；gap 24 px。右欄 `position: sticky; top: 20px`，但不超過視口高度，內部可捲動。
- Page Header：返回列表、標題／`task_id`、status、暫停／恢復、測試機、admin 健檢、程式碼 zip（有 branch 時）；測試模式才有推進 Pipeline。
- 主欄順序：需求內容（只有 `new` 可編輯）、主附件、任務對話時間軸、執行紀錄。技術 log 預設折疊，錯誤 log 顯示行數與明確標籤。
- 資訊欄位：來源／source link、stage label、classification、是否有附件、module、建立／更新時間、server confirmed running。

**右欄 Action mode（不得簡化或合併掉功能）**

| Mode／狀態 | 必要 UI 與 Action | 現有端點 |
|---|---|---|
| `answer` / `confirm_pending`, `clarify_pending` | 「規格書 QA」／「提問」Tabs；選項、建議、costly 警示、必填驗證、附圖；送出後顯示 AI 確認中，不重現空表單 | `POST tasks/:id/answer`, `POST tasks/:id/clarify-ask` |
| 無結構問題的 `answer` | 單一回覆框、附件、「送出回覆並繼續」 | `POST tasks/:id/answer` |
| `spec_review` | 規格摘要、module、實作項 Accordion、驗收項、權限；意見框、「送出」、「確認沒問題，開始實作」 | `POST tasks/:id/spec-revise`, `POST tasks/:id/spec-approve` |
| `review` / `review_pending` | 終驗說明、diff 展開／截斷提示、退回原因、最多 5 附圖；「確認退回」與「審核通過」皆可見 | `GET tasks/:id/diff`, `POST tasks/:id/reject`, `POST tasks/:id/approve` |
| `conflict` / `merge_conflict` | 每檔顯示 repo／file、分類、原因、AI 建議；選擇 take theirs／take ours／manual；每檔可追問；舊任務 fallback 保留手動解決後繼續 | `POST tasks/:id/resolve-conflicts`, `POST tasks/:id/merge-clarify`, `POST tasks/:id/mark-conflict-resolved` |
| `cs_reply` / `cs_reply_pending` | 客服回覆草稿、追問／調整輸入、「送出」、「確認送出，結案」 | `POST tasks/:id/cs-followup`, `POST tasks/:id/cs-confirm` |
| `cs_data` / `cs_data_needed` | 逐題回答、全題必填、Enter 下一題／最後送出 | `POST tasks/:id/cs-data-submit` |
| `blocker` / `stopped` | 錯誤內容、依 blocker 類型的快捷方向、人工修正說明、「從中斷處繼續」 | `POST tasks/:id/resolve-blocker` |
| `archive` / `done` | 完成說明、「封存任務」 | `POST tasks/:id/archive` |
| `message` / 其他 | 一般留言、多附件、可用時顯示「同時回寫 Odoo 備註」 | `POST tasks/:id/messages` |

**執行紀錄與 Terminal**

- 只顯示最近事件並可向上載入更早；必須保留 ANSI 顏色的可讀轉換。
- 事件區 Header 顯示 loading／Live；空狀態「尚無執行紀錄」。
- 「開啟完整終端機」導向 `/task/:id/terminal`，不在詳情卡內嵌入一個不完整終端。

### 6.E 專案列表 `/projects`

- Header：「專案」＋搜尋＋「新增專案」。新增 Modal 保留名稱、Odoo 版本、英文資料夾名、Community／Enterprise、說明；資料夾名立即驗證 `[a-zA-Z0-9_-]`。
- 專案卡片 Desktop 2 欄，寬螢幕 3 欄，每卡顯示：專案名、說明、Odoo 版本、Community／Enterprise、Repo 數、未讀問答、資料夾名、環境狀態、最愛。
- `GET projects` 沒有環境狀態；首版僅對視口內卡片最多 4 個並行請求 `GET projects/:id/env`，捲出後不重複請求 30 秒。專案量大於 30 時必須先增加 summary batch API，禁止無界 N+1。
- 主卡點擊換頁到專案詳情；快捷入口是問答、測試區、Wiki、管理（專案詳情）。資料庫查詢、SOP、上正式收入 More Dropdown，功能仍在。
- 刪除專案僅 admin 可見，要求輸入專案名。無專案空狀態導向新增；搜尋無結果只提供清除搜尋。

### 6.F 專案詳情 `/projects/:id`

**Header 與快捷入口**

- Breadcrumb：專案／專案名；標題旁顯示 Odoo 版本與版本類型。
- 主 Action 為「問答」；次 Action 為 Wiki、測試區，More 含資料庫查詢、自動部署 SOP、初始化 Wiki、上正式。「上正式」需另有清楚的待上線 badge，不可假裝成任務層 Action。

**Tabs**

| Tab | 內容與 Action |
|---|---|
| 總覽 | 說明、Repo 總數／同步錯誤、環境狀態、未讀 Chat、E2E 狀態、來源對應摘要、待上正式摘要 |
| Repo | Repo label、URL、local path、主要標記、clone 狀態／錯誤、生效主分支、AI 分支；重新 clone、更新、移除、新增。新增時先 probe remote branches、預選預設分支、可選主要 Repo；建立後主分支只讀 |
| 測試環境 | `idle`／`setting_up`／`running`／`error`，built、port，external slot，addons drift，setup log，runtime log。保留一鍵建立／重啟、開啟測試區、關閉對外名額、停止、查 log、刪除、重新整理。`setting_up` 每 5 秒更新，不因一次請求失敗誤改 `idle` |
| 設定 | Odoo 專案名與 eService 回覆者名多值對應、E2E 啟用／停用、Community／Enterprise（admin）。明示更改版本類型需重建測試區 |

**上正式 Modal**

- 列出已核准但未 `released_at` 的任務、數量、影響 Repo；明示這是「專案層級，一次併入整條 ai-dev 到 main」。
- 無待上線任務時主按鈕 disabled；衝突失敗保留完整原因與處理指引，不宣告已上線。

### 6.G Pipeline `/admin/pipelines`

- Page Header 顯示「即時監控」、最後更新時間、Live 狀態點；每 3 秒更新。頁面 hidden 時停止輪詢，回到 visible 立即更新。
- 主區 2 欄：「執行中的任務」與「進行中的 AI 問答」；不混在同一 Table。
- 任務 row：status point，status label，標題，專案，使用者，耗時，查看，暫停。暫停需確認、只鎖當列。
- Chat row：AI 回覆中，標題，專案，使用者，等待時間，查看。不提供後端不存在的中止 Chat Action。
- 區塊各自有 Skeleton、空狀態與錯誤狀態；Chat API 失敗不影響任務區顯示。

### 6.H 用量報表 `/token-report`

**資訊順序**

1. 額度卡優先：Claude 5 小時／週額度、Codex 主要／次要額度，依 API 實際有值才顯示；同時顯示已用／剩餘與 reset time（有時）。
2. 篩選：今日／7 天／30 天／自訂、專案、任務 ID、全部使用者；查詢後保留在 route query，可複製 URL。
3. 摘要指標：實際花費、完成任務、每張交付成本、實際 Token；數字用 tabular nums。
4. 趨勢：日期軸＋Token／成本 toggle，至少 2 點才畫線；有 Tooltip與鍵盤 focus。
5. 分析：依專案、依 Agent、依使用者（API 有時）；不用彩虹 pie，改用單色比例條與數字排名。
6. 明細：任務／Chat、專案、使用者、成本、Token；展開後為 Agent、provider／model（有時）、Token、成本、耗時與來源連結。

額度語意：used 0–69% 綠、70–89% 黃、≥90% 紅。未取得與額度 0 必須是不同狀態。

### 6.I Wiki `/projects/:id/wiki[/:slug]`

- Header：返回專案、Wiki 標題、新增頁面，有條件時顯示建立／重新生成。
- Desktop 使用 280 px 樹狀導覽＋內容區；樹支援展開、當前頁、node type、重新生成與刪除。`troubleshooting` 依現有邏輯不顯示不可用 Action。
- 內容區有標題、閱讀／編輯狀態、Markdown textarea、儲存／取消。切頁前若有 unsaved changes 必須確認。
- Mobile 樹狀導覽改 Drawer；當前頁標題是 trigger。載入失敗顯示重試，不誤顯示「無頁面」。

### 6.J 自動部署 SOP `/projects/:id/deploy-sop`

- Header 返回專案；頂部先說明用途與需先建立資料庫連線。
- 「你的環境」使用正式／測試兩張同層 Card：連線、service、conf、addons path、port。兩邊選同連線時顯示 inline error。
- 共用欄位：Repo URL、addon、test branch、prod branch。
- 步驟使用垂直 Stepper：查現況、備份與 diff、掛 Git、runner／sudoers，deploy YAML，驗證。每步有說明、code block、Copy icon button 與複製成功 Toast。
- 指令中的 placeholder 必須明顯標記，禁止在未填完時呈現像可直接執行的假完整指令。

### 6.K 資料庫查詢 `/projects/:id/db`

- 分區：VPN 設定、連線清單、新增／編輯連線、只讀 SQL 查詢與結果。
- 保留 VPN 檔、帳號、密碼；SSH 主機／port／user／auth／key／password；DB engine／host／port／name／user／password；連線測試、probe log、儲存、刪除。
- Query editor 明示「只允許 SELECT」，結果 Table 支援橫向捲動、欄位名、總列數與錯誤區。不在前端假裝已做 SQL 安全驗證；真防線依後端。

### 6.L 架構圖 `/architecture` 與流程圖 `/pipeline-flow`

- 兩頁必須是獨立路由、獨立標題、獨立說明；不以同一圖靠 toggle 偽裝。
- 架構圖說明系統元件與連線；流程圖說明任務主線、人工介入、AI 旁支與可選 Git 泳道。
- 圖上節點點擊／鍵盤 Enter 開說明側板；支援 fit-to-view、縮放、重設。Mobile 允許圖區橫向捲動，不把字縮到不可讀。
- Pipeline 內容必須來自 `pipeline-spec.js`；status label 來自 `status-labels.js`。過渡態 `confirm_answered`、`clarify_answered`、`clarify_chat_running` 不必畫成節點，但需在說明中可追溯。

### 6.M 個人設定 `/settings`

- 左側分區導覽（Desktop）／頂部 Select（Mobile）：「帳號」「密碼」「外觀與通知」「GitHub」「Odoo」「eService」。
- 帳號：username 只讀、display name 可編輯。密碼：目前密碼、新密碼、確認、前端即時驗證。
- 外觀與通知：深淺色 switch、瀏覽器通知開關與測試通知。如瀏覽器拒絕，顯示說明而非繼續顯示開啟。
- GitHub：PAT configured state、更新、移除、建立 PAT 官方連結；不回顯 token。
- Odoo／eService：username、password（未更改可留空）、user id、驗證、儲存；各區實體分開。
- 這頁是個人整頁設定；帳號 Popover 只是入口，不在 Popover 重複表單。

### 6.N 終端機 `/task/:id/terminal`

- Header 顯示返回任務、任務標題、連線／中斷狀態。
- Terminal 使用 code surface、等寬字、保留 xterm 捲動與鍵盤；旁邊的事件資訊不混入終端輸出。
- 窄寬只讓 Terminal 區橫向捲動，不讓整頁捲動。斷線顯示 reconnect Action，不假裝仍為 live。

### 6.O 管理員 `/admin` 及子工具

**管理員首頁**

- 上半是系統狀態摘要，下半是工具卡片；不用一面無層級的超長表單。
- 設定分區必須保留：Odoo／eService 系統連線與同步間隔、Teams、用量閘門（5／7 小時百分比）、Claude 主／備援 token 與 fallback、Codex 訂閱 device login，Context7 key、CLI push user、測試模式、Odoo 備註回寫、embedding status／重建。
- 機密只顯示 configured／not configured 與最後更新（API 有時），不回顯原值。移除訂閱／token／key 是破壞性操作，要確認。

**子工具一致規格**

- 每頁用 `NextPageHeader`，Breadcrumb 回「管理員」；正文用 Card／Table／表單／空狀態，不只給舊 View 外包一層 Frame。
- 使用者：使用者數、搜尋、username／display name／role／approved，核准、角色切換、刪除，新增使用者表單。
- Agent：左側 Agent list，右側 provider／model／effort／prompt editor，dirty state、儲存與錯誤。
- 排程：name、cadence、last run、next run、status，重新整理。
- 健檢：cadence／increment days、開始、即時狀態，finding 分類、證據／診斷／suggested prompt、裁決與理由，fix 產生、diff、adopt／push／merge／reject，候選訊號與歷史。
- 退回原因：總數、勾選／全選／批次刪除，9 欄資料，分頁。
- 失敗分類樣本：區間天數，判定分佈，高頻真因，最新 50 筆。
- Prompt 記錄：筆數／重新整理，時間、任務／Chat、Agent／model，prompt 內容；長內容折疊且可複製。
- Port 池：min／max 驗證，slot 占用狀態，儲存。
- 企業版來源：Git／Local、Odoo major、URL／branch 或 local path，clone／sync status、error，last sync，新增／編輯／同步／移除。

## 7. 原有功能保留對照

| 舊功能 | Next 位置／操作 | 驗收點 |
|---|---|---|
| 任務列表是首頁 | `/tasks` 獨立路由 | `/` 不出現任務；Sidebar 可一步進任務 |
| 新增任務＋附件 | 任務 Header 主 Action → Modal | 專案／標題／內容必填、最多 5 附件、成功重載 |
| 需回覆／待處理／暫停／全部／封存 | 任務 Tabs | 計數、篩選、URL query 一致 |
| admin 全部使用者 | 進階篩選中 owner scope | 不影響 Sidebar 「輪到你」數字 |
| 專案／狀態／來源／上正式／搜尋／排序 | `NextFilterBar` | 套用、清除、儲存組合與跨裝置 settings API 均保留 |
| 批次暫停／封存／解封存／刪除 | 批次模式＋Floating Toolbar | 全選、數量、確認、部分失敗可見 |
| 手動同步／測試推進 | 任務 Header 次 Action | 依現有權限／測試模式顯示 |
| 任務暫停、封存、刪除 | 列層 Dropdown／快捷 Action | 舊權限與已核准不可刪邏輯不變 |
| Pipeline stepper | 每張任務卡底部 | 來自單一 status registry，E2E 停用時步驟正確 |
| 任務需求編輯 | 詳情主欄，僅 `new` | 儲存失敗保留編輯內容 |
| 任務附件／下載 | 需求卡／時間軸 | filename、size、權限 token 下載 |
| 任務留言／附件／Odoo 回寫 | 右欄 message mode | 可用條件與 checkbox 預設不勾保留 |
| 分析補問／反問 | answer mode 兩 Tabs | 選項、建議、必填、附圖、AI 處理中均保留 |
| 規格審核 | spec review mode | 摘要、module、requirements、acceptance、permissions、修改與核准 |
| 人工審核／diff／退回附圖 | review mode | diff 截斷提示、退回與通過並列可見 |
| 衝突逐檔裁決／AI 追問／手解 fallback | conflict mode | 每檔三選一、建議、QA、後續三條 API 均可操作 |
| 客服回覆、追問、結案 | cs reply mode | 草稿、追問、確認送出 |
| 客服補資料 | cs data mode | 逐題必填、Enter 導覽、送出重分析 |
| Blocker 處理 | blocker mode | blocker content、快捷方向、自訂修正、重試 |
| 即時 events／完整終端 | 詳情執行紀錄／`/terminal` | 分頁、ANSI、Live update、返回 |
| admin 健檢任務／程式碼 zip | 任務 Header More | 依 admin／branch 條件顯示 |
| Chat 新建／刪除／自動標題 | Chat Header／History Drawer | 標題、URL、刪除確認均保留 |
| Chat 未讀／AI 回覆中 | Sidebar、Drawer、Thread status | 讀取後 badge 當場更新 |
| Chat 圖片選擇／貼圖／下載 | Composer／message | 物件 URL 在 unmount 釋放 |
| Chat 轉任務／任務連結 | Header Modal／Task chip | 可選附件、成功後可開任務 |
| 專案新增／搜尋／最愛／刪除 | `/projects` | 最愛樂觀更新失敗回滾；刪除輸入名稱 |
| 專案 Chat／測試區／上正式／DB／Wiki／SOP | 卡片快捷入口／More | 每個舊 Action 至少一步可達 |
| Repo 新增／probe branch／clone／更新／移除 | 專案 Repo Tab | 主分支建立後只讀；環境使用中阻擋移除 |
| 來源對應／E2E／版本類型 | 專案設定 Tab | 儲存失敗 switch 回滾；Enterprise 提示需重建 |
| 環境建立／啟動／停止／對外釋放／log／刪除 | 測試環境 Tab | 所有狀態、addons drift、setup log、runtime log 保留 |
| Wiki 樹、新增、編輯、儲存、重生、刪除 | Wiki Next page | 編輯未存的切頁阻擋保留 |
| DB 連線／VPN／SELECT | DB Next page | 全欄位、測試、probe log、查詢、刪除均可用 |
| SOP 環境對應／指令／複製 | SOP Next page | 六步指令與 placeholder 完整 |
| Pipeline 即時任務／Chat／暫停／查看 | Pipeline Next page | 區塊錯誤隔離、3s 更新 |
| 用量篩選／摘要／趨勢／分析／明細 | Token report Next page | Claude／Codex 額度卡第一；明細可展開與回來源 |
| 架構圖／流程圖 | 兩個獨立入口與頁面 | 內容不互換、URL 不同 |
| 個人設定全部分區 | `/settings` | 帳號、密碼、通知、GitHub、Odoo、eService 均可使用 |
| 管理員首頁與 10 個子工具 | `/admin*` | 本規格 6.O 每個欄位與 Action 不得缺少 |
| 新手教學 | 更多工具 | 可啟動現有 Tour，Next 的 target 需另建對應 |
| 收件匣 | Next 不保留 | 導覽無入口；直連改導任務需回覆；Legacy 不受影響 |

## 8. 色彩、層級與狀態規則

### 8.1 設計 Token

Next 只能使用 `--next-*` token，不在 Component 內寫色碼。下列為預設值；品牌調整只改 token。

| Token | Light | Dark | 用途 |
|---|---|---|---|
| `--next-bg` | `#F4F4F5` | `#111113` | App 底色 |
| `--next-surface-1` | `#FFFFFF` | `#18181B` | Card、Composer、Modal |
| `--next-surface-2` | `#FAFAFA` | `#202024` | hover、Table header、巢狀區 |
| `--next-surface-3` | `#F0F0F2` | `#29292E` | selected／pressed |
| `--next-text-1` | `#18181B` | `#F4F4F5` | 主文字 |
| `--next-text-2` | `#52525B` | `#C4C4CC` | 次文字 |
| `--next-text-3` | `#71717A` | `#9898A3` | metadata／placeholder，必須過 AA |
| `--next-border` | `#E4E4E7` | `#303036` | 普通邊框 |
| `--next-border-strong` | `#D4D4D8` | `#45454D` | Field／focus 前邊框 |
| `--next-brand` | `#714B67` | `#C5A3BB` | OAA 選中、主 Action、focus |
| `--next-info` | `#2563EB` | `#60A5FA` | 執行中／資訊 |
| `--next-success` | `#15803D` | `#4ADE80` | 成功／完成／健康額度 |
| `--next-warning` | `#B45309` | `#FBBF24` | 等人／暫停／額度警告 |
| `--next-danger` | `#B91C1C` | `#F87171` | 失敗／破壞性／額度危急 |

間距使用 4 px 基數：4、8、12、16、24、32、48；圓角 8（Field／Button）、12（Card）、16（Modal／Composer）、999（Chip）。陰影只有 `sm` 與 `lg`：Card 用 sm，Popover／Drawer／Modal 用 lg；不疊多層光暈。

### 8.2 任務狀態色

- `actor: agent` 與正在執行的 `system`：info。
- `actor: human`：warning；`merge_conflict` 可加 danger icon，但主 chip 仍表「等待人工」。
- `stopped`：danger。`done`：success。`is_paused`：warning。尚未執行的 neutral 階段用灰階。
- 元件必須同時有文字／icon／形狀；不允許只看紅綠判定。
- 圖表不以每個 Agent 一色；使用單色深淺、排名與數值。

## 9. Icon 使用規則

- 使用 Lucide 語意與線性 SVG 系統；在現有無 build 流程下建立 `NextIcon` SVG path registry 或版本固定的本地 sprite，不從 CDN 臨時載入。
- 預設 16 px、導覽 18 px、狀態 14 px，stroke 1.75–2。Icon button 點擊區至少 36×36 px，行動裝置 44×44 px。
- 正式 UI 禁止以 `←`、`↑`、`✕`、`◆`、`🚀`、`🧪`、`📎` 等 Unicode 當 icon。程式碼／log／使用者內容中的文字不在此限。
- 必要對照：新對話 `Plus`、搜尋 `Search`、問答 `MessageSquare`、任務 `ListChecks`、專案 `Boxes`、附件 `Paperclip`、送出 `ArrowUp`、歷程 `History`、建任務 `SquareCheckBig`、暫停 `Pause`、恢復 `Play`、封存 `Archive`、刪除 `Trash2`、同步 `RefreshCw`、測試區 `FlaskConical`、上正式 `Rocket`、Wiki `BookOpen`、DB `Database`、SOP `ListOrdered`、架構 `Network`、流程 `Workflow`、用量 `ChartNoAxesCombined`、設定 `Settings`、帳號 `CircleUserRound`、更多 `MoreHorizontal`。
- 只有 icon 的按鈕必須有 `aria-label`；Desktop hover／focus 顯示 Tooltip，簡短明確如「附加圖片」，不重複顯示相同文字。

## 10. 響應式規則

| 斷點 | Shell | 內容規則 |
|---|---|---|
| `≥1440` | Sidebar 280 px | 主內容上限 1280 px；專案卡可 3 欄；任務詳情 8／4 |
| `1200–1439` | Sidebar 264 px | 主內容上限 1180 px；專案 2 欄；任務詳情 8／4 |
| `768–1199` | 收斂 Sidebar 72 px，只顯 icon；專案 Chat 改 Drawer | Header Action 收 More；任務詳情改單欄，「下一步」排在需求摘要後、時間軸前 |
| `<768` | Sidebar 隱藏，左上 Menu 開全高 Drawer | 內容 padding 16 px；卡片單欄；表單單欄；底部主 Action 可 sticky |

- 360 px 是最小驗收寬度。必要橫捲僅允許 code、Terminal、diagram 與高欄位 Table 的內層容器。
- Chat Thread 在行動裝置不畫左右大氣泡；User message 最寬 88%，AI message 寬 100%，Composer 跟隨 visual viewport 避免鍵盤遮住。
- Table 轉 card row 時依欄位 priority：標題／狀態／主數值永遠顯示；metadata 收合；Action 收 Dropdown。不得直接 `display:none` 刪功能。
- Touch 不依賴 hover；所有 hover Action 在 focus-within 與 touch 版皆可達。

## 11. 深色模式

- 主題根節點為 `[data-ui="next"][data-theme="dark"]`；初始值依帳號設定，其次依 `prefers-color-scheme`，切換後使用現有 settings API 儲存。
- 深色不是簡單 invert。背景比 Card 深，Popover／Modal 比 Card 稍淺；邊框需比 Light 略明顯，陰影降低並以邊框建層級。
- 不得在 inline style 寫死淺色背景／文字。code／Terminal 使用專屬 code tokens；圖表 grid、axis、Tooltip 也必須 tokenized。
- semantic 色在深色用較亮 foreground，背景用 12–16% alpha mix，不用大面積高飽和底色。
- 焦點 ring 在兩模式必須清楚；所有文字至少 WCAG AA，主文字 4.5:1，大字 3:1。

## 12. `?ui=next` 平行運作與污染隔離

### 12.1 Bootstrap 與 Router

1. 伺服器仍回同一 `index.html`；bootstrap 在建立 Vue app 前以 `new URLSearchParams(location.search).get('ui') === 'next'` 決定模式，該值在本次 page lifecycle 不可變。
2. 使用共用 `route-manifest.js` 宣告 path、auth、admin 與語意 ID；`legacyRoutes()` 與 `nextRoutes()` 各自對應 Component，不在單一 route 內混合 Legacy／Next template。
3. Next 使用所有現有 path，URL 形式為 `/?ui=next#/tasks`。Vue Router 內導覽不改 `location.search`；需全頁導向時使用共用 `buildUiUrl(path, mode)`。
4. 切換舊／新版是全頁 reload；不在同一 Vue tree 執行 hot swap。
5. 權限守衛只依 route meta。Next 正式上線時不得以一個全域守衛將所有非 admin 改回 Legacy；僅 admin route 保留 admin 限制。
6. `/inbox` 是唯一特例：Next router redirect 到 `/tasks?tab=needs_action`；Legacy router 保留舊 View。

### 12.2 Asset 與 CSS 隔離

- 建議結構：

```text
app/public/js/ui-next/
├─ bootstrap.js
├─ NextApp.js
├─ next-routes.js
├─ store/
├─ components/
├─ pages/
└─ adapters/
app/public/css/ui-next/
├─ tokens.css
├─ shell.css
├─ components.css
└─ pages.css
```

- Next CSS 只在 Next 模式動態加載，且每個 selector 必須以 `[data-ui="next"]` 起始。禁止無 scope 的 `body`、`button`、`.btn`、`.task-card` 等 selector。
- Next 類名用 `next-*`，token 用 `--next-*`，z-index 用 `--next-z-*`。Legacy CSS 必須對 Next 根節點無效；必要時在 Next reset 內以明確的 root scope 正規化，不回頭改 Legacy 全域規則。
- Modal／Popover／Toast portal 必須 mount 在 Next root 內的 `next-overlay-root`，不插到無 scope 的 body child。

### 12.3 Component、Function 與狀態隔離

- Next page 禁止 render Legacy Component，禁止 `methods: window.LegacyView.methods`、spread Legacy View 或依 Legacy class 排版。可重用 `Api`、`SocketManager` 傳輸層、Markdown renderer、status registry、對話附件 helper 與抽出的 pure Function。
- 要共用舊 View 方法時，先把不依賴 `this`／DOM 的資料操作抽到 `controllers` 或 `adapters`，為 Legacy 與 Next 各寫薄連接層；不得為了共用而改變 API 時序。
- Next store 只暴露在 `window.OaaNext`（或 module closure），不使用 `window.needsActionCount` 等舊版 mutable ref。Auth token、當前使用者、theme 是明確允許的共用基礎狀態。
- localStorage 只用 `oaa.next.*`；舊有帳號 theme 偏好仍以伺服器 settings 為真值。任務篩選與 Sidebar 展開不得寫舊版 key。
- Socket 使用共用 connection broker，Legacy／Next 各自訂閱 adapter；page unmount 必須 unsubscribe，不允許同一事件觸發兩套 refresh callback。

### 12.4 必要自動守衛

1. Route parity test：除 `/inbox` 外 Legacy 受保護 path 皆有 Next Component，auth／admin meta 一致。
2. CSS scope test：掃描 Next CSS 全樹，每個 selector 的第一個 compound selector 必須含 `[data-ui="next"]`；keyframes／`@font-face` 另以 allowlist。
3. No legacy DOM test：Next `pages/` 不可引用／spread `window.*View`，不得出現舊版主要 class allowlist。
4. Unicode icon test：掃描 Next template 的 button／link／status 文字，擋常見箭頭、符號、emoji icon；使用者內容區排除。
5. Status coverage test：`TASK_STATUSES` 全部 key 在 `NextStatusChip`可渲染；所有 human actor 有 task action mode 或明確 fallback。
6. Action contract test：第 7 節每個 mutation endpoint 在 Next controller 有可觸發入口、pending、success、error test。
7. Isolation browser test：同一 commit 分別開啟無 query 與 `?ui=next`，驗證路由、theme、modal、socket，localStorage 及 computed style 不互相污染。

## 13. 目前沒有後端能力，不可假造

| 項目 | 目前事實 | Next 第一版處置 | 後續討論／所需能力 |
|---|---|---|---|
| Chat 模型選擇 | Chat create／message 不接受 model／provider；模型是 Agent 管理設定 | Composer 不放 model picker，也不寫死一個模型名假裝可選 | 需定義 Chat-level provider／model 權限、儲存欄位、記帳、fallback 與歷史一致性 |
| 正式／測試目標切換 | Chat 無 target environment；對話不會直接上正式，正式上線是專案層 Release | 只顯示讀取式說明與測試環境狀態，不渲染 switch／segmented control | 先定義「目標」是 AI 資料來源、實作目標、驗證環境還是部署目標；四者不可用一個 toggle 混為一談 |
| AI 語意自動標題 | 現有流程是前端以第一則內容截斷作標題 | 繼續使用 deterministic title，文案不宣稱是 AI 摘要 | 需非阻擋 title generation job、更名 API／事件與使用者手動更名權限 |
| 全站內容搜尋 | 目前無一個橫跨 tasks／chats／wiki 的搜尋 API | Command Palette 只搜導覽、專案、已取得最近 Chat；標題要求是「快速切換」而非「全站搜尋」 | 需權限過濾、全文索引、結果類型、snippet、分頁與排名 |
| 專案列表批次環境摘要 | `GET projects` 不回 env status | 只對視口卡使用現有 per-project env API，有並行與 TTL 上限 | 專案大量時新增 `GET projects/summary` 或在 list 安全 join 非機密環境欄位 |
| 非管理員 Claude／Codex 額度 | 現有 usage endpoints 與 token report 依管理員權限 | 非 admin 不顯示數字額度卡與報表入口，不把 403 當 0 | 需產品決定是全體可見、個人可見或僅 admin，再調整 API 權限與資料範圍 |
| 真實 token streaming／中止 Chat | 現有 Chat 以 `reply_pending` 與輪詢得到完整回覆，沒有 stream／cancel API | 顯示「AI 回覆中」，不假 token 流、不放 Stop 按鈕 | 需 SSE／WebSocket delta protocol、message id、cancel semantics、部分回覆儲存與重連 |
| 正式環境即時健康狀態 | 現有專案有 DB 連線／SOP／Release，但沒有統一 prod health API | 不顯示假的「正式正常」綠點；只說明 Release 語意 | 需定義健康檢查源、秘密、逾時、緩存、對使用者可見的錯誤細節 |

### 13.1 模型／正式測試切換後續討論原則

1. 模型選擇與環境選擇是兩個不同控制，不得擠在一個「模式」Dropdown。
2. 選定 model 後必須定義是僅當前 message、當前 Chat 還是整專案，以及歷史 Chat 再開時如何處理已停用模型。
3. 「測試」不能意味「AI 可以自動改測試資料」；「正式」不能意味「發送 Chat 即上線」。先定義可讀資料源、可寫目標與 Release 門檻。
4. 只要後端契約未完成，UI 就不渲染 disabled 的假控制；改以讀取式資訊說明。

## 14. 驗收清單

### 14.1 全域與外殼

- [ ] 無 `?ui=next` 時 Legacy 首頁、路由、CSS、狀態與 localStorage 行為與基準相同。
- [ ] 有 `?ui=next` 時 mount Next root，直接重整任一 hash route 不丟 mode。
- [ ] Next 正式頁無 Legacy View／DOM 嵌入、無 Legacy class 依賴。
- [ ] Next CSS 全數 scope；Legacy／Next computed-style isolation test 通過。
- [ ] 所有新版 icon 來自同一 SVG registry，無 Unicode 正式 icon。
- [ ] Sidebar 導覽、專案展開、Usage、更多工具、帳號選單均符合第 4 節；收件匣／設定／管理員無重複入口。
- [ ] Command Palette 鍵盤完整可用，且不宣稱有全站內容搜尋。
- [ ] Popover／Dropdown／Drawer／Modal 有 Escape、focus trap（需要時）、焦點還原與點外規則。

### 14.2 逐路由

- [ ] `/login`：登入、註冊、初始 GitHub／Odoo／eService 設定可完成，錯誤不清表單。
- [ ] `/`：不有任務列表；專案、圖片選擇／貼上、環境讀取資訊、建 Chat、自動標題、送 message、導頁均通過。
- [ ] `/projects/:id/chat[/:chatId]`：新對話、對話 Drawer、切換、刪除、未讀、AI pending、Markdown、附圖／貼圖／下載、轉任務、任務連結通過。
- [ ] `/tasks`：摘要、5 Tabs、全篩選、儲存組合、搜尋、排序、admin owner scope、新增／附件、同步、暫停、封存、解封存、刪除、批次、Pipeline stepper 通過。
- [ ] `/task/:id`：需求／編輯、附件、時間軸、事件、暫停、測試機、健檢、zip，及第 6.D 九種 Action mode 的正向、失敗、重複點擊防護均通過。
- [ ] `/task/:id/terminal`：資料載入、連線狀態、ANSI、捲動、重連與返回通過。
- [ ] `/projects`：新增驗證、搜尋、卡片全欄位、環境摘要、快捷入口、最愛、admin 刪除、空／錯誤通過。
- [ ] `/projects/:id`：總覽、Repo、測試環境、設定 Tabs 及第 6.F 所有 Action 通過；Release Modal 能分清核准與上線。
- [ ] `/projects/:id/wiki[/:slug]`：樹、深連結、閱讀／編輯、未存阻擋、新增、儲存、刪除、重生、空／錯誤通過。
- [ ] `/projects/:id/db`：VPN、連線 CRUD／測試／probe log、SELECT 與結果通過。
- [ ] `/projects/:id/deploy-sop`：環境對應、相同連線錯誤、六步指令、複製、placeholder 提示通過。
- [ ] `/admin/pipelines`：任務／Chat 區隔離、即時更新、耗時、專案／使用者、查看、暫停、區塊錯誤通過。
- [ ] `/token-report`：Claude／Codex 額度關聯閾值、日期／專案／任務／使用者篩選、摘要、趨勢、專案／Agent／使用者、展開明細、來源連結通過。
- [ ] `/architecture` 與 `/pipeline-flow`：兩頁內容、入口、標題不同；縮放／fit／節點說明／鍵盤與 Mobile 捲動通過。
- [ ] `/settings`：帳號、密碼、主題、通知，GitHub、Odoo、eService 各自儲存／驗證／錯誤通過。
- [ ] `/admin` 及所有子路由：第 6.O 與第 7 節所列資料、篩選、編輯、破壞性確認、空／Loading／Error 皆通過。
- [ ] `?ui=next#/inbox` 導向任務需回覆；Legacy `/inbox` 不受影響。

### 14.3 狀態、無障礙、RWD 與深色

- [ ] 每頁 Initial loading、Background refresh、Empty、Recoverable error、403、404、mutation pending／success／failure 均有可重現測試。
- [ ] 所有交互可以只用鍵盤完成；焦點順序合理，焦點樣式清楚，Drawer／Modal 關閉後回到 trigger。
- [ ] 狀態不只靠顏色；文字、icon、形狀與 `aria-live` 在需要時完整。
- [ ] 360、768、1024、1440 px 於 Light／Dark 均執行逐路由 screenshot＋關鍵交互驗收。
- [ ] 任務詳情所有 Action 在 360 px 均可達；Table 轉 card 後無欄位與 Action 被 `display:none`。
- [ ] `prefers-reduced-motion: reduce` 停止非必要動畫；一般動畫 120–200 ms，只用 transform／opacity，無背景游動與裝飾性無限動畫。

## 15. 建議實作順序與 Definition of Done

1. 先完成 Next bootstrap、route manifest、token、Shell、Icon、overlay、Button／Field／Card／Table／狀態元件與隔離測試。
2. 完成首頁／Chat，以問答作為第一個端到端 vertical slice。
3. 完成任務列／詳情／Terminal，以 Action contract test 守住功能完整性。
4. 完成專案列／詳情四 Tabs／Wiki／DB／SOP／Release。
5. 完成 Pipeline／用量／架構／流程／設定／管理員全子頁。
6. 最後才放大使用者範圍；正式切換前完成 Legacy／Next 雙清單回歸、RWD 與深色視覺比對。

一個路由只有在下列全部成立時才算 Done：已使用獨立 Next Component；現有 API／Action 功能對照全通過；Loading／Empty／Error／403／404 齊全；Light／Dark／360／768／1024／1440 通過；鍵盤與焦點通過；Legacy 回歸無差異；沒有將未實作的後端能力呈現為可用 UI。
