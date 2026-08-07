# 規格書：wiki 與歷史任務語意檢索

> 目標讀者：在正式機執行本改動的人或 agent
> 規模：三階段，各自可獨立上線與回滾。階段 1 無使用者可見變化，階段 2 改既有端點行為，階段 3 動 pipeline。
> 與其他規格無依賴，隨時可插。
>
> **收尾慣例**（見 commit `1697082`）：根目錄只留**尚未執行**的規格。本檔執行完畢後移進 `docs/`
> （該目錄在 `.gitignore` 內，spec／plan 不進版控），並比照 `SPEC-inbox.md` 等在頂部補一段
> 「執行狀態 ＋ 實際偏離」——寫下錨點複驗結果與本文沒提到、但真的會炸的坑，避免日後有人照著再做一次。

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

---

## 2. 設計

### 2.1 三個「不做什麼」的決策（先讀這段，它們決定了整份規格的形狀）

**① 不用 pgvector。**

理由不是技術偏好，是部署形態：

- Windows 軌用 `install.ps1` 以 winget 裝 EDB PostgreSQL 17。pgvector 不在 StackBuilder 內，要嘛用 Visual Studio Build Tools 自行編譯，要嘛手動丟預編譯 dll 進 `lib/` 與 `share/extension/`。**沒有能寫進 `install.ps1` 的一鍵路徑。**
- 容器軌是 ubuntu:24.04，`apt install postgresql-17-pgvector` 一行搞定。
- 於是兩軌做法完全不同，而且只有一軌會壞——這正是最難查的那類 bug。

而資料量根本用不到它。實測規模約 30 個專案，估算 chunk 總數約 16,000：

| 項目 | 數字 |
|---|---|
| 全部 chunk 的向量佔記憶體 | 384 維 × 4 bytes × 16,000 ＝ **24 MB** |
| 單次查詢實際要算的 chunk | 檢索一律 `WHERE project_id=$1` → **約 400 個** |
| 400 次 cosine 的耗時 | **< 1 ms** |

pgvector 要到幾十萬筆才開始有意義。差兩個數量級。

**② 不用外部 embedding API。**

Anthropic 沒有 embedding 產品線，所以無論如何都要引入新東西。選本地的理由：wiki 內含客戶的排障結論與規格，不外流；且無金鑰管理、無按量計費依賴。全量索引的 API 成本其實只有約 $0.10，**成本不是這個決定的理由**，資料邊界才是。

**③ 不取代現有的 LIKE。**

純語意檢索有明確弱點：**精確詞反而不準**。agent 搜一個確切的 model 名（`idx.hj.order`）或錯誤碼時，關鍵字精準無比，向量只會回一堆「大概相關」。

所以本改動是**加法**：LIKE 保留，向量是第二條腿，兩者合併排序。現有行為壞不了，這也是階段 2 能安全上線的原因。

### 2.2 資料流

```
建索引（背景、增量）
  wiki_pages.content / tasks.analysis_yaml
    → 切塊（§2.4）
    → worker 算 embedding（§2.5）
    → 存進 embedding_chunks.vector（base64 TEXT）

查詢（每次搜尋）
  查詢字串
    → worker 算 embedding（20–50 ms）
    → 撈該 project 的 chunks（記憶體快取）
    → 純 JS cosine 排序
    → 與 LIKE 結果 RRF 合併（§2.6）
    → 回 slug / title / description（維持現有兩階段形狀）
```

### 2.3 Schema

**新表**（加進 `app/server/db.js` 的 `CREATE TABLE` 清單）：

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

索引（照既有慣例，`CREATE INDEX IF NOT EXISTS ... .catch(() => {})`）：

```sql
CREATE INDEX IF NOT EXISTS idx_emb_project ON embedding_chunks (project_id);
CREATE INDEX IF NOT EXISTS idx_emb_wiki    ON embedding_chunks (wiki_page_id);
CREATE INDEX IF NOT EXISTS idx_emb_task    ON embedding_chunks (task_id);
```

