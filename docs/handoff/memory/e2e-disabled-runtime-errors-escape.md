---
name: e2e-disabled-runtime-errors-escape
description: 「coding 產出常在瀏覽器點下去才炸」的根因＝E2E tour 被 projects.e2e_disabled 全面關閉，runtime 錯誤沒有任何關卡攔得到（非使用者 prompt 問題）
metadata: 
  node_type: memory
  type: project
  originSessionId: 064acbe9-9d4b-4607-8006-4d9bb63d378a
---

2026-08-06 查證：使用者反映「最近 coding 出來的程式很常出現錯誤訊息，都要貼錯誤回來重開發」。**根因不是使用者需求描述（prompt）品質**，是驗證覆蓋缺口。

**證據鏈**
- `task_rejections` 最近 3 筆人工退回全是同型：`TypeError: v5 is not a function`（OWL JS handler）、繼承 `web.ListView.Buttons` 用不存在的 `o_list_button_add` class → xpath 對不到 → asset bundle 炸 → 後台白屏、`AttributeError: The method 'sale.order.action_idx_sale_test' does not exist`（view button name 指向不存在 method）。`rejection_items` 分類 25/28 是實作層錯（實作錯誤 22＋impl_miss 3），不是需求落差。
- **`token_usage` 裡 `playwright` agent 歷來 0 筆**——唯一會在瀏覽器真的點下去的關卡從沒執行過。
- 原因：**`projects.e2e_disabled` 在實際在用的專案全為 true**（id 1 odoo17／2 慈雲／3 鴻久／5 odoo19_HRM；只有 id 4 空測試專案 false）。刻意設計，見 `d6faab2`(2026-07-23)「新建專案預設關閉 E2E，避免每個新專案都被迫跑耗時 tour」。開關本身 `250d50a`(2026-07-14)。

  ⚠ **2026-08-12 修正這條的因果**：不是「7 個專案被刻意關掉」，而是**新建專案預設就關**
  （`project-routes.js:372-377` 的 INSERT **寫死 `true`**，且附註解說明「欄位 DEFAULT 早已凍結成
  false、改 schema 對現有機器無效」，所以不能只看 `db.js` 的 DEFAULT）。真正被人動過的只有 id 4。
  而 **id 4 `odoo19` 有 0 個 repo、0 張任務**——`project_repos` 查無此列。E2E 關的前置條件就包含
  「專案要有 clone 完成的 repo」，不滿足直接 `stopped`。**所以 playwright 歷來 0 次執行的真正原因是
  「唯一打開開關的那個專案根本跑不到那一關」**，不是「大家都關掉了」。
  推論「只有 odoo19 會走 E2E，實跑驗證只能在它身上做」是錯的，會把人導向一個永遠跑不動的對象。
- 逃逸路徑：coding 明文「本關不做任何驗證」（`coding-project.md:26`，全押 deploy）→ deploy 只跑 `odoo-bin -i/-u --stop-after-init`，抓得到 Python 語法／invalid field／view 繼承，**抓不到** JS runtime 與 button→method 綁定 → QA 只讀 `git diff` 不執行（`qa.md:16`）→ E2E 關掉 → 第一個執行到該段程式的是使用者本人。

**已補的一半**：`04ca5d4`(2026-08-05)「deploy 補後台 asset bundle 冒煙檢查」——升級後 GET `/web` 抓 `web.assets_web` bundle，404/500 判 asset bug。故「template xpath 對不到→白屏」這類**現已攔得到**（那次白屏退回發生在 08-04，煙測之前）。仍無防線的是：view button `name` 指向不存在 method、JS handler runtime 錯。

**prompt 面的次因**：`coding-project.md`／`analysis-project.md`／`qa.md` grep `owl|static/src|asset|t-on-click|bundle` **零命中**；CLAUDE.md §1 Odoo Constraints 整段只講 model／view XML／權限。agent 寫 OWL 前端等於沒有規範可依，只能賭 Context7。相關 [[deployment-topology]]。

