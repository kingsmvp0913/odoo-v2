<!-- converted from example.xlsx -->

## Sheet: Sheet1
|  | Report Sale Order {{docs.name}} |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  | Name | {{docs.partner_id.name}} |  |  |  |  |  |
|  |  |  |  |  |  | Date |    {%xv sysdate%}    |
|  | Address | {{docs.partner_id.contact_address_complete}} |  |  |  |  |  |
|  | Price Subtotal |  |  |  |  |  |  |
| {% for o in docs.order_line %} | {{o.price_subtotal}} |  |  |  |  |  |  |
| {% endfor %} | Total = {{docs.amount_total}} |  |  |  |  |  |  |