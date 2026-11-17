---
title: AI Wrapped
description: The user asks for their AI Wrapped, a year in review, or a recap of what you did together.
params:
  - name: year
    description: The year to wrap, if not this one
---
1. Go through this conversation and what you remember about the user. Pick their top topics, the
   phrase they kept using (count it as honestly as you can), the broader themes their time went to,
   and a playful AI personality type that fits them.
2. Call render_wrapped with that. Leave out `stats` unless you can estimate the numbers, and keep
   everything specific, funny and kind: the user may share it publicly, so no secrets, credentials or
   private details about other people.
3. Tell the user they can tap through the cards and press Share for a public link.
