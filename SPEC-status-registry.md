# 規格書：任務狀態 Registry（狀態分類層）

> 目標讀者：在正式機執行本改動的人或 agent
> 前置：本文件自包含，不需回頭查對話。所有現況引用皆附檔名與行號（基準：本文件產出時的 HEAD）。

> ## ✅ 執行狀態：2026-08-08 已完成（commit `3b78a7f`）
>
> 錨點複驗：本文引用的 9 組位置全部準確。§2.2 的「三份名單是完美劃分」實測成立（8＋16＋1＝25，
> 交集為空、與原手寫內容逐一相同）。實際執行時與本文有三處差異：
>
> 1. **§1 盤點漏了第四份手寫名單**：`tasks-routes.js:162` 的 `NEEDS_ACTION_STATUSES`（8 個，與
>    `HUMAN_STATUSES` 完全相同）。它比另外三份更要緊——是 `/api/tasks?needs_action=true` 的 SQL
>    查詢條件，漏補的後果是「前端照顯示、通知照發，只有 API 撈不到那張任務」。已一併收進 registry，
>    配套把 `pipeline-flow.test.js` 那支掃 route 檔原始碼的 regex 改成直接讀 registry。
> 2. **§4 階段 4（pipeline-spec 改引用）未做**：既有的 `test.each(declared)`（`pipeline-flow.test.js:57`）
>    已逐一驗證圖上 status 是真狀態、拼錯當場紅——該階段宣稱的目的**已經達成**。改動 22 處 status
>    反而是 §6 風險表裡最高的一項。改為在 `pipeline-spec.js` 檔頭註明守衛位置。
> 3. **§5.2 的既有紅燈清單已過時**，見該節更正。
>
> §4 階段 5 的兩條新守衛已加並經破壞測試驗證（故意把 `review_pending` 的 actor 改成 `system`，
> 矛盾守衛當場翻紅並指名節點）。

---

## 1. 為什麼要做

任務狀態目前是 25 個扁平字串，只有中文標籤，**沒有任何結構化屬性**。因此每個需要「把狀態分類」的地方，都得自己維護一份名單：

| 位置 | 形式 | 內容 |
|---|---|---|
| `app/public/js/status-labels.js` | `STATUS_LABELS` map | 25 個 status → 中文 |
| `app/public/js/views/TaskList.js:1` | `NEEDS_ACTION` 陣列 | 8 個 |
| `app/server/notify.js:6-9` | `ACTION_STATUSES` Set | 8 個 |
| `app/server/pipeline/runner.js:35` | `RUNNABLE_STATUSES` 陣列 | 16 個 |
| `app/server/pipeline/runner.js:24-31` | `STAGE_LABELS` map | 17 個（後端歷程文案，**刻意不併**） |
| `app/public/js/pipeline-spec.js` | 節點的 `kind` / `track` | 畫圖屬性，實質也在分類 |

**失效方式是靜默的**：新增一關時漏補某一份，該畫面顯示英文代號或少一格，不會有任何 console 錯誤。`status-labels.js` 檔頭與 `frontend-status-labels.test.js:31-33` 都記錄了實際發生過的漂移（`cs_reply_pending` 在 `socket.js` 是「等待回覆確認」、單一來源是「等待確認回覆」；`respec_running` 只有詳情頁有）。

既有防線是「事後抓漏」——用 regex 掃 `runner.js` 原始碼比對（`pipeline-flow.test.js:82`）。本改動要把它變成「結構上不可能漏」。

---

## 2. 盤點結果（核心資產，已完成核對）

### 2.1 25 個狀態的完整分類

`actor` = 誰負責推進這個狀態。四種取值：`human`（等人）／`agent`（AI 在跑）／`system`（系統自動，無 AI）／`terminal`（終態）。

