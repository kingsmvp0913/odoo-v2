# OAA UI Next 第二輪修正規格書

| 欄位 | 內容 |
|---|---|
| 文件版本 | 1.2（2026-08-31 第二輪稽核＋兩批修正執行完成；GodUI 校準待續） |
| 基準文件 | `OAA-UI-NEXT-CORRECTION-SPEC.md` v0.9.1、`OAA-UI-NEXT-SPEC.md` v1.0 |
| 文件狀態 | 稽核完成。第 1 節為本輪已實作並通過測試的項目；第 3~6 節為尚未修正、需排入下一輪的缺陷 |
| 稽核方式 | 靜態程式碼稽核（三份獨立掃描）＋ 全套 jest 測試基線量測。**未執行瀏覽器實測、未提交任何 mutation** |
| 本文件限制 | 所有「已修正」僅代表程式碼已改且 jest 通過；凡標示「待實測」者一律不得視為驗收完成 |

---

## 換台接手須知（v1.2 新增，先讀這段）

這一輪在單一 checkout 上做完，**尚未 push**。換機器繼續前需要知道：

1. **GodUI MCP 是 local scope，換台要重裝**：
   ```bash
   claude mcp add godui -- npx -y @godui/mcp@0.1.0
   ```
   寫在 `~/.claude.json` 的 project 區，不進版控。裝完**要重啟 session** 工具才會出現在工具列；不想重啟可以用 stdio 直接呼叫（本輪就是這樣做的，見下）。
   註：repo 根目錄本來就有一個 `.mcp.json`（shadcn MCP，2026-07-22 就在），與此無關。

2. **截圖需要登入態**。已支援 `RWD_TOKEN` 環境變數（從瀏覽器 localStorage 的 `aidev_token` 複製），或原本的 `RWD_USER`／`RWD_PASS`。**token 不要寫進任何版控檔案**。本輪用的 token 2026-09-02 到期。
   ```bash
   RWD_BASE_URL=http://localhost:8771/ RWD_TOKEN=<token> npm run rwd:capture
   ```
   注意 server 實際埠是 **8771**，不是 rwd 預設的 3939。

3. **未完成的工作只有一項**：GodUI 全面校準（§9）。使用者已拍板要做，做法與差異清單都在 §9。

4. **這一輪所有修正都沒有登入後的實機驗證**。全部只到「程式碼已改、jest 通過、template 能 `Vue.compile`、隔離掛載能 render」。拿到登入態後第一件事應該是跑一次完整截圖，對照 §9 的差異清單。

---

## 執行狀態總表（v1.2）

測試：改動前 **3257 passed / 10 failed** → 現在 **3395 passed / 1 failed**。唯一殘留紅燈 `frontend-status-labels.test.js` 是 §5.2 的結構性假陽性，**刻意不修**（修它等於放寬門檻）。

| 項目 | 狀態 | 備註 |
|---|---|---|
| §1.1 測試基線回復（6 支紅燈） | ✅ 已修 | 4 支是 prettier 換引號造成的假紅 |
| §1.2 五個靜默失效 | ✅ 已修 | |
| §1.3 載入失敗誤報「專案不存在」 | ✅ 已修 | |
| §1.4 runtime error gate | ✅ 已補 | §6.1 接線後才真正生效 |
| §5.5 CSS 少一個括號吃掉 82 條規則 | ✅ 已修 | **本輪最大發現**，需人眼複驗 |
| 深色表單白底／深底混排（§4.6） | ✅ 已修 | 實測深淺色各一輪 |
| 登入卡貼畫面左緣 | ✅ 已修 | 截圖接線後實跑抓到的 |
| §6.1 Next 截圖接線 | ✅ 已完成 | 22 條 Next 路由，實跑驗證過 |
| R2-P0-006 `/admin` 11 個設定區塊 | ✅ 已修 | 落到新的 `/admin/settings` 子頁 |
| R2-P0-007 刪除專案 | ✅ 已修 | |
| R2-P0-003 Wiki 教程守衛 | ✅ 已修 | |
| R2-P0-004 TaskList 即時更新 | ✅ 已修 | |
| R2-P0-008 管理者看他人任務 | ✅ 已修 | |
| R2-P0-005 ProjectDetail 兩組輪詢 | ✅ 已修 | |
| R2-P0-001 提問頁籤 | ✅ 已修 | |
| R2-P0-002 衝突分流與收尾入口 | ✅ 已修 | 順帶修好 v-if/v-else 互斥的語意錯誤 |
| §5.3 12 個複製 View 的漂移守衛 | ✅ 已補 | 現為 13 組（含 `/admin/settings`） |
| §5.5 CSS 語法守衛 | ✅ 已補 | 鑑別力已驗證 |
| §6.2 admin 路由權限守衛 | ✅ 已補 | 鑑別力已驗證 |
| §4.5 P1 內容缺漏 | ✅ 已修 | TokenReport 兩張分析表＋by_user、SOP 風險告知與安全提示、Settings PAT 更新／使用者 ID／通知診斷、ProjectList 表單 label 與上正式鈕、Terminal exit code、Pipeline 靜默失敗 |
| §4.1 action mode 內容補完 | ✅ 已修 | 含 spec.permissions（QA 比對權限的依據）與 sync_wait 阻塞原因；鍵盤送出捷徑 0 → 9 處 |
| §4.4 unicode 操作圖示 | ⚠ 部分 | 換掉 14 處；**13 處卡在凍結 View**，要換得先決定是否分家（見 §7.4） |
| §6.2 死碼守衛 | ✅ 已補 | 鑑別力已驗證 |
| **toast duration=0 讓 30 幾處錯誤訊息 0ms 消失** | ✅ 已修 | 本輪新發現，見 §5.7 |
| **Next 登入頁沒有 toast／確認視窗／教學** | ✅ 已修 | 三個全域 overlay 都掛在 shell 的 v-else 內 |
| **截圖清單漏 7 條路由** | ✅ 已修 | 含 Next 的 `/tasks`；另加守衛防止再漏 |
| **§9 GodUI 全面校準** | ⚠ 部分 | 2026-08-31 夜班：§9.5（AI 訊息改連續閱讀）✅ 已做；§9.3 契約補了 5 項（Toast `aria-live`、Command Palette ↑↓ 導航與鎖捲動、Drawer 的 `role="dialog"`／`aria-modal` 與鎖捲動）並新增守衛 `frontend-ui-next-a11y.test.js`，另補 Drawer 的焦點管理（trap＋開啟移入＋關閉還原，實測 Tab 25 次零逸出、桌機不誤 trap）。**尚缺 6 項**（Dropdown ×2、Filter Bar、Stepper、Tooltip、JS 端 reduced-motion），見 §9.3 |
| §4.2 狀態矩陣缺口 | ⚠ 部分 | ProjectChat 五個錯誤路徑仍只有 toast |
| §7 四項待裁決 | ⬜ 已裁決 3 項 | 見下方 |

**已裁決**：不動大重構（不拆檔、不清 Legacy class）；12 個複製 View 走「凍結＋比對測試」。§7.3 九種 action mode 補到什麼程度尚未拍板。

**新發現、尚未處理**：`tour-courses.js` 的四個管理員教學步驟錨點指向 `/admin`，而那些 `data-tour` anchor 現在在 `/admin/settings`。

**全域未驗證項**：本輪所有修正都**沒有登入後的實機驗證**（無 admin 帳密），受 `requiresAuth` 保護的頁面內容一律沒進去看過。所有「已修」僅代表：程式碼已改、jest 通過、template 能 `Vue.compile`、`?ui=next` 進入點零 console error。

---

## 0. 這份文件與前一份的關係

