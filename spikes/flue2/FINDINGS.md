# Flue 2.1 Phase 1 spike findings

Date of run: 2026-09-19 (EDT). This is a focused proof spike, not a product implementation.

## Environment

- Repository: `flary`, branch `flue-2-single-runtime`.
- Starting commit: `7a6fb388737abc54162accfd4883668b188974e0`.
- Node reported by the spike runner: `v26.4.0`; TypeScript: `5.9.3`; `tsx`: `4.23.1`.
- Installed packages: `@flue/runtime@2.1.0`, `@flue/sdk@2.1.0`, `@flue/cli@2.1.0`,
  `@flue/vite@2.1.0`, `@earendil-works/pi-ai@0.83.0`, and the aliased
  `@flue/runtime-legacy@1.0.0-beta.9`.
- No Cloudflare deployment, browser operation, or external OAuth operation was attempted.

The five artifacts are [hosting.ts](./hosting.ts), [providers.ts](./providers.ts),
[approvals.ts](./approvals.ts), [rollback.ts](./rollback.ts), and
[legacy-data.ts](./legacy-data.ts). `hosting.ts` is deliberately type-level: loading the Cloudflare
builder implementation under Node fails on the expected virtual `cloudflare:workers` module. The
other four artifacts execute under Node.

## Verdict table

| Seam        | Verdict                                                                                                                         | Gate result                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Hosting     | **PROVEN** for class construction, extension, routing seam, and name/tag preservation                                           | Cloudflare edge boot still needs Rob's manual exercise                               |
| Providers   | **PROVEN** for Pi `Provider` aliasing, Flue registration/resolution, four IDs, upsert, Codex SSE policy, and six helper exports | Port six helpers into Flary before removing the Pi patch                             |
| Approvals   | **NEEDS-UPSTREAM**                                                                                                              | Interceptor is an observation/wrapping seam, not a durable approval pause/resume API |
| Rollback    | **NEEDS-UPSTREAM**                                                                                                              | 2.1.0 has no public/store active-path override; the beta patch cannot be carried     |
| Legacy data | **BLOCKED**                                                                                                                     | Current code has no beta storage reader; mandatory 1.0.2 export sweep                |

## 1. Hosting (§3.1) — PROVEN (with an unverified edge runtime)

### Evidence

- The expected subpath exists. `node_modules/@flue/runtime/package.json` exports
  `./cloudflare/internal`; the declarations at
  `node_modules/@flue/runtime/dist/cloudflare/internal.d.mts:5-27` define
  `CreateFlueAgentClassOptions` and `createFlueAgentClass(options)`.
- Exact builder inputs are:
  - `AgentBase: ExtensionClass<any>` — the Cloudflare Agents SDK `Agent` class.
  - `runtime: CloudflareAgentRuntime` — the shared per-Worker runtime.
  - `className: string` — generated DO class name.
  - `agentName: string` — source identity.
  - optional `extension` — the module's `cloudflare` export.
- `extend()` is exact at `node_modules/@flue/runtime/dist/index-H4BOQWO-.d.mts:68-72`:
  - `CloudflareExtension.base?(Base: GeneratedDurableObjectClass<TBase, TEnv>): ExtensionClass<TBase>`.
  - `CloudflareExtension.wrap?(Final: GeneratedDurableObjectClass<TBase, TEnv>): GeneratedDurableObjectClass<TBase, TEnv>`.
  - `extend<TBase, TEnv>(extension: CloudflareExtension<TBase, TEnv>): CloudflareExtension<TBase, TEnv>`.
- The companion worker config builder is `createCloudflareWorkerConfig(options)` at
  `node_modules/@flue/runtime/dist/cloudflare/internal.d.mts:35-49`. It returns exactly
  `dispatchQueue`, `routeAgentRequest`, and `instanceInfo`; its dispatch route is
  `/__flue/internal/dispatch` in `node_modules/@flue/runtime/dist/cloudflare/internal.mjs`.
