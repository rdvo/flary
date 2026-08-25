import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  createCloudflareThreadService,
  handleFlarySessionProjectionQueue,
  handleFlaryThreadControlObjectRequest,
  handleFlaryThreadControlWebSocketMessage,
  projectionNeedsRecovery,
  providerFailureFromFlueEvent,
  publicAgentFailureMessage,
} from "../../src/harness/cloudflare/thread-control.ts";
import { D1ThreadCatalog } from "../../src/harness/cloudflare/d1-thread-catalog.ts";

function namespace() {
  const stores = new Map<string, ReturnType<typeof sqlStorage>>();
  return {
    stores,
    idFromName(name: string) {
      return name;
    },
    get(id: unknown) {
      const name = String(id);
      let storage = stores.get(name);
      if (!storage) {
        storage = sqlStorage();
        stores.set(name, storage);
      }
      return {
        fetch(request: Request) {
          return handleFlaryThreadControlObjectRequest({ storage: storage!, request });
        },
      };
    },
  };
}

function sqlStorage() {
  const database = new DatabaseSync(":memory:");
  let transactionDepth = 0;
  return {
    sql: {
      exec<T>(query: string, ...bindings: unknown[]) {
        const trimmed = query.trim().toLowerCase();
        if (
          bindings.length === 0 &&
          !trimmed.startsWith("select") &&
          !trimmed.includes("returning")
        ) {
          database.exec(query);
          return { toArray: () => [] as T[] };
        }
        const statement = database.prepare(query);
        if (trimmed.startsWith("select") || trimmed.includes("returning")) {
          return { toArray: () => statement.all(...bindings) as T[] };
        }
        statement.run(...bindings);
        return { toArray: () => [] as T[] };
      },
      transactionSync<T>(closure: () => T): T {
        if (transactionDepth > 0) return closure();
        transactionDepth += 1;
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = closure();
          database.exec("COMMIT");
          return result;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        } finally {
          transactionDepth -= 1;
        }
      },
    },
  };
}

function d1Database() {
  const database = new DatabaseSync(":memory:");
  return {
    async exec(query: string) {
      database.exec(query);
      return {};
    },
    prepare(query: string) {
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async run() {
          database.prepare(query).run(...bindings);
          return {};
        },
        async all<T>() {
          return { results: database.prepare(query).all(...bindings) as T[] };
        },
        async first<T>() {
          return (database.prepare(query).get(...bindings) as T) ?? null;
        },
      };
    },
  };
}

test("provider failures become short safe public messages", () => {
  assert.equal(
    publicAgentFailureMessage(new Error("direct failed: <html><body>Unable to load site</body></html> Ray ID: 123")),
    "The provider blocked the request before generation started. Try another connection or provider.",
  );
  assert.equal(
    publicAgentFailureMessage(new Error("authorization=Bearer secret-value upstream timed out")),
    "authorization=<redacted> upstream timed out",
  );
  assert.equal(publicAgentFailureMessage(new Error("x".repeat(2_000))).length, 1_000);
});

test("only interrupted active projections resume after eviction", () => {
  assert.equal(projectionNeedsRecovery({ status: "active" }), true);
  assert.equal(projectionNeedsRecovery({ status: "completed" }), false);
  assert.equal(projectionNeedsRecovery({ status: "failed" }), false);
});

test("rendered prompts keep only safe metadata in the public ledger", async () => {
  const storage = sqlStorage();
  const objects = new Map<string, Uint8Array>();
  const background: Promise<unknown>[] = [];
  let releaseArchive!: () => void;
  const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView) {
      await archiveGate;
      const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(
            value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
          );
      objects.set(key, bytes);
    },
    async get(key: string) {
      const value = objects.get(key);
      return value ? { arrayBuffer: async () => value.slice().buffer } : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  const env = {
    FLARY_SESSION_ARCHIVE: bucket,
    FLARY_SESSION_ARCHIVE_KEY: "p".repeat(48),
  };
  const call = (body: Record<string, unknown>) =>
    handleFlaryThreadControlObjectRequest({
      storage,
      env,
      execution: { waitUntil: (work) => { background.push(work); } },
      request: new Request("https://flary.internal/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  assert.equal((await call({
    method: "initialize",
    tenantId: "tenant_prompt",
    applicationId: "app",
    binding: {
      thread: {
        organizationId: "tenant_prompt",
        appId: "app",
        agentId: "agent",
        threadId: "thread_prompt",
      },
      workspace: {
        organizationId: "tenant_prompt",
        appId: "app",
        projectId: "project",
        workspaceId: "workspace",
        branch: "main",
      },
      agentId: "agent",
      defaultMode: "ask",
      defaultThinkingLevel: "medium",
      connectionIds: [],
      createdBy: { id: "user", kind: "user" },
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })).ok, true);
  const instructions = "Organization: Secret Acme\nAPI key: never-public";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(instructions),
  );
  const promptHash = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const first = await call({
    method: "recordPromptSnapshot",
    tenantId: "tenant_prompt",
    applicationId: "app",
    promptHash,
    instructions,
    agentRevision: "agent-revision-1",
  });
  assert.equal(first.ok, true, await first.clone().text());
  assert.equal(objects.size, 0);
  releaseArchive();
  await Promise.all(background.splice(0));
  assert.equal(objects.size, 1);
  const replay = await call({
    method: "recordPromptSnapshot",
    tenantId: "tenant_prompt",
    applicationId: "app",
    promptHash,
    instructions,
  });
  assert.deepEqual(await replay.json(), {
    recorded: true,
    replay: true,
    promptHash,
  });
  assert.equal(objects.size, 1);

  const recordsResponse = await call({
    method: "records",
    tenantId: "tenant_prompt",
    applicationId: "app",
    after: 0,
    limit: 100,
  });
  const records = (await recordsResponse.json() as { records: any[] }).records;
  const snapshot = records.find((record) => record.recordType === "prompt.snapshot");
  assert.equal(snapshot.publicPayload.promptHash, promptHash);
  assert.equal(snapshot.publicPayload.archived, true);
  assert.equal(JSON.stringify(snapshot).includes("Secret Acme"), false);
  assert.equal(JSON.stringify(snapshot).includes("never-public"), false);
  assert.equal(snapshot.encryptedContentRef.mediaType, "application/vnd.flary.prompt+json");
});