`OAA-UI-NEXT-CORRECTION-SPEC.md` 的 §11 是 2026-08-31 稍早的實作進度檢查點。本輪對該檢查點做了獨立複驗，結論分三類：

- **已達成、可從待辦撤下**：原 P0 有 4 項經證據確認已修（§2）。
- **檢查點沒提到的新缺陷**：多為「點了完全沒反應、也沒有錯誤訊息」的靜默失效（§3、§4）。
- **結構性問題**：既有測試守衛正在保護規格明文禁止的寫法，且巨石單檔已開始破壞其他守衛的判準（§5）。

---

## 1. 本輪已實作並通過測試

### 1.1 測試基線回復

改動前全套測試為 **7 支套件紅燈 / 10 個 test 失敗**（3257 passed, 3270 total）。逐支分診後全數修復，分兩類：

| 測試檔 | 真因 | 修法 |
|---|---|---|
| `tour-isolation.test.js` | `app.js` 過 prettier 後字面值由單引號變雙引號，`toContain("app.component('TourHost', …)")` 落空 | 斷言改 regex，對引號風格不敏感 |
| `architecture-spec.test.js` | 同上（`path: '/architecture'`） | 同上 |
| `frontend-inbox-badge.test.js` | 同上（3 處：`Api.get('inbox/unread-count')` ×2、`/inbox` route 定義被 prettier 拆成多行） | 同上；否定斷言 `Api.get('inbox')` 一併放寬，否則雙引號版會漏擋 |
| `frontend-auth-reactivity.test.js` | 同上，另加 prettier 把 `me =>` 補成 `(me) =>` 使 regex 落空 | regex 放寬引號與 arrow 括號 |
| `frontend-toast-id.test.js` | UI Next 把 `window.appToasts = toasts;` 插進測試切片的區間內，該測試在 node 環境 eval 該段 → `ReferenceError: window is not defined` | 把該導出行移出切片區間，與其他 `window.*` 導出集中在一起 |
| `frontend-markdown-xss.test.js` | Next 重寫了兩個 `v-html` 綁定，只有 v-for 變數名不同（`message.content`／`event.content`），落到白名單外 | 逐一確認消毒入口（`renderMd` → `renderMarkdown`；`ansiToHtml` 內含自有 `esc()`）後加入白名單並註明理由 |

> ⚠ **判讀教訓（要寫進團隊常識）**：前四支紅燈的錯誤訊息長得像「TourHost 沒註冊」「`/architecture` 路由被拔掉」「收件匣端點被改名」——實際上三者原封不動，只是換了引號。**以字串字面值比對原始碼的守衛，會被任何一次 formatter 執行整批打成假紅**，而假紅的訊息會誤導人去修根本沒壞的東西。新增這類守衛時一律用對格式不敏感的 regex。

`frontend-status-labels.test.js` 的紅燈是**結構性問題，本輪刻意不修**，理由見 §5.2。

**結果：全套測試從 7 支套件紅／10 個 test 失敗，降到 1 支套件紅／1 個 test 失敗（3266 passed）。**

### 1.2 已修正的靜默失效

以下四項的共同特徵是：**畫面看起來正常、按鈕是亮的、點下去什麼都不發生，也沒有任何錯誤訊息**。這類缺陷在截圖門禁與現有靜態測試下都完全隱形。

| # | 位置 | 症狀 | 真因 | 修法 |
|---|---|---|---|---|
| 1 | `UiNextPages.js` TaskDetail `answer` mode 的無解析題目分支 | `clarify_pending` 狀態下唯一的回覆入口，打字後按鈕亮起，點「送出回答」毫無反應 | textarea 綁 `resolution`（那是 blocker mode 的 `resolveBlocker` 在用），但 `submitAnswer` 讀的是 `newMessageText` → 走到早退 | 改綁 `newMessageText`，disabled 條件一併對齊 |
| 2 | `UiNextPages.js` TaskDetail `message` mode | 只選圖不打字時「送出留言」可點，點了沒反應 | 按鈕 disabled 放行「只有檔案」的情況，但 `sendTaskMessage` 第一行就是「沒文字就 return」 | disabled 改為只看文字，與 method 對齊（同 Legacy 行為） |
| 3 | `UiNextProjectChatView` 附件顯示 | 對話中**所有已送出的圖片附件永久不顯示**；點圖也沒有反應 | 附件端點要帶 `Authorization` header，`<img src>` 直連拿不到，必須逐張 fetch 成 objectURL。Next 缺 `loadAttachmentThumbs()`，`attachUrls` 是宣告了但無人寫入的 dead state；`openImage()` 是空 handler | 移植 `loadAttachmentThumbs()`（接上 Next 既有的 requestId 防競態）、`revokeMessageUrls()` 回收、實作 `openImage()`，並在 `beforeUnmount` 一併回收 |
| 4 | `UiNextProjectChatView` 未讀數 | 看完對話後側欄與專案卡的未讀數字不歸零，換裝置／重整後仍是未讀 | 缺 `markRead()`，未讀狀態不回寫伺服器 | 補 `markRead()`，於訊息載入後呼叫 |

### 1.3 已修正的錯誤訊息誤導

| 位置 | 症狀 | 修法 |
|---|---|---|
| `UiNextProjectDetailView` | 專案載入失敗（網路／權限／500）時畫面顯示「**專案不存在**」，使用者會去找一個根本沒消失的專案 | `loadError` 原本是宣告了、賦值了、但模板 0 次引用的 dead state。補上 error 分支並排在 `project` 判定之前，附重試按鈕（與 Settings、ProjectList 兩頁既有寫法一致） |

### 1.4 已補上的 runtime error gate

規格 §8.3 要求「E2E runner 必須監聽 `console.error`、`pageerror`、unhandled rejection」。既有截圖框架 `app/rwd/capture.js` 只監聽了 `pageerror`。

已補：`console.error` 監聽與 `unhandledrejection` 轉接，並在 `app/rwd/routes.js` 建立 `CONSOLE_ALLOWLIST`（**刻意留空起步**——先讓門禁把現況全部吼出來，再逐條決定豁免；反過來先塞萬用 pattern 會讓真錯誤從第一天就被吃掉）。

> 這一項補的是**能力**，不是驗收。實際跑起來會吼出什麼，取決於 §6.1 的接線完成後。

---

## 2. 原規格待辦中已達成、可撤下的項目

經靜態證據確認，以下原列為阻斷或待辦的項目**現況已符合**，不需再排工：

| 原編號 | 項目 | 證據 |
|---|---|---|
| NEXT-P0-001 | 非管理員被整體踢回 Legacy | `app.js` router guard：`requiresAuth` 只驗 `Api.isLoggedIn()` 不碰 role；`requiresAdmin` 存在且只標在 12 條 admin route；有專屬 `ForbiddenView`。全檔 `role !== "admin"` 僅 3 處，另 2 處只影響用量小工具抓取 |
| NEXT-P0-002 | 篩選白屏（template 讀 `window`） | 抽出全部 30 個 template 區段掃描，`window.` 出現 **0 次**；狀態選項已改在 JS 層取 |
| §4.1 | Next View 委派 Legacy View 的 data/computed/watch/methods/created | `window.*View` 26 個出現點**全部**是 `window.UiNext*View = Vue.defineComponent({` 自有定義；補掃 spread／mixin／`extends` 亦為 0 |
| §4.5 第一條 | Next CSS selector 必須有專用 scope | 1002 個 selector 中 1001 個合規；唯一例外 `html[data-theme="dark"] [data-ui="next"]` 仍被 `[data-ui="next"]` 限定，判定通過 |
| §4.5 第四條 | Next asset 僅在 `?ui=next` 載入 | `index.html` 兩處條件注入，無 server 端注入，Legacy 路徑完全不下載 |
| §4.6 | 硬編碼淺色背景（深色模式隱形字） | CSS 淺色值只出現在成對定義 bg／text 的 token 區塊；JS inline 的 8 個 `#fff` 全部是文字色且都配了背景 |

