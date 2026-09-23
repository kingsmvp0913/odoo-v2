---
name: raifong19-order-type-series
description: 萊峰19「訂單類型」系列 194/195/197/198/199/200 **六張全部 done（08-27）**；198 歧義已裁決、199 攔下一個會漏算 80 萬的修法、200 盤查只有兩處必修，全部經 odoo shell 實測放行，只剩使用者前端實測
metadata: 
  node_type: memory
  type: project
  originSessionId: 49795893-87c4-4d68-a986-9cca31a60648
---

2026-08-26。使用者原本提五項需求，釐清後發現第 2、4 項被他中途提的「訂單類型」吸收，
第 3 項（拿掉 Give ME 電子發票）**不需要開發**——`idx_giveme` 是獨立模組、依賴單向（giveme→idx_project）、
其他模組對它零引用，不安裝就回到標準開票流程。第 1 項（出庫不計價）使用者裁決掛起。

## 已結案（實測放行，非只看綠燈）

- **#194** 銷售單 `order_line` 還原成 Odoo 標準語意：新增 `payment_lines`、`product_lines` 改 `copy=False`
  （否則 `copy_data` 會讓商品行複製兩次）、新增 `_get_priced_lines()` override 把「哪些行參與計價」收斂成單一切換點
- **#195** 採購客製拆成 `idx_purchase`，含清掉 `confirm_reminder_mail` 死碼（`mail_reminder_confirmed` 在 19 已移除）
- **#197** 訂單類型 `idx_order_type`（`general`／`engineering`，default engineering）

- **#198／#199／#200** 2026-08-27 全數 done、已併回 ai-dev。三張都不是靠讀綠燈放行，是進
  `test_odoo19_raifong` 實測過的（該環境有真實資料：58 張訂單／103 明細／111 張發票／4 個專案，
  不是空殼）。細節見下。**尚未經使用者前端實測。**

## 已結案的細節（原「未完」段，保留給日後查證）

### ⚠ 排程約束：#200 與 #198 不可並跑
`#200`（depends 盤查）會動 `sale_order.py`／`sale_order_line.py`／`account_move.py`／`idx_packaging`，
而 `#198`（報價單範本）很可能也要動 `sale_order.py`。平台的 merge gate 只在 `merge_running` 那關序列化，
**內容衝突它擋不掉**。所以要等 #200 落地（進 ai-dev）之後才解除 #198 的暫停。
`#199` 動 `project_project.py`，與這兩張都不衝突，可以並跑。

### #198 報價單範本 — 歧義 2026-08-27 已裁決：**一律進商品明細區**，規格已放行進 coding

裁決靠實測不是偏好。進 `test_odoo19_raifong` 撈 `sale.order.template`：**全庫只有 1 張範本
「超純水專案」，9 行全是 `display_type=line_section`，沒有一行帶 product_id、沒有金額**
（桶槽／泵&鼓風機／設備／濾材&膜／機架&管架／閥件&管件／監視儀器／電器控制／外包費用）。兩個推論：
1. 這張範本本身就是工程專案用的**商品分類骨架**，所以「依類型分流」會讓工程訂單維持落在款別區
   ＝對現存唯一一張範本零效果，使用者回報的問題原封不動。
2. cs 關推薦分流的理由（「範本金額落在不計價的商品區會算不到」）**前提錯誤**——該範本沒有金額。
   工程訂單金額本來就該由款別（訂金／期中／尾款）決定（#194 已確立），「套範本後工程訂單金額為 0」
   是預期行為不是缺陷。

⚠ **不寫進規格就等於白做的細節**：`line_section`／`line_note` 行也要設 `is_product=True`
（只改分區歸屬、不動 display_type）。兩個明細區就是用 `is_product` 過濾的，只設有 product 的行
會讓九行標題全留在款別區，比原本更亂。

定案修法：覆寫 `sale.order.template.line._prepare_order_line_values()`，super() 後把 vals 的
`is_product` 設 True。core 佐證：`sale_management/models/sale_order.py:93` 的
`_onchange_sale_order_template_id` 對每行呼叫 `Command.create(line._prepare_order_line_values())`。
是 **create 時帶值**不是事後 write，所以不會踩 compute 不重算的坑。
**`sale_management` 遞移相依成立**（`sale_project` depends 它，idx_project depends sale_project）——
更正舊記錄「idx_project 沒有 depends sale_management」的言外之意：不是缺相依，明列只是講清楚。
⚠ 副作用（已知、可接受）：款別產品是靠 `product.is_order_line=True` 區分的（見 view 的 product domain），
未來若有人把款別產品放進範本，會被強制丟進商品區而與該區 domain 不符。現存範本沒有 product 所以不會發生。

