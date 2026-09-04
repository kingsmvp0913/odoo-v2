# Odoo 認證考試系統 — 交接

> 2026-09-05 更新。換機器接手看這份就夠。
> **這個檔在 repo 根目錄，會進版控**（`docs/` 底下的東西不會，所以規格與計畫沒辦法傳過去，見下方「換機器要注意」）。

---

## 一句話現況

核心引擎與考試頁主流程已改完：外部程式 POST 截圖與作答後會自動排隊，先抄題、
只對「同 Odoo 版本且有官方確認答案」的命中題直接回覆，其餘才跑新對立審查；
考試頁則顯示完整選項，用 checkbox 設定正式答案，並在下方摘要輸入／審查／最高票答案。
舊題庫 120 題已匯入目前平台 DB。

目前完整實測卡在**本機 Claude CLI 的 OAuth session 過期**；POST、落 DB 與自動啟動 worker
皆已實際走到，worker 呼叫 Claude 時才失敗。重新登入 Claude 後需再跑一次官方命中與未命中案例。

---

## 立刻要知道的三件事

1. **`cron.test.js` 有一支紅燈，不是這次改壞的。**
   已用 `git stash` 把本次全部改動移除後複驗，一樣紅。那支是
   「cron tick：上次健檢超過一個週期 → 再跑一次」。**接手時不要為了它去改 exam 的碼。**

2. **新版考試頁已補靜態契約測試，但仍未登入瀏覽器做畫面驗收。**
   無登入狀態開啟只會進登入頁。**深色模式仍未驗過。**

3. **改 `app/server/**` 要重啟才生效；改 `app/public/**` 不用**（靜態直接服務，
   server 會用檔案 mtime 當快取版本號，普通重整就會拿到新的）。

---

## 還沒做的（照重要性排）

### 1. 修正考試收件／審題／結果頁 — 已實作，待登入後畫面驗收

**只改考試流程與考試頁，`ExamBank` 題庫頁不要改。**

**考試工作台標題右側不要題庫下拉選單。** 考試頁只看目前最新一場；右上角以單一
「題庫」按鈕進題庫頁。更多工具只留一個「ODOO認證輔助」入口並優先進 `/exam-run`。
歷史考試歸檔後從題庫頁查看。外部 API 必須帶 Odoo 版本，不能靠人在考試頁選版本。

目前錯誤流程：

```
平台使用者開 /exam-run → 手動選圖＋輸入答案 → 上傳 → 再按「開始判題」
```

需求流程（比照舊 `odoo19_test` 的使用方式，但沿用目前 PostgreSQL、worker、登入與 token 架構）：

```
外部程式 POST 截圖＋輸入答案
  → server 自動排入審題，不需要平台使用者再按開始
  → 先抄題並查官方題庫（見下一節）
  → 官方未命中才跑目前新的對立審查
  → 寫入 DB
  → socket 通知考試頁重拉 DB 現況
  → 考試頁即時顯示一致／不一致與各答案
```

考試頁每一題的呈現規則：

| 欄位 | 定義 |
|---|---|
| **輸入答案** | 外部 POST 進來的作答答案（目前資料層的 `answer_their`），直接在對應選項標綠色「輸入答案」 |
| **審查答案** | 題庫命中官方確認正確答案時鎖定整題；其餘在對應選項標紅色「審查答案」。若與輸入答案相同，只顯示綠色輸入答案 |
| **投票答案** | 畫面不顯示姓名，但同一平台使用者每題只能投一次，投完所有投票按鈕消失；最高票選項直接標示 `投票 N%`，零票顯示 `投票 -` |
| **正式答案** | 直接在完整選項前以 checkbox 勾選（資料層 `answer_final`）；新 POST 題目預設採用輸入答案。已選項目可再點掉，全部取消即為空白／NULL |

頁面保留總題數／一致／不一致／處理中統計、按頁碼查看、只看不一致與即時更新；
逐題理由、信心度及題目下方答案摘要已依 2026-09-05 使用者回饋從考試頁移除，資料仍留在 DB／API
供歸檔題庫使用。**統計下方不要批次頁籤**：一場考試就是一份題庫，考完上傳圖片後
直接歸檔到該題庫，另分批次是重複層級。主流程不是讓人在頁面上傳。