---

## 3. P0：仍未修正的靜默失效與功能不可達

### R2-P0-001：TaskDetail「提問」頁籤整組不可達

Legacy 的 `clarTab` 切換鈕、提問輸入框、`submitAsk`、附圖 `onAskFilesSelected` 在 Next template 中**出現次數皆為 0**。相關 method 因 script 是逐字複製而全部存在，但**永久無法觸發**。

同一形狀的問題還有：衝突逐檔追問 AI（`submitClarify`／`clarifyText`／`clarifying` 皆 0 次）。

**修正契約**：補齊 template 分支；並新增「method 存在但 template 從不引用」的靜態守衛（見 §6.2），否則這類死碼還會再長出來。

### R2-P0-002：rebuild 衝突被錯誤導向逐檔裁決流程

Legacy 用 `isRebuildConflict`／`isSyncConflict` 分流兩種衝突並給專屬文案，Next 兩者皆 0 次出現。

更嚴重的是：Next 把「逐檔裁決」與「已在 Repo 手動解完、收尾繼續」寫成 `v-if/v-else` 互斥（Legacy 是並存）→ **使用者選了 manual 之後沒有任何收尾入口**。

### R2-P0-003：Wiki 缺教程示範專案守衛

Legacy 的 `isTourDemo()`／`tourDemoBlocked()` 在 Next **整組不存在**。示範專案 id 是字串 `'demo'`，Legacy 註解已寫明「送進 integer 型別的 `project_id` 一律 500」。

因此 Next 的 `loadPages`／`loadPage` 會直接打 API 炸掉，`save`／`removePage`／`refreshNode`／`buildWiki` 也全無守衛。**新手教學走到 Wiki 就會 500。**

### R2-P0-004：TaskList 沒有即時更新

Legacy 在 `mounted` 掛 `SocketManager.setRefreshCallback`、`beforeUnmount` 解除。Next **沒有 `mounted`／`beforeUnmount`** → 任務列表不會即時更新，只能手動重整。

這與規格 §4.2「Socket 重連與 visibility pause/resume 都要測試」直接衝突。

### R2-P0-005：ProjectDetail 環境與 repo 狀態永不更新

Legacy 有 `_startPoll()`／`_stopPoll()`（環境狀態 5 秒輪詢）與 `_startReposPoll()`／`_stopReposPoll()` + `hasCloning` computed。Next 兩組皆無。

後果：環境「建立中」**永遠停在建立中**（Legacy 文案明寫「建立中（自動重新整理）」），repo「同步中」永不更新且該區沒有手動重整鈕。

這也讓規格 §5.8 的 env 狀態矩陣在實務上失效——狀態是對的，但不會變。

### R2-P0-006：`/admin` 首頁被抽空，11 個全域設定區塊在 Next 完全不可達

**這是整份稽核最嚴重的缺口。**

`UiNextAdminView` 只有一個靜態 `cards` 陣列＋卡片 grid，**沒有 `created()`、沒有任何 `Api` 呼叫、沒有任何表單**。而 Legacy `views/Admin.js` 有 734 行、11 個全域設定區塊：

| 區塊 | 內含 |
|---|---|
| 系統連線設定 | Odoo url/db/同步間隔、eService 同三欄 |
| Microsoft Teams 整合 | Tenant/Client ID/Secret/Team/Channel/Webhook 七欄、傳送測試訊息 |
| Claude 用量閘門 | 啟用開關、5 小時／本週門檻%、五種即時閘門狀態 |
| Claude 認證憑證 | 狀態、環境變數遮蔽警告、token 欄、儲存並驗證、清除 |
| Codex 訂閱連線 | 狀態/email/plan、device-login 的 verification_url 與 user_code |
| 備用 Claude 憑證 | 撞門檻改用備用憑證開關、token 欄 |
| context7 API key | 狀態、key 欄、儲存並驗證 |
| CLI 推送身分 | 預設推送帳號下拉 |
| Pipeline 測試模式 | 開關 |
| 留言回寫 Odoo/eService | 開關 |
| 語意檢索索引 | 三態狀態/片段數/佇列/快取、重建索引 |

端點交叉驗證（對 `UiNextPages.js` grep）：`admin/teams-settings`、`admin/claude-token`、`admin/codex-subscription`、`admin/context7-key`、`admin/cli-push-user`、`admin/embedding`、`usage-gate/status`、`admin/pipeline/step` — **8 組全部 0 命中**。

**實務後果**：在 `?ui=next` 下，管理員無法設定 Odoo/eService 連線、Teams、用量閘門、Claude 主／備憑證、Codex 訂閱、context7 key、CLI 推送身分、測試模式、留言回寫，也無法重建語意索引。**唯一繞道是把網址的 `?ui=next` 拿掉。**

另：`tour-courses.js` 的 4 個管理員教學步驟在 Next 下錨不到元素。

### R2-P0-007：刪除專案能力在 Next 全站消失

Legacy `views/ProjectList.js` 有刪除專案（含 `requireText` 打字確認）。對整份 `UiNextPages.js` grep「刪除專案」＝ **0 筆**，不是搬到別頁。同頁的 `isAdmin()` 權限分支也一併消失。

### R2-P0-008：管理者無法查看他人任務

Legacy 的 `showAllUsers`／`toggleAllUsers`／`ownerFilter`／`ownerOptions`／`matchOwner`／`users` 在 Next **整組不存在**，`load()` 永遠只打 `tasks`。

這是**權限能力的退化**，不是視覺問題。

---

## 4. P1：功能缺漏與狀態錯誤

### 4.1 TaskDetail 九種 action mode 的內容殘缺

mode 判定邏輯與 Legacy 逐字相同、9 個 template 分支也都在，但**內容物殘缺程度不一**：

| mode | 缺什麼 |
|---|---|
| `answer` | AI 建議答案 `clarRecommend`、「選錯難改」`costly` 警示、「選填」標記與 `recommended` 標星、「還有必答的問題沒回答」提示、送出後的「回覆已送出」卡片 |
| `spec_review` | `spec.module`、`spec.requirements`（可摺疊）、`spec.permissions` 全缺，只渲染 summary + acceptance。**`permissions` 缺漏尤其嚴重**——CLAUDE.md §1 的權限規則要求 QA 比對實作與規格的 permissions，審核者在畫面上根本看不到 |
| `review` | diff 逐行著色 `diffLines` 退化成 `join(' | ')` 的單一 `<pre>`；`r.missing`／`r.truncated` 說明與 `diffError` 皆無；退回附件已選檔名不回顯 |
| `conflict` | 逐檔 AI 分析（`classification`／`reason`／`rationale`／建議標記）全缺，只剩 repo/file + 三顆 radio |
| `cs_reply`／`cs_data`／`blocker` | 缺說明文字、必填提示、`handleCsEnter` 逐題 Enter 跳下一題 |
| `message` | `blocker_type === 'sync_wait'` 的阻塞原因顯示 0 次 → **同步衝突卡住時畫面完全無提示** |

另：Legacy template 有 **8 處 `@keydown.enter.exact.prevent` 送出捷徑**，Next template **零個 keydown handler**。

### 4.2 頁面層級狀態矩陣缺口

規格 §4.6 要求每個 route 都有 loading／empty／error／success／retry。現況：

