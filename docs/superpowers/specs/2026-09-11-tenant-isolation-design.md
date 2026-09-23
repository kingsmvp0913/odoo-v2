# 租戶隔離設計：公司、角色、資料範圍（平台產品化 子專案 1）

日期：2026-09-11
狀態：P1～P6 已於 2026-09-14 裁決；設計已部分上線，人工驗收與剩餘項目以「開發順序」§0 為準
前置：子專案 0（AI 執行隔離）必須先完成——沒有它，資料範圍做得再嚴，AI 一句 `echo $APP_SECRET` 就全部繞過
總覽：`2026-09-11-productize-overview.md`

---

## 1. 目標與非目標

### 目標

多家客戶共用同一套平台，**彼此看不到對方的任何資料、也動不了對方的任何東西**。
帳號、角色、看得到的頁面照 §2 的裁決。

### 非目標

- AI 執行隔離（子專案 0）
- 客戶自帶 API key（子專案 2）
- 客戶自己按關卡、上正式的流程細節（子專案 3）
- 收費、金流、訂閱到期通知（子專案 4）

---

## 2. 已定調的決定

| 決定 | 日期 |
|---|---|
| 一套系統多家客戶共用（SaaS） | 09-10 |
| 開通由平台管理員代設 repo、測試區、正式機 SSH、DB 連線 | 09-11 |
| 一家公司多個帳號，分「公司管理員」與「一般使用者」 | 09-11 |
| 帳號**只綁公司**；看得到該公司綁定的全部專案。分部門以後再說 | 09-11 |
| 客戶看得到的頁面：問答、任務、Wiki（＋個人設定） | 09-11 |
| 以下工具**改成只有平台管理員**：DB 查詢頁、DB 連線管理（含 SSH／VPN）、AI 執行畫面、專案／repo 管理、測試環境管理、流程圖／架構圖。上正式另依公司綁定的 `can_release` 授權；考試系統改由公司功能開關決定（客戶預設關閉） | 09-11 原則；上正式與考試依 09-14、09-21 裁決修訂 |
| **角色只有三種**：平台管理員／公司管理員／一般使用者（取代 09-11 的四種） | 09-14 |
| **內部人員＝一家「內部公司」的成員**：除了平台管理員，每個帳號都屬於一家公司；內部公司沒有特別權限，靠「綁定全部專案」看到全部 | 09-14 |
| **一個專案可以掛多家公司**（多對多）；平台管理員新建專案時**自動綁內部公司** | 09-14 |
| 公司管理員：能管自己公司的帳號；能對「綁定上有勾『可上正式』」的專案按上正式。**內部公司的綁定不勾** ⇒ 客戶專案只有該客戶的公司管理員或平台管理員能按 | 09-14 |
| AI 用誰的 API key：**發起的人所屬公司**（任務＝建任務的人、問答＝發問的人），細節在子專案 2 | 09-14 |
| 公司可綁一組 GIT；個人有設用個人的，沒設用公司的 | 09-11 |
| 客戶也能在個人設定填自己的 GIT（碰不到主機、DB、SSH、VPN 憑證） | 09-11 |
| 公司有啟用開關＋使用期間，之後走訂閱制 | 09-11 |

---

## 3. 現況事實（2026-09-11 實查）

### 3.1 帳號與角色

- `users.role` 只有 `admin`／`user`；現有 **admin 9 個、user 6 個**，全部是內部人員。
- `verifyToken` 設 `req.isAdmin = role === 'admin'`（`auth.js:40`）。
- 另外還有**散落各處自己查 role 的地方**，至少 6 處：`auth.js:40`、`index.js:96`、`index.js:175`、`project-routes.js:37`（`isAdminUser`）、`token-report-routes.js:10`、`pipeline-routes.js:212`。
- 自助註冊存在：`POST /api/auth/register` 建 `role='user'`、`approved=false`（`auth.js:101`）；登入頁有入口（`ui-next/pages/Login.js`）。

