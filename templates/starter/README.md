# Flary agent starter

This Worker shows Flary prompt files in a local Cloudflare Worker.

```bash
npm install
npm run dev
```

Send a prompt preview:

```bash
curl -X POST http://localhost:5173/api/agents/support/preview \
  -H "content-type: application/json" \
  -d '{"customer":{"name":"Ada"},"question":"How do I reset my password?"}'
```

The preview compiles the real
`prompts/support/answer.prompt.md` file. It does not call a model.

To add durable threads, follow:

- https://github.com/rdvo/flary/blob/main/docs/examples/support-bot.md
- https://github.com/rdvo/flary/blob/main/docs/cloudflare-resources.md