| # | status | 中文標籤 | actor | agent | 圖上 kind | 現有名單歸屬 |
|---|---|---|---|---|---|---|
| 1 | `new` | 待分類 | system | — | `start` | RUNNABLE |
| 2 | `cs_running` | 客服處理 | agent | `cs` | `agent` | RUNNABLE |
| 3 | `cs_data_needed` | 需補資料 | **human** | — | `gate` | NEEDS_ACTION／ACTION |
| 4 | `cs_reply_pending` | 等待確認回覆 | **human** | — | `gate` | NEEDS_ACTION／ACTION |
| 5 | `analysis_running` | 分析中 | agent | `analysis-project` | `agent` | RUNNABLE |
| 6 | `confirm_pending` | 等待確認 | **human** | — | `gate` | NEEDS_ACTION／ACTION |
| 7 | `confirm_answered` | 已回覆 | system | — | *(UNDRAWN)* | RUNNABLE |
| 8 | `spec_review` | 等待規格確認 | **human** | — | `gate` | NEEDS_ACTION／ACTION |
| 9 | `branch_pending` | 建立分支 | system | — | `sys` | RUNNABLE |
| 10 | `coding_running` | 開發中 | agent | `coding-project` | `agent` | RUNNABLE |
| 11 | `qa_running` | QA 審查中 | agent | `qa` | `agent` | RUNNABLE |
| 12 | `clarify_pending` | 待你裁決 | **human** | — | `gate` | NEEDS_ACTION／ACTION |
| 13 | `clarify_answered` | 已裁決 | system | — | *(UNDRAWN)* | RUNNABLE |
| 14 | `clarify_chat_running` | AI 回覆中 | agent | `clarify-chat` | *(UNDRAWN)* | RUNNABLE |
| 15 | `respec_running` | 追加需求更新規格中 | agent | `respec-patch` | `agent` | RUNNABLE |
| 16 | `reject_triage` | 分診中 | agent | `analysis-reject` | `agent`※ | RUNNABLE |
| 17 | `resolve_triage` | 分診中 | agent | `analysis-reject` | `agent`※ | RUNNABLE |
| 18 | `stopped` | 失敗待確認 | **human** | — | `stop` | NEEDS_ACTION／ACTION |
| 19 | `merge_running` | 併入測試中 | system | — | `sys` | RUNNABLE |
| 20 | `merge_conflict` | 合併衝突 | **human** | — | `gate` | NEEDS_ACTION／ACTION |
| 21 | `deploy_testing` | 部署測試區 | system | — | `sys` | RUNNABLE |
| 22 | `playwright_running` | E2E 測試中 | agent | `playwright` | `agent` | RUNNABLE |
| 23 | `review_pending` | 等待審核 | **human** | — | `gate` | NEEDS_ACTION／ACTION |
| 24 | `wiki_updating` | 更新 Wiki | agent | `library` | `agent` | RUNNABLE |
| 25 | `done` | 完成 | **terminal** | — | `end` | *(皆不屬於)* |

※ #16 與 #17 共用圖上同一個節點（`triage`，`status: 'reject_triage / resolve_triage'`）。

### 2.2 關鍵驗證：三份陣列是完美劃分

- `actor === 'human'` → **8 個**，與 `NEEDS_ACTION`（`TaskList.js:1`）逐一相同
- `actor === 'human'` → **8 個**，與 `ACTION_STATUSES`（`notify.js:6-9`）逐一相同（兩份內容一致，僅順序不同）
- `actor !== 'human' && actor !== 'terminal'` → **16 個**，與 `RUNNABLE_STATUSES`（`runner.js:35`）逐一相同
- 8 + 16 + 1 = **25** = `STATUS_LABELS` 全部

**零例外。** 三份名單全部可由 `actor` 推導，不需任何特例清單。這是本改動可行性的核心證據。

### 2.3 `kind` 與 `actor` 的關係（重要修正）

**`kind` 不可由 `actor` 推導**，理由有二：