test("Flue model-turn failures are retained when the direct result is empty", () => {
  assert.equal(
    providerFailureFromFlueEvent({
      type: "turn",
      response: {
        error: {
          type: "authentication_error",
          message: "The API key cannot use this model",
        },
      },
    }),
    "The API key cannot use this model",
  );
  assert.equal(
    providerFailureFromFlueEvent({
      type: "message-completed",
      message: { errorMessage: "The provider stream failed" },
    }),
    "The provider stream failed",
  );
  assert.equal(
    providerFailureFromFlueEvent({
      type: "assistant_message_completed",
      error: "The provider rejected the request",
    }),
    "The provider rejected the request",
  );
});

test("generated Thread Control keeps ownership and append-only controls", async () => {
  const service = createCloudflareThreadService({
    env: {},
    namespace: namespace(),
  });
  const scope = {
    authorization: {
      organizationId: "tenant",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  const binding = await service.create(scope, {
    threadId: "thread_1",
    agentId: "coder",
    workspace: {
      organizationId: "tenant",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "build",
    thinkingLevel: "high",
  });
  const target = { ...scope, threadId: binding.thread.threadId };

  assert.equal((await service.list(scope)).length, 1);
  assert.equal((await service.rename!(target, { title: "Rate limits" })).metadata?.title, "Rate limits");
  await service.rollback!(target, { turnId: "turn_1" });
  const subagents = await service.subagentAction!(target, "list", {});
  assert.equal((subagents as { threads: unknown[] }).threads.length, 1);
  await service.scheduleAction!(target, "register", {
    id: "daily-review",
    message: "Review the repository.",
    trigger: { kind: "interval", intervalMs: 60_000 },
  });
  const schedules = await service.scheduleAction!(target, "list", {});
  assert.equal(
    (schedules as { schedules: unknown[] }).schedules.length,
    1,
  );
  const records = await service.auditList!(target, { after: 0, limit: 100 });
  assert.ok(records.some((record: any) => record.recordType === "rollback"));

  await assert.rejects(
    service.inspect({
      ...target,
      authorization: {
        organizationId: "other",
        actor: { id: "user", kind: "user" },
      },
    }),
    /not found|does not belong/,
  );
});

test("thread deletion is idempotent and blocks new work", async () => {
  const controls = namespace();
  const service = createCloudflareThreadService({ env: {}, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_delete",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_delete",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_delete",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "build",
  });
  const storage = controls.stores.get(
    "thread:tenant_delete:coder:thread_delete",
  )!;
  const send = (body: Record<string, unknown>) =>
    handleFlaryThreadControlObjectRequest({
      storage,
      request: new Request("https://flary.internal/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  const first = await send({
    method: "beginDelete",
    tenantId: "tenant_delete",
    applicationId: "coder",
    deletionId: "delete_1",
    acceptedAt: "2026-08-06T00:00:00.000Z",
  });
  const firstValue = await first.json() as { deletion: { id: string; status: string } };
  assert.equal(firstValue.deletion.id, "delete_1");
  assert.equal(firstValue.deletion.status, "accepted");

  const replay = await send({
    method: "beginDelete",
    tenantId: "tenant_delete",
    applicationId: "coder",
    deletionId: "delete_2",
    acceptedAt: "2026-08-06T00:01:00.000Z",
  });
  const replayValue = await replay.json() as { deletion: { id: string } };
  assert.equal(replayValue.deletion.id, "delete_1");

  const blocked = await send({
    method: "record",
    tenantId: "tenant_delete",
    applicationId: "coder",
    recordType: "message.user",
    payload: { text: "must not be appended" },
  });
  assert.equal(blocked.ok, false);
});

test("purge recovery completes after Thread Control was already erased", async () => {
  const database = d1Database();
  const catalog = new D1ThreadCatalog(database);
  const deletionId = "delete_after_control_erased";
  await catalog.putDeletion({
    id: deletionId,
    threadId: "thread_erased",
    status: "accepted",
    acceptedAt: "2026-08-18T00:00:00.000Z",
    tenantId: "tenant_erased",
    applicationId: "coder",
  });
  const service = createCloudflareThreadService({
    env: { FLARY_THREAD_CATALOG: database },
    namespace: namespace(),
  });

  await service.purge!({
    authorization: {
      organizationId: "tenant_erased",
      actor: { id: "system", kind: "system" },
    },
    appId: "coder",
    threadId: "thread_erased",
  }, deletionId);

  const deletion = await catalog.getDeletion({
    tenantId: "tenant_erased",
    applicationId: "coder",
    deletionId,
  });
  assert.equal(deletion?.status, "complete");
  assert.ok(deletion?.completedAt);
});

test("thread model selection is durable, exact, and auditable", async () => {
  const service = createCloudflareThreadService({
    env: {},
    namespace: namespace(),
  });
  const scope = {
    authorization: {
      organizationId: "tenant_models",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  const binding = await service.create(scope, {
    threadId: "thread_models",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_models",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "build",
    model: { provider: "openai", model: "gpt-5" },
    thinkingLevel: "high",
    metadata: {
      flaryModelPolicy: {
        allow: [
          { provider: "openai", model: "gpt-5" },
          { provider: "anthropic", model: "claude-sonnet" },
        ],
        switching: "user",
        fallback: "none",
      },
    },
  });
  const target = { ...scope, threadId: binding.thread.threadId };
  assert.deepEqual(await service.modelGet!(target), {
    provider: "openai",
    model: "gpt-5",
  });
  assert.equal((await service.modelList!(target)).length, 2);
  await service.modelSet!(target, {
    model: "anthropic/claude-sonnet",
  });
  assert.deepEqual(await service.modelGet!(target), {
    provider: "anthropic",
    model: "claude-sonnet",
  });
  await assert.rejects(
    service.modelSet!(target, { model: "google/gemini" }),
    /not allowed/,
  );
  const history = await service.modelHistory!(target);
  assert.equal(history.length, 1);
  const records = await service.auditList!(target, { after: 0, limit: 100 });
  assert.ok(records.some((record: any) => record.recordType === "model.changed"));
  assert.ok(records.some((record: any) => record.recordType === "provider.cache_reset"));
  const archive = await service.auditExport!(target);
  const restored = await service.restore!(target, {
    jsonl: archive as string,
    replace: true,
  });
  assert.equal((restored as { restored: boolean }).restored, true);
  const child = await service.fork(target, { threadId: "thread_models_child" });
  const childRecords = await service.auditList!(
    { ...scope, threadId: child.thread.threadId },
    { after: 0, limit: 100 },
  );
  assert.ok(childRecords.some((record: any) => record.publicPayload?._forkedFrom));
});

test("trusted runtime model aliases and turn context are thread-unique and sent to Flue", async () => {
  const controls = namespace();
  const sent: Array<{ instance: string; model: string; turnContext?: string; body: string }> = [];
  const engine = {
    idFromName(name: string) { return name; },
    get(id: unknown) {
      return {
        async fetch(request: Request) {
          const body = await request.text();
          const parsed = JSON.parse(body) as { model: string; turnContext?: string };
          sent.push({
            instance: String(id),
            model: parsed.model,
            turnContext: parsed.turnContext,
            body,
          });
          return Response.json({
            streamUrl: "https://flue.test/stream",
            offset: "0",
            submissionId: `submission_${sent.length}`,
          }, { status: 202 });
        },
      };
    },
  };
  const resolved: string[] = [];
  const service = createCloudflareThreadService({
    env: {
      FLUE_CODER_AGENT: engine,
      FLARY_SESSION_PROJECTION_QUEUE: { async send() {} },
    },
    namespace: controls,
    resolveModel(input) {
      resolved.push(`${input.tenantId}:${input.threadId}`);
      return {
        runtimeSelection: {
          provider: `flary_${input.tenantId}_${input.threadId}`,
          model: input.selection.model,
        },
        connectionReference: `ref-${input.threadId}`,
        credentialGeneration: "generation-1",
        billingMode: "subscription",
      };
    },
    resolveTurnContext(input) {
      assert.equal(input.bindings.FLUE_CODER_AGENT, engine);
      return `Thread: ${input.threadId}\nUser: ${input.userId}`;
    },
  });
  const scope = {
    authorization: {
      organizationId: "tenant_alias",
      actor: { id: "user_alias", kind: "user" as const },
    },
    appId: "coder",
  };
  for (const threadId of ["thread_a", "thread_b"]) {
    await service.create(scope, {
      threadId,
      agentId: "coder",
      workspace: {
        organizationId: "tenant_alias",
        appId: "coder",
        projectId: "project",
        workspaceId: threadId,
        branch: "main",
      },
      mode: "build",
      model: { provider: "openai-codex", model: "gpt-5.6-luna" },
      metadata: {
        flaryModelPolicy: {
          allow: [{ provider: "openai-codex", model: "gpt-5.6-luna" }],
          switching: "user",
          fallback: "none",
        },
      },
    });
  }

  await Promise.all(["thread_a", "thread_b"].map((threadId) =>
    service.submit({ ...scope, threadId }, {
      message: "Use my subscription.",
      idempotencyKey: `request_${threadId}`,
    })
  ));

  assert.deepEqual(resolved.sort(), [
    "tenant_alias:thread_a",
    "tenant_alias:thread_b",
  ]);
  assert.equal(new Set(sent.map(({ model }) => model)).size, 2);
  assert.ok(sent.every(({ model }) => model.startsWith("flary_tenant_alias_thread_")));
  assert.deepEqual(sent.map(({ turnContext }) => turnContext).sort(), [
    "Thread: thread_a\nUser: user_alias",
    "Thread: thread_b\nUser: user_alias",
  ]);
  assert.ok(sent.every(({ body }) => !body.includes("secret")));
  for (const threadId of ["thread_a", "thread_b"]) {
    const records = await service.auditList!({ ...scope, threadId }, { after: 0, limit: 100 });
    const started = records.find((record: any) => record.recordType === "turn.started") as any;
    assert.equal(
      started.publicPayload.modelPin.runtimeSelection.provider,
      `flary_tenant_alias_${threadId}`,
    );
    assert.deepEqual(started.publicPayload.modelPin.selection, {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      cacheRetention: "short",
    });
    assert.equal(started.publicPayload.modelPin.provider, "openai-codex");
    assert.equal(started.publicPayload.modelPin.model, "gpt-5.6-luna");
    assert.equal(started.publicPayload.modelPin.connectionReference, `ref-${threadId}`);
  }
});

test("message admission starts projection directly and keeps the queue as fallback", async () => {
  const controls = namespace();
  let directTracks = 0;
  let queuedTracks = 0;
  const directNamespace = {
    stores: controls.stores,
    idFromName(name: string) { return controls.idFromName(name); },
    get(id: unknown) {
      const delegate = controls.get(id);
      return {
        async fetch(request: Request) {
          const body = await request.clone().json().catch(() => ({})) as { method?: string };
          if (body.method === "track") {
            directTracks += 1;
            return Response.json({ tracked: true });
          }
          return delegate.fetch(request);
        },
      };
    },
  };
  const engine = {
    idFromName(name: string) { return name; },
    get() {
      return {
        async fetch() {
          return Response.json({
            streamUrl: "https://flue.test/stream",
            offset: "0",
            submissionId: "submission_direct_projection",
          }, { status: 202 });
        },
      };
    },
  };
  const service = createCloudflareThreadService({
    env: {
      FLARY_THREAD_CONTROL: directNamespace,
      FLUE_CODER_AGENT: engine,
      FLARY_SESSION_PROJECTION_QUEUE: {
        async send() { queuedTracks += 1; },
      },
    },
    namespace: directNamespace,
  });
  const scope = {
    authorization: {
      organizationId: "tenant_direct_projection",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_direct_projection",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_direct_projection",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    model: { provider: "openai", model: "gpt-5.6-luna" },
  });

  await service.submit(
    { ...scope, threadId: "thread_direct_projection" },
    { message: "Hello", idempotencyKey: "direct_projection_1" },
  );

  assert.equal(directTracks, 1);
  assert.equal(queuedTracks, 0);
});

test("an exact fork imports the canonical model transcript", async () => {
  const controls = namespace();
  const engineCalls: Array<{ instance: string; action: string; body: any }> = [];
  const engine = {
    idFromName(name: string) {
      return name;
    },
    get(id: unknown) {
      return {
        async fetch(request: Request) {
          const action = new URL(request.url).searchParams.get("flary") ?? "";
          const body = await request.json().catch(() => ({}));
          engineCalls.push({ instance: String(id), action, body });
          if (action === "export") {
            return Response.json({
              format: "flue-canonical",
              version: 1,
              batches: [[{ type: "message", turnId: "turn_1" }]],
            });
          }
          if (action === "import") return Response.json({ imported: true });
          return Response.json({ error: "unsupported" }, { status: 400 });
        },
      };
    },
  };
  const service = createCloudflareThreadService({
    env: { FLUE_AGENT_CODER: engine },
    namespace: controls,
  });
  const scope = {
    authorization: {
      organizationId: "tenant_fork",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  const parent = await service.create(scope, {
    threadId: "thread_parent",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_fork",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "build",
  });
  const control = controls.get(controls.idFromName(
    "thread:tenant_fork:coder:thread_parent",
  ));
  const recorded = await control.fetch(new Request("https://flary.internal/thread", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "record",
      tenantId: "tenant_fork",
      applicationId: "coder",
      recordType: "turn.completed",
      payload: { turnId: "turn_1" },
    }),
  }));
  assert.equal(recorded.ok, true);
  const child = await service.fork(
    { ...scope, threadId: parent.thread.threadId },
    { threadId: "thread_child", turnId: "turn_1" },
  );
  assert.equal(child.workspace.branch, "main-fork-thread_child");
  assert.deepEqual(engineCalls.map(({ action }) => action), ["export", "import"]);
  assert.equal(engineCalls[0]?.body.turnId, "turn_1");
  assert.equal(engineCalls[1]?.body.turnId, "turn_1");
  assert.equal(engineCalls[1]?.body.archive.format, "flue-canonical");
});

test("durable child state accepts waits, resumes, and typed completion output", async () => {
  const controls = namespace();
  const service = createCloudflareThreadService({ env: {}, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_children",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  const binding = await service.create(scope, {
    threadId: "thread_root",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_children",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "build",
    metadata: {
      flaryDelegation: {
        mode: "auto",
        maxConcurrentChildren: 4,
        maxTotalChildren: 16,
        maxDepth: 2,
      },
    },
  });
  const control = controls.get(controls.idFromName(
    "thread:tenant_children:coder:thread_root",
  ));
  const call = async (action: string, input: Record<string, unknown>) => {
    const response = await control.fetch(new Request("https://flary.internal/subagent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "subagent",
        tenantId: "tenant_children",
        applicationId: "coder",
        action,
        input,
      }),
    }));
    if (!response.ok) assert.fail(await response.text());
    return response.json() as Promise<any>;
  };
  const spawned = await call("spawn", {
    requestId: "spawn_1",
    parentThreadId: binding.thread.threadId,
    agentId: "reviewer",
    task: "Review the change.",
    seedTurns: 0,
  });
  const childId = spawned.thread.threadId as string;
  assert.equal((await call("wait", {
    requestId: "wait_1",
    threadId: childId,
    threadIds: [childId],
  })).threads[0].status, "queued");
  assert.equal((await call("start", {
    requestId: "start_1",
    idempotencyKey: "start_1",
    threadId: childId,
  })).thread.status, "running");
  assert.equal((await call("wait", {
    requestId: "pause_1",
    idempotencyKey: "pause_1",
    threadId: childId,
  })).thread.status, "waiting");
  assert.equal((await call("resume", {
    requestId: "resume_1",
    idempotencyKey: "resume_1",
    threadId: childId,
  })).thread.status, "running");
  const output = {
    summary: "The review is complete.",
    changedFiles: [],
    checks: [],
    usage: {
      steps: 1,
      toolCalls: 0,
      tokens: 10,
      costUsd: 0.01,
      sandboxSeconds: 0,
      browserSeconds: 0,
    },
    errors: [],
  };
  const completed = await call("complete", {
    requestId: "complete_1",
    idempotencyKey: "complete_1",
    threadId: childId,
    output,
  });
  assert.equal(completed.thread.status, "completed");
  assert.deepEqual(completed.thread.output, output);
});

test("portable export restores canonical and public history into a new thread", async () => {
  const controls = namespace();
  const engineCalls: Array<{ instance: string; action: string; body: any }> = [];
  const canonical = {
    format: "flue-canonical",
    version: 1,
    batches: [[{ type: "message", turnId: "turn_1", text: "hello" }]],
  };
  const engine = {
    idFromName(name: string) { return name; },
    get(id: unknown) {
      return {
        async fetch(request: Request) {
          const action = new URL(request.url).searchParams.get("flary") ?? "";
          const body = await request.json().catch(() => ({}));
          engineCalls.push({ instance: String(id), action, body });
          if (action === "export") return Response.json(canonical);
          if (action === "import") return Response.json({ imported: true });
          return Response.json({ error: "unsupported" }, { status: 400 });
        },
      };
    },
  };
  const service = createCloudflareThreadService({
    env: { FLUE_AGENT_CODER: engine },
    namespace: controls,
  });
  const scope = {
    authorization: {
      organizationId: "tenant_restore",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  const create = (threadId: string) => service.create(scope, {
    threadId,
    agentId: "coder",
    workspace: {
      organizationId: "tenant_restore",
      appId: "coder",
      projectId: "project",
      workspaceId: threadId,
      branch: "main",
    },
    mode: "build",
  });
  await create("thread_source");
  const source = { ...scope, threadId: "thread_source" };
  const sourceControl = controls.get(controls.idFromName(
    "thread:tenant_restore:coder:thread_source",
  ));
  await sourceControl.fetch(new Request("https://flary.internal/thread", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "record",
      tenantId: "tenant_restore",
      applicationId: "coder",
      recordType: "message.user",
      payload: { text: "hello" },
    }),
  }));
  const archive = await service.exportSession!(source);
  assert.equal(archive.format, "flary-thread-archive");
  assert.deepEqual(archive.canonical, canonical);

  await create("thread_restored");
  const target = { ...scope, threadId: "thread_restored" };
  const result = await service.restore!(target, { archive, replace: true });
  assert.equal((result as { restored: boolean }).restored, true);
  const records = await service.auditList!(target, { after: 0, limit: 100 });
  assert.ok(records.some((record: any) =>
    record.recordType === "message.user" &&
    record.publicPayload?._restoredFrom?.sessionId === "thread_source"
  ));
  assert.deepEqual(engineCalls.map(({ action }) => action), ["export", "import"]);
  assert.deepEqual(engineCalls[1]?.body.archive, canonical);
});

test("root usage reservations reject excess work before it starts", async () => {
  const controls = namespace();
  const service = createCloudflareThreadService({ env: {}, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_limits",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_limits",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_limits",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "build",
    metadata: { flaryLimits: { toolCalls: 1 } },
  });
  const control = controls.get(controls.idFromName(
    "thread:tenant_limits:coder:thread_limits",
  ));
  const usage = async (
    method: "reserveUsage" | "settleUsage" | "unknownUsage",
    reservationId: string,
  ) => control.fetch(new Request("https://flary.internal/usage-reservation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method,
      tenantId: "tenant_limits",
      applicationId: "coder",
      reservationId,
      kind: "tool-call",
      delta: {
        steps: 0,
        toolCalls: 1,
        tokens: 0,
        costUsd: 0,
        sandboxSeconds: 0,
        browserSeconds: 0,
      },
    }),
  }));
  assert.equal((await usage("reserveUsage", "tool_1")).ok, true);
  const blocked = await usage("reserveUsage", "tool_2");
  assert.equal(blocked.ok, false);
  assert.match(await blocked.text(), /limit.*exceeded/i);
  assert.equal((await usage("unknownUsage", "tool_1")).ok, true);
  assert.equal((await usage("reserveUsage", "tool_3")).ok, false);
});

