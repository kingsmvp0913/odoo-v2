# 階段 4「客戶按到底」事實調查

日期：2026-09-22　狀態：唯讀調查，未改任何檔案
工作目錄：`/home/odoo/odoo-v2`，branch `master`（HEAD `18de0a56`）
資料來源：`app/public/js/pipeline-spec.js`（流程單一來源）＋程式碼實查＋正式平台 DB（`postgres://…@localhost:8772/aidev`，只跑 SELECT）

## 讀過的規格與它們的日期

| 檔 | 日期／狀態 | 對階段 4 的份量 |
|---|---|---|
| `docs/superpowers/specs/2026-09-11-customer-self-serve-flow-design.md` | 2026-09-11 初稿，§8 五題 **P1～P5 全部標「已決 09-14」**，檔案 mtime 09-14 10:05 | 主規格 |
| `docs/superpowers/specs/2026-09-11-productize-overview.md` | 09-11，09-15 最後更新；§4 寫「所有待決題已全部裁決」 | 3-P1～3-P5 彙整（與主規格一致） |
| `docs/superpowers/specs/2026-09-11-productize-rollout-plan.md` | mtime 09-22 09:13（今天才動過）；§4 表列「階段 4 客戶按到底 ⬜ 未開始」 | 進度唯一來源 |
| `docs/superpowers/specs/2026-09-11-tenant-isolation-design.md` | mtime 09-21；定義 `loadTaskForActor`／`canReleaseProject`／`company_admin` | 階段 4 的前置，已大量落地 |

**沒有任何 `待決`／`TBD` 留在階段 4 的範圍內**——五題都已裁決。所以本調查的價值不在「還有什麼沒決定」，而在「已決的事有幾件其實已經做完、有幾件沒做」。

⚠ 前置狀態（rollout plan §4 表）：子專案 0（把 AI 關起來）🔨 進行中且**等主機 `upgrade.sh` 重啟**；子專案 2（客戶自帶 API key）⬜ 未開始。規格把 0、1、2 全列為階段 4 的前置。

---

## A. 關卡，以及今天誰按得下去

### A.1 流程全貌（`app/public/js/pipeline-spec.js`）

該檔開頭自述：**它不驅動執行**，是人工謄本，由 `app/server/tests/pipeline-flow.test.js` 守著不與狀態機漂移（`pipeline-spec.js:1-30`）。以下是它列的關。

| 關 | 狀態 | 誰跑 | 進入條件 | 產出／去向 |
|---|---|---|---|---|
| 待分類 | `new` | — | 任務建立 | 一律進客服關（`pipeline-spec.js:69-80`） |
| 客服處理 | `cs_running` | agent `cs` | 來源單需判性質 | 三分類：改程式／操作問題／需求不清（`:81-90`） |
| **需補資料** | `cs_data_needed` | **人** | 要改程式但需求不清 | 補完 → 回客服重跑（`:91-99`） |
| **等待確認回覆** | `cs_reply_pending` | **人** | 判操作問題，已寫回覆草稿 | 確認 → 直接結案（`:100-110`） |
| 分析 | `analysis_running` | agent `analysis-project` | 判定要改程式 | `analysis.yaml`（含 acceptance／permissions）（`:118-128`） |
| **等待確認** | `confirm_pending` | **人** | 分析自己有待答問題或信心不足 | 答完 → 分析整關重跑（`:129-138`） |
| **等待規格確認** | `spec_review` | **人** | 規格要人過目才開工 | 核准 → 建立分支；提意見 → `respec_running`（`:139-148`） |
| 建立分支 | `branch_pending` | 系統 | 規格定稿 | 每 repo 開 worktree，切點 ai-dev（`:149-158`） |
| 開發 | `coding_running` | agent `coding-project` | 分支建好或被退回 | commit（`:174-190`） |
| QA 審查 | `qa_running` | agent `qa` | 開發完成 | pass → 併入測試；fail → 退開發（`:191-203`） |
| **待你裁決** | `clarify_pending` | **人** | 所有「停下來問人」的統一閘門 | 答完依 `resume_status` 導回原關（`:204-213`） |
| 規格層重做 | `respec_running` | agent `respec-patch` | 規格閘門送意見／途中追加需求 | patch 進 `analysis.yaml`（`:214-227`） |
| 分診 | `reject_triage`／`resolve_triage` | agent `analysis-reject` | 人工退回／人填了修正指示 | fix／resume／advance／respec（`:228-241`） |
| **失敗待確認** | `stopped` | **人** | 任一關觸頂、環境錯、agent 無有效結果 | 填修正指示 → `resolve_triage`（`:242-252`） |
| 併入測試 | `merge_running` | 系統 | QA 通過 | 併進 `testing`（`:253-262`） |
| **合併衝突** | `merge_conflict` | **人** | 三個入口都撞衝突且 AI 解不掉 | 人裁決後回原關（`:263-274`） |
| 部署測試區 | `deploy_testing` | 系統 | 已併 testing | 安裝／升級模組（`:275-285`） |
| E2E 測試 | `playwright_running` | 系統 | 部署成功且專案啟用 E2E | 跑 tour（`:287-300`） |
| **等待審核** | `review_pending` | **人** | E2E 過，或 E2E 停用時部署成功 | 核准 → 併 ai-dev → Wiki → 完成（`:301-307`） |
| 併入 ai-dev | `push_ai_running` | agent `merge` | 人按核准 | 寫 `approved_at`（`:308-317`） |
| 更新 Wiki | `wiki_updating` | agent `library` | 已併 ai-dev | 功能頁（`:318-326`） |
| 完成 | `done` | — | Wiki 好 | **完成 ≠ 上線**（`:327-336`） |
| **🚀 上正式** | 不是任務狀態，專案層 | **人** | 有已核准未推 main 的任務 | 整條 ai-dev 併進 main（`:337-347`） |