### 3.2 專案與資料範圍

- `projects` **沒有任何主人或公司欄位**（`db.js:189`）。
- `GET /api/projects` 把**全部專案**回給任何登入的人（`project-routes.js:342`）。
- 搜尋會用名稱搜到所有專案（`search-routes.js` 專案那段沒有範圍條件）；任務與對話則限本人。
- 專案端點 12 支裡 11 支只有 `verifyToken`（rules/always.md 11）；`db-query-routes.js`、`env-routes.js` 全部只有 `verifyToken`。
- **測試區 SSO 只驗登入**：任何人帶任一專案 id 都能進該專案的測試區（`env-routes.js:102`）。
- 帶 `project_id` 的表：`tasks`、`project_repos`、`project_deploy_targets`、`db_connections`、`odoo_envs`、`project_chats`、`project_favorites`、`wiki_pages`、`wiki_drift`、`wiki_search_misses`、`embedding_chunks`、`classify_samples`、`task_rejections`、`token_usage`。

### 3.3 已經有範圍檢查的地方（好消息）

- **任務**：共用函式 `loadTaskForActor`（`lib/task-access.js:5-11`）＝「本人或 admin」，`pipeline-routes.js` 與 `tasks-routes.js` 的關卡端點都經過它。任務列表非 admin 只看自己的（`tasks-routes.js:218-221`）。
- **對話**：`getOwnedChat` 限本人；附件下載也經過它（`chat-routes.js:259`）。
- **任務附件下載**：限本人或 admin（`tasks-routes.js:542`）。
- **收件匣**：全部 `WHERE user_id = req.userId`（`inbox-routes.js`）。
- **用量報表**：後端有另查 admin（`token-report-routes.js:8-11`）。
- **即時推播**：`emitToUser` 走個人房間；全體廣播 `emitAll` 只有考試上傳在用（`exam-upload-routes.js:26`）。

### 3.4 GIT 憑證

- 全平台只有一個入口 `buildGitEnv(userId)`（`lib/git-identity.js:19`），沒有 PAT 就丟 `NoGitCredentialError`。呼叫點 15 處。
- 上正式合併 main **刻意**只用按的人本人的 PAT、不退機器憑證，理由是歸屬（`project-routes.js:930` 註解）——**本設計依 09-11 裁決推翻此點**。
- 內部已經有一個「CLI 推送身分」`teams_settings.cli_push_user_id`（`nightly-fix.js:603`）。

### 3.5 前端

- `isAdmin = me.role === "admin"`（`ui-next/UiNextApp.js:567`）。
- 「更多工具」裡的架構圖、流程圖、ODOO 認證輔助**沒有擋 isAdmin**（`UiNextApp.js:1259`）。
- 隱藏 admin 功能要三處齊做：nav、router guard、後端 403（rules/frontend.md 38）。

---

## 4. 資料模型

### 4.1 新表 `companies`

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | TEXT UNIQUE NOT NULL | |
| `is_active` | BOOLEAN NOT NULL DEFAULT false | 預設安全值；只有平台管理員的建立／啟用端點寫 true（rules/db-schema 43） |
| `is_internal` | BOOLEAN NOT NULL DEFAULT false | 內部公司記號，**只管付錢**（AI 用平台認證，子專案 2），不管看得到哪些專案。部分唯一索引保證只有一筆 true；**只在遷移時建立，任何 API 都不能設**——客戶公司被誤標成內部，就會用平台的訂閱跑客戶的 AI，違反條款 |
| `active_from` | TIMESTAMPTZ | 使用期間起（NULL＝不限） |
| `active_until` | TIMESTAMPTZ | 使用期間迄（NULL＝不限） |
| `git_pat_enc` | TEXT | 公司 GIT PAT，`lib/crypto.js` 加密 |
| `git_login`、`git_name`、`git_email` | TEXT | 比照 `users` 同名欄位 |
| `anthropic_api_key_enc` 等 | — | 子專案 2 補 |
| `created_at`、`updated_at` | TIMESTAMPTZ | |