⚠ **遺留限制（不是這張造成的，未修，可能要另開一張）**：在瀏覽器上按下套用範本的**當下畫面不會出現那些行**，
要按儲存後才看得到。實測 `Model.onchange(...)` 的回傳只含 `order_line`，**不含 `product_lines`／`payment_lines`**
（core 的 `_onchange_sale_order_template_id` 只寫 `self.order_line`，而客製把 `order_line` 在表單上設成
`invisible="1"`，兩個分區欄位是另外兩個獨立 One2many）。改動前後皆如此，非回歸。
存檔後結果正確：9 行全進 `product_lines`、`payment_lines` 為 0、`display_type` 保持 `line_section`（已實測）。

### #198／#199／#200 的檔案衝突約束 **已解除**（原記錄作廢）

規格定案後三張動的檔完全不重疊：#198 只新增 `sale_order_template_line.py`＋`__init__`／`__manifest__`；
#199 只動 `project_project.py`；#200 動 `sale_order_line.py`＋`sale_order.py`。三張可並跑，已同時放行。

### #200 depends 盤查 — 2026-08-27 規格已放行進 coding

結論：全 repo 盤完，**第一級只有兩處**。
- **B5** `sale_order_line._compute_invoice_status`（store=True，覆寫未帶 depends）讀了
  `untaxed_amount_to_invoice` 沒宣告。⚠ **這個落差 core 自己就有**（`sale/models/sale_order_line.py:1095`
  的 `elif line.is_downpayment and line.untaxed_amount_to_invoice == 0`，而 `:1077` 的 depends 沒宣告它）——
  規格原本寫「原生不讀它」是錯的。客製的罪是把讀取**提到迴圈開頭對每一行都讀**，觸發面從訂金行擴到全部行。
  查「客製有沒有引入落差」時要比對的是**觸發面**，不是「core 有沒有這個 bug」。
- **A1** `_compute_amounts` 讀 `order_line.is_product` 沒宣告，原判不修（「is_product 無寫入路徑」），
  改判要修——因為 **#198 即將引入寫入路徑**。跨任務的交互作用要自己想，單張任務的 agent 看不到。

判定理由的寫法教訓：「無任何寫入路徑」這種**否定式全稱斷言**站不住（欄位無 readonly、view 只是
`column_invisible="1" force_save="1"` 不是 readonly、匯入與 shell 都能寫）。改寫成可驗證的陳述
（「UI 無編輯入口、程式碼無 write/create」）。同理 D1 的 `company_id` 是 `related` **會**隨單頭連動，
不能寫「幾乎不變」。

⚠ subagent 複驗的誤報（別再被騙）：它宣稱 `idx_purchase` 的 `date_planned` 指定了 compute 但
「方法未定義」＝P0 必修。實際上 method 在 core（`purchase/models/purchase_order.py:227`），
客製只是**重宣告欄位**，depends 綁在 method 上不會遺失。若真的沒有該 method，模組根本裝不起來——
**「這會讓系統起不來」的宣稱出現在一個正在運作的系統上時，先假設是誤報。**

### #200 原始開單背景（2026-08-26）

因為 #197 同一個模式踩了兩次，開這張去盤查 `idx_*` 所有客製 compute 的 depends 落差。
任務描述裡定了**三級判準**避免假陽性：`store=True` 有落差＝真缺陷必修；`store=False` 有落差＝評估後決定；
**跨 model 用 search 反查的依賴（本專案的手開 AR 走 `origin_sale_line_id`）＝Odoo 機制本來就表達不了，
標為設計限制不修**。已知候選：`_compute_project_ids`（depends 沒有 `is_product`，但 #194 之後會讀它）。
並要求驗證走「write + flush 再讀」的真實路徑，禁用 `add_to_compute` 強制重算。

### #199 專案儀錶板收入（已回到 `spec_review`，**等審**）

