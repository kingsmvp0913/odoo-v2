# 工作平台 RWD 改造規格書（C 方案）

> 對象：`app/public`（Vue 3 + 原生 CSS 的前端）。**不動 `app/server`**。
> 分塊原則：每塊約 8 小時 agent 時間，**每塊結束時平台必須完全可用**。
> 建立：2026-08-04 ｜ 進度勾選規則見文末〈§7 進度回報〉。

---

## §1 目標與範圍

把工作平台從「桌機專用」改成手機／平板／桌機皆可正常使用（C 方案：手機原生體驗，含資訊層級重排、圖表響應式、底部導覽、PWA）。

**範圍內**

| 項目 | 數量 |
|---|---|
| 路由 / View 檔 | 23 條 / 21 檔（5,891 行） |
| `app/public/css/app.css` | 606 行 |
| inline style（layout 相關，必須遷移） | 166 處（flex/grid 106、固定寬 37、grid-template 8、nowrap 15） |
| `<table>` | 16 個 / 8 檔 |
| shell（`app/public/js/app.js` template） | 1 處 |

**範圍外（明確不做）**

- `app/server/**` 任何檔案 — 動了就要重啟常駐 server（`rules/always.md` 3），與「不影響使用」直接衝突。
- 754 處 inline style 中**純顏色／字級／間距的 510 處** — 與 RWD 無關，動它只是擴大風險面。
- 更換前端框架、引入 build step、引入 CSS 框架 — `rules/frontend.md` 31 已判定「換框架治不了病因」。
- Terminal（xterm）、TaskDetail 的 diff view — 只做「可捲動＋提示」降級，不做手機版重新設計。

---

## §2 硬約束：不能影響網站使用

這是本專案的第一約束，優先於進度。以下三層保證缺一不可。

### 2.1 樣式層 — 桌機路徑零改動

**所有新增的 RWD 樣式一律寫在 `@media (max-width: ...)` 內。** 桌機（≥1024px）永遠走原本那份 CSS，不進任何新規則。

唯一例外是 §2.2 的等價遷移，該情境有專屬驗收標準。

### 2.2 遷移層 — inline style 抽 class 必須「值等價」

166 處 layout inline style 要抽成 class 才能被 media query 覆寫（inline style 優先權高於 media query，不抽就改不動）。這是唯一會碰到桌機路徑的工作，硬規則：

- 抽出的 class 內容**與原 inline style 逐字相同**，不順手改值、不合併相似規則、不改順序。
- 想調整的值一律留到後續 Block、在 media query 內處理。
- 驗收是像素級的：桌機截圖 diff 必須為 0。

> 這條看起來過度嚴格，但它是讓「不影響使用」可被機器驗證的前提。一旦允許順手改值，就再也無法用 diff 區分「我改的」與「我弄壞的」。

### 2.3 交付層 — 每塊獨立可回滾

- 一個 Block 一個 commit，commit 訊息依 `CLAUDE.md` §3：`[Module]: Why (not what)`。
- 純前端靜態檔，瀏覽器重新整理即生效，**不需重啟 server、不需停機**。
- 任一 Block 出問題 → `git revert` 該 commit 即完全復原，不影響其他 Block。
- 部署時段：仍建議挑低使用時段，避免使用者在切換瞬間拿到半新半舊的快取。

### 2.4 驗收機器：138 張截圖

23 路由 × 2 主題（淺／深）× 3 斷點 = 138 張。用途分兩類：

| 類別 | 張數 | 作用 |
|---|---|---|
| 桌機 1440px | 46 | **回歸門禁**：每個 Block 完成後 diff 必須為 0 |
| 平板 820px ／ 手機 390px | 92 | **進度證據**：從破版逐步變成可用 |

`rules/frontend.md` 30：前端零自動化測試、改動一律人工實測。138 組人工目測會在每個 Block 重複發生，所以 Block 0 先把它自動化——這不是額外功能，是本專案的驗收基礎設施。

**已知覆蓋缺口**（誠實列出，不假裝 100%）：`/task/:id/terminal` 需要實際執行中的任務、`/projects/:id/db` 需要可用的遠端連線，這兩條無法穩定造資料，列入人工檢查清單，不計入自動 diff。實際可自動截圖的預估為 18–20 條路由。

