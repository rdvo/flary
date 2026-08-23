# Local quick start

Run the setup assistant:

```bash
npx flary quickstart my-flary-widget
```

Flary opens `http://127.0.0.1:43817`. The setup creates a local project and
deploys it to your Cloudflare account. It does not send credentials to a
Flary service.

The setup session expires after 20 minutes. It uses an HttpOnly, SameSite
cookie and checks the exact request origin. It does not use browser storage.
The local server writes provider keys only to `.dev.vars` with mode `0600`.
Wrangler sends the required values to Worker secrets during deployment.

## Cloudflare OAuth

Cloudflare supports the Authorization Code flow with PKCE for public desktop
and CLI clients. A reusable open-source package cannot create its own public
OAuth client without an owner account and publisher domain verification. The
package therefore does not include a shared Cloudflare client ID.

To use direct PKCE authorization, register a public Cloudflare OAuth client
with the exact redirect URI below:

```text
http://127.0.0.1:43817/oauth/callback
```

Configure the public client. Do not configure a client secret:

```bash
export FLARY_CLOUDFLARE_OAUTH_CLIENT_ID="your-public-client-id"
export FLARY_CLOUDFLARE_OAUTH_REDIRECT_URI="http://127.0.0.1:43817/oauth/callback"
npx flary quickstart my-flary-widget
```

The setup generates a new state value and PKCE verifier for each
authorization. It uses the S256 challenge method. It validates the state and
the exact callback URI before it exchanges the code. The access token stays
in server memory and expires with the setup process.

If no public client ID is set, select **Use Wrangler OAuth**. Wrangler owns
that OAuth client and callback. Flary asks Wrangler to use the operating
system keychain when the installed version supports it. This is the safest
supported fallback for an unconfigured source checkout.

See the Cloudflare documentation for [OAuth client setup](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/),
[OAuth endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/),
and [Wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/general/#login).

## Recovery

Run the same command again with the same project directory. Flary reads
`.flary/project.json`, `.flary/quickstart.json`, and generated source files.
It never stores the provider key in the setup record. Enter the key again if
`.dev.vars` is missing.

Deployment is safe to repeat. Wrangler and the generated configuration reuse
resources when they exist. If a Cloudflare product is not available on the
selected plan, the setup names the product and tells you to enable it, remove
the feature, or upgrade the plan before you deploy again.

## Generated integration

The Worker serves a demo at `/widget` and a Web Component at `/widget.js`.
The generated `examples/FlaryChat.tsx` file shows the React integration. The
public widget code contains no Cloudflare token, provider key, Flary internal
token, or archive key.

The example widget accepts public messages. It uses an in-memory random visitor
ID to isolate thread lists without browser storage. Before high-traffic
production use, add application identity, an origin allowlist, rate limits,
or Turnstile in `src/flary.ts`.