設計說明：

- **`wiki_page_id` / `task_id` 兩個 nullable FK，而不是 `source_type` + `source_id`**：這樣 `ON DELETE CASCADE` 會自動清掉孤兒。用泛型的 source_id 就得自己寫清理邏輯，而且刪除路徑散在 `tasks-routes.js` 與 wiki 各處，一定會漏。
- **`vector` 用 `TEXT` 存 base64，不用 `BYTEA`**：`db.js` 已有多處為 pg-mem 相容做的取捨（`ILIKE` 不可用、`ANY(陣列)` 對有索引欄位靜默回 0 列）。BYTEA 的 Buffer 往返在 pg-mem 下不保證行為一致，而代價只是 33% 空間（24 MB → 32 MB）。**穩定優先於省空間。**
- **`model_id`**：模型指紋。換模型時所有舊向量作廢，靠這欄識別。查詢時必須過濾 `model_id = 現用模型`，否則不同模型的座標系統混在一起算，結果是垃圾且不會報錯。
- **`source_hash`**：來源內容的 SHA-256。增量索引比對它而不是 `updated_at`——`wiki_pages.updated_at` 可能因無關欄位變動而更新，會造成無謂重算。

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

### 2.5 Embedding worker

**模型**：`Xenova/multilingual-e5-small`（384 維，量化後約 130 MB）

> 安裝時先確認該模型在 Hugging Face 上可下載。若 `Xenova` 帳號下已移除，改用 `onnx-community` 帳號下的同名模型。維度不變則無需改任何程式碼。

**套件**：`@huggingface/transformers`（transformers.js v3），加進 `app/package.json` 的 `dependencies`。

底層 `onnxruntime-node` 有 Windows x64 與 Linux x64 預編譯二進位，`npm install` 直接取用，**不需要編譯工具鏈、不需要 Python**。`start.ps1` 現有的「比對 hidden lockfile，缺了才裝」邏輯會自動補裝，**安裝腳本一個字都不用改**。

**⚠️ 必須跑在 worker_threads，不能在主行程算。**

Node 是單執行緒，20 人同時在用。在主行程跑推論會卡住整個 server（包含 socket.io 事件與 pipeline 排程）。做法：

- `app/server/lib/embedding-worker.js`：worker 進入點，載入模型，接收 `{ texts: string[] }` 回 `Float32Array[]`
- `app/server/lib/embedding.js`：主行程這側的門面，維護**單一 worker ＋ 序列佇列**
- worker 崩潰時自動重啟，佇列中的工作標記失敗而非無聲吞掉

**⚠️ e5 系列必須加前綴，漏了會明顯掉品質且不會報錯：**

| 用途 | 前綴 |
|---|---|
| 建索引（文件） | `passage: ` |
| 查詢 | `query: ` |

這是 e5 訓練時的約定。兩邊用錯或漏掉，檢索品質會下降但一切「看起來正常」。

**模型權重落點**：設 transformers.js 的 `env.cacheDir` 指向 `data/models/`（相對 repo 根，用 `APP_DIR` 或 `__dirname` 推導，**不得寫死絕對路徑**）。並在 `.gitignore` 加一行 `/data/models/`。

離線環境：允許事先把權重放進該目錄，啟動時偵測到就不下載。

### 2.6 混合排序（RRF）

兩條腿的分數不同量綱（LIKE 沒有分數，cosine 是 0–1），不能直接加權相加。用 **Reciprocal Rank Fusion**，只看名次不看分數：

```
score(doc) = Σ  1 / (k + rank_in_list)      k = 60（業界慣用值）
```

- 兩份清單各取前 30
- 同一頁的多個 chunk 命中時，取該頁最好的名次（不累加，否則長頁面會因為 chunk 多而灌票）
- 合併後取前 20（維持現有 `LIMIT 20`）

保留現有的 `ORDER BY (node_type <> 'troubleshooting')` 語意——排障結論優先，作為 RRF 之後的次要排序鍵。