test("nested Code Mode tool activity is projected once for realtime clients", async () => {
  const controls = namespace();
  const service = createCloudflareThreadService({ env: {}, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_tools",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_tools",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_tools",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "build",
  });
  const control = controls.get(controls.idFromName(
    "thread:tenant_tools:coder:thread_tools",
  ));
  const record = (
    state: "started" | "completed" | "failed",
    extra: Record<string, unknown> = {},
  ) => control.fetch(
    new Request("https://flary.internal/usage-reservation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "recordToolActivity",
        tenantId: "tenant_tools",
        applicationId: "coder",
        state,
        toolCallId: "tool_call_1",
        toolId: "stats",
        ordinal: 1,
        inputSummary: { range: "7d" },
        ...extra,
      }),
    }),
  );

  assert.equal((await record("started")).ok, true);
  assert.equal((await record("started")).ok, true);
  assert.equal((await record("completed", { outputSummary: { total: 42 } })).ok, true);
  const records = await service.auditList!({ ...scope, threadId: "thread_tools" }, {
    after: 0,
    limit: 100,
  });
  const activities = records.filter((item: any) =>
    item.recordType === "tool.call" || item.recordType === "tool.result"
  );
  assert.equal(activities.length, 2);
  assert.equal((activities[0] as any).publicPayload.call.toolId, "stats");
  assert.deepEqual((activities[0] as any).publicPayload.call.arguments, { range: "7d" });
  assert.equal((activities[1] as any).publicPayload.result.status, "succeeded");
  assert.deepEqual((activities[1] as any).publicPayload.result.output, { total: 42 });

  assert.equal((await record("failed", {
    toolCallId: "tool_call_2",
    outcome: "failed",
    error: "The analytics date range is invalid",
  })).ok, true);
  const failures = await service.auditList!({ ...scope, threadId: "thread_tools" }, {
    after: 0,
    limit: 100,
  });
  const failure = failures.find((item: any) =>
    item.recordType === "tool.result" &&
    item.publicPayload.result.callId === "tool_call_2"
  ) as any;
  assert.equal(failure.publicPayload.result.status, "failed");
  assert.equal(
    failure.publicPayload.result.error.message,
    "The analytics date range is invalid",
  );
});