### 4.2 既有表加欄位（走 `db.js` 的 ALTER 清單，不改 CREATE TABLE）

| 表 | 欄位 | 意義 |
|---|---|---|
| `users` | `company_id INTEGER REFERENCES companies(id)` | NULL **只允許**平台管理員 |

`projects` **不加** `company_id`（09-14 改為多對多，見 §4.3）。

### 4.3 新表 `project_companies`（專案 ↔ 公司，多對多）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `project_id` | INTEGER NOT NULL REFERENCES projects(id) **ON DELETE CASCADE** | 不帶 CASCADE 會擋死刪專案（記憶 spec-trio-executed） |
| `company_id` | INTEGER NOT NULL REFERENCES companies(id) | 公司不刪只停用（子專案 4 客戶離開流程另處理） |
| `can_release` | BOOLEAN NOT NULL DEFAULT false | 這家公司的公司管理員能不能對這個專案按上正式。預設不勾 |
| `created_at` | TIMESTAMPTZ | |
| PK | `(project_id, company_id)` | |

- **寫入檢查**：內部公司（`is_internal=true`）的綁定 `can_release` 必須是 false。
- **新建專案**：`project-routes.js` 建立專案的同一個交易內，自動插入一筆「內部公司、`can_release=false`」。
- **只有平台管理員**能新增／移除綁定、改 `can_release`。
- 共用專案（例：鴻久與鴻伍綁同一個專案）時，兩家都看得到**專案層級的 Wiki**；任務依建立者／公司隔離（一般使用者只看自己的、公司管理員看自家公司），對話只給本人。這是 2026-09-21 已落地的較新權限規則，取代原本「綁定即互相看得到任務與對話」的舊設計；待上正式清單的授權例外見子專案 3 §4.3。

### 4.4 角色：用第三個 role 值，不重用 `admin`

| 身分 | `role` | `company_id` |
|---|---|---|
| 平台管理員 | `admin` | NULL（強制） |
| 公司管理員 | **`company_admin`**（新值） | 必填 |
| 一般使用者 | `user` | 必填 |

內部公司與客戶公司用的是**同一套**公司管理員／一般使用者，差別只在綁了哪些專案、`is_internal` 決定 AI 用誰的 key。

**為什麼不讓公司管理員也用 `role='admin'`**：§3.1 那至少 6 處散落的 `role === 'admin'` 檢查，只要漏改一處，公司管理員就在那裡變成平台管理員。用新值的話，**既有檢查全部天生把公司管理員擋在外面**——漏改的結果是「公司管理員少一個功能」，不是「客戶拿到平台權限」。

寫入時檢查：`role='admin'` 必須 `company_id IS NULL`；`company_admin`／`user` 必須 `company_id IS NOT NULL`。

### 4.5b 開第一家客戶時，既有資料要不要動？（2026-09-21 釐清，實查後寫入）

**不用。現有使用者與專案一筆都不需要調整。**

實查當日狀態（`users` / `companies` / `project_companies`）：

| 對象 | 現況 | 開客戶時要做什麼 |
|---|---|---|
| 9 個平台管理員 | `company_id` 為 NULL | 不動。平台管理員本來就不屬於任何公司 |
| 7 個內部一般使用者 | 全部掛在「內部」公司 | 不動 |
| 17 個專案 | 內部公司綁滿 17／17 | **不動，也不要解除綁定** |

**開一家新客戶公司＝三個「新增」，沒有任何「搬移」：**

1. 建立該客戶公司
2. 把它的專案**加綁**到那家公司（`project_companies` 多一列）
3. 建立該客戶自己的帳號，`company_id` 指向那家公司