「等人」的名單由 `app/public/js/status-labels.js` 的 `actor:'human'` 推導，共 **8 個狀態**（`status-labels.js:24,35,43,44,47,52,53,55`），再加專案層的「上正式」＝**9 個人工按鈕**。

### A.2 授權實查

**共同入口**：所有任務層關卡端點都經 `loadTaskForActor`（`app/server/lib/task-access.js:11`）。它的判準是三段：
- `WHERE id=$1 AND (user_id=$2 OR $3=true)` — 本人或平台管理員（`task-access.js:17-19`）
- 公司管理員另一段查詢：同公司同事建的任務也看得到（`task-access.js:27-33`）
- 最後 `canSeeProject`：專案沒綁這家公司就回 null（`task-access.js:44`）

`canSeeProject` 在 `app/server/lib/tenant-access.js:33-42`；`company_admin` 這個角色值在 `tenant-access.js:9`。

**結論：9 個人工按鈕裡，8 個任務層的今天完全沒有「平台管理員限定」這回事**——只要看得到那張任務就按得下去。

### A.3 表：每個人工關卡 vs 今天的授權

| 關卡（按鈕） | 端點 | `file:line` | 中介層 | 客戶一般人（自己的任務） | 客戶公司管理員（同事的任務） | 與規格 §4.1 對照 |
|---|---|---|---|---|---|---|
| 需補資料 | `POST /api/tasks/:id/cs-data-submit` | `app/server/pipeline-routes.js:361` | `verifyToken` ＋ `loadTaskForActor` | ✅ 按得下 | ✅ 按得下 | 一致 |
| 等待確認回覆（確認送出） | `POST /api/tasks/:id/cs-confirm` | `pipeline-routes.js:342` | 同上 | ✅ | ✅ | 一致 |
| 等待確認回覆（追問） | `POST /api/tasks/:id/cs-followup` | `pipeline-routes.js:410` | 同上 | ✅ | ✅ | 一致 |
| 等待確認（回答） | `POST /api/tasks/:id/answer` | `app/server/tasks-routes.js:860` | 同上 | ✅ | ✅ | 一致 |
| 等待確認／待你裁決（反問） | `POST /api/tasks/:id/clarify-ask` | `tasks-routes.js:925` | 同上 | ✅ | ✅ | 一致 |
| 等待規格確認（核准） | `POST /api/tasks/:id/spec-approve` | `pipeline-routes.js:149` | 同上 | ✅ | ✅ | 一致 |
| 等待規格確認（要求調整） | `POST /api/tasks/:id/spec-revise` | `pipeline-routes.js:178` | 同上 | ✅ | ✅ | 一致 |
| 失敗待確認（填修正指示） | `POST /api/tasks/:id/resolve-blocker` | `tasks-routes.js:963` | 同上 | ✅ | ✅ | 一致 |
| **合併衝突（逐檔裁決）** | `POST /api/tasks/:id/resolve-conflicts` | `pipeline-routes.js:544` | 同上 | **✅ 按得下** | **✅ 按得下** | ❌ **違反 §8 P1「已決 09-14：不讓客戶處理」** |
| **合併衝突（標記手解完成）** | `POST /api/tasks/:id/mark-conflict-resolved` | `pipeline-routes.js:438` | 同上 | **✅ 按得下** | **✅** | ❌ 同上 |
| **合併衝突（問 AI）** | `POST /api/tasks/:id/merge-clarify` | `pipeline-routes.js:654` | 同上 | **✅** | **✅** | ❌ 同上 |
| 等待審核（核准） | `POST /api/tasks/:id/approve` | `pipeline-routes.js:39` | 同上＋按下當場驗 GIT 憑證（`:59-66`） | ✅ | ✅ | 一致 |
| 等待審核（退回） | `POST /api/tasks/:id/reject` | `pipeline-routes.js:94` | 同上 | ✅ | ✅ | 一致 |
| **🚀 上正式（合併 main）** | `POST /api/projects/:id/release` | `app/server/project-routes.js:1010` | `verifyToken` ＋ `loadProjectForActor`（`:1017`）＋ **`canReleaseProject`（`:1025`）** | ❌ 403 | ✅ **只要該公司對該專案的綁定勾了 `can_release`** | ✅ **已實作，規格說的「改成」已經完成** |
| **🚀 上正式（部署到客戶正式機）** | 同一支 route 的後半 | `project-routes.js:1098` | **`isAdminUser(req.userId)`** | ❌ | ❌ **被擋，只回「請通知管理員執行部署」** | ❌ **規格 §4.3 要求改成 `canReleaseProject`，未改** |
| 待上正式清單（唯讀） | `GET /api/projects/:id/pending-release` | `project-routes.js:978`，`canReleaseProject` 在 `:988` | 同上 | ❌ 403 | ✅（有勾 `can_release` 才行） | ❌ **與 3-P5「已決 09-14：客戶一般人看得到（唯讀）」相反** |

