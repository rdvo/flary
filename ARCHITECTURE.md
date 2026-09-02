# Flary architecture

Flary is one TypeScript package with a small authoring API and focused advanced exports. The source
tree separates portable contracts from runtime adapters.

## Public entry points

- `src/index.ts` is the compatible root entry point.
- `src/harness/functions` contains `flary()`, functions, agents, and sources.
- `src/harness/client` contains HTTP, run, and realtime thread clients.
- `src/react` contains optional React bindings.
- `src/vite.ts` contains the Vite and Cloudflare build integration.
- The remaining package exports expose advanced contracts and adapters.

Do not add a root export when a focused export is enough. A root export becomes part of the stable
compatibility surface.

## Runtime layers

1. `contracts` defines validated data exchanged between layers.
2. `providers`, `tools`, `mcp`, and `vault` adapt external systems.
3. `execution` applies limits, approvals, scheduling, and replay rules.
4. `storage`, `session`, `history`, and `recall` preserve durable state.
5. `cloudflare`, `flue`, and `host` connect the portable runtime to deployment and transport
   systems.
6. `functions` exposes the application authoring API.
7. `client` and `react` consume the public host protocol.

External payloads enter as untrusted data. Parse them once at the owning boundary. Internal
functions should accept named domain types after parsing.

## Durable execution flow

1. A client submits a message or function run.
2. The host authenticates the tenant and admits the request.
3. The session engine records the turn and selected model.
4. The scheduler runs the provider and protected tools.
5. Tool calls use approval, idempotency, replay, and redaction contracts.
6. Normalized events stream to clients and persist for reconnects.
7. The engine checkpoints workspace and archive state before completion.

The event log is the transcript authority. Derived views, telemetry, and history indexes must not
become a second transcript source.

## Repository directories

- `src`: published runtime and client source.
- `tests`: deterministic contract, adapter, restart, and package tests.
- `templates`: projects copied by the CLI.
- `apps`: Flary's documentation and hosted reference applications.
- `packages`: auxiliary workspace packages.
- `docs`: product documentation source.
- `scripts`: build, package, and release checks.
- `tools`: vendored development tooling with provenance and license files.

Generated `.astro`, `.flue`, `.flue-vite`, `.wrangler`, and `dist` directories must not be
committed. Generated test fixtures are isolated from lint and format checks.

## Change rules

- Keep provider details out of portable contracts.
- Keep secrets out of model-visible values, events, logs, and errors.
- Keep write operations durable and idempotent across restart.
- Add restart tests for each new write adapter or approval continuation.
- Add package tests for each new public export.
- Treat any public export removal or semantic change as a major-version change.