1. `gate`（7 個）與 `stop`（`stopped`）都對到 `actor: 'human'`，反推分不出來
2. `PF_UNDRAWN_STATUSES` 的三個狀態（`confirm_answered`／`clarify_answered`／`clarify_chat_running`）**根本沒有節點，也就沒有 `kind`**

因此本規格**不做 `kind` 推導**，`kind` 維持寫在 `pipeline-spec.js`（它本來就是畫圖屬性）。改為在測試加一條**矛盾守衛**（見 §5.3）。

### 2.4 圖上節點與狀態是多對多

實作 §4.4 時必須處理，不可假設一對一：

- `done` → 兩個節點（`csdone`、`done`；客服路徑刻意不拉貫穿全圖的線）
- `triage` 節點 → 兩個狀態（`reject_triage`／`resolve_triage`）
- `spectour`、`release`、五個 `git` 節點、`gitgh` → **無 status，只有 `ref`**（不進 registry）

既有 `pipeline-flow.test.js:25` 的 `statusesOf()` 已用 `/` 分割處理並列狀態，改成引用形式時需一併調整。

---

## 3. 設計

### 3.1 依賴方向（本改動的本質）

```
status-labels.js  ← 狀態是什麼（label / actor / agent）※ 單一來源
        ↑ 引用
pipeline-spec.js  ← 這些狀態怎麼接（節點順序、連線、進入條件、kind、track）
        ↑ 引用
runner.js / notify.js / TaskList.js  ← 全部改為推導，不再自列陣列
```

### 3.2 為什麼不把狀態屬性寫進 `pipeline-spec.js`

**這是本規格最重要的約束，違反會產生實際 bug。**

`pipelineNodes(flags)` 是**函式**，`e2eEnabled === false` 時 `e2e` 節點整個不 `push`（`pipeline-spec.js:259-276`）。若狀態屬性寫在節點裡：

> 專案關掉 E2E → `playwright_running` 的定義消失 → 但 DB 裡跑到一半的舊任務仍停在該狀態 → 列表查標籤查不到 → 畫面掉回英文代號。

根因是兩者生命週期不同：

- **狀態屬性是靜態的**：`qa_running` 永遠是「AI 在跑」，不隨任何設定變
- **流程拓樸是動態的**：哪些關存在、怎麼接，依 `e2eEnabled`／`specTour` 變

### 3.3 Registry 形狀

`app/public/js/status-labels.js` 改為：

```js
const TASK_STATUSES = {
  new:                  { label: '待分類',              actor: 'system' },
  cs_running:           { label: '客服處理',            actor: 'agent',  agent: 'cs' },
  cs_data_needed:       { label: '需補資料',            actor: 'human' },
  // ...（依 §2.1 表格全部 25 筆）
  done:                 { label: '完成',                actor: 'terminal' },
};

// 相容層：既有 25+ 處取用點零改動
const STATUS_LABELS = Object.fromEntries(
  Object.entries(TASK_STATUSES).map(([k, v]) => [k, v.label])
);

// 推導出的名單（取代三份手寫陣列）
const byActor = (...a) => Object.keys(TASK_STATUSES).filter(s => a.includes(TASK_STATUSES[s].actor));
const HUMAN_STATUSES    = byActor('human');                    // 取代 NEEDS_ACTION／ACTION_STATUSES
const RUNNABLE_STATUSES = byActor('system', 'agent');          // 取代 runner 的同名陣列
```

匯出時 `TASK_STATUSES`、`STATUS_LABELS`、`HUMAN_STATUSES`、`RUNNABLE_STATUSES` 並列，沿用檔尾既有的 `window` / `module.exports` 雙掛載寫法。

### 3.4 與既有守衛的相容性（已查證，無阻力）

`frontend-status-labels.test.js` 的兩條守衛都不會擋：

- **第 15 行** 建檔案清單時就把 `status-labels.js` 自己 `filter` 掉了 → 在該檔內擴充完全不受檢查
- **第 40 行** `LABEL_PAIR` regex 要求「值含中文」。新形狀是 `new: { label: '待分類' }`，命中的 key 是 `label`（不在 `STATUS_KEYS` 內），**不算違規**