**2026-08-12 使用者改變決定，已開始試水溫**：挑 `odoo17`(id 1) 當試點（有 repo、0 張任務歷史、
origin 是 `github.com/kingsmvp0913/aidev-test.git`——名字就寫著測試用，不是客戶正式 repo），
`e2e_disabled` 改為 false，並建了任務 **124**（`manual_1786496704371`，需求＝聯絡人表單加一個
「內部編號」欄位＋tour 驗它出現）。這是 `playwright_running` 這一關**史上第一次真的被執行到**。
⚠ 該 repo 是**空的**（只有一個「初始化 main 分支」commit），所以 pipeline 得自己建 module。
其餘前置條件已先查掉：chromium 在 image 內（`app/docker/Dockerfile.odoo`，含 Debian/Ubuntu 兩種裝法）。

### ✅ 結果：E2E 首次跑通（2026-08-12 09:14）

`task_logs` 留下 **`[E2E 通過] 1 支測試全數通過`**。是「1 支」而非 0 支——0 支會被假綠燈守衛判失敗
退回 coding，所以這是真的有跑到測試，不是空轉放行。全程**零彈跳**（qa/pw/deploy/reentry 四個
計數器都是 0），一次走完
`待分類 → 分析中 → 建立分支 → 先寫 E2E 考題 → 開發中 → QA 審查中 → 併入測試中 → 部署測試區 → E2E 測試中 → review_pending`。
產出 module `idx_partner_code`（tour 在 `static/tests/tours/`，Python 端在 `tests/`）。

**判讀陷阱（我自己踩到的）**：
- **成功的 E2E 不落 `data/logs/e2e-task*.log`**（跟 deploy 一樣，只有失敗才寫檔）。想確認「到底有沒有
  跑」不能找 log 檔，要查 **`task_logs`**（`content` 欄，不是 `message`）。`task_events` 只會有
  `▶ E2E 測試中` 這個 marker，之後一片空白——因為 b5c1acb 之後這關是純程式關、不呼叫 claude。
- **輪詢採樣會漏關卡**：我每 30 秒查一次 status，只看到 `qa_running → review_pending`，誤以為中間
  三關被跳過。真相在 `task_events` 的 `▶` marker 序列裡（它們不會漏）。

**順帶證實並已清除**：E2E 關的 `mergeInto(testing)` **確實是 no-op**——本次任務在 testing 的 reflog
只有一筆 merge（`testing@{0}`），沒有第二筆也沒有第二個 merge commit。已於 `1317e44` 連同它的衝突
處理分支、`mergeStop` 路徑、流程圖上那條多出來的線一併移除，測試改成反向鎖（斷言本關**不得**呼叫
`mergeInto`——多做一次 merge 不會報錯，沒有這條斷言就測不出有人把它加回來）。

⚠ 我一度建議「保留當冪等保險」，理由是「萬一日後在 merge 與 E2E 之間插入別的關卡」——**那正是
CLAUDE.md 明文反對的 speculative**，且 b5c1acb 砍降級路徑用的就是同一套邏輯（「留著等於維護
沒人走過的路，而它天生最少被走、最容易爛掉」）。使用者追問「到底要不要改」時我才發現這個矛盾。
**下次遇到「這段碼沒作用但留著以防萬一」，先問它防的是不是一個假想情境。**

**2026-08-06 使用者決定：暫不修**（已被上述 08-12 決定取代，保留脈絡）。三個修法都提過並被否決（補 agent prompt 前端規則／deploy 加 button 綁定檢查／打開 e2e_disabled）。若日後要動，最省力切點是「單一專案打開 E2E 試水溫」或「deploy 在 `assetSmokeCheck` 之後加一道 button 綁定檢查（`deploy-testing.js:391-416` 同位置同模式，用 odoo shell 問 registry `hasattr(env[model], name)`，不自己解析 XML／grep .py）」。
註：補 agent prompt 這條本身風險也高——`.claude/rules/agent-prompt.md` #100 實證此 repo 的純文字禁令對 pipeline agent 無效，且專案橫跨 Odoo 17／19，寫死前端版本知識會系統性帶偏。

**未確認**：那 3 筆出問題的任務（manual_17858/17859 系列）已從 `tasks` 表刪除，查不到 `original_text`，故「使用者需求寫得夠不夠清楚」只能從退回訊息與 QA 判詞反推（規格細到「inline t-on-click 直接呼叫 alert('!!!')」，看得出規格是清楚的）。