---

## §3 全域技術決策

### 3.1 斷點

```
手機   ≤ 640px
平板   641px – 1023px
桌機   ≥ 1024px   ← 不進任何新規則
```

登記進 `app/public/styleguide.html`（`rules/frontend.md` 31：新功能一律從 styleguide 挑 token，禁目測填 px）。

### 3.2 `--ui-zoom` 的處理 — 本專案最大的地雷

`app.css:197` 有 `body { zoom: var(--ui-zoom) }`（目前 1.1），且 `height: calc(100vh / var(--ui-zoom))` 是為了補償 zoom 把 `100vh` 一起放大。

影響：`zoom` 不改變 media query 的判定基準（仍按真實 viewport），但會把內容放大 1.1 倍 → 390px 的手機實際可用寬只剩約 355px，且任何 `100vw` 元素會直接溢出。

**決策：不改預設值，只在 ≤1023px 用 media query 覆寫為 1。**

```css
@media (max-width: 1023px) {
  :root { --ui-zoom: 1; }
}
```

桌機維持 1.1 完全不變；小螢幕不必再為 zoom 折算斷點。這條必須在 Block 1 最先做，否則後面每一塊的目測結果都會被 1.1 倍污染。

### 3.3 高度單位

`body { height: 100vh }` + `.main { overflow: hidden }` 的 app-shell 在手機會被動態網址列裁掉底部。小螢幕改用 `dvh`，同樣只在 media query 內。

### 3.4 模型分流（影響用量，見 §8）

- **Opus**：shell 改造、資訊層級決策、SVG 圖表響應式
- **Sonnet**：inline style 等價遷移、PWA、截圖回歸、機械性重寫

`rules/infra.md` 136：範圍窄、有明確答案的工作一律 Sonnet，用高階模型會撞 session limit。

---

## §4 Block 完成度總覽

| # | Block | 時數 | 主力模型 | 狀態 |
|---|---|---|---|---|
| 0 | 截圖基線與斷點骨架 | 8h | Sonnet | [ ] |
| 1 | viewport 地基與 sidebar drawer | 8h | Opus | [ ] |
| 2 | inline style 等價遷移（第一批） | 8h | Sonnet | [ ] |
| 3 | inline style 等價遷移（第二批） | 8h | Sonnet | [ ] |
| 4 | 表格與清單的手機型態 | 8h | Sonnet | [ ] |
| 5 | 逐頁資訊層級重排（任務流程） | 8h | Opus + Sonnet | [ ] |
| 6 | 逐頁資訊層級重排（Admin 與工具頁） | 8h | Opus + Sonnet | [ ] |
| 7 | 圖表響應式、底部導覽、PWA | 8h | 混合 | [ ] |
| | **合計** | **56h** | | |

---

## §5 各 Block 規格

### Block 0 — 截圖基線與斷點骨架

**目標**：建立可自動驗證「桌機沒被弄壞」的機器。本 Block **不改任何既有樣式**。

**動到的檔案**
- 新增 `app/tests/visual/`（截圖腳本與基線圖）
- `app/package.json`：新增 `visual:baseline` / `visual:check` script 與 Playwright devDependency
- `app/public/css/app.css`：僅在檔尾新增**空的**斷點區塊與註解
- `app/public/styleguide.html`：登記斷點 token

**實作要點**
- 檔名**不可**用 `*.test.js` 放在 `tests/` 下 — `app/package.json` 的 jest `testMatch` 是 `**/tests/**/*.test.js`，命中就會被 `npm run test:quiet` 撈進 node 環境跑而爆掉。用 `capture.js` / `compare.js` 之類的名字，走獨立 npm script。
- 截圖需登入：腳本要能帶測試帳號取得 token（沿用既有登入流程，勿新增後端端點）。
- 環境已預裝 Chromium：`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`，**不要跑 `playwright install`**。
- 路徑一律相對 repo 根或走環境變數（`CLAUDE.md` §0：禁止寫死絕對路徑）。

