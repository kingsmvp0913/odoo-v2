<!-- converted from 維修領料單_back.docx -->

4-05-15(5)
| 維修單別 | {{docs.repair_name.name or ‘’}} | {{docs.repair_name.name or ‘’}} | {{docs.repair_name.name or ‘’}} | 維修部門 | {{docs.department_name or ‘’}} | {{docs.department_name or ‘’}} | 產品品號 | 產品品號 | {{docs.product_tmpl_id.default_code or ‘’}} | {{docs.product_tmpl_id.default_code or ‘’}} | {{docs.product_tmpl_id.default_code or ‘’}} |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 維修單號 | {{docs.repair_number or ‘’}} | {{docs.repair_number or ‘’}} | {{docs.repair_number or ‘’}} | 維修人員 | {{docs.repair_employee_id.name or ‘’}} | {{docs.repair_employee_id.name or ‘’}} | 產品品名 | 產品品名 | {{docs.product_name or ‘’}} | {{docs.product_name or ‘’}} | {{docs.product_name or ‘’}} |
| 單據日期 | {{docs.repair_date or ‘’}} | {{docs.repair_date or ‘’}} | {{docs.repair_date or ‘’}} | 維修站別 | {{docs.idx_station_setting_id.code or ‘’}} | {{docs.idx_station_setting_id.code or ‘’}} | 產品品名 | 產品品名 | {{docs.product_name or ‘’}} | {{docs.product_name or ‘’}} | {{docs.product_name or ‘’}} |
| 客戶代號 | {{docs.partner_id.name or ‘’}} | {{docs.partner_id.name or ‘’}} | {{docs.partner_id.name or ‘’}} | 送修部門 | {{docs.order_depart_id.name or ‘’}} | {{docs.order_depart_id.name or ‘’}} | 產品規格 | 產品規格 | {{docs.specification or ‘’}} | {{docs.specification or ‘’}} | {{docs.specification or ‘’}} |
| 叫修單號 | {{docs.idx_maintenance_id.maintenance_id or ‘’}} | {{docs.idx_maintenance_id.maintenance_id or ‘’}} | {{docs.idx_maintenance_id.maintenance_id or ‘’}} | 送修人員 | {{docs.order_employee_id.name or ‘’}} | {{docs.order_employee_id.name or ‘’}} | 確認碼 | 確認碼 | {{docs.conf_status or ‘’}} | {{docs.conf_status or ‘’}} | {{docs.conf_status or ‘’}} |
| 問題描述 | {{docs.idx_repair_que_all or ‘’}} | {{docs.idx_repair_que_all or ‘’}} | {{docs.idx_repair_que_all or ‘’}} | {{docs.idx_repair_que_all or ‘’}} | {{docs.idx_repair_que_all or ‘’}} | {{docs.idx_repair_que_all or ‘’}} | 備註 | 備註 | {{docs.note or ‘’}} | {{docs.note or ‘’}} | {{docs.note or ‘’}} |
| 序號 | 序號 | 品號
備註 | 品名
規格 | 品名
規格 | 品名
規格 | 庫存數量
主要倉別 | 庫存數量
主要倉別 | 領用數量 | 領用數量 | 安全存量
標準用量 | 儲位 | 儲位 |
| {%tr for doc in docs.idx_repair_bom_ids %} | {%tr for doc in docs.idx_repair_bom_ids %} | {%tr for doc in docs.idx_repair_bom_ids %} | {%tr for doc in docs.idx_repair_bom_ids %} | {%tr for doc in docs.idx_repair_bom_ids %} | {%tr for doc in docs.idx_repair_bom_ids %} | {%tr for doc in docs.idx_repair_bom_ids %} | {%tr for doc in docs.idx_repair_bom_ids %} | {%tr for doc in docs.idx_repair_bom_ids %} | {%tr for doc in docs.idx_repair_bom_ids %} | {%tr for doc in docs.idx_repair_bom_ids %} | {%tr for doc in docs.idx_repair_bom_ids %} | {%tr for doc in docs.idx_repair_bom_ids %} |
| {{doc.sequence or ‘’}} | {{doc.sequence or ‘’}} | {{doc.product_tmpl_id.default_code or ‘’}}
{{doc.note or “”}} | {{doc.product_name or ‘’}}
{{doc.product_spec or ‘’}} | {{doc.product_name or ‘’}}
{{doc.product_spec or ‘’}} | {{doc.product_name or ‘’}}
{{doc.product_spec or ‘’}} | {{doc.stock_qty or ‘’}}
{{doc.warehouse_code or ‘’}} | {{doc.stock_qty or ‘’}}
{{doc.warehouse_code or ‘’}} | {{doc.qty or ‘’}} | {{doc.qty or ‘’}} | {{doc.safe_qty or ‘’}}
{{doc.bom_qty or ‘’}} | {{doc.location or ‘’}} | {{doc.location or ‘’}} |
| {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} |