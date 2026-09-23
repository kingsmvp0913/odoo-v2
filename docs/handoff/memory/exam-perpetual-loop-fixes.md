---
name: exam-perpetual-loop-fixes
description: "考試系統「越考越準」整條做通並實測（2026-09-05, abf7da99→c87f7327 已 push）——校準洩漏、推薦分數、跨考次推導器（10 題 3 場收斂 13/13 零誤判）、開考試手續拿掉；**c87f7327 之後未重啟**，讀成績單一次都沒實跑過"
metadata: 
  node_type: memory
  type: project
  originSessionId: 20adde10-76e2-4828-b579-a343f4c04cdd
  modified: 2026-09-14T09:30:31.404Z
---

2026-09-05。承 [[exam-system-into-platform]]（那份的「還沒做」清單已過時——worker、
通行碼、歸檔、挑戰模式在 09-04 之後都補上了）。

## 引擎本身是對的（實查驗證）

- **官方全對的章節 → 題目永久鎖成 100**：11 個 incorrect=0 的章節共 49 題，
  扣掉 2 題未作答 = **47 題 certain=true**，與 DB 完全吻合。有錯的章節一題都不鎖。
- **被推翻 → 標記下次提醒**：8 題被 adversary 推翻，**7 題已 history_wrong=true**。
- **取用路徑通**：實打 `/api/exam/lookup` 回 `{"confidence":100,"answer":["A"],"source":"官方章節全對推得"}`。

## 五個缺口（`abf7da99` 全修）

1. **校準洩漏（反向回饋，最嚴重）**：舊考次某章 `incorrect=0` 會**按章節名跨 bank**
   套到新考次同名章節的**新題目**上 ⇒ `scale = 0/rawRisk = 0` ⇒ 風險歸零 ⇒
   `confidence=100 且 calibrated=true`。題庫頁對 `confidence===100` 畫鎖頭、算進
   「官方確定 N」⇒ **人眼與真正的官方確認分不出來**。`certain`／`answer_official`
   仍是空的，所以 `/api/exam/lookup` 沒被污染——只有畫面會騙人。
   修法：校準單位改成 `(bank, 章節)`，同一題出現在多場時取最新那場。
2. **答錯的經驗一個字都沒留**：`archive.js` 對沒勾「沒答錯」的章節整段 `continue`
   ⇒ `exam_sections.incorrect` 在網頁流程下**恆為 0** ⇒ 校準永遠拿不到非零輸入。
   介面改成「錯幾題」數字：0 鎖定／1 以上只記錄不鎖／留白不處理。
3. **開不了新考試**：`resolveBank` 只查不建，唯一建 bank 的路是 CLI `exam-import.js`，
   而它要餵一整包做好的 `questions.json`（搬舊資料用的）。已補 `POST /api/exam/banks`。
4. **重啟產生重複作答**：`reclaimInterrupted` 只退回 pending 不刪已建的 attempts
   （失敗路徑與 retry 端點都刪過，唯獨它漏了）；且 `scheduleQueue` 全部呼叫點都在
   HTTP handler 內，開機不觸發 ⇒ 那些頁停在「等待審題」轉圈直到有人手動按重試。
5. **測試上傳汙染題庫**：`is_test` 只在前端濾掉，worker 從頭到尾沒讀過它。

## 2026-09-05 已用假考卷實跑驗完整條流水線

手法：`createApp()` 只註冊路由（啟動段在 `require.main` 保護內），所以可以**另起一個
載新碼的實例**打真 API，不必等常駐 server 重啟。假考卷用 playwright 把 HTML 截成 PNG。

五項全部在真實系統上驗過：開新考試（重名 409／版本 400）／測試上傳回 `test-ok` 且
0 作答 0 token／抄題＋中譯正確／**對立審查抓到故意答錯的那題**（引用真的
`addons/stock_account/models/product.py:750`）／歸檔填 `wrong=1` 寫進
`exam_sections.incorrect=1`、不鎖任何題、校準後**風險總和 0.99 ≈ 官方說的 1 題**。
`exam_uploads`／`exam_jobs` 這兩張表第一次真的有資料流過。