目前已完成：POST 自動排隊、dashboard API、固定 5 秒 DB 回查（避免漏掉 socket 事件）、
完整選項與正式答案 checkbox、匿名顯示且每人每題一票、最高票百分比直接標在選項、
正式答案可清成 NULL、移除題目下方答案摘要、批次頁籤與版本選單。
官方確認題以鎖定列顯示且不可展開，server 也禁止對官方題投票或修改正式答案。
外層考試頁卡片不因不一致變紅；只有輸入與審查不同的題目預設展開並顯示淡紅底。
題目列不顯示原生展開箭頭、所有狀態左側色條均已移除；focus 樣式沿用平台既有規則。

多人即時同步：POST／worker、投票及正式答案修改都會 `emitAll('exam-progress')`，所有已登入
瀏覽器收到後以 500ms debounce 重抓 dashboard；socket 中斷或漏訊時另有固定 5 秒 DB 輪詢。
投票以平台 `userId` 作匿名唯一鍵，因此必須每人使用自己的平台帳號；使用者已確認正式使用時
會有多個帳號。多人同時修改正式答案採最後寫入者為準。

相關檔案：

- `app/public/js/ui-next/pages/ExamRun.js`：即時結果工作台、完整選項、正式答案與投票 UI。
- `app/server/exam-upload-routes.js`：POST 自動排隊、dashboard、投票與正式答案 API。
- `app/server/lib/exam/worker.js`：先抄題查官方答案，未命中才審查。
- `app/server/db.js`：上傳與 attempt 關聯、批次欄位及投票資料表。

### 2. 判題前先查題庫（原 Task 2.7）— 已實作，待 OAuth 恢復後完整實測

`review.js` 已拆成抄題與審查兩階段，`worker.js` 已在兩階段之間以 fingerprint、
Odoo 版本與 `official_from` 查官方答案；非官方命中仍會送審。

使用者已拍板的做法（兩階段）：

```
① 讀圖抄題（抄題幹＋選項＋翻譯，並標記哪幾題有圖／圖表）— 不審查
   ↓ 逐題算 fingerprint 查 exam_items
 命中且有官方確認正確答案 → 直接採用，不審查、不取證、信心 100
   ↓
 沒命中 → ② 審查
          ├─ 沒圖的題 → 純文字審（用①抄出來的題幹與選項）
          └─ 有圖的題 → 重讀圖審
```

**為什麼要在①標記「這題有沒有圖」**：純文字審看不到圖，而「依圖中三條上架規則會放到
哪個位置」這種題沒有圖就是瞎猜。但每題都重讀圖又太貴——新考卷大多數題不在題庫裡，
那是常態不是例外。實測 120 題裡真正非看圖不可的約 2–3 題。

**只有官方確認正確的題才能直接採用。** 題庫裡只有歷史作答或 AI 審查結果，即使 fingerprint
命中也不能直接回覆，仍要走目前新的對立審查。查詢必須同時限制同一 Odoo 版本，避免跨版本誤用。

**命中官方答案的題不要寫 `adversary` verdict**：它沒被審查過，寫一筆假的判斷會讓信心度分層
讀到不存在的證據。信心度由 `answer_official` 直接給 100（`baseConfidence` 第一層本來就是）。

要動的檔：`app/server/lib/exam/review.js`（加「只抄題」與「純文字審」兩支）、
`app/server/lib/exam/worker.js`（`processUpload` 改兩階段）。

### 3. POST → 自動審題 → 結果頁完整實測

修正後必須真的跑一次完整流程：外部 POST → 自動觸發 worker → 官方題命中短路／非官方題走
對立審查 → socket 即時更新 → 考試頁在完整選項直接標示輸入／審查／最高票百分比 → 結果進 DB。
至少要各驗一題「官方命中」與「未命中需審查」，並驗證正式答案初值等於 POST 答案、
取消全部勾選後可保持 NULL。

### 4. 外部 API 帶入 Odoo 版本 — 尚待確認 POST 分組契約

考試頁版本選單已移除。仍需確認外部程式是「一次 POST 整場所有圖片」，還是「逐頁 POST」；
前者可由每次 batch 自動建立一份該版本的題庫，後者另需一個考試識別值，否則 server 無法判斷
同版本的多個頁面屬於同一場或下一場。確認後再固定 API 欄位與測試。