**驗收**
- [ ] 產出桌機 1440px 基線圖（含淺／深兩主題）
- [ ] 產出平板 820px、手機 390px 現況圖（此時預期破版，這是起始證據）
- [ ] `npm run visual:check` 在無改動時 diff = 0
- [ ] `cd app && npm run test:quiet` 的 `Tests: X passed` 數量與改動前一致（新腳本沒被 jest 誤撈）
- [ ] 瀏覽器實測：平台功能與外觀完全未變

**回滾**：revert 單一 commit；本 Block 未改既有樣式，回滾無副作用。

---

### Block 1 — viewport 地基與 sidebar drawer

**目標**：讓小螢幕有「正確的畫布」與「可用的導覽」。這是後續所有 Block 的前提。

**動到的檔案**
- `app/public/css/app.css`（斷點內）
- `app/public/js/app.js`（shell template，`app.js:147` 起）

**實作要點**
1. `@media (max-width: 1023px) { :root { --ui-zoom: 1 } }` — 必須第一個做（§3.2）
2. 小螢幕高度改 `dvh`
3. `.sidebar`（220px 寫死、無收合）→ drawer：漢堡鈕、遮罩、路由切換自動關閉、Esc 關閉
4. **桌機路徑完全不變**：drawer 相關樣式只在 ≤1023px 生效，≥1024px 仍走原本的 flex layout

**注意**
- 新增的全域 UI 元件依 `rules/frontend.md` 35 仿 `showToast` 模式（全域函式＋reactive state＋App template 渲染 host），載入序在 `store.js` 後、`app.js` 前。
- 深色模式必測：sidebar 有大量 `rgba(255,255,255,...)` 硬值，drawer 化後要確認遮罩層疊順序（`--z-dropdown: 100` / `--z-modal: 1000`）。

**驗收**
- [ ] 桌機 46 張截圖 diff = 0
- [ ] 手機 390px：drawer 可開關、點連結自動關閉、遮罩可關閉
- [ ] 手機 390px：無橫向捲動（zoom 修正生效）
- [ ] 手機瀏覽器捲動到底不被網址列裁切
- [ ] 深色模式下 drawer 與遮罩配色正確
- [ ] 平板 820px：sidebar 行為符合預期

**回滾**：revert 單一 commit。drawer 與 zoom 修正在同一 commit，避免只回滾一半留下 zoom=1 但無 drawer 的破碎狀態。

---

### Block 2 — inline style 等價遷移（第一批）

**目標**：把兩個最大檔的 layout inline style 抽成 class。**嚴格遵守 §2.2 值等價**。

**動到的檔案**
- `app/public/js/views/TaskDetail.js`（1,191 行 / 127 處 inline style）
- `app/public/js/views/TokenReport.js`（525 行 / 127 處 inline style）
- `app/public/css/app.css`（新增等價 class）

**只遷移這幾類**（其餘 inline style 原地不動）
- `display: flex` / `display: grid`
- 固定 px 寬（≥100px）
- `grid-template-columns`
- `white-space: nowrap`

**驗收**
- [ ] 桌機 46 張截圖 diff = 0 ← 本 Block 唯一真正的驗收標準
- [ ] 新增 class 命名與既有慣例一致，值與原 inline 逐字相同
- [ ] 兩檔的目標類 inline style 已清空
- [ ] 深色模式無變化（本 Block 不應影響任何顏色）

**回滾**：revert 單一 commit。

---

### Block 3 — inline style 等價遷移（第二批）

**目標**：其餘 19 個 view 檔的同類遷移。規則與 Block 2 完全相同。

**動到的檔案**：`app/public/js/views/` 其餘 19 檔、`app/public/js/release-modal.js`、`app/public/css/app.css`

**驗收**
- [ ] 桌機 46 張截圖 diff = 0
- [ ] 全 `app/public` 的 layout 類 inline style 歸零（`display:flex|grid`、固定寬、`grid-template`、`nowrap`）
- [ ] 深色模式無變化

**回滾**：revert 單一 commit。

---

### Block 4 — 表格與清單的手機型態

**目標**：16 個 table 在手機可讀。

**動到的檔案**
- `app/public/js/views/TokenReport.js`（3 個 table **缺 `.table-wrap`**，是全站唯一沒包的）
- 高頻表格所在 view：`AdminUsers.js`、`AdminPipelines.js`、`AdminRejections.js`、`ProjectDbQuery.js` 等
- `app/public/css/app.css`

