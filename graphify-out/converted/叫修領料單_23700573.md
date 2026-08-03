<!-- converted from 叫修領料單.docx -->

4-05-15(5)
| 叫修單別 | 叫修單別 | {{docs.maintenance_name.name or ‘’}} | {{docs.maintenance_name.name or ‘’}} | 送修部門 | {{docs.taker_department or ‘’}} | 產品品號 | {{docs.product_tmpl_id.default_code or ‘’}} | {{docs.product_tmpl_id.default_code or ‘’}} | {{docs.product_tmpl_id.default_code or ‘’}} |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 叫修單號 | 叫修單號 | {{docs.maintenance_number or ‘’}} | {{docs.maintenance_number or ‘’}} | 接單人員 | {{docs.order_taker.name or ‘’}} | 產品品名 | {{docs.product_name or ‘’}} | {{docs.product_name or ‘’}} | {{docs.product_name or ‘’}} |
| 單據日期 | 單據日期 | {{docs.maintenance_date or ‘’}} | {{docs.maintenance_date or ‘’}} | 客戶代號 | {{docs.partner_id.name or ‘’}} | 產品品名 | {{docs.product_name or ‘’}} | {{docs.product_name or ‘’}} | {{docs.product_name or ‘’}} |
| 確認碼 | 確認碼 | 確認碼 | 確認碼 | {{docs.conf_status or ‘’}} | {{docs.conf_status or ‘’}} | 產品規格 | {{docs.specification or ‘’}} | {{docs.specification or ‘’}} | {{docs.specification or ‘’}} |
| 問題描述 | 問題描述 | {{docs.idx_mtc_que_all or ‘’}} | {{docs.idx_mtc_que_all or ‘’}} | {{docs.idx_mtc_que_all or ‘’}} | {{docs.idx_mtc_que_all or ‘’}} | 備註 | {{docs.note or ‘’}} | {{docs.note or ‘’}} | {{docs.note or ‘’}} |
| 序號{% set ns = namespace(filtered_list=[]) %}{% for item in docs.idx_mtc_bom_ids %}{% if item.bom_type.id in [2, 4] and item.product_property != 'Y' and not (item.default_code or '').startswith('O100') %}{% set ns.filtered_list = ns.filtered_list + [item] %}{% endif %}{% endfor %} | 品號
備註 | 品號
備註 | 品名
規格 | 品名
規格 | 品名
規格 | 庫存數量
主要倉別 | 領用數量 | 安全存量
標準用量 | 儲位 | 儲位 |
| {%tr for doc in ns.filtered_list %} | {%tr for doc in ns.filtered_list %} | {%tr for doc in ns.filtered_list %} | {%tr for doc in ns.filtered_list %} | {%tr for doc in ns.filtered_list %} | {%tr for doc in ns.filtered_list %} | {%tr for doc in ns.filtered_list %} | {%tr for doc in ns.filtered_list %} | {%tr for doc in ns.filtered_list %} | {%tr for doc in ns.filtered_list %} | {%tr for doc in ns.filtered_list %} |
| {{doc.sequence or ‘’}} | {{doc.product_tmpl_id.default_code or ‘’}}
{{doc.note or “”}} | {{doc.product_tmpl_id.default_code or ‘’}}
{{doc.note or “”}} | {{doc.product_name or ‘’}}
{{doc.product_spec or ‘’}} | {{doc.product_name or ‘’}}
{{doc.product_spec or ‘’}} | {{doc.product_name or ‘’}}
{{doc.product_spec or ‘’}} | {{doc.stock_qty or ‘0’}}
{{doc.warehouse_code or ‘’}} | {{doc.qty or ‘0’}} | {{doc.safe_qty or ‘0’}}
{{doc.bom_qty or ‘0’}} | {{doc.location or ‘’}} | {{doc.location or ‘’}} |
| {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} |