`canReleaseProject` 本體：`app/server/lib/tenant-access.js:67-76`（平台管理員必過；否則要 `isCompanyAdmin` ＋ 該綁定 `can_release === true`）。

前端按鈕條件已經照 `canReleaseProject` 走，不是 `isAdmin`：`app/public/js/ui-next/pages/ProjectDetail.js:177`、`pages/ProjectList.js:110`、`UiNextApp.js:1348`（三處都是 `v-if="project.can_release"`）。

### A.4 今天正式庫的實際樣子（SELECT 實查）

- `companies`：2 家 — id 1「內部」`is_internal=t`、id 2「測試公司」`is_internal=f`，兩家都 active。
- `project_companies`：**17 筆全部綁在公司 1，`can_release` 為真的 0 筆。**
- `users`：`admin` 9 人（無公司）、`company_admin` 1 人（公司 2）、`user` 7 人（公司 1）。

所以**今天沒有任何非平台管理員按得下「上正式」**——規格 §7「內部公司成員不能再按上正式」事實上已經生效（靠資料，不是靠程式特判）。而唯一那個 `company_admin` 屬於公司 2，公司 2 零個專案綁定 ⇒ 他現在看不到任何專案。

### A.5 順帶查到、不在規格裡的兩個授權缺口

1. **`POST /api/tasks/batch/archive`（`tasks-routes.js:693`）沒有經過 `loadTaskForActor`**，只有 `user_id = $2 OR isAdmin`（`:701-707`）。功能上客戶因此**能自己放棄／封存自己的任務**（這是好事，見 C），但它還會連帶呼叫 `reclaimTestingFrom`（`:708`），那支對專案的 `testing` 分支做 `reset --hard` 重建（`tasks-routes.js:168-190` 的註解）。**一個客戶的一般使用者封存自己的任務，會動到整個專案共用的 `testing` 分支。** 共用專案（兩家公司綁同一專案）時這是跨租戶的副作用。規格沒談過封存。
2. `GET /api/projects/:id/env/log`（`app/server/env-routes.js:210`）只要 `verifyToken` ＋ `loadProjectForActor`，回的是 `docker logs` 尾端 256KB 原文；UI 上「查看 log」按鈕**沒有 `isAdmin` 條件**（`ProjectDetail.js:255`，旁邊 `:251/:253/:254/:256` 的建立／停止／刪除都有）。詳見 D。

---

## B. 客戶看得到什麼，讀不讀得懂

### B.1 規格怎麼渲染

後端在 `app/server/tasks-routes.js:130-142` 的 `parseSpecYaml` 把 `analysis.yaml` 白名單成 6 個欄位：`summary / module / execution_mode / requirements / acceptance / permissions`。`findings`（AI 自己的查碼筆記，滿是 `檔案:行號`）、`case_id`、`clarification_channel`、`low_confidence` **都不外吐**。

