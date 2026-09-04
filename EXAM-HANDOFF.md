# Odoo 認證考試系統 — 交接

> 2026-09-04 收工。換機器接手看這份就夠。
> **這個檔在 repo 根目錄，會進版控**（`docs/` 底下的東西不會，所以規格與計畫沒辦法傳過去，見下方「換機器要注意」）。

---

## 一句話現況

核心引擎全部做完並實測過（120 題已進正式 DB，對立審查實測 30/30），**介面能看能用**，
**上傳到判題的整條路也接起來了**，但**「判題前先查題庫」這個你最初的需求 1 還沒接上**。

---

## 立刻要知道的三件事

1. **`cron.test.js` 有一支紅燈，不是這次改壞的。**
   已用 `git stash` 把本次全部改動移除後複驗，一樣紅。那支是
   「cron tick：上次健檢超過一個週期 → 再跑一次」。**接手時不要為了它去改 exam 的碼。**

2. **前端一次都沒在瀏覽器自動驗證過**（此 repo 沒有 playwright，前端本來就沒有自動化測試）。
   使用者已人工看過題庫頁並提了 6 輪修改，都已修完。**深色模式仍未驗過。**

3. **改 `app/server/**` 要重啟才生效；改 `app/public/**` 不用**（靜態直接服務，
   server 會用檔案 mtime 當快取版本號，普通重整就會拿到新的）。

---

## 還沒做的（照重要性排）

### 1. 判題前先查題庫（Task 2.7）— 最重要，這是需求 1 的核心

**規格 §4.6 與 §4.6.1 已經寫好完整設計，但 `worker.js` 完全沒實作。**
現在每一題都重新判，就算題庫裡已經有官方確定的答案也一樣。

使用者已拍板的做法（兩階段）：

```
① 讀圖抄題（抄題幹＋選項＋翻譯，並標記哪幾題有圖／圖表）— 不審查
   ↓ 逐題算 fingerprint 查 exam_items
 命中且有官方答案 → 直接採用，不審查、不取證、信心 100
   ↓
 沒命中 → ② 審查
          ├─ 沒圖的題 → 純文字審（用①抄出來的題幹與選項）
          └─ 有圖的題 → 重讀圖審
```

**為什麼要在①標記「這題有沒有圖」**：純文字審看不到圖，而「依圖中三條上架規則會放到
哪個位置」這種題沒有圖就是瞎猜。但每題都重讀圖又太貴——新考卷大多數題不在題庫裡，
那是常態不是例外。實測 120 題裡真正非看圖不可的約 2–3 題。

**命中的題不要寫 `adversary` verdict**：它沒被審查過，寫一筆假的判斷會讓信心度分層
讀到不存在的證據。信心度由 `answer_official` 直接給 100（`baseConfidence` 第一層本來就是）。

要動的檔：`app/server/lib/exam/review.js`（加「只抄題」與「純文字審」兩支）、
`app/server/lib/exam/worker.js`（`processUpload` 改兩階段）。

### 2. 上傳畫面的實測

端點與頁面都做好了（`/exam-run`），但**沒有真的跑過一次完整流程**：
上傳 → 觸發 → socket 即時更新 → 結果進題庫。要找幾張截圖實跑一次。

### 3. 版本切換 UI

`GET /api/exam/versions` 端點做好了但前端沒接。目前選題庫等於選版本（bank 綁版本）。
要考別的 Odoo 版本時才需要。

### 4. `data/exam/upload-token.txt` 還沒建

不建的話**外部同事上傳一律 503**。內容就一行通行碼。
（平台帳號登入的人不受影響——`checkExamToken` 有 JWT 放行分支。）

### 5. 深色模式人工檢查

題庫頁與作戰台都沒在深色模式下看過。CSS 全部走 `var(--*)` 沒有寫死顏色，
理論上沒問題，但這條規則（`rules/frontend.md` 第 30 條）要求人工實測。

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