**實作要點**
- 先補齊 `.table-wrap`（`app.css:486` 已有 `overflow-x: auto`，這是既有機制，直接沿用）
- 手機（≤640px）：高頻表格改卡片式呈現（每列一張卡、欄名作標籤）
- `ProjectDbQuery` 的查詢結果表格**維持橫向捲動**，不卡片化 — 欄位數不固定，卡片化反而更難讀
- 觸控目標 ≥44px

**驗收**
- [ ] 桌機 46 張截圖 diff = 0
- [ ] TokenReport 3 個 table 已包 `.table-wrap`
- [ ] 手機 390px：所有表格不造成頁面橫向捲動（表格自身可捲）
- [ ] 高頻表格在手機以卡片呈現且資訊完整
- [ ] 深色模式下卡片邊框／底色正確

---

### Block 5 — 逐頁資訊層級重排（任務流程）

**目標**：使用者每天在走的 6 頁，在手機上以「重要的先出現」重新排列。

**頁面**：`TaskList`(609) / `TaskDetail`(1,191) / `ProjectList`(169) / `ProjectDetail`(404) / `Settings`(368) / `Login`(251)

**實作要點**
- 手機優先顯示：任務狀態、待處理動作、主要按鈕；次要 meta 收折
- modal 在手機改全屏（`.modal` 已有 `max-width: 100%`，`app.css:474`，基礎可沿用）
- TaskDetail 的 diff view 維持橫向捲動並加提示，不重新設計（§1 範圍外）
- Login／註冊已有 640px 斷點（`app.css:536`），檢查與新斷點是否衝突，衝突則統一到 §3.1

**驗收**
- [ ] 桌機 46 張截圖 diff = 0
- [ ] 6 頁在手機 390px 主流程可完成（建任務、看任務、回答澄清、審核）
- [ ] 6 頁在平板 820px 版面合理
- [ ] 深色模式全數確認
- [ ] 表單送出只取當前題目鍵值（`rules/frontend.md` 37）未被破壞

---

### Block 6 — 逐頁資訊層級重排（Admin 與工具頁）

**目標**：其餘 15 頁。多為表格頁，吃 Block 4 的成果，單頁成本低於 Block 5。

**頁面**：`Admin` / `AdminUsers` / `AdminAgents` / `AdminPipelines` / `AdminHealthCheck` / `AdminRejections` / `AdminClassifySamples` / `AdminPromptLogs` / `AdminPortPool` / `AdminEnterprise` / `WikiView` / `ProjectChat` / `ProjectDbQuery` / `Terminal` / `TokenReport`（表格部分）

**實作要點**
- `Terminal`（xterm）：手機明確降級 — 橫向捲動＋「建議在桌機使用」提示，不做手機版終端機
- `WikiView` / `ProjectChat`：長文與對話流，手機主要調整行寬與輸入區固定位置
- admin 頁的隱藏邏輯三處齊做的既有規則（`rules/frontend.md` 38）不得因重排而破壞

**驗收**
- [ ] 桌機 46 張截圖 diff = 0
- [ ] 15 頁在手機 390px 不破版
- [ ] Terminal 降級提示存在且不阻擋桌機使用
- [ ] admin 頁在非 admin 帳號下仍正確隱藏
- [ ] 深色模式全數確認

---

### Block 7 — 圖表響應式、底部導覽、PWA

**目標**：C 方案的加值項。這是唯一可以整塊砍掉而不影響前 7 塊價值的 Block。

**實作要點**
1. **TokenReport SVG 圖表**：圓餅與圖例在手機改為上下排列，圖例可捲；沿用既有 `--cat-1`～`--cat-20` 類別配色（`app.css:63`），**不得新增顏色**
2. **底部導覽**：手機 ≤640px 顯示底部 tab（任務／專案／Pipeline／設定），與 drawer 並存不衝突
3. **PWA**：`manifest.json`、icon、service worker（僅做離線殼與靜態資源快取）

**PWA 的風險提醒**：service worker 的快取會讓使用者拿到舊版前端，與「不影響網站使用」直接衝突。必須採 network-first 或帶版本號的 cache busting，且上線前確認「改一次 CSS → 重整能拿到新版」。若無法在本 Block 內確定這件事，**PWA 應延後，不要硬上**。