| 頁面 | loading | empty | error | retry |
|---|---|---|---|---|
| TaskList | ✅ | ✅（且區分「有篩選」與「無任務」） | ✅ | ✅ |
| Wiki | ✅ | ✅ | ⚠ 僅頁面清單有；`loadPage` 失敗只 toast | ✅ |
| ProjectDetail | ✅ | ✅ | ✅（本輪已補） | ✅（本輪已補） |
| TaskDetail | ✅ | ❌ 無 `v-else`，task 為 null 且無 error 時整頁空白 | ✅ | ❌ |
| ProjectChat | ✅ | ✅ | ❌ 全部只 `showToast`，畫面無錯誤區塊 | ❌ |

規格 §4.6 明寫「不得只靠四秒後消失的 toast」，ProjectChat 五個錯誤路徑全部違反。

### 4.3 其他 parity 缺口（節錄）

- **ProjectChat**：轉任務視窗缺圖片縮圖預覽（只有檔名 checkbox，使用者無法判斷勾的是哪張圖）、缺 Enter 送出與 Esc 關閉、附加圖片按鈕缺 `:disabled="sending"`。
- **TaskList**：儲存的篩選組合（我的最愛）整組不存在；`openEnv` 從列表直開測試機退化成不可點的 `<span>`；來源與專案名 chip 失去連結能力；`review_pending` 分頁進不去（route query 白名單不含它，統計數字改用正則猜狀態）；TourDemo 示範卡片不再插入 → 新手教程在列表頁沒有可指的卡片；`sort` 少兩個選項。
- **Wiki**：`isDirty()` 退化成只判 `this.editing`，而 notes 頁 textarea 有 `@input="editing=true"` → **打過任何一個字元再切頁，即使已儲存也會跳「尚未儲存」確認框**；tree 排序丟掉「專案備註排最前」，預設開啟頁從「專案備註」變成「概論」。
- **ProjectDetail**：`updateRepo(id)` 直接轉呼 `reclone(id)`，但 Legacy 的 `updateRepo` 打的是不同端點（`/update`）——**這是行為改變，不是 parity**，需確認語意。

### 4.4 Unicode／emoji 當操作圖示（27 個操作點）

SVG registry 已存在且已含對應 icon（`close`／`arrow-left`／`chevron-down`／`chevron-up`／`send`／`check`／`star`），但仍有 27 處操作按鈕使用 Unicode，其中：

- `←` 返回鈕 **11 處**
- `×` 關閉鈕 4 處（其中「移除待傳檔案」那顆連 accessible name 都沒有）
- `↑` 送出鈕、`⌃`/`⌄` 展開收合、`⌕` 下載附件 ×2、`→` 帶入編輯器 ×2、`▾`/`▸` 收合、`🔧` 修這條、`←`/`→` 翻頁、`↵` 命令面板
- `▶` 次要內容 disclosure（同行還有硬編碼 `color:#888`）

另有 8 處狀態／裝飾用 emoji（`🌐`／`🔒`／`🖥️`／`🐳`／`✦`／`✓`／`▢`／`⬚`）屬 §4.4 灰區，需逐一裁決。

**沒有任何測試在擋這件事**——整個 tests/ 目錄 grep `emoji` 零命中。

### 4.5 工具與管理頁的缺口

這批頁面中 12 個是逐字複製（§5.3），功能缺口為零。**真正改寫過的只有 6 個，缺口全部集中在這裡**：

**Token Report（落差最大，去空白後只剩 Legacy 的 27%）**
- **兩張完整分析表整個消失**：各關卡成本與失敗率表（7 欄，含 `avg_calls_per_task` ≥2 紅、`fail_rate` ≥0.2 紅的門檻著色）、專案品質統計表（5 欄，一次過關率 <0.5 紅、人工退回率 ≥0.3 紅、主要退回原因）。後端欄位 `cost_usd`／`calls`／`avg_calls_per_task`／`failed_calls`／`fail_rate`／`project_stats` 在 Next **完全沒有出口**。
- 三張圓餅圖 + 點擊放大 modal 整組消失，降級為無百分比、無顏色的文字清單；**`by_user` 這個維度 Next 完全不使用**。
- 摘要卡 7 張 → 4 張；折線圖掉了 y 軸刻度、資料點 hover tooltip、x 軸日期標籤、寬度自適應。
- 明細表掉「記錄時間」欄與展開內容的「耗時」，**但畫面說明文字仍寫著「可展開各 Agent 的模型、用量與耗時」——與實作不符**。
- 「僅顯示前 100 筆（共 N 筆）」提示消失，但仍照樣 `.slice(0,100)`，且旁邊顯示的是總筆數 → 比 Legacy 更容易誤讀。
- error／retry 皆查無（失敗只 toast，畫面只剩篩選列）。

**Deploy SOP（掉了整頁的判斷依據）**
script 與 Legacy 逐字相同，**缺口全在 template**：專案名稱不顯示（`project` 有載入但從未使用）、「這頁在做什麼」說明區塊全砍、**「先知道代價」風險告知區塊全砍**（「正式區是全自動、沒有人工關卡」）、無連線時的引導與「前往設定連線」按鈕全砍（只剩兩個空 select，無出口）、每區的 SSH 事實顯示成死碼、direct 模式連線警告消失、**七段步驟說明與五段安全提示全數移除**（含「設定檔沒 db_name ＝多資料庫模式，升級一定要帶 `-d`」「新目錄要 chown 給 runner 帳號否則卡 Permission denied」「刻意不做的兩件事：不自動 pip install、失敗不自動回滾」等無法從指令本身推得的內容）。

- **placeholder 守衛修過頭**：Next 新增 `copyReady()` 擋掉含 `<…>` 的指令（方向正確，且不會誤判 `${{ github.ref_name }}`），但步驟 1（`systemctl cat <服務名>` 等）與步驟 4（`config.sh --url <repo 網址> --token <該頁給的 token>`）的尖括號是**硬寫死的操作指示，沒有任何輸入欄能填掉** → 這兩顆複製鈕永久 disabled，而 Legacy 可以複製。且 disabled 無 `title`／`aria-label`／旁註，CSS 也沒有 `:disabled` 樣式 → 使用者按不下去時無從得知原因。

**Settings**
- **能力缺失（非文案）：PAT 已連結後無法更新** —— 輸入框與儲存鈕都包進 `v-else`，`configured===true` 時只剩「移除連結」，要換 token 必須先移除再重設。
- **Odoo／eService 的「使用者 ID」輸入框消失**，但 `verifyOdoo` 仍會寫入、`save()` 仍會送出 → **有 state 沒 UI，值錯了也改不了**。
- **`testNotify` 的三段診斷全消失**（`denied` → 教學文案、`default` → 提示先開開關、localStorage 停用 → 提示）→ **權限被封鎖時按下去完全無回饋**。
- GitHub PAT 未設定的紅色警示（「你的任務將被擋下」）降為中性說明句；四步驟取得 PAT 教學、SAML SSO 提醒消失；Teams 區塊被併入帳號資料且說明全失。

**Project List**
- 刪除專案（見 R2-P0-007）、上正式按鈕不可達（`releaseId` 無寫入點＝死碼）、資料庫查詢／自動部署 SOP／初始化 Wiki 三顆卡片按鈕消失（`goDb`／`goDeploySop` 未實作）。
- **新增表單的 label 與說明全消失**，尤其「英文資料夾名稱 *」的必填星號與「測試環境的容器、目錄與資料庫都用它命名」警語 —— **這正是撞過中文專案名容器塌縮那顆雷的欄位**。
- 空狀態不再分流：新帳號 0 專案時看到的是「找不到符合的專案」。
- 未讀數紅底 badge 降級為文字；表單「取消」按鈕消失；Skeleton 降級為文字；教程示範專案與所有 `data-tour` 錨點消失。