test("the Cloudflare thread host bridges durable interactive user input", async () => {
  const controls = namespace();
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  const runtime = {
    idFromName(name: string) { return name; },
    get() {
      return {
        async fetch(request: Request) {
          const method = new URL(request.url).pathname.split("/").at(-1)!;
          const body = await request.json<Record<string, any>>();
          calls.push({ method, body });
          if (method === "listStoredUserInput") {
            return Response.json([{
              request: {
                id: "input_1",
                threadId: body.runId,
                questions: [{
                  header: "Delivery",
                  question: "When should we deliver?",
                  options: [{ label: "Tomorrow", description: "Recommended" }],
                  multiSelect: false,
                }],
                requestedBy: { id: "agent", kind: "agent" },
                requestedAt: new Date(0).toISOString(),
              },
              response: null,
            }]);
          }
          return Response.json({ request: {}, response: body.input });
        },
      };
    },
  };
  const service = createCloudflareThreadService({
    env: {
      FLARY_RUN_SERVICE: runtime,
      FLARY_INTERNAL_TOKEN: "t".repeat(32),
    },
    namespace: controls,
  });
  const scope = {
    authorization: {
      organizationId: "tenant_input",
      actor: { id: "user_1", kind: "user" as const },
    },
    appId: "concierge",
  };
  await service.create(scope, {
    threadId: "thread_input",
    agentId: "concierge",
    workspace: {
      organizationId: "tenant_input",
      appId: "concierge",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "ask",
  });
  const target = { ...scope, threadId: "thread_input" };
  const requests = await service.listUserInput!(target);
  assert.equal(requests[0]?.request.id, "input_1");
  await service.respondToUserInput!(target, "input_1", {
    answers: { Delivery: "Tomorrow" },
  });
  assert.equal(calls[0]?.method, "listStoredUserInput");
  assert.equal(calls[0]?.body.runId, "tenant_input:concierge:concierge:thread_input");
  assert.equal(calls[1]?.method, "respondToStoredUserInput");
  assert.deepEqual(calls[1]?.body.answeredBy, { id: "user_1", kind: "user" });
});

test("lazy catalog and Code Mode lifecycle events are durable and safe", async () => {
  const controls = namespace();
  const service = createCloudflareThreadService({ env: {}, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_runtime",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_runtime",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_runtime",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "build",
  });
  const control = controls.get(controls.idFromName(
    "thread:tenant_runtime:coder:thread_runtime",
  ));
  const record = (activityId: string, recordType: string, payload: unknown) =>
    control.fetch(new Request("https://flary.internal/usage-reservation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "recordRuntimeActivity",
        tenantId: "tenant_runtime",
        applicationId: "coder",
        activityId,
        recordType,
        payload,
      }),
    }));

  assert.equal((await record("exec:start", "codemode.started", {
    executionId: "exec_1",
    code: "return process.env.SECRET",
    codeBytes: 29,
    maxToolCalls: 20,
  })).ok, true);
  assert.equal((await record("exec:search:1", "tool.search", {
    executionId: "exec_1",
    query: "find analytics token=secret",
    resultIds: ["stats", "trend"],
    resultCount: 2,
    durationMs: 8.4,
  })).ok, true);
  assert.equal((await record("exec:describe:1", "tool.describe", {
    executionId: "exec_1",
    toolId: "stats",
    found: true,
    operation: "read",
    requiresApproval: false,
    schema: { secret: "must not persist" },
    schemaBytes: 512,
    durationMs: 2,
  })).ok, true);
  assert.equal((await record("exec:done", "codemode.completed", {
    executionId: "exec_1",
    durationMs: 15,
    usage: {
      toolCalls: 1,
      searches: 1,
      describes: 1,
      batches: 0,
      codeBytes: 29,
      resultBytes: 32,
    },
  })).ok, true);
  assert.equal((await record("exec:done", "codemode.completed", {
    executionId: "exec_1",
    durationMs: 999,
  })).ok, true);

  const records = await service.auditList!({ ...scope, threadId: "thread_runtime" }, {
    after: 0,
    limit: 100,
  });
  const runtime = records.filter((item: any) =>
    item.recordType.startsWith("codemode.") ||
    item.recordType === "tool.search" ||
    item.recordType === "tool.describe"
  ) as any[];
  assert.deepEqual(runtime.map((item) => item.recordType), [
    "codemode.started",
    "tool.search",
    "tool.describe",
    "codemode.completed",
  ]);
  assert.equal(runtime[0].publicPayload.code, undefined);
  assert.equal(runtime[1].publicPayload.query, "find analytics token=<redacted>");
  assert.equal(runtime[1].publicPayload.resultCount, 2);
  assert.deepEqual(runtime[1].publicPayload.resultIds, ["stats", "trend"]);
  assert.equal(runtime[2].publicPayload.schema, undefined);
  assert.equal(runtime[2].publicPayload.schemaBytes, 512);
  assert.equal(runtime[3].publicPayload.durationMs, 15);
  assert.deepEqual(runtime[3].publicPayload.usage, {
    toolCalls: 1,
    searches: 1,
    describes: 1,
    batches: 0,
    codeBytes: 29,
    resultBytes: 32,
  });
});

