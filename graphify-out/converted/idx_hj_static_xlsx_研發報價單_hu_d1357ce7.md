<!-- converted from idx_hj_static_xlsx_研發報價單_hu.xlsx -->

## Sheet: 報價單
| 產品名稱            |  | {{ docs.product_name or '' }} |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 廠別  |  | {{ docs.partner_id.partner_name or '' }} | 客戶名字 | {{ docs.contact_id.name if docs.contact_id else '' }} | 產品料號  | {{ docs.product_tmpl_id.default_code if docs.product_tmpl_id else '' }} | 單據日期 | {{ docs.maintenance_date.strftime('%Y/%m/%d') if docs.maintenance_date else '' }} |
| 叫修單號 |  | {{ docs.maintenance_id or '' }} |  |  | 業務 | {{ docs.order_taker.name if docs.order_taker else '' }} | 工程師 | {{ docs.employee_id.name if docs.employee_id else '' }} |
| 問題描述 | {{ docs.idx_mtc_que_all or '' }} |  |  |  | 工程回復 | {{ docs.note or '' }} |  |  |
| {% set ns = namespace(filtered_list=[]) %}{% for item in docs.idx_mtc_bom_ids %}{% if item.bom_type.id in [1] %}{% set ns.filtered_list = ns.filtered_list + [item] %}{% endif %}{% endfor %} | 品名 |  | 規格 |  | 數量 | 單價 | 金額 | 備註 |
| {% for doc in ns.filtered_list %}{{ (doc.sequence or 0) | int }} | {{ doc.product_name or '' }} |  | {{ doc.product_spec or '' }} |  | {{ doc.qty or '' }} | {{ doc.unit_price or '' }} | {{ doc.amount or '' }} | {{ doc.note or '' }} |
| {% endfor %} |  |  |  |  |  | Total:  | {{ (ns.filtered_list | default([])) | sum(attribute='amount', start=0) }} |  |