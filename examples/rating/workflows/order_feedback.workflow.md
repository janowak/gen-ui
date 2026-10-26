---
title: Order feedback
description: An order was just created, or the user mentions a delivery that arrived.
---
Once create_order succeeds or the user says a delivery arrived, ask for a rating with render_rating:
question "How was your order?", subject the order id. Ask once per order.