test("hibernating realtime commands resume from socket attachments and deduplicate", async () => {
  const controls = namespace();
  const service = createCloudflareThreadService({ env: {}, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_realtime",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_realtime",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_realtime",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "build",
  });
  const storage = controls.stores.get(
    "thread:tenant_realtime:coder:thread_realtime",
  )!;
  const sent: any[] = [];
  let attachment: Record<string, unknown> = {
    tenantId: "tenant_realtime",
    applicationId: "coder",
    threadId: "thread_realtime",
    includeChildren: true,
    actor: { id: "user", kind: "user" },
    sent: 4,
    acknowledged: 4,
  };
  const socket = {
    send(value: string) { sent.push(JSON.parse(value)); },
    close() {},
    serializeAttachment(value: unknown) {
      attachment = value as Record<string, unknown>;
    },
    deserializeAttachment() { return attachment; },
  };
  const queued: unknown[] = [];
  const frame = JSON.stringify({
    version: 1,
    type: "command",
    requestId: "request_1",
    idempotencyKey: "command_1",
    command: "send",
    input: { message: "Continue." },
  });

  await handleFlaryThreadControlWebSocketMessage({
    storage,
    env: { FLARY_SESSION_PROJECTION_QUEUE: { async send(value: unknown) { queued.push(value); } } },
    socket,
    message: frame,
  });
  await handleFlaryThreadControlWebSocketMessage({
    storage,
    env: { FLARY_SESSION_PROJECTION_QUEUE: { async send(value: unknown) { queued.push(value); } } },
    socket,
    message: frame,
  });
  await handleFlaryThreadControlWebSocketMessage({
    storage,
    env: {},
    socket,
    message: JSON.stringify({ version: 1, type: "ack", cursor: 9 }),
  });

  assert.equal(queued.length, 1);
  assert.deepEqual(
    sent.filter((value) => value.type === "accepted").map((value) => value.duplicate),
    [false, true],
  );
  assert.equal(attachment.acknowledged, 9);
  assert.equal(attachment.sent, 4);
});

