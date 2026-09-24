# 考試系統改用客戶自己的 API key 設計（平台產品化 子專案 2 的延伸）

日期：2026-09-24
狀態：設計已於 2026-09-24 經使用者逐節確認；**程式已實作、測試全綠，但未重啟、未人工驗收**
實作紀錄：全跑 402 suites／5907 tests，新增 24 項全過，失敗數與動手前的基線完全相同（4 項，
都在 `frontend-base-path` 與 `frontend-auth-reactivity` 這兩支既有紅燈上，與本次無關）。
§6 那兩項人工驗收尚未執行。
前置：子專案 2（`2026-09-11-byok-api-key-design.md`，`buildClaudeAuthEnv` 已上線）、子專案 1（公司表）
總覽：`2026-09-11-productize-overview.md`；進度以「開發順序」§0 為準

---

## 1. 目標與非目標

### 目標

- 考試系統的 AI 執行**一律用發起者所屬公司自己的 Anthropic API key**，與 pipeline 同一條判準（`lib/claude-auth.js` 的 `buildClaudeAuthEnv`）。
- 客戶公司沒有設定 key 時**必須失敗**，不得靜默退回廠商的平台訂閱。
- 判題品質**逐字不變**：送進 AI 的 prompt、參數、工具、模型完全不動，只有認證憑證換人。

### 非目標（本輪刻意不做）

這些是 2026-09-24 使用者在四個選項中只挑了「客戶自帶 key」的直接結果，不是遺漏：

- **記帳**：考試花費仍不進 `token_usage`，用量報表看不到考試。
- **進容器**：考試 AI 仍在主機上跑。兩道既有的工具閘門因此得以保留——`review.js` 的 `--allowed-tools`（有截圖才給 `Read`，否則空字串）與 `challenge.js` 的 `--disallowed-tools`；`runClaude` 兩者都不支援。
- **花費上限**：考試沒有「任務」這個單位，`--max-budget-usd` 無處可掛。
- **可中止**：`exam-upload-routes.js:192` 註解描述的既有限制（公司被停用時正在跑的那一輪會跑完）仍然存在。
- **題庫的跨公司可見性**：`GET /api/exam/banks` 至今沒有公司過濾，所有開了考試功能的公司互看得到彼此的題庫。**這是獨立的缺陷，開第一家客戶之前必須處理，但不在本設計範圍**。

---

## 2. 現況實查（2026-09-24）

| 事實 | 位置 |
|---|---|
| 考試自己 spawn `claude`，完全不經平台 AI 通道 | `lib/exam/review.js:402`、`lib/exam/challenge.js:192`、`lib/exam/evidence.js:369` |
| env 白名單只放行系統變數，**含 `HOME`** ⇒ 實際吃的是主機 `~/.claude` 的互動式登入憑證 | `lib/agent-env.js` 的 `LEGACY_ENV_KEYS` |
| 考試資料表**沒有任何 `company_id` 或 `user_id`** | `exam_banks`／`exam_uploads`／`exam_attempts` 只有文字欄 `responder` |
| 上傳通行碼是**全平台唯一一組**，存在 `data/exam/upload-token.json`，不屬於任何人 | `lib/exam/upload.js` 的 `issueUploadToken` |
| 本機（127.0.0.1）來的上傳**免 token** | `lib/exam/upload.js` 的 `isLocal`＋`checkExamToken` 第一行 |
| JWT 路徑驗出了 `payload.userId` 卻**沒有留下來** | `exam-upload-routes.js:68` 之後只 `next()` |
| 判題常常**不在請求當下發生**：6 個 `scheduleQueue()` 觸發點中，平台重啟續跑與取消暫停兩條完全沒有發起人 | `index.js:415`（`reclaimInterrupted` → `scheduleQueue`）、`exam-upload-routes.js:391` |
| `evidence.js` 的 spawn **網頁到不了**，唯一呼叫端是手動 CLI | `tools/exam-review-run.js:111` |
| 平台管理員設定的 Claude token **已設定** | 查 `teams_settings`：`claude_oauth_token_enc` 非 null，備用為 null |