- 動作面板不重印規格，只有一個輸入框＋「要求調整」「確認開工」兩顆鈕（`app/public/js/ui-next/pages/TaskDetail.js:1317-1330`）。
- 規格本體印在對話流那則 `[等待你審核規格]` 底下（`TaskDetail.js:1155-1170`）：
  - `module` → `<code>` 直出（`:1158`）
  - `requirements` → **預設收合**，標題寫「實作項（給 AI 的施工細節，共 N 項）」（`:1159-1162`）
  - `acceptance` → **永遠攤開**（`:1163-1166`）
  - `permissions` → 攤開（`:1169`）

⚠ **但整包 `analysis_yaml` 仍然在 API 回應裡**：`GET /api/tasks/:id` 用 `SELECT t.*`（`tasks-routes.js:372-380`），原始 YAML 隨 `task.analysis_yaml` 一起送到瀏覽器，只是 UI 不畫它。規格 §4.4「YAML 原文收合起來，只有平台人員展開得到」——**UI 層算做到了，資料層沒有。**

### B.2 實際內容讀不讀得懂（正式庫 143 份規格，用 `js-yaml` 逐份解析）

| 指標 | 數字 |
|---|---|
| `summary` 字數 中位／最大 | **262 字 / 2,627 字** |
| `summary` 超過 400 字 | **45 / 143（31%）** |
| `requirements` 項數 中位／最大 | 6 / 36 |
| `requirements` 單行含檔名、行號、反引號或 Model/field 字樣 | **703 / 953 行（74%）** |
| `acceptance` 為空 | 1 / 143 |
| `permissions` 有填 | **17 / 143（12%）** |

**判斷：分兩半，一半合格一半不合格。**

`summary` 與 `acceptance` 是真的寫給人看的。實際抽樣（task 282）的 `summary`：

> 資料庫每天自動備份的「保留天數」（超過這個天數的舊備份檔會被自動刪掉），在程式碼與說明文件裡寫的預設值（主機上沒另外指定時程式會用的數字）從 3 天改成 14 天…

`acceptance` 更好，全部是畫面語言（task 279、278 實抽）：

> 以只有銷售「使用者: 僅自己的文件」權限、未給任何會計權限的使用者登入，開啟一張自己為「銷售員」且狀態為「草稿」的應收憑單，表單左上角出現「編輯」按鈕。
> 進入「先人查詢」開啟任一先人，「農曆生日」標籤右邊是三個並排的小輸入框…

`requirements` 則完全是給工程師的（同一張 task 282）：

> - main/odoo_backup.py 第 44 行：`DEFAULT_RETENTION_DAYS = int(os.getenv("ODOO_RETENTION_DAYS", "3"))` 的 fallback 由 '3' 改為 '14'…
> - main/backup.md 第 240~245 行備份目錄結構預覽：prd 與 dev 兩組各改為「首筆檔名 + 省略行 + 末筆檔名」三行呈現…

**誠實結論：客戶按「確認開工」時要看的那三塊（summary／acceptance／權限）裡，前兩塊已經夠白話、可以按；`requirements` 不能給客戶讀，但它已經預設收合、而且標題就講明是「給 AI 的施工細節」。真正的缺口是 (a) 三成的 `summary` 超過 400 字（09-04 那次量到 13%，現在是 31%，往壞的方向走了）、(b) `permissions` 只有 12% 有填，等於審核者多半看不到「誰能用、能做什麼」。**

### B.3 澄清通道

存在，而且有兩個：

- `clarification_channel`（`analysis.yaml` 內）→ 後端 `taskClarification`（`tasks-routes.js:110-120`）解析出 `summary / intro / questions`，只在 `confirm_pending`（與其對話續跑態）回傳（`tasks-routes.js:406-409`）。回答走 `POST /api/tasks/:id/answer`（`tasks-routes.js:860`），反問走 `clarify-ask`（`:925`）。
- `clarify_pending`「待你裁決」是**所有「停下來問人」的統一閘門**（`pipeline-spec.js:204-213`），QA 判規格歧義、分診判原因含糊都走它。

**沒人回答會怎樣：什麼都不會發生，任務無限期停在那裡。**
- `app/server/cron.js` 每分鐘跑一次（`cron.js:286`），對 8 個人工狀態**沒有任何逾時、催辦或自動推進**；唯一相關的是 `cron.js:57` 把 `done/stopped` 超過保留期的 `task_events` 清掉（回放資料，不是任務本身）。
- 通知只發一次、只發給任務擁有者：`notify.js:37-49` 的 `_dispatchAction` 寫一筆 `user_inbox`（`lib/inbox.js:22-28`）＋ socket。收件匣的 `WHERE user_id = req.userId`（`inbox-routes.js:23-38`）。
- **沒有任何往平台管理員升級的路徑。** 全 repo 找不到「通知平台管理員」的機制（`notify.js` 只有 `notifyAction(userId, …)` 與 `emitAll`）。規格 §5 兩處寫「通知平台管理員」——**未實作**。

