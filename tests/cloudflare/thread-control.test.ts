import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  createCloudflareThreadService,
  handleFlarySessionProjectionQueue,
  handleFlaryThreadControlObjectRequest,
  handleFlaryThreadControlWebSocketMessage,
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

test("trusted runtime model aliases are thread-unique, pinned, and sent to Flue", async () => {
  const controls = namespace();
  const sent: Array<{ instance: string; model: string; body: string }> = [];
  const engine = {
    idFromName(name: string) { return name; },
    get(id: unknown) {
      return {
        async fetch(request: Request) {
          const body = await request.text();
          const parsed = JSON.parse(body) as { model: string };
          sent.push({ instance: String(id), model: parsed.model, body });
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