**⚠ 內部公司的綁定必須留著。** 專案↔公司是多對多（§4.3），加綁客戶公司**不會**取代內部公司的綁定。若把內部那一列解除，開發這個專案的自己人就看不到它了——那不是隔離，那是把自己鎖在外面。

**⚠ 共用專案的已知邊界（依 2026-09-21 實作修正）：** 內部與客戶公司同時綁定時，客戶**不會**因此看到內部人員建立的任務或對話；任務看建立者所屬公司，對話只給本人。專案 Wiki 仍是兩家公司共用的內容；有 `can_release` 的公司管理員查看待上正式清單時，也可能看到同一專案中別家已核准的任務，按下上正式會一起帶上（子專案 3 §4.3）。這是已記載的共用專案風險，不再把「任務層級隱藏」誤列成尚未裁決的新需求。

---

### 4.5 既有資料怎麼遷移

- 建一筆內部公司：`is_internal=true`、`is_active=true`、使用期間 NULL。
- 現有 9 個 admin：`company_id` 留 NULL，role 不動。
- 現有 6 個 user：`company_id`＝內部公司，role 維持 `user`。
- 現有 17 個專案：各插一筆綁內部公司、`can_release=false`。平台管理員開通時才另外綁到客戶公司。
- ⇒ **預設就是客戶什麼都看不到**，不會因為遷移漏掉而外洩。
- 注意：「鴻久」專案同時掛著鴻久與鴻伍的正式連線（`db_connections` id 2、3）。多對多之後**不必拆專案**，可以兩家都綁；但兩家會互相看得到（§4.3），綁之前要確認。
- 現有 6 個一般使用者會失去 §2 列的工具，上線前要先告知。

---

## 5. 權限判斷

### 5.1 單點：`verifyToken` 一次載入身分

`verifyToken` 本來每個請求就查一次 `users`（`auth.js:37`）。改成 JOIN `companies`，掛上：

```
req.actor = { userId, role, companyId, isPlatformAdmin, isInternal, isCompanyAdmin, companyUsable }
```

- `req.isAdmin` **語意不變**（仍是 `role === 'admin'`）
- **公司不可用**（`is_active=false`，或不在 `active_from`～`active_until` 之間）→ 所有 `/api` 回 403「公司帳號已停用或不在使用期間」。只放行 `GET /api/auth/me`，讓前端能顯示原因（登出是前端丟掉 token，不經後端）。

### 5.2 新共用函式（`lib/tenant-access.js`）

| 函式 | 規則 |
|---|---|
| `canSeeProject(actor, projectId)` | 平台管理員 → 全部；其他人 → `project_companies` 有 `(projectId, actor.companyId)` 這一筆。**內部公司不特判**，它看得到全部是因為全部都綁了 |
| `canReleaseProject(actor, projectId)` | 平台管理員；或 `company_admin` 且自己公司對該專案的綁定 `can_release=true`（子專案 3 §4.3 使用） |
| `loadProjectForActor(id, req, cols)` | 比照 `loadTaskForActor`：看不到回 null → 路由回 **404**（不回 403，避免洩漏「這個 id 存在」） |
| `loadTaskForActor`（改） | 任務所屬專案必須 `canSeeProject`；一般使用者只看自己的任務，公司管理員可看同公司成員的任務（§8 P1 已決） |
| `canManageCompanyUsers(actor, companyId)` | 平台管理員，或同公司的公司管理員 |

- 列表類查詢（`GET /api/projects`、搜尋）一律 `JOIN project_companies`，不要撈全部再在 JS 過濾。

### 5.3 各路由檔的改動