### 5. `data/exam/upload-token.txt` 還沒建

不建的話**外部同事上傳一律 503**。內容就一行通行碼。
（平台帳號登入的人不受影響——`checkExamToken` 有 JWT 放行分支。）

### 6. 深色模式人工檢查

題庫頁與作戰台都沒在深色模式下看過。CSS 全部走 `var(--*)` 沒有寫死顏色，
理論上沒問題，但這條規則（`rules/frontend.md` 第 30 條）要求人工實測。

### 7. 已知的即時同步邊界

- 同一份題庫內可即時同步；若使用者開頁後另建立一份新題庫，目前頁面不會自動切換 bank。
- socket 快速路徑約 500ms 後重抓；備援輪詢最慢約 5 秒，不是逐 DOM event 的硬即時。
- 多個 refresh 可同時執行，極端情況下較早發出的舊回應可能較晚返回並造成短暫舊畫面；
  若正式壓測遇到再加 request sequence guard。
- 本機 DB 有一份 `介面預覽（假資料）`（bank id 2、3 題），不在 Git 內；換機器不會跟著 push。

---

## 已經做完並驗證過的

| 項目 | 證據 |
|---|---|
| 對立審查取代盲判 | 實測 **30/30**（盲判 28/30）、假陽性 **0/27**、每題 10.4s |
| 資料層 9 張表 | 120 題、47 題官方確定、19 章節、**25,015 條術語** |
| 中英雙語 | **選項中譯 120/120**（術語表優先，官方譯法鎖死） |
| 信心度＋章節校準 | 校準後風險總和 **15.03**，官方說 15，誤差 0.03 |
| 取證（信心 < 90） | 150 筆原始碼行號 |
| 題庫介面 | 章節分組、單一信心度、EN／中切換、搜尋 |
| 上傳＋佇列 worker | 併行 3、進度存 DB、重啟可續跑 |
| `odooGlossary` skill | 已註冊並同步到 `.agents/` |

**19 頁全跑的結果**：推翻 8 題，而官方說錯 15 題 ⇒ **約 7 題是盲區**（審查與作答者
一起錯，交叉驗證看不見）。信心最低的兩題都是 Accounting，只有 4%。

---

## 實跑的成本數字（估算用）

- **約 24 秒／題**（審查 15.6s ＋ 58% 的題要取證）
- **題數越多的頁每題越慢**：5 題 9.4s/題、12 題 24.3s/題
  （一次呼叫要抄完整頁的題幹與所有選項再翻譯，內容越多輸出越長）
- 120 題約 48 分鐘（序列）。併行 3 可壓到 16–20 分鐘，但 worker 已內建併行，
  CLI（`tools/exam-review-run.js`）仍是序列
- 逾時預設 **1200 秒**（`EXAM_JUDGE_TIMEOUT_MS`／`EXAM_EVIDENCE_TIMEOUT_MS`）。
  180s 在一頁 8 題時撞到過；12 題的頁實測 292s

---

## 接手前必讀的坑

### pg-mem 有三個相容性差異（測試綠 ≠ 正式對）

1. **`ON CONFLICT DO NOTHING RETURNING` 在真衝突時仍回一列** ⇒ 用 `rows.length` 判斷
   「新增 vs 合併」會讓測試環境永遠走錯邊。改成**先 SELECT 再分岔**。
2. **不支援 `NULLIF`** ⇒ 把判斷搬回 JS，SQL 保持最笨的 UPDATE。
3. **不支援相關子查詢**（子查詢引用外層欄位）⇒ 改 `LEFT JOIN` + `GROUP BY`，
   或全撈出來在 Node 端合併。**症狀會偽裝成「測試卡住」**——240s 沒輸出，
   換 `--detectOpenHandles` 才看到 6.9 秒就報錯了。懷疑卡住時先跑一支已知會過的
   同類測試當對照組。

### 安全：agent 拿得到 Read/Grep，而官方答案就在同一個 repo 裡

- **prompt 不給絕對路徑**：截圖複製進每次呼叫獨立的暫存目錄，只給檔名 `shot.jpg`。
  給絕對路徑等於告訴 agent repo 在哪，它可以自己去讀 `answer-key.json`。