**⚠ 副作用：那次 recompute 改寫了既有 120 題中的 15 個欄位。**不是污染——
存在 DB 的值是 09-04 寫的、與現在的審查／證據已對不上（當時每題 2 筆 adversary，
現在剩 1 筆）。連跑兩次 `recomputeConfidence` 皆 **0 處變動**⇒ 冪等，那 15 處是
一次性追平。`certain`／`calibrated` 一處未變 ⇒ **校準洩漏確認沒有發生**。
教訓：**動真資料前先 snapshot，跑完逐欄比對**；「有變動」不等於「弄壞了」，
要用「再跑一次還會不會變」來分辨。

另外發現（未修）：**刪題庫不會刪截圖檔**，`app/uploads/exam_<bankId>/` 會留下孤兒目錄
（現場有 exam_4~exam_8 是更早的殘留）。

## 三場累積實測：「越考越準」確認成立（2026-09-05）

同一張假考卷連考三場，全部實跑：

| | 第一場（錯 1 題） | 第二場（全對→歸檔鎖定） | 第三場（同樣的題） |
|---|---|---|---|
| 耗時 | 99.1s | ~90s | **28.0s** |
| 新增 adversary 審查 | 3 筆 | 3 筆 | **0 筆** |
| `seen_count` | 1 | 2 | 3 |

- **跨考次去重成立**：三場考同樣 3 題，`exam_items` 始終只有 3 列。
- **章節全對推正解成立**：第二場歸檔填 `wrong=0` → `locked:3`，推出的官方答案
  **C/A/A 與真正的正解完全一致**——系統不知道答案，只靠「官方說這章沒錯 + 我答了什麼」。
- **短路成立**：第三場 `toReview` 為空 ⇒ `challengePage` 根本沒被呼叫（`worker.js:108-110`）。
  28s 裡有 14s 是收尾空轉，實際只花約 14s 抄題。**抄題仍要 AI**（要算 fingerprint），
  省掉的是判題＋取證那一段。

**⚠ 判題完成到可以歸檔之間有約 14 秒空窗**（`EXAM_IDLE_ROUNDS=6 × EXAM_IDLE_WAIT_MS=2000`，
worker 空轉等晚到的頁）。這段時間 `exam_jobs` 仍是 `running` ⇒ 歸檔回 409
「這份題庫還有工作在跑」、信心度也還是 null。**寫自動化要等 `exam_jobs` 而不是
`exam_uploads`**——我第一版腳本就是等錯表，歸檔整個被擋掉。

清理後原有 120 題**變動 0 處**（第二次跑就沒有上次那 15 處追平，印證冪等）。


## 2026-09-05 後續：推薦分數、推導器、把手續拿掉（`902ac9b7`→`c87f7327`，已 push）

- **推薦分數**（`lib/exam/score.js`）：每選項一個數字、一題加起來 100。放後端才測得到。
  ⚠ `c`＝`exam_items.confidence` 的定義是「**你填的那個答案**正確的機率」，不是
  「審查有多確定」——c=30 是審查找到原始碼、很有把握你錯了。把 c 掛到審查主張的
  選項上會整個反過來，而反了之後畫面照樣好好的。其餘選項給 3 分底座不給 0
  （實測 120 題裡有 7 題正解是你與 AI 都沒提到的第三個）。
- **人工勾的 `history_wrong` 已從公式移除**：那個勾是人看著審查的信心度打的，
  等於把同一個 AI 判斷算兩次（使用者自己指出）。它現在只剩「需確認」判定在用。
- **推導器**（`lib/exam/deduce.js`）：把各場考試的「這章錯幾題」當聯立方程式解，
  推得出「第一場錯的到底是哪一題」。事實的單位是 **(題目, 你填的答案)** 不是題目。
  矛盾時**什麼都不寫**並具名回報。**10 題實測 3 場收斂到 13/13、零誤判。**
- **開考試這道手續整個拿掉**：`bank` 選填，沒有進行中的就自動開一場；歸檔把
  status 標 `archived`（原本標 ready，跟新建的同值 ⇒ 分不出「還在考」與「考完」）。
- **`responder`（作答者）從 API 移除**：前端從沒顯示、DB 120 筆全 NULL。

### ⚠ 讀成績單：原實作會一列都讀不出來

真實成績單（`data/exam/banks/2026-08-14-1/section-result.png`）是長條圖，
**只有百分比、沒有題數**。第一版要求「看不到題數就整列略過」＝全滅。
改成：百分比從圖上讀，**題數用 DB 裡的**（每章考幾題本來就是我們寫進去的），相乘。
拿那張真圖的數據驗算：19 章逐章與標準答案相同、錯題合計 15。
**教訓：寫「讀圖」功能前先把那張圖打開看過。**

