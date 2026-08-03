<!-- converted from example.docx -->

{{docs.name}}

{{docs.partner_id.name}}
{{formatdate(docs.date_order)}}




| Product | Description | Quantity | Unit Price | Subtotal |
| --- | --- | --- | --- | --- |
| {%tr for line in docs.order_line %} | {%tr for line in docs.order_line %} | {%tr for line in docs.order_line %} | {%tr for line in docs.order_line %} | {%tr for line in docs.order_line %} |
| {{line.product_template_id.name}} | {{line.name}} | {{line.product_uom_qty}} | {{line.price_unit}} | {{line.price_subtotal}} |
| {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} | {%tr endfor %} |
| {{spelled_out(docs.amount_total)}} |
| --- |