- **取證用 symlink 縮視野**：cwd 是 tmpdir 空目錄，底下只放 `src/` → `data/odoo-core/<ver>/`。
- **Node 端硬驗 evidence 的 ref 落在 `src/` 內**否則丟棄——prompt 裡的限制是 soft instruction。
- 殘留風險：`--dangerously-skip-permissions` 是無人監督自動化的必要條件，
  真正的隔離要靠容器。目前是「不給線索」而非密不透風。

### 前端

- **CSS class 一律 `ui-next-` 開頭**（`frontend-ui-next.test.js` 會擋）。
- **新路由要補 `app/rwd/routes.js`**（`rwd-gate.test.js` 會擋）。
- **grid 的欄數必須等於直接子元素個數**——少一欄的後果是多出來的元素掉到下一列，
  版面亂掉而沒有任何錯誤訊息。實測踩過（找了三輪才發現）。
- **computed 在 template 不能加括號**（加了直接 TypeError 白畫面）。
- 改 `app/public` 不需要重啟也不需要 push，存檔即生效。

### 資料判讀

- **`certain` 必須獨立於 `official_from` 存**：那 47 題的 `officialFrom` 標的是 `manual`
  （原專案 build-bank 讓 `prev.official` 分支優先），只查 `section-all-correct` 會數出 **0 題**。
- **`incorrect === 0` 不等於「官方全對」**：沒作答的題不算錯也不算對。
  POS 是 3 題答對 2、未答 1。
- **官方譯法港台混用**（`Journal Entry` → 日記**賬**記項），**不要修成台灣用語**——
  考試畫面印的就是這些字。

---

## 換機器要注意

**規格、計畫、驗證報告全在 `docs/` 底下，而 `docs/` 在 `.gitignore` 內**，
所以 **push 不過去**。要帶走的話得手動複製：

- `docs/superpowers/specs/2026-09-04-odoo-exam-platform-design.md` — 設計規格（含 §4.6.1 兩階段設計）
- `docs/superpowers/plans/2026-09-04-odoo-exam-platform.md` — 實作計畫
- `docs/superpowers/specs/2026-09-04-adversary-bench-result.md` — 對立審查驗證報告
- `docs/superpowers/specs/solve-md-patch.md` — `/solve` 要貼的段落（那個檔在 Windows 那台）

**`data/exam/` 也不進版控**（截圖是二進位、`answer-key.json` 含官方答案）。
新機器要重跑的話得重新從 `https://github.com/kingsmvp0913/odoo19_test.git` 取。

**題庫資料在平台 DB 裡**（`claude` DB／port 5416），換機器要一起搬 DB 才有那 120 題。

---

## 常用指令

```bash
# 全跑測試（一律用這個，不要 npx jest——平行 worker 下 pg-mem 會浮動假紅）
cd app && npm run test:quiet

# 匯入舊題庫
node tools/exam-import.js data/exam/banks/2026-08-14-1 2026-08-14-1 19

# 對既有題庫跑審查（已審過的頁自動跳過，--force 強制重審）
node tools/exam-review-run.js 2026-08-14-1 all
node tools/exam-review-run.js 2026-08-14-1 13        # 只跑第 13 頁

# 查題庫資料
node .claude/skills/platformDB/query.js "SELECT COUNT(*) FROM exam_items"

# 查 Odoo 官方繁中術語
node .claude/skills/platformDB/query.js \
  "SELECT term_en, term_zh FROM exam_glossary WHERE odoo_version='19' AND term_en ILIKE '%order%' ORDER BY hit_count DESC LIMIT 20"
```

## 環境變數

| 變數 | 預設 | 用途 |
|---|---|---|
| `EXAM_JUDGE_MODEL` | `opus` | 審查與取證的模型。**不要改成 sonnet**（實測 28/30 vs opus 30/30） |
| `EXAM_JUDGE_TIMEOUT_MS` | 1200000 | 單次審查呼叫（一整頁） |
| `EXAM_EVIDENCE_TIMEOUT_MS` | 1200000 | 單次取證呼叫（一題） |
| `EXAM_CONCURRENCY` | 3 | worker 併行數。**不要調高**——Claude 帳號全平台共用，會排擠開發 pipeline |
| `EXAM_BATCH_LIMIT` | 50 | 一次批次上傳的上限 |