**Terminal**
- **exit code 數值不再顯示**（Legacy 印 `失敗 (code N)`）→ 分不清 exit 1 還是 exit 137。
- 四態壓成兩態且語意錯誤：任務尚未啟動時狀態列顯示「**已結束**」（Legacy 是「待機」），而同一畫面 header 卻寫「任務尚未開始或已等待輸出」——兩處互相矛盾。

**Pipeline Monitor**
- **端點失敗偽裝成「沒有任務」**：Legacy 失敗發 toast，Next 是 `.catch(() => null)` 完全靜默，畫面顯示「目前沒有執行中的 Pipeline」，與真的沒任務無法分辨。

**Admin 子工具的系統性狀態缺口**
- users／agents／schedules／pipelines 四頁**一律沒有頁內錯誤態＋重試鍵**，錯誤只走 toast。
- `AdminSchedulesView` 與 `AdminPortPoolView` 連空狀態都沒有；`AdminAgentsView` 的 agents 為空時左欄靜默空白。
- 頁首語彙三種並存（Next 原生 `ui-next-page-head`／Legacy `.topbar`／Legacy `.page-header`），返回鈕有無不一致，而 Next 側欄沒有 `/admin` 直達項（只在帳號選單）→ 從那幾頁回管理員首頁要多繞一層。

### 4.6 深色模式：DB 頁白底／深底混排（CSS 特異度問題）

Next 自己**沒有**寫死白底（該區段只有兩個徽章的 `color:#fff`）。真因是特異度：

- `app.css`：`[data-theme="dark"] .form-group input/select/textarea { background:#fff; color:#111827 }` — 特異度 **(0,2,1)**，註解明寫「輸入框一律白底黑字，不隨深色模式切換（辨識度優先）」
- `ui-next.css`：`.ui-next-main .field-input, .ui-next-main .form-control { background:var(--surface); color:var(--text) }` — 特異度 **(0,2,0)**

結果：Next 深色模式下，DB 頁**包在 `.form-group` 裡的 input 是白底**（VPN 帳密、連線表單全部），而**沒包 `.form-group` 的 SQL textarea 與連線下拉是深底**。Legacy 是「全部白底」的一致刻意設計；Next 變成同一張表單白底與深底混排。

**另一顆 Next 專屬的深色缺陷**（Legacy 不會發作）：兩個徽章寫死 `color:#fff` 疊在 `background:var(--primary)` 上。Legacy 深色沒覆寫 `--primary`（仍是靛藍，白字可讀）；Next 的 `--primary` 指向 `--next-brand`，深色區把它改成 **`#C5A3BB` 淺紫** → 白字對比嚴重不足。這正是 `.claude/rules/frontend.md` 第 32 條講的情況，只是換了殼才發作。

> 這兩項有明確 CSS 事實佐證，但**實際渲染色需人眼開圖確認**。

### 4.7 Diagram 的 fit/zoom/reset：兩邊都沒有

規格 §5.14 要求 Diagram 提供 fit／zoom／reset。掃描四份程式碼的 `zoom|scale(|transform|wheel|pan|drag|fit|reset|panzoom|fullscreen` 等，**Legacy 與 Next 皆全數查無**（唯一命中的 `viewBox` 與 `width/height` 恆等，是 1:1 固定尺寸）。唯一檢視手段是 CSS 橫向捲動。

**這不是 Next 的退步，而是對兩個 UI 同時的新功能需求**，且照現況（逐字複製）要改兩份。

---

## 5. 結構性問題：守衛正在保護反模式

這一節是本輪最重要的發現。三個問題都不是「某個頁面沒做完」，而是**現有的品質機制本身在往錯的方向施力**。

### 5.1 測試把「修飾 Legacy DOM」釘死成必過條件

規格 §4.5 明文禁止：「不得使用 `.ui-next-main .task-card` 之類 selector 去修飾 Legacy DOM 作為最終解法」。

現況：`ui-next.css` 內有 **93 個** 這種 selector（`.ui-next-main .task-card`、`.ui-next-main .form-control`、`.ui-next-main .btn-primary`、`.ui-next-main .data-table th`、`.ui-next-main .modal`、`.ui-next-main .chat-split` …）。

而 `frontend-ui-next.test.js` 的「日常頁面與工具頁都有 ui-next 範圍內的視覺覆寫」這支測試，**正在斷言這些 selector 必須存在**（`expect(css).toContain('.ui-next-main ' + selector)`）。

**這正是 NEXT-P0-006「既有測試把 Legacy 包裝誤判為 Next 完成」的具體樣態**——只是這次不是誤判，是主動要求。任何人想照 §4.5 清掉這些 selector，都會被測試擋下來。

對應地，Next template 仍大量使用 Legacy class：`form-control` 38 次、`btn-outline` 27、`section-title` 15、`settings-section` 14、`btn-primary` 13、`data-table` 11、`table-wrap` 11、`page-header` 10。

**修正契約**：
1. 先決定 Legacy class 的去留（見 §7 待裁決事項），**在決定之前不要動這 93 個 selector**——它們現在是深色模式可讀性的唯一支撐。
2. 決定「清除」後，該測試必須從「要求存在」翻轉為「禁止存在」，且要分階段：每移轉一個頁面，就把該頁的 selector 從允許清單移到禁止清單。
3. 這期間深色模式**只能靠人眼實測**，靜態 gate 檢不出（Legacy class 的底色來自 `app.css`，是執行期才解析的）。

### 5.2 巨石單檔開始破壞其他守衛的判準

`UiNextPages.js` 是 **5869 行 / 356KB 的單一檔案**，內含 26 個 View。規格 §4.1 建議的目錄結構（`app/, components/, composables/, adapters/, pages/, registries/`）完全沒有落地。

直接後果已經出現：`frontend-status-labels.test.js` 紅燈。該測試的啟發式是「同一個檔案內命中 3 個以上狀態 key 才可能是複製了狀態表」——這個門檻假設「一個檔案 ≈ 一個頁面」。實際命中的三處分屬**完全不同的語意域**：

| 位置 | 內容 | 實際語意 |
|---|---|---|
| TaskDetail template | `{answer:'等待回答', spec_review:'規格審核', review:'人工審核', …}` | action mode 標題，不是任務狀態 |
| AdminRejections | `{ new:'待分類', classified:'已分類', error:'分類失敗' }` | 退回分類狀態 |
| AdminEnterprise | `{ done:'🟢 可用', syncing:'🔄 同步中', … }` | repo `clone_status`（且用 emoji 當狀態圖示） |

三個獨立頁各一個，湊在同一個檔案裡就湊滿了門檻。**這是假陽性，但真因是巨石檔**，不是測試寫錯。

**修正契約**：拆檔是前提，不是美化。在拆檔之前，不要為了消紅而放寬這支測試的門檻——放寬等於把真正的狀態表複製也一起放行。

### 5.3 12 個 View 是逐字複製，門禁通過但兩份會各自漂移

把 Legacy view 本體與 `UiNextPages.js` 對應行段剝掉縮排、正規化引號後逐行 diff，**差異一律只有元件名稱那一行**：

`UiNextDbView`、`UiNextAdminUsersView`、`UiNextAdminAgentsView`、`UiNextAdminSchedulesView`、`UiNextAdminHealthCheckView`、`UiNextAdminRejectionsView`、`UiNextAdminClassifySamplesView`、`UiNextAdminPromptLogsView`、`UiNextAdminPortPoolView`、`UiNextAdminEnterpriseView`、`UiNextArchitectureView`、`UiNextPipelineFlowView` — 共約 **2,800 行重複碼**。

這是 commit `2ee3e9a4 [UI Next]: Restore independent and usable workflows`（+4630/−344）的做法：把原本的 Legacy wrapper 換成完整複製。三處為隱藏被包元件第二標題而寫的 CSS（`.ui-next-diagram-panel`／`.ui-next-admin-legacy`／`.ui-next-tool-legacy` 的 `> .page-header { display:none }`）成為死碼，**恰好證明雙標題曾經發生過，現在是靠複製而非靠隱藏解決的**。

