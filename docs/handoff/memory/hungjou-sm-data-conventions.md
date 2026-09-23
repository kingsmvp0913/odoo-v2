---
name: hungjou-sm-data-conventions
description: 鴻久 Odoo↔SmartERP 的資料慣例實查結果：供應商 name 存代號、主供應商主檔全空、po_id 約三成對不上 SM
metadata: 
  node_type: memory
  type: reference
  originSessionId: 28d67437-baf9-4fc4-80ba-7bfc750cc727
---

2026-09-04 為審 task 230 連鴻久／鴻伍正式區（Odoo）與 SM 正式區（MSSQL）實查的結果。查法見 `/getSQL`，連線 id：2=鴻久正式、3=鴻伍正式、5=鴻久SM正式、6=鴻伍SM正式。

**1. `res_partner.name` 存的是供應商代號，不是公司中文名。** 實際值長 `V01074`／`V02024`／`V03117`／`V9101`／`099`。SM 的 `PURTB.TB010` 同樣是 `V03020` 這種代號，兩邊格式天然一致。所以碼裡看到 `supplier_id.name` 寫進 TB010 **不是 bug**，別再誤判一次。`res_partner.ref` 是空的，代號不在那裡。

**2. `product_template.primary_supply`（品號主供應商）在兩區都是 0 筆。** 供應商是靠 `_get_default_po_slip_and_supplier` 以 `res.partner.name == primary_supply` 反查的，來源全空 ⇒ 推導結果永遠是空 recordset。任何「依供應商自動分組／自動帶出」的需求，在正式區都等於要人工逐列手選，除非先補這個主檔。`purchase_default_slip_id` 是 task 230 才加的新欄位，上線同樣是空的 ⇒ 單別全部 fallback 到 311。

**3. Odoo 的 `idx_repair.po_id` 約三成對不上 SM。** 抽最近 20 張有 po_id 的維修單：12 張完全對得上（`po_id` 與 `PURTB` 的 `TB001-TB002` 一致）、2 張是查詢只濾 `TB029='E20'` 而漏掉的 `N20` 單別、**6 張在 SM 找不到對應**（其中 2 張 `TA007='V'` 已作廢）。那 6 張的現象是 SM 上該單的 `TB029` 寫 `E30`，而 **Odoo 根本沒有 E30 單別**（只有 E20 8354 筆／N20 24 筆／E21 1 筆）。**原因未查明**——可能 SM 端人工改過來源單別，也可能另有流程建單。
   - 判讀影響：`_sync_existing_po_if_any` 靠 `TB029/TB030` 找既有單，這批本來就找不到 ⇒ 一律建新單，是**既有行為**。task 230 的 migration 把 `po_id` 灌進 `line_po_id` 也只是忠實保留舊行為，沒變好也沒變壞。查到「到貨量沒更新」時，先確認是不是落在這三成裡。

**欄位對照**（PURTA 主檔／PURTB 明細）：`TA001/TB001`=單別、`TA002/TB002`=單號、`TA007`='V' 為作廢、`TB003`=項次、`TB010`=供應商代號、`TB014`=SM 回填數量、`TB029/TB030`=來源單別/單號（Odoo 維修單的 `repair_slip`/`repair_number`）、`TB031`=來源明細序號。`idx_repair.po_id` 格式為 `單別-單號`（如 `311F-20260528007`），911 筆全部含 `-`，`_split_repair_po_id` 都拆得開。

相關：[[hungjou-230-review-2026-09-04]]、[[hungjou-211-213-review-2026-08-28]]
