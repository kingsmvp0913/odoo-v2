# 規格書：wiki 與歷史任務語意檢索

> 目標讀者：在正式機執行本改動的人或 agent
> 規模：階段 0～3，各自可獨立上線與回滾。階段 0／1 無使用者可見變化，階段 2 改既有端點行為，階段 3 動 pipeline。
> 與其他規格無依賴，隨時可插。
>
> **收尾慣例**（見 commit `1697082`）：根目錄只留**尚未執行**的規格。本檔執行完畢後移進 `docs/`
> （該目錄在 `.gitignore` 內，spec／plan 不進版控），並比照 `SPEC-inbox.md` 等在頂部補一段
> 「執行狀態 ＋ 實際偏離」——寫下錨點複驗結果與本文沒提到、但真的會炸的坑，避免日後有人照著再做一次。

> ## 修訂記錄：2026-08-08 審核更正
>
> 初版的規模估算（30 專案／16,000 chunk）**沒有實測依據，實際差了約 50 倍**。連帶多段推論一起改了。
> 若你手上有初版的印象，以下這幾條是被推翻的，不要混用：
>
> | 初版說 | 實測／更正 |
> |---|---|
> | 30 個專案、16,000 chunk、向量佔 24 MB、單次查詢算 400 個、全量重建 9 分鐘 | **8 專案／83 頁／約 300 chunk／< 1 MB／單次約 40 個／全量約 10–20 秒**（§2.1） |
> | 必須跑 worker_threads，否則建索引會卡住主行程 9 分鐘 | 結論保留、**理由換掉**：真正的原因是「每次查詢都要算 query embedding」（§2.5） |
> | 24 MB 全載入、不需要 lazy load／LRU（有一整段取捨討論） | 規模是 < 1 MB，整段取捨討論已刪（§2.7） |
> | 模型備援用 `onnx-community/multilingual-e5-small` | **該 repo 不存在**（HF API 回 401）。備援改 `nixiesearch/...`（§2.5） |
> | `@huggingface/transformers` 是 transformers.js v3 | npm 現版 **4.2.0**（§2.5） |
> | 測試放 `tests/*.test.js` | 實際路徑是 **`app/server/tests/`**（§4.3） |
> | 效果驗收從 `wiki_drift` 撈「搜過沒搜到」的案例 | **那張表沒有這種資料**，撈不出來 → 新增階段 0 產生它（§4.4） |
> | 正式機基線是 `2148 passed`，拿它比對 | **當天就腐爛了**：2026-08-08 實測 `2173 passed / 159 suites`。基線改成「動手前自己跑一次」（§4.2、§7.4） |
> | 記憶體不足時改用外部 embedding API（provider 介面為此保留） | 該介面規格從沒定義過，且與 §2.1 決策②的資料邊界衝突；風險本身也不存在 → 已刪（§5） |
>
> 另外補上初版沒寫、但漏了就會出錯的三件事：增量重算必須先刪舊 chunk（§2.3）、
> 快取要帶 `model_id`（§2.7）、觸發點的實際位置共 9 處（§2.8）。
>
> **同日第二輪修訂**（查了成長曲線與既有端點之後）：
>
> - **做這件事的理由整個換邊**：wiki 短期內用不到語意檢索（單專案候選集只有 3–28 頁），
>   **歷史任務才是主戰場**（成長速度是 wiki 的數倍，且沒有「列目錄」這種替代方案）。見 §2.1。
> - **階段 0 加一項**：`/ai/wiki/search` 回 0 筆時自動退回全目錄。5 行的事，卻是 §1 兩個痛點的直接解，
>   而且在向量索引還沒建好時就是最好的退路。見 §3 階段 0。
> - **第 15 步改寫**：不自動注入 few-shot，改成在 `analysis-project` 的【知識查詢】加一行端點。
>   理由（與該 agent 來源分層設計的衝突、超規格風險、prompt cache）見 §3 階段 3。
> - **§7 已執行**：`.claude/rules/always.md` 規則 2 已依 §7.4 改掉（使用者 2026-08-08 明確同意）。

---

## 1. 要解決什麼

`/ai/wiki/search`（`app/server/wiki-routes.js:144`）目前是字串比對：