門禁測試禁止的是 `window.*View.methods` 這種委派寫法 —— **逐字複製可以通過這道門禁，而門禁不檢查兩份是否對等**。

好處是這 12 個 view 的功能 parity 缺口為零。代價是往後 Legacy 的任何修正都不會傳到 Next，且沒有任何機制會發現。

**修正契約**：拆檔（§7.2）時一併決定這 12 個 view 的歸宿——抽共用、或明確標記為「已凍結的複製，Legacy 改動需同步」並加一支比對測試。

### 5.4 兩顆未爆彈

**(a) Next 依賴 Legacy 檔案的 top-level `const`。** 以下識別字在 `UiNextPages.js` 內完全沒有定義（已複驗：`const AR_KIND_COLOR`／`const PF_BUSES`／`const HC_STATUS` 命中數皆為 0）：

- `AR_KIND_COLOR`／`AR_KIND_LEGEND` ← `views/Architecture.js`
- `PF_BUSES`／`PF_KIND_COLOR` ← `views/PipelineFlow.js`
- `HC_STATUS`／`HC_LAYER`／`HC_FIX`／`HC_SEV`／`SEV_BY_RANK`／`HC_CADENCE` ← `views/AdminHealthCheck.js`

能跑只因為 `index.html` 無條件先載入 Legacy 檔。**「Next 完成了、可以下架 Legacy view」這個很自然的下一步，會直接讓這三頁 `ReferenceError` 白畫面。**

**(b) `UiNextPages.js` 的 IIFE 提早收尾。** 檔案第 1 行開 `(function () {`，第 3321 行就 `})();`（全檔唯一頂層收尾，共 5900+ 行），恰好落在 `UiNextAdminUsersView` 之後。**其後的 11 個 View 全在全域範疇宣告。**

目前不會壞（IIFE 內的 7 個區域 helper 在收尾後引用數皆為 0，`node --check` 通過），但這是明顯的貼上瑕疵——日後任何在 3321 行後引用那些 helper 的改動會直接 `ReferenceError`。

### 5.5 一個少打的括號讓 ui-next.css 後段 82 條規則整段失效（已修）

`.ui-next-pipeline-grid` 的 `grid-template-columns:repeat(2,minmax(0,1fr)` 少一個右括號。CSS 解析器會一路找配對括號，把後面的內容**全部吞掉**——不是丟棄出錯的那一條宣告，是丟棄檔案後段。

用 CSSOM 數 `document.styleSheets` 的實測：

| | 規則數 | `@media` | `ui-next-chat` 規則 |
|---|---|---|---|
| 修復前 | 275 | 7 | **0** |
| 修復後 | 357 | 10 | 17 |

失效的 82 條包含 `(max-width:900px)`／`(max-width:560px)`／`(max-width:760px)` **三組響應式斷點**，以及**整個 Chat 頁的佈局**。

也就是說 **Next 的 Chat 頁從來沒有套過自己的 CSS**，一直靠殘留的 Legacy class 撐著——這正好解釋了 §5.1 看到的「Next 大量使用 Legacy class 卻還能看」。它也意味著本文件 §4 中所有關於 RWD 與版面的判斷，都是在「後段 CSS 沒生效」的狀態下做的，**修好之後需要重新評估**。

**為什麼四道防線一個都沒攔到**：

- CSS scope gate 只解析 selector 前綴有沒有 scope，不驗語法是否有效。
- 截圖門禁當時沒有 Next 路由（§6.1 才補上）；就算有，**壞掉的版面對壞掉的版面 diff 恆為 0**。
- 頁面照樣渲染得出來，console 完全沒有錯誤。
- `node --check` 只驗 JS，不碰 CSS。

已補守衛：`app/server/tests/frontend-css-syntax.test.js`（逐字掃描追蹤 `{}` 與 `()` 深度，在 `{`／`}` 邊界要求圓括號已收乾淨；另加「規則數不得斷崖式塌陷」的粗略活著證明）。鑑別力已驗證：把 bug 放回去會紅並指出行號。

> ⚠ **這 82 條規則一次生效會改變畫面**，尤其 Chat 頁與各斷點下的版面。這是本輪唯一一個「修正本身需要人眼複驗」的改動。

### 5.7 一個參數值把行為反轉：30 幾處錯誤訊息 0ms 就消失（已修）

`showToast(message, level, duration)` 把 `duration` 無條件丟進 `setTimeout`。於是 `showToast(msg, "error", 0)` 變成「0ms 後移除」——而呼叫端的意圖正好相反，`0` 是「這則不要自己消失」（規格 §4.6：錯誤訊息預設不可自動消失）。

ui-next 有 **32 處**錯誤路徑這樣寫，全部靜默失效：使用者只看到操作沒反應，看不到原因。

只改「`duration<=0` 就不設 timer」是不夠的——toast 從來沒有關閉鈕，那會讓訊息永遠卡在畫面上，比自動消失更糟。所以同時補了 `dismissToast` 與關閉鈕，並用 `sticky` 旗標決定要不要畫那顆鈕。

**同源的第二個缺陷**：Next 的 `toast-container`、`confirm-dialog-host`、`tour-host` 三個全域 overlay 都掛在 shell 那個 `v-else` 裡面，於是未登入與 `/login` 頁走 `v-if` 分支時三者都不存在——**登入失敗的 toast、確認視窗、新手教學在那些頁面上全部靜默不出現**。已移到兩個分支之外。

> ⚠ 尚缺 `aria-live`，見 §9.3。沒有它的話，對螢幕閱讀器使用者仍是看不到也聽不到。

### 5.8 靜態字串守衛對 formatter 沒有抵抗力

見 §1.1。四支測試因一次 prettier 執行同時變紅，且錯誤訊息全部指向「功能被拔掉」這個錯誤方向。

**修正契約**：新增比對原始碼的守衛時，一律用對格式不敏感的 regex（引號、arrow 括號、換行）。已修的五處可作為範本。

---

## 6. 測試與驗證基礎設施

### 6.1 Playwright 已經有了，但 Next 從未被瀏覽器碰過

這是本輪發現的**最高槓桿缺口**。現況盤點：

**已經有的**：`playwright ^1.62.1` 在 devDependencies、瀏覽器已 vendored、`app/rwd/capture.js` 實際開 chromium 跑截圖、5 個 npm scripts（`rwd:baseline`／`capture`／`check`／`gate`／`inventory`）、3 viewport × light/dark 矩陣、pixelmatch 比對、baseline 需人工核准、動態內容遮罩、中文字型處理。**規格 §8.4 要求的形狀完全吻合。**

**缺的**：`app/rwd/routes.js` 的 25 條路由**全部是 Legacy hash route**，整個 `app/rwd/` 目錄 grep `ui-next|ui=next` **零命中**。

也就是說：一套能用的視覺回歸框架就在旁邊，Next 一張圖都沒拍過。

**修正契約**（優先於本文件其他所有測試工作）：
1. 給 route 定義加 `ui: 'next'` 維度，`resolveUrl` 在該維度下插入 `?ui=next` query（hash routing，query 必須在 `#` 之前）。
2. Next 的 `expect` selector 改為 `.ui-next-shell`（登入頁另計，該頁走 `v-if` 的非 shell 分支）。
3. `STABILIZE_CSS` 目前只解除 Legacy 容器（`.app-shell`／`.main`／`.content`／`.page-body`）的高度與 overflow 限制；Next 用 `.ui-next-shell`／`.ui-next-main`，**不補的話所有 Next 截圖只會有一屏高**——這個坑 Legacy 那邊踩過一次，五個頁面的基線曾經只有一屏而沒有任何訊號。
4. §1.4 已補的 console error gate 在此才會真正生效。

