<!-- converted from example_with_picture.xlsx -->

## Sheet: Sheet1
|  | Report Sale Order {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  | Name | {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  | Date |    {%xv sysdate%}    |  |  |  |  |  |  |  |
|  | Address | {{docs.contact_address_complete}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  | Price Subtotal |  |  |  |  |  |  |  |  |  |  |  |  |  |
| {% for o in docs.order_line %} | {{o.price_subtotal}} |  |  |  |  |  |  | {% img o.product_id.image_1920 %} |  |  |  |  |  |  |
| {% endfor %} | Total = {{docs.amount_total}} |  |  |  |  |  |  |  |  |  |  |  |  |  |