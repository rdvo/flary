# Personal Flary dashboard

This is one Worker in your Cloudflare account. It includes Better Auth,
single-owner setup, Flary functions and agents, and generated durable storage.

The first deployment prints a one-time setup token. Open `/setup` or `/` and
create the owner. Registration closes after the owner record is committed.

```bash
npm run dev
npx flary doctor
npx flary deploy
```

Provider keys are in `.dev.vars` for local development and Worker secrets in
production. The dashboard never displays a stored secret value.

Open `/connections` after owner setup to add an MCP server. Paste its HTTPS
MCP URL. Flary discovers OAuth, receives the callback in this Worker, stores
the credential encrypted, and validates the server's tools. No MCP token is
stored in source code.