### 2.7 記憶體快取

24 MB 全部載入即可，**不需要 lazy load 或 LRU**（前一版設計有，按實際規模重算後移除——那是為不存在的規模做準備）。

- server 啟動後背景載入，載完前查詢自動退回純 LIKE（不阻塞啟動）
- 建索引寫入後同步更新快取
- 結構：`Map<project_id, Array<{ chunkId, wikiPageId, taskId, vec: Float32Array }>>`

### 2.8 觸發時機

| 情境 | 動作 |
|---|---|
| wiki 頁儲存／重新生成 | 該頁入佇列，增量重算 |
| 任務寫入 `analysis_yaml` | 該任務入佇列 |
| 管理頁按「重建索引」 | 全量重跑（約 9 分鐘） |
| 夜間排程 | 掃 `source_hash` 不一致者補算 |

夜間排程掛進 `app/server/cron.js`，照既有的 `HEALTH_CHECK_INTERVAL_MS` 模式（每分鐘 tick，內部判斷間隔）。時段避開 pipeline 尖峰，與測試區夜間關機同時段最合適。

---

## 3. 實作步驟

### 階段 1：embedding 基礎建設（無使用者可見變化）

1. `app/package.json` 加 `@huggingface/transformers` 相依
2. `.gitignore` 加 `/data/models/`
3. `app/server/db.js`：加 `embedding_chunks` 建表與三個索引（走既有 `CREATE TABLE` 清單，**不是** ALTER 清單——這是新表不是新欄位）
4. `app/server/lib/embedding-worker.js`：worker 進入點
5. `app/server/lib/embedding.js`：門面、佇列、快取、切塊、cosine
6. `app/server/lib/embedding-index.js`：建索引流程（全量／增量、`source_hash` 比對、進度落 DB）
7. `app/server/admin-routes.js`：`POST /admin/embedding/rebuild`、`GET /admin/embedding/status`
8. `app/public/js/views/Admin.js`（或既有 Admin 子頁）：重建按鈕 ＋ 進度顯示
9. `app/server/cron.js`：夜間補算

**驗收**：能把現有 wiki 全量索引完，`embedding_chunks` 有資料；重跑第二次因 `source_hash` 相同而幾乎瞬間完成；期間 server 正常回應其他請求（worker 沒卡住主行程）。

### 階段 2：wiki 語意檢索（風險最低，先上）

10. `app/server/wiki-routes.js` 的 `/ai/wiki/search`：加向量腿，RRF 合併，**LIKE 原樣保留**
11. 索引尚未建立或 worker 未就緒時，**自動退回純 LIKE**（不得報錯、不得回空）

**驗收**：見 §4.2。介面形狀、回傳欄位、agent prompt **零改動**。

### 階段 3：歷史任務相似度（風險最高，最後做）

12. 新端點 `GET /ai/tasks/similar?project=&q=&limit=`（掛 `aiEndpointGuard`，比照 wiki 端點）
13. 回 `task_id` / `title` / 摘要，**不回 analysis_yaml 全文**（同樣的兩階段原則，否則一次查詢就把三份規格灌進 context）
14. 接進 `analysis-project`：把最相似的 N 張任務的 `analysis.yaml` 當 few-shot

**⚠️ 第 14 步先停下來確認。** 動 agent prompt 前必讀 **agentPrompt** skill（placeholder／`<result>` 契約／prompt 版本指紋會影響 session 綁定）。而且這一步會改變 analysis 的產出品質，**沒有辦法用單元測試證明變好**——驗收方式見 §4.4。

---

## 4. 測試與驗證

### 4.1 指令

```bash
cd app && npm run test:quiet          # 全跑，含 --runInBand
```

**不要用 `npx jest` 全跑**——平行 worker 下 pg-mem 會產生浮動假紅。紅了之後才對那一支單獨跑不帶 `--silent` 的完整輸出。

### 4.2 基線：全綠，新紅燈一律先當成自己造成的