test("plain realtime messages bypass the Queue when the generated host is available", async () => {
  const controls = namespace();
  const service = createCloudflareThreadService({ env: {}, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_realtime_direct",
      actor: { id: "user_direct", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_realtime_direct",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_realtime_direct",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    model: { provider: "openai", model: "gpt-5.6-luna" },
  });
  const name = "thread:tenant_realtime_direct:coder:thread_realtime_direct";
  const storage = controls.stores.get(name)!;
  let attachment: Record<string, unknown> = {
    tenantId: "tenant_realtime_direct",
    applicationId: "coder",
    threadId: "thread_realtime_direct",
    includeChildren: false,
    actor: { id: "user_direct", kind: "user" },
    sent: 0,
    acknowledged: 0,
  };
  const sent: Array<Record<string, unknown>> = [];
  const socket = {
    send(value: string) { sent.push(JSON.parse(value)); },
    close() {},
    serializeAttachment(value: unknown) { attachment = value as Record<string, unknown>; },
    deserializeAttachment() { return attachment; },
  };
  let queued = 0;
  let providerAdmissions = 0;
  const engine = {
    idFromName(value: string) { return value; },
    get() {
      return {
        async fetch(request: Request) {
          providerAdmissions += 1;
          if (request.method !== "POST") {
            return Response.json([{
              type: "submission-settled",
              position: { batch: 1, index: 0 },
              conversationId: "thread_realtime_direct",
              submissionId: "submission_realtime_direct",
              outcome: "completed",
              timestamp: new Date().toISOString(),
            }], {
              headers: {
                "Stream-Next-Offset": "1",
                "Stream-Up-To-Date": "true",
                "Stream-Closed": "true",
              },
            });
          }
          return Response.json({
            streamUrl: "https://flue.internal/agents/coder/thread_realtime_direct",
            offset: "0",
            submissionId: "submission_realtime_direct",
          }, { status: 202 });
        },
      };
    },
  };
  const background: Promise<unknown>[] = [];
  await handleFlaryThreadControlWebSocketMessage({
    storage,
    env: {
      FLARY_THREAD_CONTROL: controls,
      FLUE_CODER_AGENT: engine,
      FLARY_SESSION_PROJECTION_QUEUE: { async send() { queued += 1; } },
    },
    socket,
    message: JSON.stringify({
      version: 1,
      type: "command",
      requestId: "request_direct",
      idempotencyKey: "command_direct",
      command: "send",
      input: { message: "Hello" },
    }),
    execution: { waitUntil(work) { background.push(work); } },
    webSockets: {
      acceptWebSocket() {},
      getWebSockets() { return [socket]; },
    },
  });

  assert.equal(queued, 0);
  assert.ok(providerAdmissions >= 1);
  assert.ok(sent.some((frame) => frame.type === "accepted"));
  assert.ok(sent.some((frame) => frame.type === "result"));
  await Promise.allSettled(background);
});

test("queued realtime commands keep the trusted model resolver", async () => {
  const controls = namespace();
  const sentModels: string[] = [];
  const engine = {
    idFromName(name: string) { return name; },
    get() {
      return {
        async fetch(request: Request) {
          const body = await request.json() as { model: string };
          sentModels.push(body.model);
          return Response.json({
            streamUrl: "https://flue.test/stream",
            offset: "0",
            submissionId: "submission_realtime",
          }, { status: 202 });
        },
      };
    },
  };
  const env = {
    FLARY_THREAD_CONTROL: controls,
    FLUE_CODER_AGENT: engine,
    FLARY_SESSION_PROJECTION_QUEUE: { async send() {} },
  };
  const service = createCloudflareThreadService({ env, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_realtime_alias",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_realtime_alias",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_realtime_alias",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    model: { provider: "openai-codex", model: "gpt-5.6-luna" },
    metadata: {
      flaryModelPolicy: {
        allow: [{ provider: "openai-codex", model: "gpt-5.6-luna" }],
        switching: "user",
        fallback: "none",
      },
    },
  });
  let acknowledged = false;
  await handleFlarySessionProjectionQueue({
    env,
    resolveModel(input) {
      return {
        runtimeSelection: { provider: "trusted-thread-alias", model: input.selection.model },
      };
    },
    messages: [{
      body: {
        kind: "realtime.command",
        controlName: "thread:tenant_realtime_alias:coder:thread_realtime_alias",
        target: { ...scope, threadId: "thread_realtime_alias" },
        frame: {
          version: 1,
          type: "command",
          requestId: "request_realtime_alias",
          idempotencyKey: "request_realtime_alias",
          command: "send",
          input: { message: "Continue." },
        },
      },
      ack() { acknowledged = true; },
      retry() { throw new Error("The realtime command was retried"); },
    }],
  });
  assert.equal(acknowledged, true);
  assert.deepEqual(sentModels, ["trusted-thread-alias/gpt-5.6-luna"]);
});

test("root realtime replay includes child events only when requested", async () => {
  const controls = namespace();
  const service = createCloudflareThreadService({ env: {}, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_child_stream",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_root",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_child_stream",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    mode: "build",
  });
  const storage = controls.stores.get(
    "thread:tenant_child_stream:coder:thread_root",
  )!;
  const makeSocket = (includeChildren: boolean) => {
    const frames: any[] = [];
    let attachment: Record<string, unknown> = {
      tenantId: "tenant_child_stream",
      applicationId: "coder",
      threadId: "thread_root",
      includeChildren,
      actor: { id: "user", kind: "user" },
      sent: 1,
      acknowledged: 1,
    };
    return {
      frames,
      socket: {
        send(value: string) { frames.push(JSON.parse(value)); },
        close() {},
        serializeAttachment(value: unknown) {
          attachment = value as Record<string, unknown>;
        },
        deserializeAttachment() { return attachment; },
      },
      attachment: () => attachment,
    };
  };
  const withChildren = makeSocket(true);
  const withoutChildren = makeSocket(false);
  const response = await handleFlaryThreadControlObjectRequest({
    storage,
    webSockets: {
      acceptWebSocket() {},
      getWebSockets: () => [withChildren.socket, withoutChildren.socket],
    },
    request: new Request("https://flary.internal/project-child", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "projectChild",
        tenantId: "tenant_child_stream",
        applicationId: "coder",
        childThreadId: "thread_reviewer",
        childAgentId: "reviewer",
        sourceCursor: "child:thread_reviewer:event:1",
        recordType: "message.assistant",
        recordedAt: new Date().toISOString(),
        attempt: 0,
        sourceRevision: "test",
        payload: { text: "Review complete" },
      }),
    }),
  });

  assert.equal(response.ok, true);
  const events = withChildren.frames.find((frame) => frame.type === "events");
  assert.equal(events.records[0].publicPayload._child.threadId, "thread_reviewer");
  assert.equal(withoutChildren.frames.some((frame) => frame.type === "events"), false);
  assert.equal(withoutChildren.attachment().sent, events.cursor);
});