| 檔案 | 改成 |
|---|---|
| `project-routes.js` | 列表與讀取依 `canSeeProject` 過濾；建立／修改／repo 增刪／reclone／對應設定 → 平台管理員限定；建立時自動綁內部公司（§4.3） |
| `search-routes.js` | 專案名稱搜尋依 `canSeeProject` 過濾 |
| `wiki-routes.js`（`/api/...` 部分） | `loadProjectForActor` |
| `chat-routes.js` | 在某專案下**建立**對話前先 `loadProjectForActor`（現在只驗對話屬於本人，不驗專案看不看得到） |
| `tasks-routes.js` | 建立任務時驗專案；`loadTaskForActor` 已涵蓋其餘 |
| `env-routes.js` | SSO 與讀取狀態 → `loadProjectForActor`（客戶驗收要進測試區）；setup／stop／delete → 平台管理員限定 |
| `db-query-routes.js`（`/api/...` 部分） | 全部 → 平台管理員限定 |
| `pipeline-routes.js` | 已走 `loadTaskForActor`，隨 §5.2 自動生效；上正式權限見子專案 3 |
| `exam-routes.js`、`exam-upload-routes.js` | **公司設定的功能開關（客戶預設關閉）**。2026-09-21 使用者裁決推翻原本的「平台管理員限定」，保留內部一般使用者可用。程式已接上功能開關；開第一家客戶前仍須人工驗證公司開／關兩種情境（進度見「開發順序」§0）。 |
| `settings.js` | 個人 GIT 所有人可用；Odoo 帳密與同步設定對客戶隱藏（§8 P2 已決） |
| `admin-routes.js` | 維持平台管理員；使用者建立／修改要能設 `company_id` 與 `company_admin` |
| **新增** `company-routes.js` | 公司管理員管理自家帳號：列出／新增／停用／改角色（只能在 `user`↔`company_admin` 之間），範圍限自己公司。內部公司的公司管理員一樣只管內部帳號 |
| **新增** 公司管理（admin） | 平台管理員：建立公司、改啟用與期間、綁公司 GIT、**綁定／解除專案與勾選 `can_release`**。`is_internal` 不開放設定 |
| `auth.js` 註冊 | 關閉自助註冊；帳號只由平台管理員或公司管理員建立（§8 P3 已決） |

### 5.4 靜態守衛（防止以後新增的路由忘記檢查）

新增測試：掃描**全部** route 檔（比照 `frontend-base-path.test.js` 的 `walk()`，不列死檔案清單），凡是路徑含 `/api/projects/:id` 或 `/api/tasks/:id` 的路由，handler 內必須呼叫 `loadProjectForActor`／`loadTaskForActor`，或掛平台管理員 middleware。沒有就紅燈。

### 5.5 前端

- `isAdmin` 維持＝平台管理員；新增 `isInternal`、`isCompanyAdmin`。
- 「更多工具」裡的架構圖、流程圖、ODOO 認證輔助 → `v-if="isAdmin"`；對應 router 加 `requiresAdmin`。
- 專案頁的 repo／環境／DB 管理區塊、任務選單的 AI 執行畫面 → 平台管理員限定。
- 公司管理員多一個「公司帳號」頁。
- 平台管理員的公司管理頁：每家公司綁了哪些專案、各自有沒有勾「可上正式」。
- 三處齊做（nav／router／後端 403）。

---

## 6. GIT 憑證改為「個人 → 公司」退回

改單點 `buildGitEnv(userId)`，15 個呼叫端不動：

1. 該使用者有個人 PAT → 用個人的（行為與現在相同）
2. 沒有，且屬於某家公司（含內部公司）→ 用該公司的 `git_pat_enc`
3. 沒有，且是平台管理員（無公司）→ **不退回**（09-14 裁決 P4），走第 4 步擋下
4. 都沒有 → 維持丟 `NoGitCredentialError`

- `project-routes.js:930` 那段「只用本人 PAT、不退機器憑證」的註解與擋法一起改掉，註解改寫成新規則與裁決日期。
- 回傳值加一個 `source: 'personal' | 'company' | ...`，寫進時間軸，讓人看得出這次是用誰的身分推的。
- **公司 GIT 綁定時**：對該公司每個專案的 repo 跑一次 `git ls-remote` 驗證可存取，失敗就不存。
- 順帶解決：自動部署因為系統觸發、找不到人的 PAT 而失敗（見記憶 deploy-fetch-missing-pat）。

