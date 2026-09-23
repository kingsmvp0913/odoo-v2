# 客戶自帶 API key 設計（平台產品化 子專案 2）

日期：2026-09-11
狀態：P1～P4 已於 2026-09-14 裁決；認證切換已部分實作，花費上限與公司管理員報表仍待做（進度以「開發順序」§0 為準）
前置：子專案 0（容器與環境變數白名單）、子專案 1（公司）
總覽：`2026-09-11-productize-overview.md`

---

## 1. 目標與非目標

### 目標

- 客戶觸發的 AI **一律用發起者所屬公司自己的 Anthropic API key**，費用由 Anthropic 直接算給客戶（09-14：一個專案可掛多家公司，所以看「人」不看「專案」）。
- 平台**不代付、不轉售、不中介** Claude 用量（Anthropic 條款要求）。
- key 加密保存，永遠不回傳瀏覽器。
- 單張任務有花費上限，避免客戶收到嚇人的帳單。

### 非目標

- 跟 Anthropic 業務談轉售（使用者裁決 09-11：不談）
- Codex（只留內部，09-11 裁決）
- 平台服務費怎麼收（子專案 4）

---

## 2. 已定調的決定

| 決定 | 日期 |
|---|---|
| 客戶自帶 API key（BYOK） | 09-11 |
| key 由客戶管理員填（拆法 v2 核准時一併定下） | 09-11 |
| 非客戶觸發的 AI（健檢、夜間改善、內部專案）用平台自己的認證 | 09-11 |
| 客戶只用 Claude | 09-11 |

---

## 3. 現況事實（2026-09-11 實查）

### 3.1 Anthropic 條款（code.claude.com/docs/en/legal-and-compliance）

- 「Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential」
- 「Anthropic does not permit third-party developers … to route requests through Free, Pro, or Max plan credentials on behalf of their users.」
- 在產品裡跑 Claude Code 需要同意 **Commercial Terms**，且「The Claude Code binary must not be modified」、不得移除或限制它內建的認證方式。
- 名稱與 logo：可以照實說「產品裡跑的是 Claude Code」，但**不能**把 Claude Code／Anthropic 的名稱或 logo 放進自己的產品名、公司名或 logo。

### 3.2 平台現在的認證