---

## C. 「失敗待確認」與脫困路徑

### C.1 需要人的狀態

就是 A.1 那 8 個 `actor:'human'` 狀態。其中真正是「出事了」的兩個：`stopped`（失敗待確認）與 `merge_conflict`（合併衝突）。

`stopped` 的成因（`pipeline-spec.js:242-252`）：任一關重試觸頂、環境錯誤、agent 沒吐出有效結果；跨關總彈跳上限 `MAX_REENTRY=2`。

### C.2 失敗時客戶看到什麼

`blocker_content` 被原封不動塞進對話流，當成一則「執行中斷」泡泡（`app/public/js/ui-next/pages/TaskDetail.js:115-116`，`:730` 把 role `blocker` 標成「執行中斷」）。正式庫實抽兩筆：

- task 276：`請先到設定填個人 GitHub PAT，任務才能存取 GitHub。` ← 可讀
- task 147：`任務在各關卡間循環 2 次仍未通過，需人工介入。最後錯誤：odoo.tools.convert.ParseError: while parsing /mnt/extra-addons/main/idx_project/views/project_task_views.xml:170 … View error context: '-no context-'` ← **原始 Python traceback，客戶看不懂**

規格 §4.5「客戶看到的是白話的原因，不是 `blocker_content` 原文」——**未實作，今天就是原文。**

### C.3 提供哪些動作

`stopped` 的動作面板（`TaskDetail.js:1429-1440`）：一個自由輸入框＋三顆快捷鈕。快捷鈕的文字（`TaskDetail.js:47-53`）：

- 「碼我自己改好了，重新審查」→ `程式碼我已經自行修正完成，請回傳 decision="advance"、target="qa"。`
- 「環境已排除，重跑部署」→ `環境問題已排除，程式碼未變動，請回傳 decision="advance"、target="deploy"。`
- 「這是誤判，直接送人工審核」→ `這是誤判，不需再修改，請回傳 decision="advance"、target="review"。`

**這三顆是寫給供應商工程師的**（前提是「你自己去 repo 改碼」「你自己去修環境」，內容還是在教使用者對 AI 下 `decision=/target=` 這種契約詞彙）。客戶按任何一顆都是說謊。

送出後走 `POST /api/tasks/:id/resolve-blocker`（`tasks-routes.js:963`）→ 專案任務轉 `resolve_triage` 交分診 agent（`:975-980`）。

### C.4 關鍵問題：客戶自己脫得了困嗎

**部分可以，三條路裡兩條通、一條不通。**

| 情境 | 客戶能不能自己處理 | 依據 |
|---|---|---|
| 任務 `stopped`（重試觸頂／agent 失敗） | **可以**。`resolve-blocker` 只要 `verifyToken`＋`loadTaskForActor`（`tasks-routes.js:963-966`），填一段話就交給分診 agent 重新決定往哪走 | ✅ |
| 任務 `merge_conflict` | **可以，但規格說不該讓他**。三支端點全開（`pipeline-routes.js:438/544/654`），前端面板也沒有 `isAdmin` 條件（`TaskDetail.js:1355-1412`）。其中「已手動解決衝突，繼續」這顆的前提是**有人真的去 repo 改衝突檔**——客戶做不到，按下去只會讓任務帶著沒解的衝突往下走 | ⚠ 規格 §8 P1 說不讓、程式沒擋 |
| 放棄整張任務 | **可以**。`POST /api/tasks/batch/archive`（`tasks-routes.js:693`）開放一般使用者封存自己的任務。單張的 `/archive`（`:725`）與 `DELETE`（`:753`）是 `requirePlatformAdmin` | ✅（但副作用見 A.5） |
| 「請平台協助」 | **沒有這個東西**。全 repo 找不到任何 escalate／求助端點或按鈕 | ❌ §8 P2「已決 09-14：要」未實作 |
| 上正式時 main 撞衝突 | **不能**。規格 §5 自己也說這種客戶沒辦法處理，要通知平台管理員——而通知機制不存在（見 B.3） | ❌ |

**一句話：客戶在「AI 自己卡住」這種常見失敗上能自救；在「Git 層面的失敗」上完全不能，而且今天沒有任何東西會告訴供應商「有人卡住了」。**

---

## D. 測試區驗收