---

## 7. 公司可用性的檢查點

| 檢查點 | 公司不可用時 |
|---|---|
| `verifyToken`（§5.1） | 客戶登入後所有 API 403 |
| 子專案 0 的 `canRun(scope)` | 不開 AI 容器、不發通行證 |
| agent 設成 Codex、而觸發者（任務＝建任務的人；問答＝發問者）屬於**非內部公司**（09-15 子專案 0 計畫 Q3） | 丟例外，訊息寫明「客戶公司的 AI 只能用 Claude」；內部公司成員照常可選 Codex。子專案 0 本身不擋（沒有公司表），這一條必須在本子專案接上，否則客戶的 AI 能經 Codex 繞過容器隔離 |
| cron 裡的自動推進 | 依**任務建立者所屬公司**判斷（與子專案 2「誰付錢」同一個人），不可用就跳過該任務。一個專案掛多家公司，所以不能用專案判斷 |
| 正在跑的任務 | **立刻中止**（09-14 裁決 P5）：砍掉該公司所有在跑的 AI 容器，任務停在原地並寫時間軸「公司帳號已停用或到期」。改到一半的程式碼留在任務 worktree、沒有合併，不影響正式 |

---

## 8. 已裁決事項

| # | 問題 | 建議 | 其他選項 |
|---|---|---|---|
| P1 | 一般使用者看得到同公司別人的任務嗎？ | **已決 09-14：只看自己的**；公司管理員看全公司；有 `can_release` 的公司管理員另外看得到該專案全部待上正式任務（共用專案時會帶到別家的任務） | — |
| P2 | 客戶的個人設定要不要保留「Odoo 帳密、同步設定」？ | **已決 09-14：對客戶隱藏**，只留顯示名稱、密碼、個人 GIT | — |
| P3 | 自助註冊怎麼辦？ | **已決 09-14：關閉**，帳號一律由平台管理員或公司管理員建立 | — |
| P4 | 平台管理員（沒有公司）沒有個人 GIT 時，退回用誰的？ | **已決 09-14：不退回，擋下**（平台管理員必須自己填個人 GIT；內部公司成員照規則退回內部公司 GIT） | — |
| P5 | 公司到期或被停用時，正在跑的任務怎麼辦？ | **已決 09-14：立刻中止**（我原本建議跑完這一輪，使用者選立刻中止）；見 §7 | — |
| P6 | 公司管理員能不能**刪除**自家帳號？ | **已決 09-14：只能停用** | — |

---

## 9. 測試

- **跨公司矩陣**（supertest＋pg-mem）：A 公司的人對 B 公司的專案、任務、對話、wiki、測試區 SSO → 一律 404。
- **多對多**：專案綁 A、B 兩家 → A、B 都看得到，C 回 404；解除 B 的綁定後 B 立刻 404。
- **上正式綁定**：A 的公司管理員在 `can_release=false` 時不能按、改 true 後能按；A 的一般使用者兩種情況都不能；內部公司的綁定寫入 `can_release=true` → 拒絕。
- **新建專案自動綁內部公司**：建完查 `project_companies` 有內部公司那一筆；內部公司的一般使用者看得到。
- **`is_internal` 不可經 API 設定**：建立／修改公司帶 `is_internal: true` → 被忽略或拒絕，DB 仍只有一筆 true。
- **工具權限**：平台管理員以外的人（含內部公司成員）呼叫 §2 的平台管理工具 → 403；上正式與考試系統依各自的 `can_release`／公司功能開關測試。
- **公司管理員不是平台管理員**：呼叫 `/api/admin/*`、`code-zip`、用量報表 → 403。
- **公司不可用**：`is_active=false`、期間已過、期間未到 → 403；`/api/auth/me` 仍可用；該公司在跑的 AI 被中止（P5）。
- **測試區 DB 帳號**（§10）：測試區容器的環境變數不含平台 DB 帳密；用測試區帳號連 `aidev` 與別的 `test_*` 被拒；不是超級使用者。
- **角色寫入約束**：`admin`＋company_id、`company_admin`／`user` 無 company_id → 拒絕。
- **GIT 退回順序**：個人 → 公司 → （P4）→ 丟例外，各一支。
- **§5.4 靜態守衛**本身要能紅：刻意拿掉某支路由的檢查，確認測試會紅。
- **遷移**：既有帳號與專案遷移後，拿一個新客戶帳號登入，列表應為空。
- 前端沒有自動化測試（rules/frontend.md 30）：平台管理員、內部公司一般使用者、客戶公司管理員、客戶一般使用者各登入一次人工點過。