### 為什麼不能「只看 token、不存身分」

2026-09-24 使用者提出：「token 進來後看是誰的就用誰的 AI 去判題」。這個判準對大部分請求成立，但有三個洞：

1. **本機免 token**：根本沒有 token 可看。
2. **共用通行碼不屬於任何人**：一整台平台一組，看得出「有碼」，看不出「是誰」。
3. **判題活得比請求久**：`scheduleQueue` 是丟出去就不管的；平台重啟續跑那條路上，發起該次上傳的請求早就結束了。而 `buildClaudeAuthEnv(null)` 的行為是「用平台訂閱」——客戶的考試只要遇到一次重啟，錢就靜靜回到廠商頭上，而且不報錯。

結論：身分必須在上傳那一刻**寫進資料列**，才撐得過重啟。裁決為「記在那一頁上」，而非題庫層——錢是逐頁燒的，逐頁記更準。

---

## 3. 設計

### 3.1 身分寫入（上傳時）

- `exam_uploads` 新增 `user_id INTEGER REFERENCES users(id)`，**可為 null**（null ＝內部，用平台訂閱）。
- 全專案只有一處 INSERT 這張表（`exam-upload-routes.js:172`），加一欄即可。
- `checkExamToken` 解析出身分後放進 `req.examUserId`，三條路各自的落點：

| 進來的路 | `req.examUserId` | 理由 |
|---|---|---|
| 本機 127.0.0.1（免 token） | `null` | 這台機器自己＝廠商，本來就該用平台訂閱 |
| 平台帳號 JWT | `payload.userId` | 已經驗出來了，只是現在丟掉 |
| 共用通行碼 | 通行碼檔新增的 `issued_by` | 同時只有一把有效（重產即失效），沒有歧義 |

- `issueUploadToken(dataDir, issuedBy)` 多寫一欄 `issued_by`；`peekUploadToken` 一併回傳。
- **舊的通行碼檔沒有 `issued_by`** ⇒ 讀到 undefined 時當 `null`（內部）。這是相容處理，不是預設值：舊碼效期只有 3 小時，升級後很快就會被重產取代。

### 3.2 憑證解析（判題時）

- `worker.js` 在每頁開跑前 `await buildClaudeAuthEnv(upload.user_id)`，把回傳的 env 物件沿著呼叫鏈往下傳：
  - `challengePage(...)` → `challenge.js` 的 spawn
  - `extractPage(...)` → `review.js` 的 `runPrompt` → spawn
