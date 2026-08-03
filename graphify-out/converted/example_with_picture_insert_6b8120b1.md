<!-- converted from example_with_picture_insert.xlsx -->

## Sheet: insert_img
|  | Report Sale Order {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  | Name | {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  | Date |    {%xv sysdate%}    |  |  |  |  |  |  |  |
|  | Address | {{docs.contact_address_complete}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  | Price Subtotal |  |  |  |  |  |  |  |  |  |  |  |  |  |
| {% for o in docs.order_line %} | {{o.price_subtotal}} |  |  |  |  |  |  | {% insert_img o.product_id.image_1920 %} |  |  |  |  |  |  |
| {% endfor %} | Total = {{docs.amount_total}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
## Sheet: insert_img_inside_loop
| Report Sale Order {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Name | {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  | Date |    {%xv sysdate%}    |  |  |  |  |  |  |  |
| Address | {{docs.contact_address_complete}} |  |  |  |  |  |  |  |  |  |  |  |  |
| Price Subtotal |  |  |  |  |  |  |  |  |  |  |  |  |  |
| {% for o in docs.order_line %}{{o.price_subtotal}} |  |  |  |  |  |  | {% insert_img o.product_id.image_1920 %} |  |  |  |  |  |  |
| {% endfor %} Total = {{docs.amount_total}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
## Sheet: insert_img_cell
|  | Report Sale Order {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  | Name | {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  | Date |    {%xv sysdate%}    |  |  |  |  |  |  |  |
|  | Address | {{docs.contact_address_complete}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  | Price Subtotal |  |  |  |  |  |  |  |  |  |  |  |  |  |
| {% for o in docs.order_line %} | {{o.price_subtotal}} |  |  |  |  |  |  | {% insert_img_cell o.product_id.image_1920 %} |  |  |  |  |  |  |
| {% endfor %} | Total = {{docs.amount_total}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
## Sheet: insert_img_cell_inside_loop
| Report Sale Order {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Name | {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  | Date |    {%xv sysdate%}    |  |  |  |  |  |  |  |
| Address | {{docs.contact_address_complete}} |  |  |  |  |  |  |  |  |  |  |  |  |
| Price Subtotal |  |  |  |  |  |  |  |  |  |  |  |  |  |
| {% for o in docs.order_line %}{{o.price_subtotal}} |  |  |  |  |  |  | {% insert_img_cell o.product_id.image_1920 %} |  |  |  |  |  |  |
| {% endfor %} Total = {{docs.amount_total}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
## Sheet: insert_img_cell_size
|  | Report Sale Order {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  | Name | {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  | Date |    {%xv sysdate%}    |  |  |  |  |  |  |  |
|  | Address | {{docs.contact_address_complete}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  | Price Subtotal |  |  |  |  |  |  |  |  |  |  |  |  |  |
| {% for o in docs.order_line %} | {{o.price_subtotal}} |  |  |  |  |  |  | {% insert_img_cell o.product_id.image_1920, 200, 200%} |  |  |  |  |  |  |
| {% endfor %} | Total = {{docs.amount_total}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
## Sheet: insert_img_cell_size_inside_loo
| Report Sale Order {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Name | {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  | Date |    {%xv sysdate%}    |  |  |  |  |  |  |  |
| Address | {{docs.contact_address_complete}} |  |  |  |  |  |  |  |  |  |  |  |  |
| Price Subtotal |  |  |  |  |  |  |  |  |  |  |  |  |  |
| {% for o in docs.order_line %} {{o.price_subtotal}} |  |  |  |  |  |  | {% insert_img_cell o.product_id.image_1920, 200, 200%} |  |  |  |  |  |  |
| {% endfor %} Total = {{docs.amount_total}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
## Sheet: insert_img_cell_size_height
| Report Sale Order {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Name | {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  | Date |    {%xv sysdate%}    |  |  |  |  |  |  |  |
| Address | {{docs.contact_address_complete}} |  |  |  |  |  |  |  |  |  |  |  |  |
| Price Subtotal |  |  |  |  |  |  |  |  |  |  |  |  |  |
| {% for o in docs.order_line %} {{o.price_subtotal}} |  |  |  |  |  |  | {% insert_img_cell o.product_id.image_1920, height=250 %} |  |  |  |  |  |  |
| {% endfor %} Total = {{docs.amount_total}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
## Sheet: insert_img_cell_size_width
| Report Sale Order {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Name | {{docs.name}} |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  | Date |    {%xv sysdate%}    |  |  |  |  |  |  |  |
| Address | {{docs.contact_address_complete}} |  |  |  |  |  |  |  |  |  |  |  |  |
| Price Subtotal |  |  |  |  |  |  |  |  |  |  |  |  |  |
| {% for o in docs.order_line %} {{o.price_subtotal}} |  |  |  |  |  |  | {% insert_img_cell o.product_id.image_1920, width=250 %} |  |  |  |  |  |  |
| {% endfor %} Total = {{docs.amount_total}} |  |  |  |  |  |  |  |  |  |  |  |  |  |