`pipeline-flow.test.js:3` 與 `frontend-status-labels.test.js:3` 都以 `const { STATUS_LABELS } = require(...)` 解構取用 —— §3.3 的相容層保證兩者繼續有效。

---

## 4. 實作步驟

> 每個階段結束都必須跑測試並全綠才進下一階段。**階段 2 完成後可隨時停手**——registry 已就位，後續是逐步把散落的陣列收回來，非全有全無。

### 階段 1：盤點 ✅ 已完成

結果即 §2.1 表格，實作時直接採用，不需重跑。

### 階段 2：建立 registry ＋ 相容層

**檔案**：`app/public/js/status-labels.js`（唯一）

1. 依 §2.1 表格寫出 `TASK_STATUSES` 全部 25 筆
2. 加上 §3.3 的相容層與推導函式
3. 檔頭註解更新：說明它從「標籤表」升級為「狀態 registry」，並寫明 §3.2 的約束（狀態屬性不得下放到 `pipeline-spec.js`）

**驗證**：
```bash
cd app && npm run test:quiet 2>&1 | grep -vE '^PASS |^$'
```
本階段**不得有任何行為改變**，全部既有測試必須維持原狀態。

### 階段 3：三份陣列改為推導（一次一個，逐個驗證）

| 順序 | 檔案 | 動作 |
|---|---|---|
| 3a | `app/server/notify.js:6-9` | `ACTION_STATUSES` 改為 `new Set(HUMAN_STATUSES)` |
| 3b | `app/public/js/views/TaskList.js:1` | 刪 `NEEDS_ACTION` 字面陣列，改用 `HUMAN_STATUSES` |
| 3c | `app/server/pipeline/runner.js:35` | `RUNNABLE_STATUSES` 改為引用 registry 推導值 |

**3a／3c 注意**：後端 `require('../public/js/status-labels.js')` 是跨層引用。既有測試已這樣做（`pipeline-flow.test.js:3`），但那是**測試**在讀，本階段是 **runtime** 在讀。若團隊認為後端 runtime 不宜依賴 `public/`，改為把 registry 放 `app/server/lib/task-statuses.js`、由 `public/js/status-labels.js` 反向引用——**但前端無法 `require`，屆時 registry 必須留在 `public/`**。故建議維持 registry 在 `public/js/status-labels.js`，與既有測試的取用方式一致。

**3b 注意**：`TaskList.js` 的 `DEV_STEPS`／`CS_STEPS` 進度條陣列（第 5-29 行）**本階段不動**——它們是「畫進度條的分組」，與 `actor` 是不同維度。

**驗證**：每個子步驟後單獨跑一次全跑測試，紅了立刻停。

### 階段 4：`pipeline-spec.js` 改為引用

把節點的 `status: 'qa_running'` 改為引用 registry 的 key，使拼錯從「靜默畫錯一格」變成「當場 undefined → 測試紅」。

**必須處理 §2.4 的多對多**：`triage` 節點的並列狀態、`done` 的雙節點、無 status 的節點（`spectour`／`release`／`git` 系列維持只有 `ref`）。

同步調整 `pipeline-flow.test.js:25` 的 `statusesOf()` 以配合新形狀。

### 階段 5：反向守衛 ＋ 文件

1. **新增守衛（本改動的主要新增價值）**：registry 中 `actor === 'human'` 的狀態，`runner.js` 內不得存在自動推進它的賦值。擋的是「不小心讓該等人的閘門被自動跳過」——目前完全沒有防線的一類 bug。
2. **矛盾守衛**（§2.3）：圖上 `kind ∈ {gate, stop}` 的節點，其 status 在 registry 必須是 `actor: 'human'`；`kind === 'agent'` 必須是 `actor: 'agent'`。
3. **更新 `.claude/skills/pipelineFlow/SKILL.md`**：維護順序從「先改 spec → 再改 runner」改為「**先改 registry → 再改 spec 和 runner**」。漏這步的話，下次照舊流程改會在錯的地方起手。