### D.1 今天的流程

1. 任務走到 `review_pending`，客戶在任務頁看到「審核通過／退回修正」面板（`TaskDetail.js:1331-1354`），旁邊有查看 diff 的入口（`:1345`）。
2. 要真的看畫面，走專案頁／側欄的「測試區」→ `GET /api/projects/:id/env/sso`（`app/server/env-routes.js:120`）。
3. 該端點 **已經接上租戶範圍檢查**：`loadProjectForActor`（`env-routes.js:124-126`）。規格 §4.6「SSO 端點改用 `loadProjectForActor`」——**已完成。**
4. 環境若被閒置回收或從未建過，這支會**自己把環境拉起來**並回 202（`env-routes.js:153-161`），不需要管理員。所以客戶進得去。
5. 進去後平台簽一張 30 秒 TTL 的 token（`env-routes.js:175`），Odoo 側 JIT 建帳號。

### D.2 有哪些地方預設「按的人是供應商員工」

| # | 東西 | `file:line` | 問題 |
|---|---|---|---|
| 1 | **測試區 Odoo 帳號＝ Odoo 系統管理員** | `app/docker/addons/idx_aidev_sso/controllers/main.py:141`（`gids = [base.group_user, base.group_system]`） | 客戶在測試區是 admin，開發者模式、伺服器動作（可跑任意 Python）全開。§8 P3「已決 09-14：維持現行」＝**刻意接受**，前提是階段 2c 測試區獨立 DB 帳號（rollout plan 記為 ✅ 已完成），但那份紀錄也寫著「**尚未由真人點過 SSO 登入**」 |
| 2 | **「查看 log」給所有人** | 按鈕 `app/public/js/ui-next/pages/ProjectDetail.js:255`（無 `isAdmin`，旁邊 `:251/:253/:254/:256` 都有）；端點 `env-routes.js:210` | 客戶按下去看到 `docker logs` 尾端 256KB 原文 |
| 3 | **「查看建立記錄」給所有人** | `ProjectDetail.js:259-261`（`env.setup_log` 直接 `<pre>` 出來），資料來自 `env-routes.js:64-67` 的 `SELECT … setup_log` | clone／venv／pip／init／seed 的完整建置輸出。**我沒有驗證 `setup_log` 裡會不會夾到 PAT 或 DB 密碼——這是未知數，見 E** |
| 4 | 建立／停止／刪除環境、歸還對外名額 | `env-routes.js:195 / 229 / 237 / 185` 全部 `requirePlatformAdmin` | 環境壞掉時客戶只能等人 |
| 5 | 部署失敗 log 沒有任何 API | `DEPLOY_LOG_DIR` 只在 `lib/agent-mounts.js:49` 與 `cron.js:68` 出現，沒有任何 route 讀它 | 客戶看不到、供應商也得進機器看 |
| 6 | 執行歷程（agent 逐字輸出） | `tasks-routes.js:639`，`requirePlatformAdmin`；UI `TaskDetail.js:1094` | 這個擋對了 |

---

## E. 阻礙與我查不出來的事

### E.1 會擋住開工的

1. **前置沒完成。** 規格說階段 4 的前置是子專案 0、1、2。rollout plan §4：子專案 0 🔨「合併完成但等主機 `upgrade.sh` 重啟」、子專案 2（客戶自帶 API key）⬜ 未開始。要不要等，是裁決題不是事實題。
2. **租戶第 3 部從未在瀏覽器裡驗過。** rollout plan §4 該列自己寫「⚠ **從未在瀏覽器裡驗證過**」，並指向 `docs/3b-manual-verification-checklist.md`。階段 4 整條路都疊在這層之上。
3. **今天沒有可拿來演練的資料。** 唯一的 `company_admin`（公司 2）零個專案綁定、`project_companies` 裡 `can_release=true` 的是 0 筆。要走一次完整流程，得先建綁定並勾 `can_release`——那是寫入動作，本次沒做。

### E.2 規格說已決、程式卻是另一回事（照重要性排）