### 6.2 靜態 gate 的三個缺口

規格 §8.1 列了六個禁止項，現況只有兩個半有守衛：

| 禁止項 | 現況 |
|---|---|
| Next tree 出現 `window.*View.data/…` | ✅ 有（否定 regex） |
| Next route 使用 Legacy wrapper component | ✅ 有 |
| 未 scope 的 Next CSS selector | ⚠ 真解析，但 `html[data-theme=` 是無底洞前綴——`html[data-theme="dark"] .task-card` 會通過 gate 卻污染 Legacy DOM |
| Unicode/emoji 作為操作圖示 | ❌ 完全沒有（碼裡 27 處而測試全綠） |
| 缺少 `requiresAdmin`／錯設全域 admin gate | ❌ 實質沒有（只擋 `window.location.replace(`，未逐 route 驗證 admin 旗標） |
| 頁面自建狀態 label mapping | ❌ 沒有（現有斷言只擋一個特定 v-for 字面量） |

另建議新增（本輪缺陷直接催生的）：

- **「method 存在但 template 從不引用」的死碼守衛** — R2-P0-001 的整個「提問」頁籤就是這樣消失的，而 method 還在，看起來像做完了。
- **「data 宣告但 template 從不引用」的 dead state 守衛** — `attachUrls`（§1.2-3）與 `loadError`（§1.3）都是這個形狀。
- **「按鈕 disabled 條件與 handler 早退條件不一致」** — §1.2-1 與 §1.2-2 兩個靜默失效都是這個形狀。這一項難以純靜態檢測，可能得靠 component test。

### 6.3 測試層級現況

`frontend-ui-next.test.js` 共 22 支，**21 支是字串存在或否定字串比對，只有 1 支（CSS scope）做真實解析。零支 mount、零支行為驗證**。jest 設定為 `testEnvironment: "node"`，無 jsdom、無 `@vue/test-utils` → **結構上不可能 mount**。

規格 §8.2 的六個 component test 主題、§8.3 的十項 browser E2E，**目前是 0/6 與 0/10**。

---

## 7. 待裁決事項

以下三項需要拍板才能排工，因為做法互斥且成本差距大：

### 7.1 Legacy class 的去留

Next template 有 168 處以上使用 Legacy class，靠 93 個 `.ui-next-main <legacy-class>` selector 撐住外觀。三條路：

- **(A) 全面清除**：符合 §4.5，但要重寫 26 個 View 的 markup 與對應 CSS，且過程中深色模式只能靠人眼守。
- **(B) 收斂成 Next 自有 class，保留對應樣式**：折衷，工作量集中在 CSS 改名與 template 替換。
- **(C) 維持現狀，把 §4.5 第二條改成「允許以 `.ui-next-main` 前綴覆寫」**：成本最低，但等於承認 Next 不是獨立 UI。

無論選哪條，`frontend-ui-next.test.js` 那支「要求 selector 存在」的測試都必須改寫。

### 7.4 那 12 個逐字複製的 View 怎麼辦

§5.3 的 2,800 行重複碼，三條路：

- **(A) 抽共用**：把 script 抽成共用 options 或 composable，兩個 UI 各自套自己的 template。工作量大但根治漂移。
- **(B) 明確凍結**：標記為「已凍結的複製」，加一支比對測試（Legacy 動了而 Next 沒動就紅）。成本低，但兩份 template 的視覺差異永遠存在。
- **(C) 維持現狀**：接受漂移風險。**不建議** —— 沒有任何機制會發現漂移，而且 Legacy 的修 bug commit 不會傳到 Next。

無論選哪條，§5.4(a) 的 Legacy top-level `const` 相依都必須先解掉，否則「下架 Legacy view」這一步會讓三頁白屏。

### 7.2 是否拆分 `UiNextPages.js`

5869 行單檔已在破壞守衛判準（§5.2），且 26 個 View 擠在一起讓任何 parity 補完都是高風險編輯。拆檔本身無自動化測試保護（沒有任何測試會執行這些 View），需要拆完後靠瀏覽器逐頁實測。

建議：**先做 §6.1 的 Next 截圖接線，有了視覺基線再拆**。順序反過來的話，拆檔造成的視覺回歸沒有任何東西接得住。

### 7.3 九種 action mode 補到什麼程度

§4.1 列出的缺漏中，`spec_review` 缺 `permissions` 顯示與 `conflict` 缺逐檔 AI 分析屬**影響決策品質**（審核者看不到就無從判斷）；其餘（Enter 捷徑、選填標記、costly 警示）屬效率與體感。若要分批，建議前者優先。

---

## 8. 建議執行順序

| 階段 | 內容 | 前置 |
|---|---|---|
| A | §6.1 Next 截圖接線（4 個步驟）→ 建立第一份 Next 視覺基線 | 無 |
| B | **R2-P0-006 `/admin` 11 個設定區塊**、**R2-P0-007 刪除專案** — 兩者都是「Next 下完全做不到、只能拿掉 `?ui=next` 繞道」的能力缺口，優先於一切外觀工作 | A |
| C | R2-P0-003 Wiki 教程守衛、R2-P0-004 TaskList 即時更新、R2-P0-005 ProjectDetail 輪詢 — 三個都是「移植 Legacy 既有 method」，風險低 | A（有基線才知道有沒有改壞） |
| D | R2-P0-001 提問頁籤、R2-P0-002 衝突分流與收尾入口、R2-P0-008 管理者查看他人任務 | A |
| E | §4.5 的 Token Report 兩張分析表、SOP 風險告知與安全提示、Settings PAT 更新與通知診斷 | A |
| F | §7.1／§7.2／§7.4 裁決後執行 | 拍板 |
| G | §6.2 三個靜態 gate ＋ 三個新守衛 | D（先修完才不會一加就滿江紅） |
| H | §4.1 action mode 內容補完、§4.2 狀態矩陣補完、§4.4 icon 替換、§4.6 深色修正 | G |

---

## 9. GodUI 全面校準（未做，使用者已拍板）

原規格 `OAA-UI-NEXT-SPEC.md` §0 明訂兩個視覺參考來源：

- **AskME**（askme.ideaxpress.biz）— 問答優先、單欄閱讀、收斂導覽、克制單色、大留白、細邊框
- **GodUI**（godui.design）— Command Palette、Filter Bar、Dropdown、Drawer、Conversation Thread、Prompt Composer、Agent Timeline、Stepper、Tooltip、Toast、Card 的交互與視覺原則。**只轉譯原則，不引入 React runtime**（GodUI 是 React/TS/Tailwind/framer-motion，本專案是 Vue 3 Global Build + Vanilla CSS）。

### 9.1 元件落地盤點

11 個裡有 10 個存在，缺 **Tooltip**（全站用 26 個原生 `title=""` 代替——原生 tooltip 樣式無法控制、深色模式下是系統白底、手機完全不出現、螢幕閱讀器行為也不一致）。

| GodUI 元件 | 我們的對應 |
|---|---|
| Command Palette | `.ui-next-command`（⌘K） |
| Filter Bar | `.ui-next-filterbar` |
| Dropdown | `.ui-next-account-menu` |
| Drawer | Chat 側欄、手機側欄 |
| Conversation Thread | `.ui-next-thread` |
| Prompt Composer | 首頁問答輸入區 |
| Agent Timeline | `.ui-next-run-list`／執行歷程 |
| Stepper | `.ui-next-status-flow`、SOP 七步、註冊六步 |
| Toast | `.toast-container` |
| Card | `.ui-next-panel` |
| **Tooltip** | **無** |

### 9.2 從 MCP 抽到的動效規律