---

## 5. 測試與驗證

### 5.1 指令（重要）

```bash
cd app && npm run test:quiet 2>&1 | grep -vE '^PASS |^$'
```

**不要用 `npm test`**（輸出 127K，色碼佔 27%、console 堆疊佔 25%，對判斷紅綠零資訊量）。**不要用 `npx jest`**（平行 worker 下 pg-mem 產生浮動假紅）。

### 5.2 已知的既有紅燈

**⚠ 2026-08-08 實測更正：本機基線是全綠（2148 passed / 0 failed / exit 0，158 suites）。**
下列三支在此環境**都是綠的**——`ensureWorktreeAtMain` 兩支的 CRLF 問題在 Linux checkout 不成立
（且 git identity 那個真因已於 08-06 修掉），`vpn-gateway-run` 那支同理。

照舊清單判讀有實害：它會叫你把 `git-integration.test.js` 的紅燈當 CRLF 放過去，而在這台上那代表
**你真的改壞了東西**。正確做法是拿 `2148 passed` 當基線比對，任何新紅燈都先當成自己造成的。

（原清單，僅供其他環境參考：`git-integration.test.js` 的 `ensureWorktreeAtMain` 兩支＝CRLF 行尾差異；
`vpn-gateway-run.test.js` 的 `defaultTmpFilePath › 容器化（APP_DIR 已設）`＝開發機非容器。）

除上述外的紅燈**先假設是 flaky**（`pgPass` flake 家族，常見於 `enterprise-routes`／`spec-review`／`env-agent-sso-route`，每輪不同支且單跑一律綠）。判定法一律是「stash 掉改動、對那一支單獨再跑」，不要靠記憶認定。

### 5.3 本改動應該讓哪些測試更嚴

改完後 `pipeline-flow.test.js:82` 那個「掃 `runner.js` 原始碼找 `status = 'xxx'`」的 regex hack 仍保留（它抓的是「runner 實際會寫什麼」，仍有價值），但 §4 階段 5 的兩條新守衛提供了它給不了的保障。

---

## 6. 風險與回滾

| 風險 | 影響 | 對策 |
|---|---|---|
| 相容層漏掉某個取用形式 | 全站狀態顯示英文代號 | 階段 2 不改行為，全跑測試須零變化 |
| 後端 runtime 依賴 `public/` | 架構爭議 | §4 階段 3 已說明取捨；不接受則整個階段 3c 跳過，僅 runner 保留手寫陣列 |
| 階段 4 動到圖的形狀 | 流程圖畫錯 | `pipeline-flow.test.js` 102 支、八種 flag 組合全跑；另可依 `pipelineFlow` skill 做八組合快照逐字元比對 |
| 改到一半中斷 | —— | 每階段自成完整狀態，階段 2 之後任何一步停手都是可上線的 |

**回滾**：本改動不含 DB migration、不改任何狀態字串本身、不改流程轉移。回滾即 `git revert`，無資料面殘留。

---

## 7. 明確不做（scope 邊界）

- **不改任何狀態的字串值** —— DB 內既有資料不受影響
- **不改流程轉移邏輯** —— `runner.js`／`verdict-router.js`／`reject-triage.js` 的轉移賦值一律不動
- **不合併 `runner.js` 的 `STAGE_LABELS`** —— 那是「執行歷程」的階段文案，刻意與前端不同（客服處理**中**／已回覆澄清），合併會改動歷程文字。既有涵蓋關係由 `frontend-status-labels.test.js:57-69` 守住
- **不動 `TaskList.js` 的 `DEV_STEPS`／`CS_STEPS`** —— 進度條分組是另一個維度
- **不新增狀態、不刪除狀態**
