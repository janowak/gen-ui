---
title: New order
description: The user wants to create, place or add an order for a customer.
params:
  - name: customer
    description: Customer name, if you know it
  - name: products
    description: Products to order, in plain words
---
1. If a customer is given, look it up with search_customers and use its id.
2. Show the order form with render_form:
   - customer: resource_select from search_customers (searchParam query, itemsPath items, idPath id, labelPath name), required, pre-filled when known
   - products: resource_multiselect from list_products (searchParam q, itemsPath data.products, idPath sku, labelPath title)
   - priority: select low / normal / high, default normal
   - delivery_date: date
   - notes: textarea, up to 500 characters
   - submit: create_order, idempotencyParam request_id, label "Create order"
3. Don't ask questions the form already covers.
