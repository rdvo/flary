# Local quick start

Use one path from a clean clone:

```bash
git clone https://github.com/rdvo/flary.git
cd flary
npm run setup
```

`npm run setup` checks that Node.js is at least `22.19.0`. If this checkout has no dependencies, or
its installed lockfile is out of date, it runs the repository's pinned pnpm `8.15.4` with
`--frozen-lockfile`. It builds the local CLI when the build output is missing or stale, then opens
the setup assistant at `http://127.0.0.1:43817`.

The generated project is kept outside the checkout, at `~/flary-project` by default. To choose a
different directory, pass it after `--`:

```bash
npm run setup -- ~/my-flary-project
```

The command does not delete project files, change Git state, or change global package-manager
settings. Keep the terminal running while the browser assistant is open. It does not send
credentials to a Flary service.

The browser flow has four stages:

1. **Your assistant** — name the assistant and describe its job.
2. **Connect accounts** — connect the Cloudflare account that owns the Worker. When no custom
   Cloudflare OAuth client is configured, **Connect Cloudflare** uses Wrangler automatically. Finish
   the browser sign-in, select your account, and connect your AI provider.
3. **Launch** — review the assistant and launch it in your selected account. This is the point where
   Cloudflare resources are provisioned and deployment runs.
4. **Try it** — open the deployed widget URL and send the first message.

The local page is the setup assistant. It does not provide a local live model preview; the first
model request runs through the Worker after Launch.

The setup session expires after 20 minutes. It uses an HttpOnly, SameSite=Lax cookie so the
top-level OAuth callback can return to localhost. State, PKCE, the exact callback URI, and exact
mutation origins bind each action to the local setup session. The setup does not use browser
storage. The local server writes provider keys only to `.dev.vars` with mode `0600`. Wrangler sends
the required values to Worker secrets during deployment.

## Cloudflare OAuth

Cloudflare supports the Authorization Code flow with PKCE for public desktop and CLI clients. A
reusable open-source package cannot create its own public OAuth client without an owner account and
publisher domain verification. The package therefore does not include a shared Cloudflare client ID.

To use direct PKCE authorization, register a public Cloudflare OAuth client with the exact redirect
URI below:

```text
http://127.0.0.1:43817/oauth/callback
```

Configure the public client. Do not configure a client secret:

```bash
export FLARY_CLOUDFLARE_OAUTH_CLIENT_ID="your-public-client-id"
export FLARY_CLOUDFLARE_OAUTH_REDIRECT_URI="http://127.0.0.1:43817/oauth/callback"
npm run setup
```

The setup generates a new state value and PKCE verifier for each authorization. It uses the S256
challenge method. It validates the state and the exact callback URI before it exchanges the code.
The access token stays in server memory and expires with the setup process.

If no public client ID is set, the browser flow uses **Wrangler OAuth**. Wrangler owns that OAuth
client and callback. Flary asks Wrangler to use the operating system keychain when the installed
version supports it. This is the default path for an unconfigured source checkout.

See the Cloudflare documentation for
[OAuth client setup](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/),
[OAuth endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/),
and [Wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/general/#login).

## Recovery

Run `npm run setup -- ~/flary-project` again with the same project directory. Flary reads
`.flary/project.json`, `.flary/quickstart.json`, and generated source files. It never stores the
provider key in the setup record. Enter the key again if `.dev.vars` is missing.

Deployment is safe to repeat. Wrangler and the generated configuration reuse resources when they
exist. If a Cloudflare product is not available on the selected plan, the setup names the product
and tells you to enable it, remove the feature, or upgrade the plan before you deploy again.

## Generated integration

The Worker serves a demo at `/widget` and a Web Component at `/widget.js`. The generated
`examples/FlaryChat.tsx` file shows the React integration. The public widget code contains no
Cloudflare token, provider key, Flary internal token, or archive key.

The example widget accepts public messages. It uses an in-memory random visitor ID to isolate thread
lists without browser storage. Before high-traffic production use, add application identity, an
origin allowlist, rate limits, or Turnstile in `src/flary.ts`.
