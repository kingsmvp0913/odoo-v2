# 考試系統的租戶隔離設計（開第一家客戶前的阻擋條件）

日期：2026-09-24
狀態：**程式已實作、測試全綠，但未重啟、未人工驗收**（2026-09-24，commit `d10d7e3a`）
實作紀錄：全跑 405 suites／5996 tests／0 失敗。基線 5922 → +74，與預測一致（新測試 73＋新原始碼檔 1 的全樹守衛）。
§5 那一項人工驗收尚未執行。實作時與設計的唯一差異：`seesAllBanks` 把「沒有公司」也算內部——
那是全平台既有慣例（`tenant-access` 的 `isUserCompanyInternal`、`company-features`、`agent-home` 都這樣判），
設計當下沒寫出來，第一次全跑就被既有測試打臉（沒有公司的一般使用者看不到內部場次）。
前置：子專案 1（公司表）、`2026-09-24-exam-byok-design.md`（`exam_uploads.user_id` 已上線）
總覽：`2026-09-11-productize-overview.md`；進度以「開發順序」§0 為準

---

## 1. 目標與非目標

### 目標

- 客戶公司**能用考試作戰台**（`/exam-run`：傳自己的考卷、AI 判題、投票定案、歸檔），但**只看得到自己公司的考試場次**。
- 客戶公司**完全看不到題庫管理頁**（`/exam-bank`：瀏覽累積的題目、標歷史錯題）——那是內部的東西。
- 前後端判準**一致**。今天前端 router 擋死兩頁、後端 `requireFeature('exam')` 放行，這個不一致本身就是洞。

### 非目標（使用者 2026-09-24 裁決）

- **題目池不分家**。`exam_items` 的鍵是 `UNIQUE (odoo_version, fingerprint)`，一個 Odoo 版本一池，「越考越準」整個機制就是靠跨場次累積在這池裡。分家等於每家客戶從零開始、累積歸零。
  - 由此產生、**使用者已知並接受**的兩件事：客戶的考卷會用到內部累積出來的官方答案（`answer_official`／`certain`）；客戶的題目也會併進那個池，內部之後看得到。客戶看不到內部的**場次與截圖**，但答案知識是互通的。
- 考試花費的記帳、進容器、花費上限（見 `2026-09-24-exam-byok-design.md` §1）。

---

## 2. 現況實查（2026-09-24）

| 事實 | 位置 |
|---|---|
| 考試端點共 **24 支**，全部只掛 `verifyToken` ＋ `requireFeature('exam')`，**沒有任何一支問「這場是誰的」** | `exam-routes.js`（6 支）、`exam-upload-routes.js`（18 支） |
| `GET /api/exam/banks` 是裸的 `SELECT ... FROM exam_banks`，沒有 WHERE | `exam-routes.js:26` |
| 前端 router 對 `/exam-bank` 與 `/exam-run` **都**掛 `requiresInternal`，後端卻放行 | `app/public/js/app.js:208`、`:214` |
| 上傳沒指定場次時自動挑「還沒結束的那一場」——**客戶的考卷會掉進內部正在進行的場次** | `exam-upload-routes.js` 的 `resolveBank` |
| 上傳通行碼是**全平台唯一一把**，存在單一檔案，重產即舊的失效 | `lib/exam/upload.js` 的 `issueUploadToken` |
| `exam_uploads.user_id` 已經記了每一頁是誰傳的 | 2026-09-24 BYOK 那輪加的 |
| `GET /api/exam/lookup`、`GET /api/exam/versions` **沒有任何前端呼叫端**（推測是外部截圖腳本用） | grep `app/public/`、`tools/` 皆無 |

### 為什麼場次要加欄位，不能從上傳推

「這場屬於哪家公司」理論上可以從 `exam_uploads.user_id` 推。**但空場次推不出來**：`POST /api/exam/banks`（開一場新考試）建出來的場次一張截圖都沒有，於是建立它的人當場就看不到它。自動建場次（`resolveBank`）也一樣，建立與第一次上傳之間有空窗。

所以 `exam_banks` 要有 `company_id`，在**建立當下**寫入。這與 2026-09-24 稍早「BYOK 不必綁題庫」的結論不衝突：那時問的是「錢算誰的」，答案是逐頁記更準；這裡問的是「這場給誰看」，答案必須在場次本身。

---

## 3. 設計

### 3.1 場次歸屬

- `exam_banks` 新增 `company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`，**可為 null＝內部**（與 `exam_uploads.user_id` 同一個約定）。
- 寫入時機：
  - `POST /api/exam/banks`（手動開一場）→ 建立者的 `company_id`（內部人員為 null）。
  - `resolveBank` 自動開一場 → **上傳者**的 `company_id`（`req.examUserId` 推出來）。
- 既有資料一次性遷移：全部維持 null（＝內部）。目前只有內部在用，這是事實而非假設。

### 3.2 可見範圍