---

## 10. 測試區資料庫帳號隔離（09-14 新發現，必修）

### 10.1 現況（2026-09-14 實查）

- 測試區 Odoo 連資料庫用的是**平台自己的 `DATABASE_URL`**（`pipeline/env-agent.js:193` `odooDbArgs()`），經 `dbEnvFlags` 以 `-e USER=… -e PASSWORD=…` 傳進容器（`lib/docker-env.js:193-203`）；seed、升級、tour 的 `docker exec` 也用同一組。
- 那個帳號 `odoo` 是 **PostgreSQL 超級使用者**（`rolsuper=true`）。
- 同一個 PG（埠 8772）裡同時有平台 DB `aidev` 和**全部客戶的測試區 DB**（09-14 共 17 個 `test_*`）。
- 測試區 SSO 建出來的帳號**與 admin 同群組**（`idx_aidev_sso/controllers/main.py:54-68`），含 `base.group_system` ⇒ 可以建「伺服器動作」執行 Python。
- `--db-filter`／`--no-database-list`（`docker-env.js:230`）只擋 Odoo 網頁介面，**擋不住容器裡的 Python 自己連 DB**。

### 10.2 會怎樣

任何進得了測試區的人（09-14 裁決：客戶驗收時就是 admin），或 AI 寫進模組的一段程式碼，都能用超級使用者：
- 讀平台 DB `aidev`（任務、對話、加密憑證的密文）
- 讀、改別家客戶的測試區 DB
- 超級使用者可以 `COPY … TO PROGRAM` 在平台容器裡執行指令 ⇒ 讀 `data/config.json`（總鑰匙）

這條路**不經過 AI 容器**，所以子專案 0 做完也擋不住。

### 10.3 裁決（09-14）

客戶在測試區**維持 admin 權限**（驗收什麼都能試），改靠資料庫帳號把影響鎖在自己的測試 DB（子專案 3 P3）。

### 10.4 做法