- 讀章節那條路（`POST /api/exam/banks/:id/read-sections`）走 `verifyToken`，直接用 `req.userId` 解析後傳進 `readSections`。
- 合併順序：**`{ ...pickLegacyEnv(process.env), ...authEnv }`**。authEnv 必須在後面——官方認證優先序是 `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `CLAUDE_CODE_OAUTH_TOKEN` > 憑證檔，而 `pickLegacyEnv` 放行的 `HOME` 會讓憑證檔可讀，順序寫反就會靜默沿用舊行為（測試看不出來，因為兩種都「跑得起來」）。
- `evidence.js` **不動**：唯一呼叫端是手動 CLI，發起人就是廠商本人。

### 3.3 沒有 key 的客戶

- `buildClaudeAuthEnv` 丟 `NoAnthropicKeyError`（`code = 'NO_ANTHROPIC_KEY'`）。**不攔、不轉譯**，讓它沿既有的單頁失敗路徑走（`worker.js` 的 catch 會把該頁標 `failed` 並記下訊息）。
- 訊息本身已經是給人看的白話：「這家公司還沒有設定 Anthropic API key，AI 無法執行。請公司管理員在設定頁填入。」
- **不得有任何 fallback 到平台訂閱的分支**。`companies.is_internal` 的欄位註解已寫明理由：靜默退回不會報錯，只會在月底的帳單上出現。
- 公司停用／過期時 `buildClaudeAuthEnv` 同樣丟這個例外（它內部呼叫 `isUserCompanyUsable`），走同一條路，不另開分支。

### 3.4 刻意不動的

prompt 文字、CLI 參數、`cwd`、`model`、MCP 設定檔（`lib/exam/mcp/none.json`）、兩道工具閘門（`review.js` 的 `--allowed-tools`、`challenge.js` 的 `--disallowed-tools` 與 `--append-system-prompt`）、逾時長度——全部逐字不動。這是 §4 品質關卡成立的前提。

### 3.5 已知的副作用（使用者已確認接受）

改動前，考試 AI 吃主機 `~/.claude` 的互動式登入憑證；改動後，內部（`user_id` 為 null 或內部公司）會改用**平台管理員設定的那把 token**（實查已設定）。

兩者都是廠商的帳，但確實換了一把。這是刻意的：與 pipeline 一致，並避開 `lib/claude-auth.js` 檔頭記載的老問題——併發 spawn 共用會被刷新改寫的憑證檔，在 token 輪替瞬間互相踩空而出現 "Not logged in"。

若平台 token 未設定，`getClaudeAuthEnv()` 回空物件、完全不碰該 key，行為與今天相同（仍讀憑證檔）。

---

## 4. 品質關卡

需求原句是「必須有逐題比對的品質關卡——搬錯會讓判題品質悄悄改變，過去的考試成績就不能拿來比」。

**不能用「同一頁跑兩次比對結果」來驗**：同一份 prompt 送兩次，模型本來就會給出不同措辭，差異全部來自取樣，證明不了任何事。誤把它當關卡，只會得到一個永遠紅或永遠要人肉判讀的測試。

真正驗得動的是**輸入逐字相同**：

1. **spawn 參數快照**：對 `review.js` 與 `challenge.js` 各鎖一支測試，斷言改動前後 `args`、`prompt`、`cwd`、`model` 完全一致，**差異只出現在 env 的認證欄位**。
2. **身分解析**：四條路各一支（本機、JWT、通行碼、`verifyToken`），斷言落進 `exam_uploads.user_id` 的值。
3. **沒 key 的客戶**：那一頁標 `failed`、訊息可讀、且**沒有任何** spawn 發生（證明沒有 fallback）。
4. **重啟續跑**：`reclaimInterrupted` 之後重跑，`user_id` 從 DB 讀得回來、不是 null。
5. **合併順序**：authEnv 覆蓋得過 `pickLegacyEnv` 的結果（防 §3.2 那個寫反也不會報錯的坑）。

---

## 5. 影響範圍

| 檔案 | 動什麼 |
|---|---|
| `app/server/db.js` | `exam_uploads` 加 `user_id`（migration） |
| `app/server/lib/exam/upload.js` | `issueUploadToken` 存 `issued_by`；`peekUploadToken` 回傳 |
| `app/server/exam-upload-routes.js` | `checkExamToken` 產出 `req.examUserId`；INSERT 加一欄；`read-sections` 傳 `req.userId` |
| `app/server/lib/exam/worker.js` | 每頁解析 authEnv 並往下傳 |
| `app/server/lib/exam/review.js` | `runPrompt`／`extractPage` 收 authEnv 並合併進 spawn env |
| `app/server/lib/exam/challenge.js` | `challengePage` 同上 |
| `app/server/lib/exam/sections.js` | `readSections` 把 authEnv 轉交 `runPrompt` |
| `app/server/lib/exam/evidence.js` | **不動** |

---

## 6. 驗收

- 全跑不得有新紅燈（基線在實作前自己量，見 `.claude/rules/always.md` 第 2 條）。
- 上述 5 項品質關卡測試全綠。
- **人工**：以內部帳號跑完一場考試（確認換 token 後判題照常）；以一家沒設 key 的客戶公司帳號上傳一頁（確認該頁失敗且訊息看得懂，不是靜默成功）。這兩項無法用測試取代——前者驗的是「換了憑證仍跑得動」，後者驗的是「失敗訊息真的到得了畫面」。