**正式機基線是 2148 passed / 0 failed / exit 0**（2026-08-08 實測，見 commit `68ba5ed`）。

⚠️ **不要沿用 `.claude/rules/always.md` 規則 2 的那份「既有紅燈」清單**——它已被 `68ba5ed` 推翻，而且照它判讀會有實害：

| 舊清單說 | 實際 |
|---|---|
| `git-integration.test.js` 的 `ensureWorktreeAtMain` 兩支是 CRLF 造成、必紅 | **真因是無全域 git identity，08-06 已修**。Linux checkout 也不會有 CRLF 問題 |
| `vpn-gateway-run.test.js` 的容器那支必紅 | 在正式機上是綠的 |

照舊清單判讀，等於「叫你把 `git-integration` 的紅燈當環境問題放過去，而在這台上那代表你真的改壞了東西」。

**判定法**：拿 `2148 passed` 當基線比對，任何新紅燈先當成自己造成的。真的懷疑是 flaky（pgPass flake 家族）才單跑複驗，且必須單跑才算數。

### 4.3 本改動要新增的測試

照配對慣例，每個新模組配一支：

| 檔案 | 驗什麼 |
|---|---|
| `tests/embedding-chunk.test.js` | 切塊：標題邊界、350 字上限、50 字重疊、標題路徑前綴、空塊丟棄 |
| `tests/embedding-cosine.test.js` | cosine 正確性、`model_id` 不符時被排除 |
| `tests/embedding-index.test.js` | `source_hash` 相同時不重算；來源刪除後 CASCADE 清乾淨 |
| `tests/wiki-search-hybrid.test.js` | RRF 合併名次；同頁多 chunk 不灌票；**worker 未就緒時退回純 LIKE 且回傳形狀不變** |

**測試不得載入真實模型。** 把 `embedding.js` 的 `embed()` 在測試中換成固定向量的 stub——否則每跑一次測試就載 130 MB 模型，且引入網路相依。

### 4.4 效果驗收（自動化測不到的部分）

語意檢索的品質**無法用單元測試證明**。上線前準備一份人工測試集：

1. 從 `wiki_drift` 或排障對話裡撈 10–20 個**真實搜過但沒搜到**的案例
2. 記錄改動前的 `hits` 數與是否命中正確頁
3. 改動後重跑同一批，比對

沒有這份對照，「有沒有變好」只能靠感覺。**這一步不能省。**

### 4.5 前端硬規則

管理頁的進度顯示：配色一律走 `app.css` 的 CSS 變數／dark-aware class。**禁止**在 inline style 寫死淺色 `background` 而不同時寫死文字色——深色模式下文字吃 `var(--text)` 會翻白、整段隱形。

### 4.6 部署後

- **改 `app/server/**.js` 後必須重啟 server**，常駐進程載的是舊碼
- 首次啟動會下載模型權重（約 130 MB），確認 `data/models/` 有落檔
- 觀察記憶體：模型常駐約 300 MB ＋ 向量 24 MB，確認機器吃得住

---

## 5. 風險與回滾

| 風險 | 徵狀 | 處置 |
|---|---|---|
| 模型下載失敗（防火牆／HF 不可達） | 啟動 log 有下載錯誤，檢索退回純 LIKE | 手動放權重進 `data/models/`；功能降級但不中斷 |
| worker 崩潰 | 檢索退回純 LIKE | 自動重啟；連續失敗則停用向量腿並在管理頁顯示 |
| 記憶體不足 | server OOM | 改用外部 embedding API（`embedding.js` 的 provider 介面就是為此保留） |
| 切塊策略不佳 | 檢索命中率沒改善 | 調 §2.4 的字數與重疊，重建索引即可，不動 schema |
| 品質不如預期 | §4.4 的對照沒改善 | 見下方回滾 |

**回滾**：階段 2 只要把 `/ai/wiki/search` 的向量腿拿掉即可，LIKE 一直都在，行為完全復原。資料層回滾是一句：

```sql
DROP TABLE IF EXISTS embedding_chunks;
```

