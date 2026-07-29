---
model: inherit
thinking: high
tools:
  - docs.search

input:
  customer.name: string
  question: string

limits:
  steps: 20
  tools: 40
---

Answer {{customer.name}} clearly and briefly.

Question:

{{question}}