## ⚠ 還沒做 / 還沒驗

- **`c87f7327` 之後未重啟** ⇒ 自動開場、讀成績單新算法、`archived` 狀態都還沒生效。
  （`abf7da99` 那批已於 20:37 重啟生效並實測過。）
- **讀成績單一次都沒實跑**——邏輯改對且有 24 支測試，但「AI 看不看得懂那張長條圖」
  沒驗過。手邊就有真圖可測：`data/exam/banks/2026-08-14-1/section-result.png`。
- **仍沒有前端接的端點**：`GET /api/exam/jobs`（判題進度與 `interrupted` 在 UI 上
  看不到）、`GET /api/exam/uploads`、`GET /api/exam/versions`、`/api/exam/lookup`
  （`/solve` 那條捷徑）。`POST /api/exam/banks` 在自動開場之後前端也不再用，
  但測試與腳本會用，刻意留。
- **舊的 120 題在作戰台看不到**：它們是 CLI 匯入的、沒有 `exam_uploads` 列，
  而作戰台按上傳分組。不是壞掉，題庫頁看得到。
- fingerprint 漂移沒有觀測；死碼未清（`reviewQuestions`／`gatherEvidenceBatch`／
  `readUploadToken`）；刪題庫不刪截圖目錄。

## 2026-09-14：空場次（`d9678388` 已 push，未重啟）

- 使用者回報列表有 0 題的 `2026-09-07`（id 19，是按「清空」留下的），已照指示從正式 DB 刪掉＋刪 `app/uploads/exam_19`。
- 改：上傳檢查全過才 `resolveBank`（原本傳失敗也開一場）；批次全壞回 400；清空未結束的場次連 `exam_banks` 列與截圖目錄一起刪（已歸檔／有章節的留著）。
- 「等歸檔才建場次」做不到：上傳、判題、歸檔都掛在 bank_id 上。
- 同一天第二場叫 `YYYY-MM-DD-2`，**前提是第一場已歸檔**，否則圖混進第一場。

## 2026-09-14：分數改成每頁判完就算（`9f75434d` 已 push，未重啟）

- 使用者要求：**每個區塊當下就要有分數，不是整場收工才統一給**。
- 原因：信心度只在 `runQueue` 收工時 `recomputeConfidence` 一次 ⇒ 考試中 `option_scores` 全 null；「需確認」只比對審查答案不看信心度，所以先出現。
- 改：`processUpload` 結尾 `recomputeConfidence(db, bank, { itemIds: 這頁 })`，整份算、只寫這頁（併行時避免互蓋成 null）；失敗只記 note 不讓整頁失敗。收工那次全量重算保留。
- 實測 167 題整份算 77ms。新測試舊碼紅（Received null）新碼綠；全跑 4826 passed。

## 2026-09-14：讀成績單「一章都對不上」（`75b1ab43` 已 push，未重啟）

- 真因：bank 20 的 11 頁上傳時**全沒帶 section**，listPages 回的章節全空 ⇒ matchToPages 零命中。截圖上明明印著章節大標題與麵包屑。
- 第二個洞：歸檔面板的「章節名稱」輸入框**只送去歸檔，不送去讀成績單**（read-sections 只讀 DB）⇒ 人打了等於沒打。
- 改：抄題 prompt 多讀 `section`，worker 在上傳沒帶時補寫 `exam_uploads.section_title`＋新題的 section_title；read-sections 吃前端 `sections` JSON；全空時錯誤訊息改叫人去填章節名。6 支新測試舊碼全紅；全跑 4830 passed。
- 使用者嫌「先去表格填章節名」太麻煩 ⇒ 再加 `assignByOrder`：整場沒章節名、頁數＝章數、讀圖沒略過任何章，才照成績單 x 軸順序一頁配一章，回 `sections` 讓前端填回表格（`dee3a10e` 已 push，未重啟）。**讀成績單第一次實跑**：真圖＋bank 20 真資料，11 章順序全對、HR 錯 1／Sales 錯 1，其餘 0。全跑 4836 passed。
- bank 20 回填 11 頁章節名的 SQL 被 auto mode 分類器擋下，**沒寫**。對應（已看截圖確認）：1 Introduction／2 CRM／3 Inventory／4 MRP／5 Website / eCommerce／6 Human Resources／7 Timesheets／8 Project／9 Accounting／10 Purchase／11 Sales。

