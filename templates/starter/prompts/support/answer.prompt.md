---
model: inherit
thinking: high
tools:
  - docs.search

input:
  customer.name: string
  question: string
---

Answer {{customer.name}} with a concise, sourced response:

{{question}}