| # | 規格說 | 程式實況 | `file:line` |
|---|---|---|---|
| 1 | §8 P1：合併衝突**不讓客戶處理** | 三支端點對任何看得到該任務的人全開，前端面板也不擋 | `pipeline-routes.js:438 / 544 / 654`；`TaskDetail.js:1355-1412` |
| 2 | §8 P2：失敗待確認要給「請平台協助」按鈕 | 不存在 | 全 repo 無相符字串 |
| 3 | §4.5：客戶看白話原因，`blocker_content` 原文收合 | 原文直接當一則對話泡泡印出來 | `TaskDetail.js:115-116` |
| 4 | §4.3：部署正式的權限檢查由 `isAdminUser` 改成 `canReleaseProject` | 合併 main 那半**已改**（`:1025`），部署那半**沒改** | `project-routes.js:1098` |
| 5 | §5：合併失敗／部署失敗要通知平台管理員 | 通知只發給任務擁有者，無升級路徑 | `notify.js:37-49`；`lib/inbox.js:22` |
| 6 | §4.3：確認視窗要列出每張任務的標題、**提出者、核准時間** | 只列 `#task_id / title / status` | `app/public/js/release-modal.js:99-104`（資料來源 `project-routes.js:972-976` 有 `approved_at` 但沒渲染，且完全沒有提出者／核准人欄位） |
| 7 | 總覽 3-P5：客戶一般人看得到待上正式清單（唯讀） | 一般使用者 403 | `project-routes.js:988` |

### E.3 規格說要做、其實**已經做完**的（別重做）

| 規格條目 | 已在程式裡 | `file:line` |
|---|---|---|
| §4.3「誰能按」改 `canReleaseProject` | 合併 main 那半完成，含 404/403 次序的防探測處理 | `project-routes.js:1017-1027`；`lib/tenant-access.js:67-76` |
| §4.2 GIT 憑證「個人 → 公司」退回 | `buildGitEnv(req.userId)` 已走退回，只在兩者皆無時擋 | `project-routes.js:1033-1039` |
| §4.3 確認視窗明寫「資料庫改動不會還原、平台不會備份」 | 原文就在彈窗裡，且是必勾的 checkbox | `release-modal.js:112-119` |
| §4.4 YAML 原文不給客戶、`requirements` 收合 | 後端白名單 6 欄、前端 `requirements` 預設收合 | `tasks-routes.js:130-142`；`TaskDetail.js:1159-1162` |
| §4.6 測試區 SSO 端點改 `loadProjectForActor` | 完成 | `env-routes.js:124-126` |
| §7 內部公司成員不能按上正式 | 事實上已生效（17 筆綁定 `can_release` 全 false） | DB 實查 |
| 前端按鈕用 `can_release` 而非 `isAdmin` | 三處都對 | `ProjectDetail.js:177`、`ProjectList.js:110`、`UiNextApp.js:1348` |

### E.4 我查不出來的（老實說）

1. **`odoo_envs.setup_log` 裡會不會含 PAT／DB 密碼。** 我沒有逐筆 dump 現有 `setup_log` 去比對敏感樣式。它是整段 clone／pip／init 的輸出，而 clone 用的是帶 PAT 的 URL——**可能外洩，但我沒有證據，也沒有反證。** 這決定「查看建立記錄」要不要立刻改成 admin-only。
2. **測試區 Odoo admin 帳號在 2c（獨立 DB 帳號）之後到底還能做什麼。** rollout plan 說 2c 已完成並在正式平台驗過（`COPY TO PROGRAM` 擋、`pg_authid` 擋、`rolsuper=f`），但同一列也寫「尚未由真人點過 SSO 登入」。我沒有實際登進測試區試過伺服器動作，**§8 P3 這個裁決的安全前提我無法確認成立**。
3. **`summary` 從 13% 超長變成 31% 超長的原因。** 我只量到數字，沒有回溯是哪幾支 agent prompt 改動造成的，也沒分辨是不是特定專案拉高的。
4. **共用專案（兩家公司綁同一專案）的實際行為。** 今天資料庫裡沒有這種情形（17 筆全綁公司 1），所以規格 §4.3 講的「按下去會連另一家已核准的任務一起上線」我只能從 `PENDING_RELEASE_SQL`（`project-routes.js:972-976`，沒有任何 user/company 條件）推論成立，**沒有實測**。
5. **`reclaimTestingFrom` 在多公司共用專案時的破壞範圍。** 我確認了它會被一般使用者觸發、會 `reset --hard` testing，但沒有追完 `rebuildTesting` 對「別家公司在飛的任務」的完整後果。
6. **`pipeline-flow.test.js` 現在是不是綠的。** 我沒有跑測試（唯讀調查）。`pipeline-spec.js` 的謄本準確性靠它守著，本報告 A.1 直接採信該檔。

---

## 要你拍板的事