照文字描述絕對猜不到，必須從源碼取：

- 主要 spring 幾乎都是 **`stiffness 320, damping 32, mass 0.9`**（面板、訊息、抽屜、時間軸、toast 全部同一組）
- 快速回饋用 **`stiffness 520, damping 32`**（dropdown、filter chip、composer）
- Tooltip 例外，很軟：**`stiffness 170, damping 12, mass 0.1`**
- 每個元件都有 `{ duration: 0 }` 分支 —— 那是 `prefers-reduced-motion` 的處理

⚠ **我們沒有 framer-motion**，spring 只能用 CSS `transition`／`@keyframes` 近似。規格 §7 本來就要求支援 `prefers-reduced-motion`，所以動效收斂不算違規，但不會跟 GodUI 一模一樣。

### 9.3 缺的無障礙／鍵盤契約（實測 16/20 未達成）

這份是靜態掃描 `UiNextApp.js` + `UiNextPages.js` 的結果，可直接當工作清單：

| 元件 | 契約 | 現況 |
|---|---|---|
| Command Palette | `role="dialog"` `aria-modal` Escape | ✅ 有 |
| Command Palette | **↑↓ 導航** | ❌ 缺 |
| Command Palette | **開啟時鎖背景捲動** | ❌ 缺 |
| Dropdown | `aria-expanded` | ✅ 有 |
| Dropdown | **`role="menu"` `role="menuitem"` `aria-haspopup`** | ❌ 缺 |
| Dropdown | **方向鍵導航** | ❌ 缺 |
| Filter Bar | **`role="listbox"` `role="option"` `aria-selected"`** | ❌ 缺 |
| Drawer | **`role="dialog"` `aria-modal`** | ❌ 缺 |
| Drawer | **Escape 關閉** | ❌ 缺 |
| Drawer | **開啟時鎖背景捲動** | ❌ 缺 |
| Toast | **`aria-live="polite"`** | ❌ 缺 |
| Stepper | **`aria-current`** | ❌ 缺 |
| Tooltip | **`role="tooltip"`** | ❌ 缺（元件本身就沒有） |
| 共用 | JS 端的 `prefers-reduced-motion` 分支 | ❌ 缺（CSS 端有） |

> **Toast 的 `aria-live` 特別值得先補**：本輪剛修好「錯誤訊息 0ms 就消失」（§5.7），但沒有 `aria-live` 的話對螢幕閱讀器使用者仍是**看不到也聽不到**。

### 9.4 建議做法

拆**兩個平行 agent，用檔案分工避免互相覆蓋**（同一檔案兩個 agent 同時寫會蓋掉彼此）：

- **A** → `app/public/js/ui-next/UiNextApp.js` + `app/public/css/ui-next.css`：Command Palette、Drawer／側欄、Toast
- **B** → `app/public/js/ui-next/UiNextPages.js` + `app/public/css/ui-next-pages.css`：Conversation Thread、Prompt Composer、Agent Timeline、Stepper、Filter Bar、Dropdown、Tooltip（新建）

⚠ **B 要避開 `FROZEN_COPIES` 的 13 個 View**（`frontend-ui-next-frozen-copies.test.js`），動了會紅。

### 9.5 AskMe 風格仍未達成的一項

規格 §5.3 點名：**Chat 的 AI 訊息用大型 bordered card，與 AskMe 的連續閱讀層級不符**，應改成主要內容欄。

**✅ 2026-08-31 夜班已做**（commit `254bfd06`）。AI 訊息去掉 border／背景／卡片陰影改為連續閱讀欄，使用者訊息維持 bubble；訊息欄與 Composer 對齊等寬（實測 computed 皆為 811.989px）。同批也把對話頁的 Composer 改成與首頁問答同一套兩層排法（原本是兩套，違反「不可使用兩套版型或 Composer」的契約）。

⚠ 這項明顯改變 Chat 頁外觀，**RWD 46 張桌機截圖基線需要重建**，且仍待人眼驗收。

### 9.6 取 GodUI 規格的方法（不必重啟 session）

MCP 剛加時工具不在工具列，可用 stdio 直接呼叫。本輪用的腳本邏輯：spawn `npx -y @godui/mcp@0.1.0`，走 `initialize` → `notifications/initialized` → `tools/call`。三個工具：`list_components`、`search_components`、`get_component`。

⚠ `get_component` 一次回 4–16KB 的 React 源碼，11 個會吃掉大量 context。本輪的作法是寫一個抽取器只留四類資訊（動效參數、`role`/`aria-*`、鍵盤處理、尺寸與層級的 Tailwind token），96KB 壓成 4.9KB。**建議照做，不要整包讀進來。**

---

## 10. Definition of Done（沿用並補充）

沿用 `OAA-UI-NEXT-CORRECTION-SPEC.md` §12 全部條件，另補三條：

- Next 的每個 route 都有至少一組通過的瀏覽器截圖（dark/light × 3 viewport），且 console error gate 全程無未 allowlist 的錯誤。
- 每一條加入 `CONSOLE_ALLOWLIST` 的 pattern 都附有「為什麼這不是產品問題」的說明；不接受 `/.*/ ` 或只寫「雜訊」。
- 本文件 §3、§4 的每一項都已標記為「已修正並附證據」或「經核准延期」，不存在未裁決的殘留項。

---

## 附錄：本輪未涵蓋的範圍

**明確聲明未做，不得當成已通過**：

- 未執行任何瀏覽器實測。所有「已修正」僅代表程式碼已改且 jest 通過。
- 未提交任何 mutation（建立／編輯／刪除任務、專案、Chat、Wiki、環境、Release、DB query、Settings 儲存、Admin CRUD）。
- 未驗證匿名、session expired、一般使用者三種身分的實際行為（僅靜態確認 router guard 邏輯）。
- 未量測 RWD（360／768／1024／1440）、未驗證 Keyboard-only 流程、focus trap、screen reader landmark。
- §4.6 的深色模式結論有明確 CSS 特異度佐證，實際渲染色已用瀏覽器 computed style 複驗（深淺各一輪），但**整頁外觀未經人眼確認**。
- 測試最終狀態：**3395 passed / 1 failed**（改動前為 3257 passed / 10 failed）。唯一殘留紅燈 `frontend-status-labels.test.js` 是 §5.2 的結構性假陽性，**刻意不修** —— 修它就等於放寬門檻，會讓真正的狀態表複製一起被放行。拆檔（§7.2）後它會自然轉綠。

### 本輪新增的守衛（都做過鑑別力驗證）

「鑑別力驗證」＝把被修掉的 bug 放回去，確認測試真的會紅。這個 repo 有過「測試全綠但其實什麼都沒測到」的教訓，所以每支新守衛都做了這一步：

| 守衛 | 擋什麼 | 鑑別力驗證方式 |
|---|---|---|
| `frontend-ui-next-frozen-copies` | 13 個逐字複製的 View 靜默漂移 | 在 Legacy 檔注入一行，確認點名該組 |
| `frontend-css-syntax` | CSS 語法錯誤吞掉檔案後段 | 把少括號的 bug 放回去，確認指出行號 |
| `frontend-admin-route-guard` | admin 路由漏旗標、全域 admin gate 復辟 | 記憶體內改造內容跑同一套解析，兩種錯都抓到 |
| `frontend-ui-next-deadcode` | 宣告了卻用不到的 method／data | 把 `specReqOpen` 從 template 拿掉，確認點名 |
| `rwd-gate`（擴充） | 新增 route 卻忘了加進截圖清單 | 拿掉 `#/tasks`，確認點名 |
| `frontend-toast-id`（擴充） | `duration=0` 被當成 0ms | 把 `setTimeout` 改回無條件，確認變紅 |