**驗收**
- [ ] 桌機 46 張截圖 diff = 0
- [ ] 圖表在手機可讀、圖例不溢出
- [ ] 底部導覽在手機可用，與 drawer 無重疊衝突
- [ ] PWA 可安裝，且改動前端後重整能取得新版（若不成立則移除 PWA）
- [ ] 深色模式全數確認

---

## §6 全域檢查清單（每個 Block 都要過）

- [ ] 桌機 1440px 截圖 diff = 0
- [ ] 深色模式人工實測（`rules/frontend.md` 30、32：寫死淺色在深色模式會維持亮底）
- [ ] 未使用 `.btn-secondary`（`app.css` 從未定義，用了等於裸按鈕 — `rules/frontend.md` 33）
- [ ] `computed` 的值呼叫端未加括號（`rules/frontend.md` 34）
- [ ] 引用的前端 helper 名稱已核對 `api.js` / `dialog.js`（`rules/frontend.md` 36）
- [ ] 新樣式的 px／色值取自 `styleguide.html` 的 token（`rules/frontend.md` 31）
- [ ] commit 前 `git status --porcelain -uno` 逐檔挑選，**禁用 `git add -A`**（`rules/always.md` 4）
- [ ] 未動 `app/server/**`

---

## §7 進度回報與勾選規則

1. 每完成一個 Block，**回到本檔**把該 Block 的驗收 checkbox 與 §4 總覽的狀態一併勾起來。
2. 勾選的唯一標準是驗收條件全數通過。**部分完成不勾**，改在該 Block 標題下加一行 `> 進行中：<還差什麼>`。
3. 驗收沒過就不要進下一個 Block — 桌機 diff 一旦破功，後面每一塊都在不確定的地基上疊。
4. 勾選與該 Block 的程式改動放同一個 commit，讓「規格書狀態」與「程式狀態」永遠一致。
5. 若某 Block 實作後發現規格有誤，**先改本檔再改程式**，並在該 Block 下記一行原因。

---

## §8 用量預算與閘門風險

### 8.1 預算

| | 用量 | 佔 Max 5x 週額 |
|---|---|---|
| Opus 部分 | 11–15h | 31%–100% |
| Sonnet 部分 | 34–45h | 12%–32% |
| **seven_day 總體** | **45–60h** | **約 30%–60%** |

output token 量級約 80–120 萬（依 `rules/infra.md` 160，全價 input 僅佔 0.4%，估算只需盯 output）。

### 8.2 閘門風險（比額度本身更重要）

平台是**單一 Claude 帳號共用**（`rules/infra.md` 134），本專案吃的是正式 pipeline 在吃的同一條 `seven_day`。`usage-gate.js:16` 的 7 日門檻預設 **95%**，觸發即暫停所有任務自動推進。

**用內部優化把產線停掉，代價遠超省下的時間。**

**排程建議**：8 個 Block 攤成 **3–4 週**，每週 2–3 塊、增量控在 10%–20%。每週開工前先看一次 sidebar 的用量 bar，接近門檻就順延。

### 8.3 校準（把上表誤差壓到 ±10%）

上表的「時數 → %」換算是整份規格最沒把握的一環（Anthropic 只公布時數區間，不公布 token 額度）。你們手上有直接算法：`claude-usage.js` 會把 `seven_day.utilization` 存進 `data/claude-usage.json`，配 `token_usage` 表即可反推「1% = 多少 output token」。

```sql
-- 平台 DB（claude / port 5416）；查某段期間的實際消耗
SELECT DATE_TRUNC('day', created_at) d,
       SUM(output_tokens) out_tok,
       SUM(input_tokens)  in_tok,
       SUM(cache_read_tokens) cache_read
FROM token_usage
WHERE created_at > NOW() - INTERVAL '14 days'
GROUP BY 1 ORDER BY 1;
```

拿「某週 utilization 從 X% 走到 Y%」除以同期 `SUM(output_tokens)`，得到本帳號的真實換算率，再把 §8.1 的 80–120 萬 output 代入，即可取代上表的推估值。**建議在 Block 0 完成時做一次**，之後每個 Block 用實績滾動修正。
