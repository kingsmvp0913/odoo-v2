---
name: hungjou-230-review-2026-09-04
description: 鴻久 task 230（請購單別/供應商拆單）退回三缺陷後第二輪複審全數通過，含正式資料驗證與「兩次擔心都被實測解除」的判讀教訓
metadata: 
  node_type: memory
  type: project
  originSessionId: 28d67437-baf9-4fc4-80ba-7bfc750cc727
---

2026-09-04 鴻久 task 230（IDX-2026080079「產品品號預設單別／單別個別手選預設311」）。第一輪 `fa6b9cd` 人工退回三點，coding 重做出 `3961496`（5 檔 +48/-10，很克制、無規格外改動），**第二輪複審全數通過**，停在 `review_pending` 等按核准。

**三個必修的實際修法**（都真的修到，不是改註解）：
1. `_sync_existing_po_if_any` 加 `AND RTRIM(ISNULL(B.TB010,'')) = ?`，值取 `materials[:1].supplier_id.name`——與寫入端 `_create_po_lines` 的 TB010 同一個值，對得上。
2. `_create_po_header` 不再從 `context` 撈模型，改成參數傳 `po_order, active_model`（比我建議的「補 with_context」更乾淨）。`_sync_one_group` 簽名與 `append_dedicated_purchase_line:549` 的呼叫順序已核對無誤。
3. `migrations/17.0.1.0.8/post-migration.py` 已建、`__manifest__.py` version 有一起 bump。非阻斷項 (a) 也順手修了（tree 加 `editable="bottom"`；可編輯的只有 `po_slip_id`/`supplier_id`，`arrival_status`/`source_po_number` 是 compute 無 inverse 所以 Odoo 自動鎖）。

**兩次「以為是缺陷」都被實測解除——都是讀碼推不出來的**：
- 疑 migration 的 `search()` 漏 `active_test=False`（[[hungjou-211-213-review-2026-08-28]] 同款坑，`idx.repair` 確實有 `active` 欄位）→ 實查正式區「停用維修單底下帶專料列」= **0 筆**，漏不到。
- 疑 TB010 寫入值回歸：舊碼寫 `product_tmpl_id.primary_supply`、新碼寫 `supplier_id.name`，看起來換了來源 → 實查 `_get_default_po_slip_and_supplier` 是用 `res.partner.name == primary_supply` 反查的，**兩者本來就等價**；再實查 `res_partner.name` 存的就是代號，格式也對。見 [[hungjou-sm-data-conventions]]。

**通則**：`git show` 看得到「值從 A 換成 B」，看不到「A 和 B 其實是同一個東西」。跨系統欄位的等價性只有連真實資料才能確認，這次兩個擔心都是這樣消掉的——**別把讀碼推論當成缺陷送出去**（第一輪三點是真缺陷，這輪兩點若照送就是假警報）。

**上線前要拍板的（非程式問題）**：品號「主供應商」正式區 0 筆 ⇒ 供應商預設永遠空 ⇒ 依供應商拆單得逐列手選。詳見 [[hungjou-sm-data-conventions]]。

相關：[[hungjou-211-213-review-2026-08-28]]、[[hungjou-183-187-review-2026-08-25]]、[[task-diff-three-dot-stale-main]]