規格第一輪漏了**收入總數的路徑**，而且它明確宣稱「改一處就讓總數與明細一致」——那句是錯的。
實際上兩條路徑分開：
- 點開明細清單 → `_get_domain_from_section_id` → `_get_sale_items_domain`（規格有涵蓋）
- **收入總數** → `_get_profitability_items`（core `sale_project/models/project_project.py:767`）
  **自己組 domain**，經 `_get_revenues_items_from_sol`。那個 domain 有 `('project_id','=',False)` 分支，
  會把「該訂單底下沒掛專案的行」撈進來——商品行通常正是沒掛專案的。

⚠ **2026-08-27 更正：「覆寫 `_get_profitability_sale_order_items_domain`」這個建議是錯的**，已改掉。
那是 core 的共用擴充點，被兩處用且**用途相反**：
- `sale_project/models/project_project.py:557-559` `_get_revenues_items_from_sol`＝收入查詢條件（要套分流的是這處）
- `:750-752` `_add_invoice_items`＝拿它撈 `sale_lines.invoice_lines.ids` 當**排除清單**傳給
  `_get_items_from_invoices(excluded_move_line_ids=...)`

覆寫共用點會同時縮小排除清單：商品行被濾掉 → 它們的發票行不再被排除 → 被當「額外發票」撈回
（`:688-694` 只排 excluded，並以 `analytic_distribution in account_id` 挑行；非 cogs 一律歸 revenues
`:707-712`），最後加回 revenues total（`:760-762`）。**症狀：商品明細一旦開票就漏算回收入總數，
而未開票時測起來全綠**——這種只在特定資料狀態下才現形的缺陷，正是規格審核該擋下來的。

定案修法：覆寫 `_get_revenues_items_from_sol(self, domain=None, with_action=True)`，把分流條件
`Domain(domain or Domain.TRUE) & Domain([...])` 後再 super()。收入路徑上與原方案等價
（core 的擴充點本來就是 `Domain([核心條件]) & domain`），但排除清單維持完整。
判準可複用：**改 core 擴充點前先數它被呼叫幾次、每一處拿回傳值做什麼**——同一個 domain 當「查詢條件」
與當「排除清單」時，加條件的效果是相反的。

✅ **2026-08-27 實測證實了這個判斷**（專案 3 台積電超純水專案、訂單 S00068、明細 105 已開票 800000）：
把該款別行改成商品行後，正確修法算出 revenues invoiced = **0**；同一組資料用 monkeypatch 換成
「覆寫共用擴充點」立刻變回 **800000**——那 80 萬正是從 `_add_invoice_items` 的發票路徑漏回來的。
改成一般訂單後回到 800000＋to_invoice 76000（商品行重新計入）。手法見 [[odoo-test-env-shell-testing]]。

## 這輪的教訓

- **`store=True` 的 compute 改計算範圍必須補 `depends`**，否則 DB 留下錯誤值，而且**部署與 QA 都不報錯**。
  #197 為此踩了兩次（第一次漏 `amount_*`／`invoice_status`，第二次漏 `amount_to_invoice`／`amount_invoiced`）。
  實測確認 Odoo 對同名 compute 的 depends 是**合併**不是取代，但寫法上仍該把原依賴完整列出。
- 兩次退回都是靠 **odoo shell 實測**抓到的，讀碼與 QA 都沒發現。測時要走「不強制重算」的真實路徑
  （`write` + `flush_all` 後直接讀 DB），用 `env.add_to_compute` 強制重算會繞過缺陷。見 [[odoo-test-env-shell-testing]]

## 已落地的產物

- 專案備註（wiki `project-notes`，838 字）已改寫：只寫**判斷方法**不寫會過期的斷言
  （使用者的顧慮：第三方 repo 會改，wiki 給錯誤訊息比沒有更糟）
- 平台：deploy 支援多模組 `7f2b358f`、analysis prompt 教它填多模組 `39da9e48`，皆已 push＋重啟生效。
  見 [[deploy-single-module-limit]]

## 第二個 repo（查證於 2026-08-26，**會過期，引用前重驗**）

`odoo19_taipure` 的 testing 分支有 4 個模組，`_inherit` 清單裡**沒有** `sale.order`／`purchase.order`。
唯一與我們重疊的是 `yc_project_budget_fix` 繼承 `project.project`，但它只碰**預算**（`budget.line`），
與 #199 的**收入**（`sale.order.line`）不同 method、不同資料表，故不衝突。
`yc_project_budget_fix` 與 `yc_quality` 為 installed，所以我的 odoo shell 實測已含它們的影響。
⚠ 兩邊互不相依、載入順序不保證——哪天撞到同一個 method 會安靜地其中一邊失效。