1. **合併衝突：立刻把三支端點關成平台管理員限定，還是維持全開？** 關起來＝照 §8 P1 的裁決走，代價是今天內部使用者（7 個一般帳號）也會失去自己解衝突的能力。維持全開＝第一家客戶進來時，他按得到一顆按了只會把沒解的衝突推下去的按鈕。
2. **「請平台協助」：這一版做，還是先靠人工回報？** 做＝要同時補「通知平台管理員」的機制（今天完全不存在），範圍會從一顆按鈕長成一條通知鏈。不做＝客戶卡住時沒有任何東西會讓供應商知道，只能靠客戶打電話。
3. **`blocker_content`：加一層白話轉寫，還是先只做「原文收合＋一句通用說明」？** 轉寫＝要多跑一支 agent（每次失敗多一次花費）。收合＝當天就能做完，但客戶看到的還是「任務失敗了，請描述你希望怎麼處理」這種等於沒說的話。
4. **上正式的部署那半：改成 `canReleaseProject`，還是留 `isAdminUser`？** 改＝客戶的公司管理員真的能「按到底」，SSH 進客戶正式機的動作由客戶自己負責。留＝階段 4 的名字不成立，每次上線都還是要供應商按最後一下。
5. **待上正式清單（3-P5）：開給客戶一般人唯讀，還是承認 1-P1「只看自己的」勝出、把 P5 撤銷？** 開＝要改 `project-routes.js:988` 的門檻，而該清單會把同公司同事的任務標題全部吐出去（那正是 `:983-987` 的註解刻意擋的）。撤銷＝規格要改一行，程式不動。
6. **測試區的「查看 log」「查看建立記錄」：現在就收成 admin-only，還是等查清 `setup_log` 有沒有含憑證再決定？** 先收＝一行前端條件，內部使用者少兩個排障入口。等查＝在查清之前不要開第一家客戶。
7. **`permissions` 只有 12% 有填：要不要把它列為階段 4 的一部分？** 列入＝分析關 prompt 要改，且 QA 的比對基準會跟著變。不列＝客戶審規格時，「誰能用、能做什麼」這件事在 88% 的任務上是空白的。

---

## 已拍板（2026-09-22）

| 題目 | 裁決 | 備註 |
|---|---|---|
| 4. 上正式的部署那半 | **改成 `canReleaseProject`，讓客戶的公司管理員自己按到底** | 「客戶按到底」才名實相符。⚠ 合約清單那條「客戶自己按上正式造成的損害，責任歸屬」從「最好要有」升級成**必要條件**——客戶按下去是真的 SSH 進他們自己的正式機 |
| 上正式的開關要放哪一層 | **沿用現有的專案層 `can_release`，不加公司層總開關** | 控制者建議過公司層（緊急時能一次收回），使用者選擇維持現狀。操作上的代價：要收回一家公司的上正式權，得逐一取消每個綁定專案的勾選 |
| 1. 合併衝突三支端點 | **收成平台管理員限定**，並補一個讓管理員找得到的入口 | ⚠ 查證後發現「找得到」大部分已經有了：`merge_conflict` 的 actor 是 human，本來就進「需要處理」清單；管理員有 `?all=true`。缺的只是一個主動入口，見下一列 |
| 2. 客戶卡住怎麼通知 | **管理員首頁掛一條「有 N 張卡住」**，不做「請平台協助」按鈕、不做通知鏈 | 與第 1 列是同一件事的兩半：收起來之後客戶按不到，得靠這條讓你們看到。代價：不登入就不會知道 |
| 3. 失敗訊息要不要翻譯 | **原文收合起來＋一句通用說明**，不跑 AI 翻譯 | 不花額度、當天做得完 |
| 5. 待上正式清單給不給客戶一般使用者看 | **給看（唯讀）** | ⚠ 要改 `project-routes.js:988` 的門檻。**注意 `:983-987` 有一段註解刻意在擋這件事**——那段的理由是會把同公司同事的任務標題全部吐出去。動之前先讀它，若理由仍成立要回報而不是直接改 |
| 6. 測試區 log／建立記錄 | **給看，維持現狀** | 控制者實掃正式資料 16 份建立記錄，找 GitHub token／網址內嵌帳密／password 字樣，**零命中**。但 log 是 pip／clone 的原始輸出，以後會不會夾到沒人能保證——值得補一支守衛定期掃 |
| 7. 規格的 `permissions` 欄位 | **列入階段 4：要求 AI 一定要填** | ⚠ **關鍵背景：這條規則早就存在**——`CLAUDE.md` 的 P6 白紙黑字要求分析關填 `permissions`，QA 關要比對。所以 12% 不是「沒規定」而是「規定了沒生效」。**改法不是加規則，是先查為什麼現有規則沒被遵守**（提示詞沒注入到？agent 忽略？QA 沒真的比對？），否則只會再加一條同樣被忽略的規則 |