```js
const like = `%${q.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;
WHERE LOWER(title) LIKE $2 OR LOWER(content) LIKE $2 OR LOWER(COALESCE(description,'')) LIKE $2
```

字對不上就是 0 筆。實際的失效場景：

> wiki 有一頁排障結論叫「維修單過帳後庫存沒扣」。agent 遇到問題去搜「hj 領料異常」或「stock move 沒產生」，兩次都是 0 筆。

而且**失敗完全沒有訊號**——端點回 200 加一個空 `hits` 陣列，agent 當作「wiki 沒有記載這件事」，繼續自己瞎猜。這個問題該端點的註解本身就寫過一次（「wiki 一多就必漏——而且漏掉沒有任何訊號」），當時的解法是把 `description` 一併回傳，但那只緩解了「按標題挑頁」，沒有解決關鍵字本身猜不中。

第二個缺口是 `tasks.analysis_yaml` **完全沒有檢索**。Odoo 客製高度重複，一張新任務常常跟三個月前某張很像，但 `analysis-project` 每次都從零讀 code、從零寫規格。

**⚠ 上面那個失效場景是舉例，不是實測案例。** 目前沒有任何地方記錄「誰搜了什麼、回了 0 筆」——這正是階段 0 要補的（§3、§4.4）。在真實案例累積出來之前，「語意檢索改善了多少」無法量化。

---

## 2. 設計

### 2.1 三個「不做什麼」的決策（先讀這段，它們決定了整份規格的形狀）

**① 不用 pgvector。**

理由不是技術偏好，是部署形態：

- Windows 軌用 `install.ps1` 以 winget 裝 EDB PostgreSQL 17（`install.ps1:26`，`PostgreSQL.PostgreSQL.17`）。pgvector 不在 StackBuilder 內，要嘛用 Visual Studio Build Tools 自行編譯，要嘛手動丟預編譯 dll 進 `lib/` 與 `share/extension/`。**沒有能寫進 `install.ps1` 的一鍵路徑。**
- 容器軌是 ubuntu:24.04，`apt install postgresql-17-pgvector` 一行搞定。
- 於是兩軌做法完全不同，而且只有一軌會壞——這正是最難查的那類 bug。

而資料量根本用不到它。**以下是 2026-08-08 直接查平台 DB 的實測值**，不是估算：

| 項目 | 實測 |
|---|---|
| 專案數 | 8 |
| wiki 頁數／`content` 總字元 | 83 頁／39,703 字（平均 478 字/頁） |
| 有 `analysis_yaml` 的任務／總字元 | 15 張／21,452 字 |
| 合計待索引字元 | **61,155 字** |

由此推算（350 字一塊、重疊 50 字 → 有效步進 300 字；標題切會再多出一些短塊）：

| 項目 | 數字 |
|---|---|
| chunk 總數 | **約 200–350**（首次索引後以實際為準） |
| 全部 chunk 的向量佔記憶體 | 384 維 × 4 bytes × 300 ＝ **約 460 KB** |
| 單次查詢實際要算的 chunk | 檢索一律 `WHERE project_id=$1` → **約 40 個** |
| 40 次 cosine 的耗時 | **可忽略（微秒級）** |
| 全量重建耗時 | **約 10–20 秒** |

pgvector 要到幾十萬筆才開始有意義。差**三個**數量級。

**⚠ 但真正決定這件事值不值得做的，是成長曲線，不是現在的靜態值。**

平台的任務資料全部產生於 2026-08-02～08-06，**只有 5 天**（26 張任務、15 張有 `analysis_yaml`）。
換算約 **5 張任務/天、其中約 3 張會產出規格**：

| | 現在 | 3 個月後 | 1 年後 |
|---|---|---|---|
| 有 `analysis_yaml` 的任務 | 15 張 | 約 270 張 | **約 1,100 張** |
| 任務側 chunk 數 | 約 70 | 約 1,300 | **約 5,200** |
| 單專案最大 wiki 頁數 | 28 頁 | 100–200 頁 | 300–500 頁 |
| 單專案 wiki 目錄（title＋description）字數 | 671 字 | 2,400–4,800 字 | 7,000–12,000 字 |

**由此得到本規格的兩個施工重心，跟初版寫的相反：**

1. **wiki 檢索短期內不是重點。** 檢索一律 `WHERE project_id=$1`（§6），所以單次候選集就是「單一專案的 wiki」——
   最大的專案（鴻久）只有 28 頁，**整包目錄才 671 字**。這個量級直接列給 agent 挑就好，
   而且 `/ai/wiki/pages`（`wiki-routes.js:128`，無 LIMIT、已回 `slug/title/node_type/description`）**早就做好了**。
   §1 的失效場景真正的破口在 prompt：`pipeline/cs-capability.md:9` 把 `search` 排在 `pages` 前面，
   還寫「比逐頁看標題可靠」——在 28 頁的規模下這句話是反的。所以階段 0 先補「0 筆回退全目錄」（§3），
   那是 5 行的事，能撐到單專案約 300 頁，以目前速度大約是半年到一年。
2. **歷史任務檢索才是語意檢索真正的正主。** 1,100 張任務**沒有「列目錄」這個替代方案**——
   任務標題不足以判斷相似度，數量也會破千。這件事只能靠語意檢索。而且它的成長速度是 wiki 的數倍，
   三個月後任務側的 chunk 數就會超過 wiki，一年後是好幾倍。

**所以階段 2（wiki）與階段 3（任務）要一起做，但心裡要清楚**：階段 2 短期效益低，
它的價值是把管線（切塊／worker／快取／RRF）跑通並驗證；階段 3 才是這套基礎建設將來的主要使用者。

> 其餘兩點執行前要有心理準備：
> 1. 語意檢索解決的是「詞猜不中」，解決不了「wiki 根本沒寫那件事」。§4.4 的對照要分辨這兩類。
> 2. 本規格的所有設計（全載入記憶體、純 JS cosine）在 chunk 數 < 50,000 前都成立——依上表推算約可撐 5～8 年。超過再回頭談 pgvector 也不遲，因為 §5 的回滾是一句 SQL。

**② 不用外部 embedding API。**

Anthropic 沒有 embedding 產品線，所以無論如何都要引入新東西。選本地的理由：wiki 內含客戶的排障結論與規格，不外流；且無金鑰管理、無按量計費依賴。全量索引的 API 成本其實只有幾美分，**成本不是這個決定的理由**，資料邊界才是。

**這個決定沒有逃生門**：本規格不定義 provider 抽象層、不預留切換外部 API 的介面。要切換就是改碼，而且那等於推翻資料邊界的前提，必須重新拍板。

**③ 不取代現有的 LIKE。**

純語意檢索有明確弱點：**精確詞反而不準**。agent 搜一個確切的 model 名（`idx.hj.order`）或錯誤碼時，關鍵字精準無比，向量只會回一堆「大概相關」。

所以本改動是**加法**：LIKE 保留，向量是第二條腿，兩者合併排序。現有行為壞不了，這也是階段 2 能安全上線的原因。

### 2.2 資料流

```
建索引（背景、增量）
  wiki_pages.content / tasks.analysis_yaml
    → 切塊（§2.4）
    → worker 算 embedding（§2.5）
    → 先刪該來源的舊 chunk，再整批寫入 embedding_chunks（§2.3）

查詢（每次搜尋）
  查詢字串
    → worker 算 embedding（20–50 ms）
    → 撈該 project 的 chunks（記憶體快取）
    → 純 JS cosine 排序
    → 與 LIKE 結果 RRF 合併（§2.6）
    → 回 slug / title / description（維持現有兩階段形狀）
```

### 2.3 Schema

**新表**（加進 `app/server/db.js` 的 `CREATE TABLE` 清單，`db.js:74` 起那個 `statements` 陣列）：

```sql
CREATE TABLE IF NOT EXISTS embedding_chunks (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  wiki_page_id INTEGER REFERENCES wiki_pages(id) ON DELETE CASCADE,
  task_id      INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL DEFAULT 0,
  content      TEXT NOT NULL,
  vector       TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  source_hash  TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

索引（照既有慣例，`db.js:728` 起那段的寫法，一律 `.catch(() => {})`）：

```sql
CREATE INDEX IF NOT EXISTS idx_emb_project ON embedding_chunks (project_id, model_id);
CREATE INDEX IF NOT EXISTS idx_emb_wiki    ON embedding_chunks (wiki_page_id);
CREATE INDEX IF NOT EXISTS idx_emb_task    ON embedding_chunks (task_id);
```

設計說明：

- **`wiki_page_id` / `task_id` 兩個 nullable FK，而不是 `source_type` + `source_id`**：這樣 `ON DELETE CASCADE` 會自動清掉孤兒。用泛型的 source_id 就得自己寫清理邏輯，而且刪除路徑散在三份手動清單裡（`db.js:125-129` 的註解已經寫過這個坑：admin-routes 刪使用者、project-routes 刪專案、tasks-routes 刪單張任務各一份，漏補任何一處的症狀是「刪任務／刪專案／刪使用者直接失敗」），一定會漏。**已實測 pg-mem 確實執行 `ON DELETE CASCADE`**，測試環境不會假綠。
- **`vector` 用 `TEXT` 存 base64，不用 `BYTEA`**：`db.js` 與 `wiki-routes.js:143,170` 已有多處為 pg-mem 相容做的取捨（`ILIKE` 不可用、`ANY(陣列)` 對有索引欄位靜默回 0 列）。BYTEA 的 Buffer 往返在 pg-mem 下不保證行為一致，而代價只是 33% 空間（460 KB → 610 KB，這個量級不必討論）。**穩定優先於省空間。**
- **`model_id`**：模型指紋。換模型時所有舊向量作廢，靠這欄識別。查詢時必須過濾 `model_id = 現用模型`，否則不同模型的座標系統混在一起算，結果是垃圾且不會報錯。所以 `idx_emb_project` 做成 `(project_id, model_id)` 複合。
- **`source_hash`**：來源內容的 SHA-256。增量索引比對它而不是 `updated_at`——`wiki_pages.updated_at` 可能因無關欄位變動而更新，會造成無謂重算。

**⚠ 增量重算必須「先刪後插」，不能 upsert。**

一頁改短了（原本切 5 塊、現在只切 3 塊），若只覆寫不刪，尾巴那 2 塊舊 chunk 會永遠留在索引裡，讓搜尋撈出**已經被刪掉的內容**——而且不會報錯。

而且**不能靠 `UNIQUE` 約束 ＋ `ON CONFLICT` 解決**：本表兩個來源欄位必有一個是 NULL，而 `UNIQUE` 對含 NULL 的列不去重（PostgreSQL 標準行為，**已實測 pg-mem 行為一致**——重複列照樣插得進去）。所以正確做法是每次重算該來源時，在同一個 transaction 內：

```sql
DELETE FROM embedding_chunks WHERE wiki_page_id = $1;   -- 或 task_id = $1
-- 接著整批 INSERT 新的 chunk
```

**不動任何既有表的欄位。** 這是回滾能一句 SQL 完成的前提（§5）。

### 2.4 切塊

**為什麼要切**：一頁 wiki 動輒數千字，涵蓋三四個主題。整頁算一個座標＝把不同主題平均成一個「什麼都沾一點」的位置，誰都搜不準。這是實作上最容易做錯、也最影響效果的一步。

規則：

1. **先按 markdown 標題切**（`^#{1,6} `）。標題天然是主題邊界。
2. 每段若超過上限，**再按字數切，每塊 350 字、重疊 50 字**。重疊是為了避免答案剛好跨在切點上。
3. **每塊前面接上頁面標題與所屬標題路徑**，例如 `維修管理 > 過帳流程\n\n<正文>`。單獨一塊正文常常沒有主詞，接上路徑後語意才完整。
4. 空白塊、純標題塊（正文少於 20 字）直接丟棄。

上限取 350 字的理由：`multilingual-e5-small` 的 max sequence length 是 512 token，中文一字約 1–1.5 token，加上前綴與標題路徑，350 字是安全值。超過會被靜默截斷。

`analysis_yaml` 同理，按 YAML 頂層 key 切（`^[a-z_]+:`），再按字數切。

> 目前 wiki 平均只有 478 字/頁，多數頁面切完就是 1–2 塊，第 2 條規則實際上很少觸發。仍要實作（規模會長），但除錯時別把力氣花在調字數上——先確認標題切與前綴有沒有生效。

### 2.5 Embedding worker

**模型**：`Xenova/multilingual-e5-small`（384 維，量化後約 130 MB）

> 2026-08-08 實測該 repo 存在且可下載（HF API 回 200）。
> 若日後被移除，備援是 `nixiesearch/multilingual-e5-small-onnx`（維度相同，不需改程式碼）。
> **不要用 `onnx-community/multilingual-e5-small`——該 repo 不存在**（初版規格寫錯，HF API 回 401）。
> `intfloat/multilingual-e5-small` 是原始權重，沒有 ONNX，transformers.js 直接用不了。

**套件**：`@huggingface/transformers`（npm 現版 **4.2.0**），加進 `app/package.json` 的 `dependencies`。

底層 `onnxruntime-node` 有 Windows x64 與 Linux x64 預編譯二進位，`npm install` 直接取用，**不需要編譯工具鏈、不需要 Python**。`start.ps1:33-46` 現有的「比對 hidden lockfile 與 package-lock.json，缺了或較新才跑 `npm install --prefer-offline`」邏輯會自動補裝，**安裝腳本一個字都不用改**——前提是 `package-lock.json` 要跟著 commit（它在版控內）。

> ⚠ 該套件另外相依 `sharp`（影像處理，也是原生二進位；本專案用不到影像功能但裝相依時會一起裝）。
> Linux x64 有預編譯，Windows 軌**第一次 `npm install` 要實測確認**，別等到正式機才發現。

**⚠ 必須跑在 worker_threads，不能在主行程算。**

理由是**查詢**，不是建索引：全量重建只要 10–20 秒（§2.1），但**每一次搜尋都要現算一次 query embedding，20–50 ms**。Node 是單執行緒、20 人同時在用，在主行程跑推論等於每次搜尋都讓整個 server（含 socket.io 事件與 pipeline 排程）停 20–50 ms。做法：

- `app/server/lib/embedding-worker.js`：worker 進入點，載入模型，接收 `{ texts: string[] }` 回 `Float32Array[]`
- `app/server/lib/embedding.js`：主行程這側的門面，維護**單一 worker ＋ 序列佇列**
- worker 崩潰時自動重啟，佇列中的工作標記失敗而非無聲吞掉

> ⚠ **這個 repo 目前沒有任何地方用 `worker_threads`**（實測 0 處；背景工作全走 `node-cron` 每分鐘 tick ＋ `child_process`）。
> 這是新引進的執行模型，沒有既有範例可抄，也沒有既有測試涵蓋它崩潰／重啟的行為。§4.3 的測試要把這段補上。

**⚠ e5 系列必須加前綴，漏了會明顯掉品質且不會報錯：**

| 用途 | 前綴 |
|---|---|
| 建索引（文件） | `passage: ` |
| 查詢 | `query: ` |

這是 e5 訓練時的約定。兩邊用錯或漏掉，檢索品質會下降但一切「看起來正常」。

**模型權重落點**：設 transformers.js 的 `env.cacheDir`（**已對過 4.2.0 原始碼，屬性名正確**）指向 `data/models/`（相對 repo 根，用 `APP_DIR` 或 `__dirname` 推導，**不得寫死絕對路徑**）。並在 `.gitignore` 加一行 `/data/models/`（現有 `.gitignore` 只列了 `/data/` 底下的具體檔案，沒有通用規則，不會衝突）。

離線環境：允許事先把權重放進該目錄，啟動時偵測到就不下載。

### 2.6 混合排序（RRF）

兩條腿的分數不同量綱（LIKE 沒有分數，cosine 是 0–1），不能直接加權相加。用 **Reciprocal Rank Fusion**，只看名次不看分數：

```
score(doc) = Σ  1 / (k + rank_in_list)      k = 60（業界慣用值）
```

- 兩份清單各取前 30（**LIKE 那條腿的 `LIMIT 20` 要改成 30**——這是 SQL 改動，不是行為改動；最終仍只回 20 筆）
- 同一頁的多個 chunk 命中時，取該頁最好的名次（不累加，否則長頁面會因為 chunk 多而灌票）
- 合併後取前 20（維持現有 `LIMIT 20` 的回傳筆數）

保留現有的 `ORDER BY (node_type <> 'troubleshooting')` 語意——排障結論優先，作為 RRF 之後的次要排序鍵。

> ⚠ 這是**刻意的行為改變**：現在 troubleshooting 是主要排序鍵（永遠排最前），改完之後 RRF 分數才是主要鍵。
> 一個 RRF 分數低的 troubleshooting 頁會沉下去。回傳欄位與筆數不變，但**同一個查詢的排序會變**，
> §4.4 的對照要把這件事納入判讀，別誤判成「語意檢索害的」。

### 2.7 記憶體快取

全部載入即可（約 460 KB，§2.1），**不需要 lazy load 或 LRU**。

- server 啟動後背景載入，載完前查詢自動退回純 LIKE（不阻塞啟動）
- 建索引寫入後同步更新快取
- 結構：`Map<project_id, Array<{ chunkId, wikiPageId, taskId, vec: Float32Array }>>`

**⚠ 載入時就要帶 `WHERE model_id = 現用模型`**。快取結構本身不存 `model_id`，所以過濾必須發生在載入那一刻；換模型時**整個快取清掉重載**，否則 §2.3 說的「必須過濾 model_id」在快取這條路徑上等於沒做。

### 2.8 觸發時機

| 情境 | 動作 |
|---|---|
| wiki 頁儲存／重新生成 | 該頁入佇列，增量重算（先刪後插，§2.3） |
| 任務寫入 `analysis_yaml` | 該任務入佇列 |
| 管理頁按「重建索引」 | 全量重跑（約 10–20 秒） |
| 夜間排程 | 掃 `source_hash` 不一致者補算 |

**⚠ 觸發點共 9 處，全部都要掛，漏一處的症狀是「那條路徑寫進去的內容永遠搜不到」**（已實測，行號為 2026-08-08 當下）：

wiki（5 處）：

| 位置 | 說明 |
|---|---|
| `pipeline/library-agent.js:43` `_upsertNode()` | `INSERT ... ON CONFLICT DO UPDATE`，新建或更新 |
| `pipeline/library-agent.js:56` `_ensureNode()` | `INSERT ... ON CONFLICT DO NOTHING`，只建不改 |
| `pipeline/library-agent.js:181` `refreshWikiNode()` | ⟳ 重生，單頁 UPDATE（**不是刪光重建**） |
| `pipeline/troubleshooting.js:31` | 排障節點初始化 |
| `pipeline/troubleshooting.js:58` | 排障節點 upsert |

`analysis_yaml`（4 處）：

| 位置 | 說明 |
|---|---|
| `pipeline/spec-review.js:119` | 使用者確認規格 |
| `pipeline/runner.js:266` `writeAnalysisYaml()` | 記錄裁決 |
| `pipeline/respec-agent.js:146` | 途中追加需求後重寫規格 |
| `pipeline/clarify-chat.js:201` | 澄清對話合併答案 |

一律在**寫入成功之後**才入佇列（wiki 那 5 處都不會先刪列，所以不必擔心刪除競態）。

夜間排程掛進 `app/server/cron.js`，照既有的 `HEALTH_CHECK_INTERVAL_MS` 模式（`cron.js:91,96-108`：每分鐘 tick、內部判斷間隔、`_tickRunning` 防重入）。時段避開 pipeline 尖峰，與測試區夜間關機同時段最合適。

---

## 3. 實作步驟

### 階段 0：先止血，並讓失敗留下痕跡（幾行的事，但後面全靠它）

這一階段跟 embedding 完全無關，**先上、獨立回滾**。兩件事都動 `app/server/wiki-routes.js` 的 `/ai/wiki/search`：

0a. **回 0 筆時落一筆記錄**（查詢字串、project_id、時間）。落 DB 一張小表或既有 log 皆可，但要能事後撈出來。

0b. **回 0 筆時自動退回全目錄**：改回該專案的全部頁（等同 `/ai/wiki/pages` 的結果，見 `wiki-routes.js:128`），
    並在回應加一個旗標（例：`fallback: 'all_pages'`）讓 agent 知道這是回退不是命中。
    單專案目錄最大 671 字（§2.1），代價可忽略。

**為什麼排在最前面**：

- 0a：§1 那個失效場景是舉例，不是實測。目前沒有任何地方記錄「誰搜了什麼、回了 0 筆」，
  所以 §4.4 的效果對照**沒有資料可用**（初版規格說去 `wiki_drift` 撈，但那張表記的是「wiki 頁描述與程式碼矛盾」的回報，
  見 `db.js:337` 的註解，不是搜尋失敗紀錄）。這一步先上，累積一兩週，後面才有東西比。
- 0b：這一次解掉 §1 的兩個痛點——「搜不到」與「失敗完全沒有訊號」——而且**不依賴 agent 自律**
  （現在 `pipeline/cs-capability.md:9` 把 `search` 排在 `pages` 前面，agent 照著做，搜不到就以為沒有記載）。
  它同時也是階段 2 的退路：向量索引還沒建好、或 worker 掛了的時候，行為跟這裡一致。

**驗收**：故意搜一個不存在的詞 → 記錄裡找得到那筆，且回應帶 `fallback` 旗標與該專案全部頁。
回傳欄位形狀與既有一致（`slug/title/node_type/description`），agent prompt 零改動。

> 順帶（不強制、需載入 **agentPrompt** skill 才動）：`pipeline/cs-capability.md:9` 那行註解
> 「有關鍵字就先搜（比逐頁看標題可靠——標題常對不上實際內容）」在目前規模下是反的，
> 建議與下一行的 `/ai/wiki/pages` 對調順序。0b 上線後這件事不再是必要的，只是更省一次往返。

### 階段 1：embedding 基礎建設（無使用者可見變化）

1. `app/package.json` 加 `@huggingface/transformers` 相依（連同 `package-lock.json` 一起 commit）
2. `.gitignore` 加 `/data/models/`
3. `app/server/db.js`：加 `embedding_chunks` 建表與三個索引（走既有 `CREATE TABLE` 清單，**不是** ALTER 清單——這是新表不是新欄位）
4. `app/server/lib/embedding-worker.js`：worker 進入點
5. `app/server/lib/embedding.js`：門面、佇列、快取、切塊、cosine
6. `app/server/lib/embedding-index.js`：建索引流程（全量／增量、`source_hash` 比對、**先刪後插**、進度落 DB）
7. `app/server/admin-routes.js`：`POST /admin/embedding/rebuild`、`GET /admin/embedding/status`
8. `app/public/js/views/Admin.js`：重建按鈕 ＋ 進度顯示
9. `app/server/cron.js`：夜間補算
10. §2.8 那 9 個觸發點各掛一行入佇列

**驗收**：能把現有 wiki 全量索引完（約 200–350 筆，10–20 秒），`embedding_chunks` 有資料；重跑第二次因 `source_hash` 相同而幾乎瞬間完成；**把某頁內容改短後重算，舊的尾巴 chunk 確實消失**；期間 server 正常回應其他請求（worker 沒卡住主行程）。

### 階段 2：wiki 語意檢索（風險最低）

11. `app/server/wiki-routes.js` 的 `/ai/wiki/search`：加向量腿，RRF 合併，**LIKE 原樣保留**（僅 `LIMIT 20` → `30`）
12. 索引尚未建立或 worker 未就緒時，**自動退回純 LIKE**（不得報錯、不得回空）

**驗收**：見 §4.2、§4.4。介面形狀、回傳欄位、agent prompt **零改動**（排序會變，見 §2.6 的警語）。

### 階段 3：歷史任務相似度（與階段 2 一起做——它才是這套基礎建設的主要使用者，§2.1）

13. 新端點 `GET /ai/tasks/similar?project=&q=&limit=`（掛 `aiEndpointGuard`，定義在 `lib/ai-token.js:54`，比照 wiki 端點）
14. 回 `task_id` / `title` / 摘要，**不回 analysis_yaml 全文**；另備一個取單張全文的端點。這是既有 wiki 那套兩階段原則（先清單、要細節再取單張），否則一次查詢就把三份規格灌進 context
15. 在 `analysis-project.md` 的【知識查詢】區段加一行，讓它**需要時自己查**（比照 `pipeline/cs-capability.md:8-15` 給 wiki 的三行 curl）

**⚠ 第 15 步刻意不做 few-shot 自動注入。** 初版規格寫的是「把最相似的 N 張 `analysis.yaml` 當 few-shot 注入 prompt」，改掉的理由有三，第三個是硬性的：

1. **與該 agent 的來源分層設計衝突**：`analysis-project.md:39` 明寫 `[碼]` 是能自行複驗的，`[正式區DB]`／`[log]`／`[wiki]` 是「你這關取不到、無從驗證的來源，**不得當已知事實直接寫進規格**」。歷史任務的 `analysis.yaml` 正是這一類——別人寫的規格，這關複驗不了。自動注入等於繞過這個設計，還把它擺在最顯眼的位置。
2. **放大 pipeline 最貴的錯誤**：`CLAUDE.md` §0 是「NEVER add fields/models/logic beyond the task's agreed spec」。塞三份完整的他人規格進去，agent 很容易把範例裡的欄位或權限寫法帶進本任務；而 analysis 的產出是 coding／qa／playwright 三關的輸入，汙染在這裡會一路傳下去。
3. **會打到 prompt cache**：`.claude/rules/agent-prompt.md` 規則 99——注入片段要放在「同專案跨任務固定的前綴」位置，per-task 動態資料會讓前綴逐字不同。few-shot 每張任務都不一樣，正是最糟的位置。

改成「主動查」之後：agent 判斷需要才查、不需要就不花 token；不動 placeholder 契約與 `promptVersion` 指紋；也不需要「等樣本累積到 N 張才能開」的門檻——agent 自己看清單就知道有沒有像的。

**那一行要寫什麼**：指向端點、並註明**歷史規格是參考不是事實**，依 `analysis-project.md:39` 的來源分層處理（會左右實作決策的，改寫成 `clarification_channel.questions` 問使用者）。

**⚠ 動 agent prompt 前必讀 agentPrompt skill**（placeholder／`<result>` 契約／prompt 版本指紋會影響 session 綁定）。

**驗收**：端點能對一個已知任務撈回它的相似鄰居（樣本少時人工看合不合理即可）；`analysis-project` 跑一張任務，確認它有呼叫該端點、且產出的規格沒有出現本任務沒要求的欄位。

---

## 4. 測試與驗證

### 4.1 指令

```bash
cd app && npm run test:quiet          # 全跑，含 --runInBand
```

**不要用 `npx jest` 全跑**——平行 worker 下 pg-mem 會產生浮動假紅。紅了之後才對那一支單獨跑不帶 `--silent` 的完整輸出。

### 4.2 基線：自己量，不要抄任何寫死的數字

**動手改任何東西之前，先跑一次全跑，把 `Tests: X passed` 與 `Test Suites` 那兩行記下來。那就是你的基線。**

參考值：2026-08-08 在這台實測是 `2173 passed / 3 skipped / 159 suites / exit 0`（全綠）。
**但這個數字每 merge 一次就會變**——同一天稍早 `68ba5ed` 量到的是 `2148 passed / 158 suites`，
不到一天就差了 25 支。所以它只能當「應該全綠」的佐證，**不能拿來比對**。

⚠ **不要沿用 `.claude/rules/always.md` 規則 2 的那份「既有紅燈」清單**——它已被 `68ba5ed` 推翻，而且照它判讀會有實害：

| 舊清單說 | 實際 |
|---|---|
| `git-integration.test.js` 的 `ensureWorktreeAtMain` 兩支是 CRLF 造成、必紅 | **真因是無全域 git identity，08-06 已修**。Linux checkout 也不會有 CRLF 問題 |
| `vpn-gateway-run.test.js` 的容器那支必紅 | 在這台上是綠的 |

照舊清單判讀，等於「叫你把 `git-integration` 的紅燈當環境問題放過去，而在這台上那代表你真的改壞了東西」。

**判定法**：跟**你自己量的**基線比對，任何新紅燈先當成自己造成的。真的懷疑是 flaky（pgPass flake 家族）才 stash 掉改動、對那一支單獨複驗，且必須單跑才算數。

### 4.3 本改動要新增的測試

照配對慣例，每個新模組配一支。**路徑是 `app/server/tests/`**（初版規格寫成 `tests/`，會找不到地方放）：

| 檔案 | 驗什麼 |
|---|---|
| `app/server/tests/embedding-chunk.test.js` | 切塊：標題邊界、350 字上限、50 字重疊、標題路徑前綴、空塊丟棄 |
| `app/server/tests/embedding-cosine.test.js` | cosine 正確性、`model_id` 不符時被排除（**含快取載入那條路徑**，見 §2.7） |
| `app/server/tests/embedding-index.test.js` | `source_hash` 相同時不重算；**內容改短後舊 chunk 被刪乾淨**（§2.3 的先刪後插）；來源刪除後 CASCADE 清乾淨 |
| `app/server/tests/embedding-worker.test.js` | worker 崩潰後自動重啟；佇列中的工作被標記失敗而不是無聲吞掉（§2.5，repo 內無既有範例可抄） |
| `app/server/tests/wiki-search-hybrid.test.js` | RRF 合併名次；同頁多 chunk 不灌票；**worker 未就緒時退回純 LIKE 且回傳形狀不變** |

pg-mem 已實測支援 `SERIAL PRIMARY KEY` 與 `ON DELETE CASCADE`，這兩件事不用擔心。
其餘 pg-mem 限制見 `.claude/rules/testing.md`（`ANY(陣列)`、partial unique index、`btrim()`、相關子查詢），
以及 `wiki-routes.js:143,170` 的兩則註解。

**測試不得載入真實模型。** 把 `embedding.js` 的 `embed()` 在測試中換成固定向量的 stub——否則每跑一次測試就載 130 MB 模型，且引入網路相依。

### 4.4 效果驗收（自動化測不到的部分）

語意檢索的品質**無法用單元測試證明**，而且**這件事的資料要靠階段 0 生出來**：

1. 階段 0 上線後，讓它跑一兩週，撈出 10–20 筆真實的「搜了但回 0 筆」的查詢
2. 逐筆人工判定：正確答案在 wiki 裡嗎？
   - **在** → 這筆算數，記錄改動前後是否命中
   - **不在** → 這筆語意檢索救不了（§2.1 的警語），從對照組剔除並另外計數
3. 階段 2 上線後重跑同一批，比對命中率；同時確認 §2.6 的排序改變沒有把 troubleshooting 頁壓下去

「不在 wiki 裡」那一類的筆數本身就是結論：如果佔多數，代表真正該補的是 wiki 內容，不是檢索演算法。

沒有這份對照，「有沒有變好」只能靠感覺。**這一步不能省，而且它是階段 0 存在的唯一理由。**

### 4.5 前端硬規則

動 `app/public` 前先載入 **platformDev** skill。管理頁的進度顯示：配色一律走 `app.css` 的 CSS 變數／dark-aware class。**禁止**在 inline style 寫死淺色 `background` 而不同時寫死文字色——深色模式下文字吃 `var(--text)` 會翻白、整段隱形。

### 4.6 部署後

- **改 `app/server/**.js` 後必須重啟 server**，常駐進程載的是舊碼
- 首次啟動會下載模型權重（約 130 MB），確認 `data/models/` 有落檔
- 觀察記憶體：模型常駐約 300 MB ＋ 向量 < 1 MB。目前 server 常駐約 108 MB、機器可用約 148 GB，**空間充裕**

---

## 5. 風險與回滾

| 風險 | 徵狀 | 處置 |
|---|---|---|
| 模型下載失敗（防火牆／HF 不可達／repo 被移除） | 啟動 log 有下載錯誤，檢索退回純 LIKE | 手動放權重進 `data/models/`，或改用 §2.5 的備援 repo；功能降級但不中斷 |
| worker 崩潰 | 檢索退回純 LIKE | 自動重啟；連續失敗則停用向量腿並在管理頁顯示 |
| `sharp` / `onnxruntime-node` 在 Windows 軌裝不起來 | `npm install` 失敗，`start.ps1` 中止 | 先在 Windows 機實測一次再上正式（§2.5） |
| 增量重算沒刪乾淨 | 搜得到已刪除／已改寫的舊內容，且不報錯 | §2.3 的先刪後插；`embedding-index.test.js` 要涵蓋 |
| 切塊策略不佳 | 檢索命中率沒改善 | 調 §2.4 的字數與重疊，重建索引即可（10–20 秒），不動 schema |
| 品質不如預期 | §4.4 的對照沒改善 | 先分辨是「詞猜不中」還是「wiki 沒寫」（§4.4 第 2 步）；後者不是本規格能解的 |

> 初版列了「記憶體不足 → 改用外部 embedding API」這一列，已刪除：機器可用 148 GB、server 才吃 108 MB，
> 風險不存在；而且 §2.1 決策②拒絕外部 API 的理由是資料邊界，拿「把資料送出去」當回滾方案是自相矛盾。

**回滾**：階段 2 只要把 `/ai/wiki/search` 的向量腿拿掉即可（並把 `LIMIT` 改回 20），LIKE 一直都在，行為完全復原。資料層回滾是一句：

```sql
DROP TABLE IF EXISTS embedding_chunks;
```

因為**沒有動任何既有表的欄位**，這句就是完整清理。（階段 0 那張記錄表可以留著，它獨立於本功能。）

---

## 6. 明確不做

- **不裝 pgvector**（理由見 §2.1）
- **不做 provider 抽象層／外部 embedding API 的切換介面**（§2.1 決策②）
- **不動 `wiki_pages` / `tasks` 的既有欄位**（回滾成本的來源）
- **不改 `/ai/wiki/search` 的回傳欄位與筆數**（agent prompt 零改動是階段 0／2 能安全上線的前提。兩處刻意的行為改變：排序會變見 §2.6，0 筆時回退全目錄見階段 0——兩者都不動欄位形狀）
- **不做跨專案檢索**：一律 `WHERE project_id=$1`。這既是效能前提，也是資料邊界
- **不在檢索結果回 content 全文**：維持現有兩階段設計，否則一次搜尋就把整個 wiki 灌進 agent 的 context
- **不做 re-ranking 模型**：多一個模型、多 300 MB，這個量級不值得
- **不做 few-shot 自動注入**：歷史規格一律走「agent 主動查端點」，理由見階段 3
- **不碰 `analysis-project` 以外的 agent**（階段 3）。唯一例外是階段 0 那個順序對調的建議，且非必要
- **不再自己改 `.claude/rules/always.md`**：§7 那次是經使用者當面同意才動的；日後要再改同樣要先問（`CLAUDE.md` §0）

---

## 7. 規格外的待辦：紅燈豁免清單的來源 —— ✅ 2026-08-08 已修

**本節已執行完畢**（使用者當日明確同意後修改 `.claude/rules/always.md` 規則 2）。以下保留原始脈絡，供日後追溯為什麼那條規則長成現在的樣子。

實際修法：刪掉那兩條具體豁免、保留判定法與 flaky 家族那段、改成「動手前自己跑一次當基線，新紅燈一律先當成自己造成的」，並在條目內寫明**不要再寫死清單或通過數字**以及為什麼（避免有人日後又加回去）。

本節不屬於語意檢索的施工範圍，但**執行本規格時一定會撞到**，所以當初列在這裡。

### 7.1 問題

`68ba5ed`（2026-08-08）實測推翻了那份「既有紅燈、不要 debug」清單，但**只修了三份 SPEC，沒有回頭修規則來源**。`.claude/rules/always.md` 規則 2 至今仍寫著：

```
2. 下列紅燈是既有問題，乾淨 HEAD 也紅，不要 debug（2026-08-06 實測更新）：
   - git-integration.test.js 的 ensureWorktreeAtMain 兩支：CRLF 行尾差異，Windows checkout 必紅
   - vpn-gateway-run.test.js 的 defaultTmpFilePath › 容器化（APP_DIR 已設）…：開發機非容器故必紅
```

### 7.2 逐條對照

| always.md 規則 2 說 | 實測 | 判定 |
|---|---|---|
| `ensureWorktreeAtMain` 兩支＝CRLF 行尾差異，Windows 必紅 | 真因是**無全域 git identity**，08-06 當天已修；Linux checkout 也不會有 CRLF 問題 | ❌ 錯 |
| `vpn-gateway-run.test.js` 容器那支必紅 | 該機是綠的 | ❌ 錯 |
| 判定法：stash 掉自己的改動、對那一支單獨再跑一次 | — | ✅ 對，唯一該留的 |
| 其餘紅燈先假設 flaky（pgPass 家族），單跑複驗才算數 | — | ✅ 對 |

**為什麼會錯**：規則 2 自己標注「2026-08-06 實測更新」，而 CRLF 的真因（git identity）也正是 08-06 修掉的。那份清單是在修好**之前**量的，修好之後沒有人回頭更新它。

### 7.3 影響範圍（比清單過期本身嚴重）

`always.md` 是**常駐規則，不是只有人在讀**——`CLAUDE.md` 與 `.claude/rules/` 由 agent-loader 注入 pipeline agent。所以每一支會跑測試的 agent 都可能拿到這份已被推翻的豁免清單。

實害是 `68ba5ed` 的標題本身：**它會叫你把 `git-integration` 的紅燈當環境問題放過去，而在這台上那代表你真的改壞了東西。**

### 7.4 修法（✅ 已於 2026-08-08 經使用者同意後執行）

已將 `.claude/rules/always.md` 規則 2 改為：

- **刪掉**那兩條具體豁免（CRLF 兩支、vpn-gateway 容器那支）
- **保留**判定法（stash 後單跑複驗）與 flaky 家族那段——這兩條實測仍成立
- **改成**：「動手前先自己跑一次全跑當基線，之後任何新紅燈一律先當成自己造成的」

⚠ **不要在規則裡寫任何絕對的通過數字。** 初版規格建議寫「基線 `2148 passed`」——那正是規則 2 犯的錯：
把某台機器某一天的快照當成永久規則。實測證明它**同一天就腐爛了**（`68ba5ed` 量到 2148，幾小時後同一台是 2173）。
寫死數字只會製造下一個規則 2。

（`CLAUDE.md` §0 硬規則寫明「不得在未經使用者明確同意下修改工作流程設定」，`.claude/rules/always.md` 屬於同一類，
所以這一步是等使用者拍板後才動的。日後要再改這條，同樣要先問。）

修完之後 `always.md` 規則 2 與本規格 §4.2 說的是同一件事，兩邊都可以照。