- 管理員設定的訂閱 OAuth token 存在 `teams_settings.claude_oauth_token_enc`，另有備用一組（`lib/claude-auth.js`）。
- 注入只有一個點：`claude-runner.js:197` 的 `getClaudeAuthEnv()`（rules/infra 131）。
- `usage-gate.js:64-130` 依訂閱視窗的用量百分比，在主／備用之間切換。
- rules/infra 134 寫「用量閘門必須是全域的」——**這個前提在 BYOK 之後只對平台自己的認證成立**。
- 認證優先序：`ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `CLAUDE_CODE_OAUTH_TOKEN`（`claude-auth.js:81`）。官方說明：`-p` 模式下只要有 `ANTHROPIC_API_KEY` 就一定用它。
- `start.sh:50-51`：`data/config.json` 若有 `ANTHROPIC_API_KEY` 會 export 進平台環境（子專案 0 的白名單會擋住它流進 AI）。
- 驗證 token 的既有做法：用那組 token 跑一次 `runClaude('回覆 ok')`（`admin-routes.js:75`）。

### 3.3 花費

- `token_usage` 每次 AI 執行記一筆（含 `user_id`、`project_id`）；成本換算在 `lib/token-cost.js`（`costSql`、`RATES`）。
- ⚠ `token_usage` **會低估**：失敗那一輪不記帳、子 agent 的用量沒算進去（記憶 token-usage-underreports-cost）。
- `claude --help`：`--max-budget-usd <amount>`「Maximum dollar amount to spend on API calls (only works with --print)」。pipeline 用的正是 `-p`。
- stream-json 的 `result` 事件帶 `total_cost_usd`（runner 在 `claude-runner.js:291` 解析 result）。

---

## 4. 設計

### 4.1 儲存

`companies` 加欄位：

| 欄位 | 說明 |
|---|---|
| `anthropic_key_enc` | `lib/crypto.js` 加密；目前已實作，名稱以實際資料庫欄位為準 |
| `anthropic_key_last4` | 畫面上顯示「••••abcd」用 |
| `anthropic_key_set_by`、`anthropic_key_set_at` | 誰、什麼時候設的 |
| `anthropic_key_verified_at` | 最後一次驗證成功時間 |
| `task_budget_usd` | 單張任務花費上限（§4.5） |

GET 只回是否已設定與後四碼，**永遠不回原文**（比照記憶 password-no-longer-returned-to-browser）。目前管理員 API 只回 `has_anthropic_key`，後四碼、設定者與時間尚未實作；這些欄位不能因目前沒有就視為已完成。PUT 沒帶 key 就沿用舊值。

### 4.2 誰能設

- 公司管理員：在新的「公司設定」頁填（內部公司不需要填）。
- 平台管理員可代填（§8 P1 已決）。目前只有平台管理員的 API／畫面已實作，公司管理員自行填 key 的入口仍待做。

### 4.3 存檔前驗證

用這把 key 跑一次最小的 `claude -p`（把環境變數換成 `ANTHROPIC_API_KEY`）。**認證失敗就不存**；網路或服務暫時失敗時可儲存，但必須明確告知「未完成驗證」，不得顯示成驗證成功。
這次驗證本身也要走子專案 0 的容器。

### 4.4 注入規則

子專案 0 容器白名單裡的「Claude 認證」這一項，照下表決定：

**09-14 裁決：看「發起的人」所屬公司，不看專案**（一個專案可以掛多家公司，子專案 1 §4.3）。

「發起的人」：
- 任務的每一關（分析、開發、QA、重跑、自動推進）＝**建任務的人**（`tasks.user_id`），不管實際是誰按下重跑
- 問答＝發問的人（`project_chats.user_id`）

| 發起的人 | 用哪個認證 |
|---|---|
| 屬於一般公司（`is_internal=false`） | 該公司的 `ANTHROPIC_API_KEY` |
| 屬於內部公司（`is_internal=true`） | 平台現行認證（`getClaudeAuthEnv()`＋用量閘門） |
| 平台管理員（無公司） | 平台現行認證 |
| scope `internal`（健檢、改善） | 平台現行認證 |

- 例：內部人員在鴻久的專案上發問 ⇒ 用平台認證（你付）；鴻久的人在同一個專案上發問 ⇒ 用鴻久的 key。
- 公司可用性（啟用、使用期間）也看同一家公司。

- **公司沒設 key → `canRun` 回 false**：不開容器，任務停在原地，時間軸寫「公司尚未設定 API key」，通知客戶管理員。
- **絕不退回用平台的認證**（條款不允許，而且 rules/pipeline 59 要求 fallback 指向最嚴格）。
- 平台的用量閘門 `usage-gate.js` **只套在平台認證**。客戶 key 沒有「訂閱視窗百分比」這種東西，不套。

### 4.5 單張任務花費上限

一張任務會跑很多次 AI（分析、開發、QA、重跑……），`--max-budget-usd` 只管單次，所以要兩層：

1. **開跑前**：算這張任務已經花掉多少（`token_usage` 依 task 加總，用 `costSql`）。已花 ≥ 上限 → 不開跑，任務停下，時間軸寫白話原因，客戶管理員可以提高上限後按繼續。
2. **跑的時候**：傳 `--max-budget-usd <上限 − 已花>` 給這一次執行。

**讓累計數字更準**：`token_usage` 新增 `cost_usd` 欄位，直接記 `result` 事件的 `total_cost_usd`（有這個值時優先用它，沒有才用 `costSql` 估）。
沒有產生 `result` 的失敗輪仍然會漏記，列入 §9 已知風險。

上限預設值依 §8 P2：先用歷史任務的 p90／p99 算出候選數值，再由產品負責人確認；尚未有已核准的美元數值。

### 4.6 錯誤處理

| 狀況 | 做法 |
|---|---|
| key 無效或被撤銷 | 停下、不重試；通知客戶管理員「API key 無效」；公司的 `anthropic_key_verified_at` 清空 |
| 客戶的 Anthropic 帳戶額度不足 | 停下、不重試；通知客戶管理員 |
| 超過單張任務上限 | 停下（§4.5） |
| 被限流（429） | 視為暫時性錯誤，沿用現行重試上限 |

⚠ 上面各種錯誤的**實際錯誤字面**，計畫階段拿真 key 實測取得（例如故意用撤銷的 key、額度 0 的帳戶），比照 `auth-signature.js`／`sandbox-signature.js` 只收 CLI 自己印的字面，**不猜**。
rules/infra 132：`Not logged in` 這類認證錯誤走 stdout 不走 stderr，兩邊都要掃。

### 4.7 客戶看得到花費嗎

公司管理員可看自家公司用量報表，後端強制公司範圍；平台管理員可依公司篩選。Claude 訂閱額度頁不開給客戶（§8 P3 已決）。

### 4.8 條款遵循（不是程式，但上線前一定要做）

- 以平台營運者身分同意 Anthropic **Commercial Terms**。
- Claude Code 用 npm 官方套件原版安裝（子專案 0 的映像檔已是如此），不改 binary。
- 產品名稱、logo 不含 Claude Code／Anthropic 字樣。
- 服務條款寫明「AI 用量費用由客戶與 Anthropic 直接結算」（子專案 4）。

---

## 5. 測試

- key 加解密；GET 絕不回原文；PUT 不帶 key 沿用舊值。
- **注入矩陣**：一般公司的人 → 該公司 key；內部公司的人／平台管理員 → 平台認證；`internal` → 平台認證；**同一個專案綁兩家公司，兩家的人各自發起 → 各用各的 key**；內部人員重跑客戶建的任務 → 仍用客戶公司的 key；公司沒 key → `canRun` false 且**不會**拿到平台認證（這條最重要，要單獨一支測試）。
- 用量閘門切換主／備用，不會影響客戶 key 的執行。
- 花費上限：已花 ≥ 上限 → 不開跑；未達 → 傳入的 `--max-budget-usd` 等於剩餘值；`cost_usd` 有值時優先於估算。
- 錯誤分類：用實測取得的字面寫 signature 測試。

---

## 6. 會改變的既有行為

- 客戶專案的任務，**不再**受平台訂閱用量閘門影響，也不會消耗平台的訂閱額度。
- rules/infra 134「用量閘門全域」要改寫成「只管平台自己的認證」。

---

## 7. 切換步驟

1. 子專案 1 上線（公司存在）
2. 加欄位、公司設定頁、驗證、注入規則
3. 用你自己開的一把測試 key 建一家測試公司，完整跑一張任務，對帳：平台 `token_usage.cost_usd` 加總 vs Anthropic Console 顯示的花費
4. 對得上才開放給真客戶

---

## 8. 已裁決事項

| # | 問題 | 建議 | 其他選項 |
|---|---|---|---|
| P1 | 平台管理員能不能在開通時**代填**客戶的 key？ | **已決 09-14：可以代填**，記下 `set_by`；公司管理員之後可以自己換 | — |
| P2 | 單張任務上限的預設值？ | **已決 09-14：先用歷史資料算再訂**（`token_usage` 每張任務花費的 p90、p99）；公司管理員可自己調 | — |
| P3 | 客戶看得到花費嗎？ | **已決 09-14：沿用現有用量報表**（`token-report-routes.js`），加「公司」條件＝該公司成員發起的執行。報表開給公司管理員，後端**強制**只回自家公司（不吃客戶帶的篩選參數）；平台管理員多一個公司篩選。Claude 訂閱額度頁（usage）不開給客戶——客戶自帶 key 沒有訂閱百分比。報表低估成本的問題照 §4.5 的 `cost_usd` 欄位處理 | — |
| P4 | 同一家公司能不能不同專案用不同 key？ | **已決 09-14：不行，一家一把** | — |

---

## 9. 已知風險

| 項目 | 狀態 |
|---|---|
| 失敗輪沒產生 `result` 事件時漏記花費 ⇒ 實際花費可能超過平台算的上限 | `--max-budget-usd` 仍在單次執行層擋住；平台累計數字標示「估算」 |
| key 在 AI 容器的環境變數裡，被注入時 AI 讀得到 | 接受：那是客戶自己的 key，只能花客戶自己的錢；容器隔離確保拿不到別家的 |
| Anthropic 改條款 | 上線前、之後每半年重讀一次 legal-and-compliance 頁 |