因為**沒有動任何既有表的欄位**，這句就是完整清理。

---

## 6. 明確不做

- **不裝 pgvector**（理由見 §2.1）
- **不動 `wiki_pages` / `tasks` 的既有欄位**（回滾成本的來源）
- **不改 `/ai/wiki/search` 的介面與回傳欄位**（agent prompt 零改動是階段 2 能安全上線的前提）
- **不做跨專案檢索**：一律 `WHERE project_id=$1`。這既是效能前提，也是資料邊界
- **不在檢索結果回 content 全文**：維持現有兩階段設計，否則一次搜尋就把整個 wiki 灌進 agent 的 context
- **不做 re-ranking 模型**：多一個模型、多 300 MB，這個量級不值得
- **不碰 `analysis-project` 以外的 agent**（階段 3）

---

## 7. 規格外的待辦：紅燈豁免清單的來源本身還沒修

本節不屬於語意檢索的施工範圍，但**執行本規格時一定會撞到**，所以列在這裡。

### 7.1 問題

`68ba5ed`（2026-08-08）實測推翻了那份「既有紅燈、不要 debug」清單，但**只修了三份 SPEC，沒有回頭修規則來源**。`.claude/rules/always.md` 規則 2 至今仍寫著：

```
2. 下列紅燈是既有問題，乾淨 HEAD 也紅，不要 debug（2026-08-06 實測更新）：
   - git-integration.test.js 的 ensureWorktreeAtMain 兩支：CRLF 行尾差異，Windows checkout 必紅
   - vpn-gateway-run.test.js 的 defaultTmpFilePath › 容器化（APP_DIR 已設）…：開發機非容器故必紅
```

### 7.2 逐條對照

| always.md 規則 2 說 | `68ba5ed` 實測 | 判定 |
|---|---|---|
| `ensureWorktreeAtMain` 兩支＝CRLF 行尾差異，Windows 必紅 | 真因是**無全域 git identity**，08-06 當天已修；Linux checkout 也不會有 CRLF 問題 | ❌ 錯 |
| `vpn-gateway-run.test.js` 容器那支必紅 | 該機是綠的 | ❌ 錯 |
| 判定法：stash 掉自己的改動、對那一支單獨再跑一次 | — | ✅ 對，唯一該留的 |
| 其餘紅燈先假設 flaky（pgPass 家族），單跑複驗才算數 | — | ✅ 對 |

**為什麼會錯**：規則 2 自己標注「2026-08-06 實測更新」，而 CRLF 的真因（git identity）也正是 08-06 修掉的。那份清單是在修好**之前**量的，修好之後沒有人回頭更新它。

### 7.3 影響範圍（比清單過期本身嚴重）

`always.md` 是**常駐規則，不是只有人在讀**——`CLAUDE.md` 與 `.claude/rules/` 由 agent-loader 注入 pipeline agent。所以每一支會跑測試的 agent 都可能拿到這份已被推翻的豁免清單。

實害是 `68ba5ed` 的標題本身：**它會叫你把 `git-integration` 的紅燈當環境問題放過去，而在正式機上那代表你真的改壞了東西。**

### 7.4 建議修法（一行的事，但需明確同意才動）

改 `.claude/rules/always.md` 規則 2 為：

- **刪掉**那兩條具體豁免（CRLF 兩支、vpn-gateway 容器那支）
- **保留**判定法（stash 後單跑複驗）與 flaky 家族那段——這兩條實測仍成立
- **改成**：正式機基線 `2148 passed / 0 failed / exit 0`，新紅燈一律先當成自己造成的

⚠️ 本規格**不自己動它**：`CLAUDE.md` §0 硬規則寫明「不得在未經使用者明確同意下修改工作流程設定（hook、`settings.json`、CI、本檔）」，`.claude/rules/always.md` 屬於同一類。**請由人明確拍板後再改。**

在那之前，執行本規格時以 §4.2 為準，不要以 `always.md` 規則 2 為準。