單一判準，寫成一支函式 `examBankScope(actor)`（放 `lib/exam/scope.js`），比照 `lib/tenant-access.js` 的形狀：

| 身分 | 看得到的場次 |
|---|---|
| 平台管理員 | 全部 |
| 內部公司成員 | 全部 |
| 客戶公司成員 | `company_id = 自己公司` 的那些 |

**看不到一律回 404 不回 403**（專案既有原則：403 等於告訴對方「這個 id 存在」）。

### 3.3 端點分類（24 支）

**A. 題庫管理 → 內部限定**（新增 `requireInternal` 中介層，非內部一律 404）

| 端點 | 說明 |
|---|---|
| `GET /api/exam/sections` | 瀏覽章節與題目清單 |
| `GET /api/exam/items/:id` | 單題詳情（含累積出來的官方答案） |
| `PATCH /api/exam/items/:id/history-wrong` | 標歷史錯題 |
| `GET /api/exam/versions` | 版本切換（題庫頁用） |
| `GET /api/exam/lookup` | 指紋查詢既有題目 |

**B. 考試作戰台 → 客戶可用，但要綁場次**（先解出場次 id，再過 `examBankScope`）

| 端點 | 場次從哪來 |
|---|---|
| `GET /api/exam/banks` | 清單本身 → 加 WHERE |
| `POST /api/exam/banks` | 建立 → 寫入歸屬（§3.1） |
| `POST /api/exam/submit`、`POST /api/exam/batch` | `resolveBank` → §3.4 |
| `POST /api/exam/run` | `body.bank` |
| `POST /api/exam/banks/:id/pause`、`/archive`（GET＋POST）、`/read-sections`、`DELETE /attempts` | `params.id` |
| `GET /api/exam/jobs`、`/uploads`、`/dashboard` | `query.bank` |
| `POST /api/exam/uploads/:id/retry` | upload → `bank_id` |
| `POST /api/exam/attempts/:id/vote`、`PATCH /attempts/:id/final` | attempt → `bank_id` |
| `GET /api/exam/shot/:kind/:id` | `score` 走 bank、`upload` 走 upload → `bank_id` |

**C. 上傳通行碼 → 見 §3.5**：`GET`／`POST /api/exam/upload-token`。

### 3.4 `resolveBank` 不得跨公司

沒指定場次時，「還沒結束的那一場」必須限縮在**上傳者自己公司**的場次內；找不到就開一場新的、掛在上傳者的公司底下。

這條不是防禦性補強：現況下客戶傳的第一張圖就會落進內部正在進行的場次，而且**沒有任何徵狀**——內部同事會在自己的作戰台上看到不認識的題目，客戶則以為自己傳成功了。

### 3.5 上傳通行碼改成一家公司一把

現在是全平台一把，存單一檔案、重產即舊的失效。客戶一旦開始用，雙方會互相把對方的碼作廢——**症狀是「我的通行碼昨天還能用」，而 log 上看不出任何異常**。

改成以發放者的公司為鍵（內部為 `internal`）各存一把，檔案結構從單一物件改成以公司為鍵的物件。`checkExamToken` 逐把比對，命中哪一把就用那把的 `issued_by` 當身分（§3.1 的 BYOK 那輪已經在記了）。

### 3.6 前端

- `/exam-bank` 維持 `requiresInternal`（現況正確，後端補上同樣的判準即可）。
- `/exam-run` 的 `requiresInternal` 改成看 `features.exam`——這條 router meta 的註解明寫它是「刻意保守的近似」，客戶能用之後那個近似就過嚴了。
- 選單入口已經是 `userStore.features.exam`，不動。

---

## 4. 測試

1. **場次可見性矩陣**（supertest＋pg-mem）：平台管理員／內部成員／甲公司成員／乙公司成員 × 內部場次／甲的場次。看不到一律 404。
2. **B 類端點逐支**：拿別家公司的場次 id 打過去，全部 404。這一條要能擋住「新增端點時忘了接上檢查」——用掃全檔的靜態守衛列出 B 類清單，漏接就紅。
3. **A 類端點**：客戶公司成員一律 404，內部 200。
4. **`resolveBank`**：客戶上傳且內部有一場進行中 → **不得**落進那一場，要另開一場掛在客戶公司。
5. **通行碼**：甲公司重產不影響乙公司與內部那把；用甲的碼傳的圖落在甲的場次。
6. **題目池共用（反向確認）**：客戶上傳的題目**會**併進共用池、也**會**用到內部累積的官方答案——這是裁決要的行為，釘住它才不會有人日後「順手修掉」。

---

## 5. 驗收

- 全跑不得有新紅燈（基線動手前自己量）。目前基線是 **403 suites／5922 tests／0 失敗**。
- **人工**：開一家客戶公司、打開考試功能、以該公司帳號走完「傳一張考卷 → 判題 → 看結果」，確認看不到內部場次、也進不去題庫頁。這一項無法用測試取代——它驗的是「客戶真的用得起來」，而不只是「擋得住」。