## 2026-09-14：歸檔後作戰台自動清空（`d5fcd72e` 已 push，純前端免重啟）

- 使用者要「確認歸檔後自動清空」。**刻意不刪資料**：清空端點刪 `exam_attempts`，而 deduce.js 與章節校準都 JOIN 已歸檔場次的作答。
- 改成作戰台只取 `status !== 'archived'` 的場次，歸檔完變空畫面並保留 archiveResult 的略過／矛盾訊息。
- playwright 實測（網路層擋非 GET、把 banks 回應改成 archived）深色模式正確。

## 2026-09-14：官方確認的題不算需確認（前端，未 commit）

- 真因：`needsCheck` 沒排除 `review_source==='official'`，官方答案≠這次填的就算需確認；但官方題畫成點不開的鎖定區塊 ⇒ 數字多、找不到是哪題。bank 21 實況 P1-1（官方 B 填 A）、P2-2（官方 C 填 A）。
- 改 `ExamRun.js` needsCheck 一行＋一支挖函式實跑的測試（舊碼紅）。全跑 4838 passed。未開瀏覽器看。
- 同日追加（未 commit）：①正式答案的勾只給管理員——`PATCH /api/exam/attempts/:id/final` 非 admin 回 403（**要重啟才生效**），前端 `isAdmin` computed 鎖 checkbox，投票不受影響。②改選別的答案（含清成留白）後選項後面掛「原答案」標記（`showOriginal`）。③**推翻舊決定**「照審查改完就退出需確認」：`isMismatch`／`repeatsKnownWrong` 改成原答案與現在答案兩個都比，改過答案的題留在需確認。全跑 4841 passed。④**使用者拍板**：題號前那一欄**永遠**顯示勾選的答案（`finalText`，留白畫「—」），推薦字母＋分數移到 title。第一版「只有改過才顯示」被打臉：勾回原答案 A 被判沒改過，前面跑出推薦 B（bank 22 P3-1）。全跑 4842 passed。

## 2026-09-14：推薦分數跟著勾選跑＋方括號拆字（`7440e411`／`4283f2bc` 已 push，未重啟）

- **分數**：`exam-upload-routes.js` 餵 `optionScores` 的 `mine` 原本是 answer_final，但 confidence 是「**原答案**對」的機率（審查推翻的是 answer_their，改勾不重算）⇒ 照審查改勾 B 後 B 從 67 掉到 30（bank 23 P5-2）。改成固定 `answer_their`。舊的前端靜態測試寫死了錯的假設，已改。
- **指紋**：抄題把截圖切掉的字補成 `fo[rm]`，括號被換成空白拆成兩詞 ⇒ 206/379、207/454 各兩列，379 沒吃到官方答案 A。`normalizeQuestion` 先刪 `[]`。324 題重算只有 379、454 會變，剛好撞 206、207。
- **使用者裁決不合併** DB 裡既有的兩組重複列（206/379、207/454），別再提議。唯一影響：bank 22 Purchase 的 378/381/382 信心度 75（合併後應為 67）。379 在 bank 22（已歸檔、填 A 正確），454 在 bank 23（已鎖 B）。新上傳會正確命中 206/207。
- 校準讓推翻題的信心度被稀釋（127：base 30 → 57，因 bank 2 Sales 只錯 1 題、8 題風險總和 1.61）是照設計，不是 bug；使用者未要求改公式。
- 全跑 4844 passed（基線 4842＋2）。工作目錄仍有更早未 commit 的 ExamRun／admin 403 改動，刻意沒夾帶。

## 判讀陷阱

- **盤點 agent 會誤報**：它說 `exam_sections.correct` 存的是「有作答數」語意壞掉——
  不成立，那段只在「這章沒答錯」時執行，此時 answered == correct。**引用 subagent
  的結論前先自己驗那幾條最嚴重的**。
- **綠測試證明不了什麼**：新加的兩支守衛我都把舊碼 checkout 回來實跑確認會紅
  （校準那支：confidence 是 100，期望 80）。
- **量前端尺寸不能照抄 rect**：ui-next 外殼帶 zoom，rect 39px ≈ CSS 35.5px，
  見 [[ui-next-css-traps]] 第 8 條。