| 項目 | 做法 |
|---|---|
| 每個測試區一個 PG 角色 | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`，名稱帶測試區 id；密碼隨機產生、`lib/crypto.js` 加密存在 `odoo_envs` |
| DB 擁有者 | 平台用超級使用者建好 `test_<folder>` 後 `ALTER DATABASE … OWNER TO` 該角色，並在該 DB 內 `REASSIGN OWNED BY odoo TO` 該角色 |
| 擋連別的 DB | 每個 DB（含 `aidev`、`postgres`、其他 `test_*`）`REVOKE CONNECT … FROM PUBLIC`，只給擁有者；新建測試區時對新 DB 也做 |
| ⚠ `postgres` 維護庫要補回 | 撤掉 PUBLIC 之後，**必須對該測試區角色單獨 `GRANT CONNECT ON DATABASE postgres`**。Odoo 非連它不可：映像 entrypoint 的 `wait-for-psql.py` 先連 `postgres`（連不到就 `exit 1`，容器只吐一行 `Database connection failure` 就死），之後 `bus` 的 imbus `LISTEN` 與 `ir_cron` 喚醒 worker 也都走 `db_connect('postgres')`。2026-09-16 實測：漏掉這道，測試區**完全建不起來**、狀態永久卡在「建立中」。只放行 `postgres` 一個庫（裡面沒有業務資料，看得到的只有 DB 名單與角色名等共用目錄），`aidev` 與別家 `test_*` 仍然連不進去 |
| 容器拿到的帳密 | `dbEnvFlags` 與所有 `docker exec` 改用該測試區角色，**不再**傳平台 `DATABASE_URL` 的帳密 |
| 既有測試區 | 遷移腳本逐一建角色、轉擁有者、重建容器；做完比對「容器環境變數裡沒有 `USER=odoo`」 |
| 缺角色時 | 大聲失敗、不啟動測試區，**絕不退回**用平台帳號（rules/pipeline 59） |

⚠ 計畫階段要實測：Odoo 以非超級使用者跑 `-i base` 初始化、裝 `unaccent` 等擴充套件是否需要額外權限（擴充套件要超級使用者建，可由平台先建好再轉擁有者）。

### 10.6 09-15 實測結果（推翻上表兩處）

在正式 PG 上用 `drill_*` 臨時角色／DB 實測，已全部清除：

| 項目 | 結果 |
|---|---|
| `REASSIGN OWNED BY odoo TO …` | **不能用**：`odoo` 是 initdb 的 bootstrap 超級使用者（oid 10），直接報 `required by the database system`。而且 `REASSIGN OWNED` 會連**其他 DB 的擁有權**一起轉走（用 drill_a 在交易內證實後回滾）⇒ 上表「DB 擁有者」列改為：`ALTER DATABASE … OWNER TO` ＋在該 DB 內逐一 `ALTER TABLE/SEQUENCE/VIEW/ROUTINE … OWNER TO`（排除擴充套件成員、被表擁有的序列），`test_liSheng` 複本 449 個 relation 不到 1 秒轉完、殘留 0 |
| Odoo 建 DB | 平台沒有任何地方建 DB，是 Odoo `-i base` 時自己建（需 CREATEDB）。改由平台先 `CREATE DATABASE … OWNER <角色> ENCODING 'UTF8' LC_COLLATE 'C' TEMPLATE template0`（與 Odoo 相同）；**DB 已存在時 Odoo 會跳過建 `pg_trgm`**，所以平台要自己建 |
| 非超級使用者跑 Odoo 17 `-i base`／既有 DB 轉擁有者後 `-u base` | 都 exit 0 |
| 角色自建 `pg_trgm`／`unaccent` | 可以（trusted extension） |
| 角色 DDL、trigram 索引 | 可以 |
| `REVOKE CONNECT … FROM PUBLIC` 後連別的 DB | 擋下（no CONNECT privilege）；超級使用者不受影響，自己的 DB 照連 |
| `COPY TO PROGRAM`／讀 `pg_authid`／`pg_read_file`／建 DB | 全部擋下 |
| 看得到其他 DB 名稱 | 看得到（`pg_database` 對所有人可讀），連不進去——接受 |
| 現況 | 任何非超級使用者現在連得進 `aidev`（讀不到表） |

另：pg_hba 是 `127.0.0.1 trust`＋`10.0.0.0/24 scram`，**從平台容器（host 網路）連 `10.0.0.1` 來源 IP 是 192.168.10.110，不在允許網段**；測試區容器來源是 10.0.0.x 才對得上。平台容器內任何程式經 127.0.0.1 連線不需密碼——子專案 0 的 AI 容器必須連不到宿主 loopback。

### 10.5 排程

跟子專案 0 同級的前置：**任何客戶進測試區之前必須完成**。不依賴公司表，可以提前做。