- The runtime object needed by the builder is constructed by `createCloudflareAgentRuntime(options)`
  at `node_modules/@flue/runtime/dist/agent-coordinator-BEWH2ojV.d.mts:44-90`. Its `prepare` input
  is `{ storage, className, agentName }` at lines 58-64, and its DO lifecycle methods are `attach`,
  `onStart`, `drainSubmissions`, `onRequest`, `onFiberRecovered`, and `onAlarm`.
- The type-level construction proof supplies `className: "FlueFlaryThreadAgent"`,
  `agentName: "flary-thread"`, `extend({ base, wrap })`, and the worker identity/binding mapping in
  [hosting.ts:14-48](./hosting.ts#L14-L48). It also checks the three worker-config return keys and
  the internal dispatch path at [hosting.ts:58-74](./hosting.ts#L58-L74).
- Existing Flary naming and migration logic already uses the required names: `src/vite.ts:267-277`
  constructs `Flue${PascalName}Agent`; `src/vite.ts:301-305` emits the `flary-v1` manifest tag;
  `src/vite.ts:445-475` preserves/replaces the existing `flary-v1` migration entry instead of
  creating a second tag. Existing Cloudflare config contains `FlueFlaryThreadAgent` and
  `FlueRegistry` (`apps/cloud/wrangler.jsonc:67-85`).

### Intended integration seam

Keep Flary's existing generated function/worker plugin and replace the generated beta agent class
body with the Flue 2 sequence:

1. Register the Flary agent definition and provider aliases in the app/agent module.
2. Build one shared `createCloudflareAgentRuntime(...)` from generated agent registrations and Flary
   context/store factories.
3. For each existing generated DO identity, call
   `createFlueAgentClass({ AgentBase, runtime, className: "FlueFlaryThreadAgent", agentName: "flary-thread", extension })`.
4. Use `createCloudflareWorkerConfig` for dispatch, request routing, and instance lookup; retain
   Flary's internal route handling around it.
5. Reuse the existing binding/class names and the existing `flary-v1` migration tag. The spike
   proves no _new_ migration is required merely to construct the same class names.

The edge behavior is not claimed as deployed proof. The published implementation imports the
Cloudflare virtual module, so this lane did not run it under Node and did not deploy to Cloudflare.
Data compatibility with beta storage is a separate blocked §3.5 gate.

## 2. Providers (§3.2) — PROVEN

### Evidence

- Flue 2.1 removed beta registration. The migration guide at
  `node_modules/@flue/sdk/docs/guide/migration.md:240-255` explicitly removes `registerProvider` and
  `registerApiProvider` and directs callers to Pi `Provider` objects plus `setProvider()`.
- Exact Flue API: `setProvider(provider: Provider): void`,
  `hasProvider(providerId: string): boolean`, and `resolveModel("provider-id/model-id")` are
  declared at `node_modules/@flue/runtime/dist/sandbox-DDnz8bIa.d.mts:289-321` and exported through
  `@flue/runtime/internal` (`internal.d.mts:318`). The implementation at
  `node_modules/@flue/runtime/dist/providers-8VayQV37.mjs:21-25` delegates to Pi's mutable Models
  collection; the declaration documents replacement/upsert by provider ID at lines 296-300.
- Pi 0.83's `Provider` shape is `node_modules/@earendil-works/pi-ai/dist/models.d.ts:42-76`;
  `createProvider()` accepts `{ id, auth, models, api }` at lines 136-158. Models carry their own
  `provider` field (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:647-665`).
- [providers.ts:43-85](./providers.ts#L43-L85) is the minimal adapter: validate the Flary alias,
  clone models with the alias provider ID, wrap `stream` and `streamSimple`, merge the optional
  fetch, force `transport: "sse"` for Codex when a fetch is injected, and call Flue `setProvider()`.
- [providers.ts:90-122](./providers.ts#L90-L122) registers and resolves all four planned IDs:
  `anthropic`, `openai-codex`, `openai`, and `google`; the same alias is then replaced with a second
  provider to prove upsert behavior.
- The temporary Pi patch adds the six worker helpers in
  `patches/@earendil-works__pi-ai@0.83.0.patch:239-327`: `startAnthropicManualOAuth`,
  `completeAnthropicManualOAuth`, `startOpenAICodexDeviceAuthorization`,
  `pollOpenAICodexDeviceAuthorization`, `startOpenAICodexManualOAuth`, and
  `completeOpenAICodexManualOAuth`. Pi's installed declarations expose the same six functions at
  `node_modules/@earendil-works/pi-ai/dist/worker-oauth.d.ts`.
  [providers.ts:12-28](./providers.ts#L12-L28) imports/exports all six and
  [providers.ts:133-144](./providers.ts#L133-L144) verifies their presence.

### Incompatibilities and exact product contract

- The Flue registry is module-scoped and has no unregister; aliases must be unique per tenant/thread
  and may be replaced only deliberately. The adapter contract should remain
  `registerProviderAlias({ provider, providerAlias, ... }) -> { providerAlias, model(id) }`.
- Pi Codex's WebSocket path does not honor injected `fetch`; when a caller supplies `fetch`, the
  final adapter must force `transport: "sse"`. The artifact proves this policy, but no live Codex
  request was made.
- The six helpers are currently supplied by the temporary Pi patch. Before removing that patch, lane
  B must port them to a Flary-owned worker-safe module (Web Crypto plus `fetch`, with no Node
  callback-server imports) and export the exact six names plus `OAuthCredentials`.

## 3. Approvals (§3.3) — NEEDS-UPSTREAM

### What is proven

- Flue 2.1 does have the named type: `FlueExecutionOperation`, `FlueExecutionContext`, and
  `FlueExecutionInterceptor` are declared at
  `node_modules/@flue/runtime/dist/observation-DnfaXl2A.d.mts:16-64`. A tool operation has
  `{ type: "tool", toolCallId, toolName }`; context can carry `submissionId`, `conversationId`,
  `operationId`, and `turnId`.
- The installation API is `instrument({ observe, interceptor, dispose })`
  (`node_modules/@flue/runtime/dist/instrumentation-DOeU_zDN.d.mts:3-14`). Runtime registration is a
  process/isolate interceptor list (`node_modules/@flue/runtime/dist/errors-CsDcT_C4.mjs:16-42`),
  not a durable journal.
- [approvals.ts:30-84](./approvals.ts#L30-L84) is a type-correct interceptor that creates a stable
  `(submissionId, toolCallId)` row, throws a Flary-tagged `flary.approval.waiting` error before
  `next()`, and records the completed result. [approvals.ts:98-126](./approvals.ts#L98-L126)
  serializes that row, recreates it after simulated eviction, approves it, and proves a later
  re-dispatch runs the tool once and replays the committed result on duplicate delivery.

### Why this is not a Flue durability proof

- The actual Flue tool execution wraps the call in `interceptExecution(...)`
  (`node_modules/@flue/runtime/dist/conversation-stream-store-B2RVviYM.mjs:841-905`). The normal
  catch path records a generic tool error result and rethrows; there is no approval-specific durable
  settlement or resume token in this path.
- Flue does durably record normal tool outcomes (`attachment-store-BTESG7ao.d.mts:225-255`) and
  durable `step.do` memos (`attachment-store-BTESG7ao.d.mts:380-393`). Those records are not an
  approval-pending record and cannot by themselves identify an unexecuted, approved call to resume.
- Therefore the approval row and pending identity must live in a Flary-owned durable journal keyed
  at minimum by `submissionId`, `turnId`, `toolCallId`, tool name, and an arguments hash. The exact
  call must transition `waiting -> approved -> completed`, with first-write-wins result storage. The
  in-memory/JSON snapshot in the artifact proves the required state machine only; it does not claim
  Cloudflare eviction durability.

### Smallest upstream hook needed

Either (a) add a durable pre-tool admission/pause API that persists the operation identity and a
tagged `approval.waiting` settlement, then accepts `resume(submissionId, toolCallId, argsHash)` with
idempotent completion, or (b) add an equivalent Flary-owned append/resume hook immediately around
Flue's canonical tool-call/outcome commit. A plain interceptor that throws is insufficient. Phase 2
must not claim approvals until one of these hooks is available and exercised through a real
evict/re-dispatch test.

## 4. Rollback (§3.4) — NEEDS-UPSTREAM

### Evidence and fixture result

- Flue 2.1's installed implementation computes the path only from `conversation.activeLeafId`:
  `node_modules/@flue/runtime/dist/dispatch-Dohpn4Ea.mjs:698-713`. `buildConversationContextEntries`
  immediately consumes that path, applies compaction, and returns model context at lines 714-737.
  There is no target-entry/exclude-target option.
- The package's `@flue/runtime/internal` export list
  (`node_modules/@flue/runtime/dist/internal.d.mts:318`) does not expose `getActiveConversationPath`
  or `buildConversationContext`; [rollback.ts:71-73](./rollback.ts#L71-L73) checks that absence
  directly.
- [rollback.ts:17-69](./rollback.ts#L17-L69) mirrors the installed active-leaf traversal with a
  synthetic conversation. Appending a Flary rollback signal preserves the abandoned records in
  canonical storage and makes the marker/current tail part of the model path; it does not branch
  context to `a1`. The three dimensions are therefore distinct:
  - **Model context filtering:** fixed active-leaf traversal plus compaction; no store override.
  - **Canonical storage:** append-only records; old entries remain.
  - **Subsequent dispatch:** extends the current active leaf, not an arbitrary historical target.
- Flary's existing beta-only workaround is exactly the patch in
  `scripts/apply-flue2-session-patch.cjs:1-33` and the corresponding beta hunk at
  `patches/@flue__runtime-legacy@1.0.0-beta.9.patch:125-139`. It changes the context projection; it
  cannot be applied to Flue 2.1 because the implementation and record model changed.

### Smallest upstream hook needed

Expose a store-level fork/active-path operation that accepts `{ targetEntryId, excludeTarget }`,
appends an immutable marker, and makes the context builder use the selected path while preserving
canonical history. The operation must also define the parent for the next dispatch. Without that
hook, lane A1/D must not delete the postinstall patch or claim active-path rollback parity.

## 5. Legacy data (§3.5) — BLOCKED; mandatory 1.0.2 export sweep

### Fixture and evidence

- [legacy-data.ts:10-130](./legacy-data.ts#L10-L130) contains a representative beta.9 canonical
  stream: `conversation_created`, user message, assistant start/text delta/completion, and
  `submission_settled`, with the beta envelope fields (`v`, `id`, `conversationId`, `harness`,
  `session`, timestamps, parent/message IDs, turn/submission IDs).
- Beta's actual installed export API is `exportCanonical(turnId)` at
  `node_modules/@flue/runtime-legacy/dist/internal.mjs:903-917`. It flushes the beta stream and
  returns `{ format: "flue-canonical", version: 1, batches, throughTurnId }`.
- Beta import requires an empty target and strips `submissionId`/`attemptId`, skipping
  `submission_settled`, at `node_modules/@flue/runtime-legacy/dist/internal.mjs:919-934`. This is
  runtime-owned behavior, not a Flary-owned parser.
- Flary's current `migrateSessionEngine()` only calls the abstract source engine's `active()` and
  `export()`, verifies the archive hash, calls target `restore()`, and appends `runtime.migrated`
  (`src/harness/session/engine.ts:106-147`). There is no current source engine that reads beta
  SQLite/stream storage without loading beta runtime code.
- [legacy-data.ts:143-225](./legacy-data.ts#L143-L225) proves the generic migration seam works with
  a pre-exported, hash-verified archive and confirms no `@flue/runtime-legacy` module was loaded. It
  intentionally reports `existingThreadReader: "missing"`: the proof cannot turn the current
  abstract `source.export()` contract into a reader for an existing beta DO.

### Release-gate decision

**NO lazy 1.1.0 migration is safe today. Ship a mandatory 1.0.2 export-sweep release while beta.9
remains installed. Do not implement the sweep in this Phase 1 spike.**

The 1.0.2 sweep must, for every idle legacy thread:

1. Refuse export while any submission is unsettled, then call beta `exportCanonical()` and persist
   the complete ordered `flue-canonical` v1 batches, thread/agent identity, source revision, and a
   SHA-256 digest.
2. Preserve all canonical records needed to rebuild the conversation: creation, user/signal
   messages, assistant stream/message records, tool calls/outcomes/commits, compaction, child
   conversation creation/retention, rollback signals, turn IDs, and stable parent/message/record
   IDs. Skip only beta's operational `submission_settled` rows at import time, following the
   installed beta contract.
3. Copy attachment bytes plus attachment metadata/chunk identity for any image/content references;
   the canonical record archive alone is not enough for exact context restoration.
4. Write one immutable, retry-safe archive manifest per thread and a durable export marker. A retry
   must compare the source digest and never silently replace an archive.

The 1.1.0 lazy algorithm after `-legacy` dependencies are gone is then: read the immutable Flary
archive by thread ID; verify its digest; restore only into an empty Flue 2 stream; append an
idempotent migration marker; and serve the thread from Flue 2 thereafter. The invariant is **one
verified archive and one successful restore per legacy thread, with no live legacy runtime
dependency**.

## Unresolved risks and manual exercises

- Cloudflare edge construction, Durable Object boot, SQLite schema behavior, and a real
  `dispatch -> read/observe` round trip were not deployed or run. Rob must exercise these manually
  against a disposable Worker while checking generated bindings and the existing `flary-v1`
  migration.
- Codex OAuth device/manual flows and the forced SSE transport need a manual credentialed exercise;
  this spike only checks Pi 0.83 declarations and offline registration.
- Approval eviction remains unproven until the upstream durable hook or an equivalent Flary
  append/resume integration exists.
- The legacy export sweep must decide the exact attachment archive format and test beta records
  containing tool calls, compaction, child sessions, and rollback markers before 1.1.0.

## Recommended exact lane contracts

These contracts reflect the findings; they are not Phase 2 implementation approval.

- **A1 — session engine/ledger:** keep `migrateSessionEngine()` hash verification and Flue 2
  empty-target restore. Do not mark `flue-legacy` readable until 1.0.2 manifests exist. Treat
  rollback as blocked behind the active-path/fork hook; do not claim `activePathRollback` from an
  append-only marker alone.
- **A2 — Flue transport:** use the Flue 2 dispatch/observation seam and the generated worker
  config/internal builder; preserve `submissionId` and the existing Flary stream projection. No
  approval pause implementation in transport until the durable resume identity is available.
- **B — providers/Pi:** implement the artifact's `registerProviderAlias()` contract for `anthropic`,
  `openai-codex`, `openai`, and `google`; upsert through `setProvider`; force Codex SSE when `fetch`
  is supplied; port and export the six worker OAuth helpers before deleting the Pi patch.
- **C — app/authoring:** use Flue hooks/`instrument()` for ordinary authoring and telemetry wiring
  only. Do not expose a product approval guarantee from `FlueExecutionInterceptor` alone.
- **D — hosting/thread control:** the internal builder/name/tag seam is ready, but hold live
  migration until the legacy export sweep and approval/rollback decisions are resolved. Preserve
  `Flue<Name>Agent`, `FlueRegistry`, `FlaryRuntime`, `FlaryThreadControl`, and `FlaryWorkspace`
  names and `flary-v1`.
- **E — observability:** `observe()` plus `instrument()` is usable for non-durable
  observation/tracing. Document that subscribers do not replay history and are not an approval
  journal; do not couple telemetry to approval correctness.
- **F — storage/workspace:** independent of these five seams, but any archive/attachment
  implementation must provide immutable digest equality and scoped reads for the 1.0.2 export
  manifests.

## Final Phase 2 decision

**PHASE 2: NO-GO.** Hosting and providers are proven, but approvals and rollback require upstream
hooks, and the §3.5 release gate is blocked without a beta.9 export sweep. The next approved
milestone is a 1.0.2 export-sweep design/release while beta.9 is still installed, followed by
upstream hook resolution and a real Cloudflare/manual OAuth exercise. No product files were changed
by this spike.
