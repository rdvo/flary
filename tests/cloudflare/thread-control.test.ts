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

type TerminalOutcome = "completed" | "failed";

async function terminalReplayFixture(outcome: TerminalOutcome, suffix: string) {
  const controls = namespace();
  const tenantId = `tenant_terminal_${suffix}`;
  const threadId = `thread_terminal_${suffix}`;
  const admissionId = `terminal_${suffix}`;
  const submissionId = `submission_${suffix}`;
  let providerAdmissions = 0;
  const engine = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(request: Request) {
          if (request.method === "POST") {
            providerAdmissions += 1;
            return Response.json(
              {
                streamUrl: `https://flue.internal/agents/coder/retry_${suffix}`,
                offset: "0",
                submissionId: `retry_${suffix}`,
              },
              { status: 202 },
            );
          }
          const settled = {
            type: "submission-settled",
            position: { batch: 1, index: 0 },
            conversationId: threadId,
            submissionId,
            outcome,
            ...(outcome === "completed"
              ? { result: { text: "terminal result" } }
              : { error: { message: "terminal provider failure" } }),
          };
          return Response.json([settled], {
            headers: {
              "Stream-Next-Offset": "1",
              "Stream-Up-To-Date": "true",
              "Stream-Closed": "true",
            },
          });
        },
      };
    },
  };
  const env = { FLARY_THREAD_CONTROL: controls, FLUE_CODER_AGENT: engine };
  const service = createCloudflareThreadService({ env, namespace: controls });
  const scope = {
    authorization: {
      organizationId: tenantId,
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId,
    agentId: "coder",
    workspace: {
      organizationId: tenantId,
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    model: { provider: "openai", model: "gpt-5.6-luna" },
  });
  const storage = controls.stores.get(`thread:${tenantId}:coder:${threadId}`)!;
  const admission = {
    streamUrl: `https://flue.internal/agents/coder/terminal_${suffix}`,
    offset: "0",
    submissionId,
  };
  const admit = await handleFlaryThreadControlObjectRequest({
    storage,
    env,
    request: new Request("https://flary.internal/admit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "admitTurn",
        tenantId,
        applicationId: "coder",
        admissionId,
      }),
    }),
  });
  assert.equal(admit.ok, true, await admit.text());
  const background: Promise<unknown>[] = [];
  const tracked = await handleFlaryThreadControlObjectRequest({
    storage,
    env,
    execution: {
      waitUntil(work) {
        background.push(work);
      },
    },
    request: new Request("https://flary.internal/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "track",
        tenantId,
        applicationId: "coder",
        admission,
        admissionId,
        agentId: "coder",
        instanceId: `thread:${tenantId}:coder:${threadId}`,
      }),
    }),
  });
  assert.equal(tracked.ok, true, await tracked.text());
  await Promise.allSettled(background);
  const row = storage.sql
    .exec<{ value_json: string }>(
      "SELECT value_json FROM flary_thread_control WHERE key = ?",
      `projection:${submissionId}`,
    )
    .toArray()[0];
  assert.ok(row);
  const projection = JSON.parse(row.value_json) as Record<string, unknown>;
  assert.equal(projection.status, outcome);
  assert.equal(projection.admissionId, admissionId);
  return {
    controls,
    env,
    service,
    scope,
    target: { ...scope, threadId },
    storage,
    admission,
    admissionId,
    getProviderAdmissions: () => providerAdmissions,
  };
}

async function exportFenceFixture(suffix: string) {
  const controls = namespace();
  const service = createCloudflareThreadService({ env: {}, namespace: controls });
  const scope = {
    authorization: {
      organizationId: `tenant_fence_${suffix}`,
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: `thread_fence_${suffix}`,
    agentId: "coder",
    workspace: {
      organizationId: scope.authorization.organizationId,
      appId: scope.appId,
      projectId: "project",
      workspaceId: `workspace_${suffix}`,
      branch: "main",
    },
  });
  const rootThreadId = `thread_fence_${suffix}`;
  const rootName = `thread:${scope.authorization.organizationId}:${scope.appId}:${rootThreadId}`;
  const storage = controls.stores.get(rootName)!;
  const call = async (body: Record<string, unknown>, targetStorage = storage) => {
    const response = await handleFlaryThreadControlObjectRequest({
      storage: targetStorage,
      env: { FLARY_THREAD_CONTROL: controls },
      request: new Request("https://flary.internal/subagent-fence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId: scope.authorization.organizationId,
          applicationId: scope.appId,
          ...body,
        }),
      }),
    });
    const value = await response.json();
    return {
      ...(value && typeof value === "object" ? value : {}),
      ok: response.ok,
    } as Record<string, any>;
  };
  const spawned = await call({
    method: "subagent",
    action: "spawn",
    input: {
      requestId: `spawn_${suffix}`,
      parentThreadId: rootThreadId,
      agentId: "coder",
      task: "Review the change.",
      seedTurns: 0,
    },
  });
  const childId = String(spawned.thread.threadId);
  const admissionId = `subagent_${childId}`;
  await call({ method: "admitTurn", admissionId });
  return { controls, service, scope, storage, rootThreadId, childId, admissionId, call };
}

test("parent export stays blocked while a child is active and opens after completion", async () => {
  const fixture = await exportFenceFixture("complete");
  const blocked = await fixture.call({
    method: "legacyExportBegin",
    operationId: "export_active",
  });
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.error), /unsettled submission/i);

  await fixture.call({
    method: "subagent",
    action: "complete",
    input: {
      requestId: "complete_child",
      idempotencyKey: "complete_child",
      threadId: fixture.childId,
      output: { summary: "done" },
    },
  });
  const opened = await fixture.call({
    method: "legacyExportBegin",
    operationId: "export_after_complete",
  });
  assert.equal(opened.started, true);
});

test("parent export opens after terminal child failure or cancellation", async () => {
  for (const action of ["fail", "cancel"] as const) {
    const fixture = await exportFenceFixture(action);
    await fixture.call({
      method: "subagent",
      action,
      input: {
        requestId: `${action}_child`,
        idempotencyKey: `${action}_child`,
        threadId: fixture.childId,
        ...(action === "fail"
          ? { error: { code: "provider_failed", message: "provider failed", retryable: true } }
          : {}),
      },
    });
    const opened = await fixture.call({
      method: "legacyExportBegin",
      operationId: `export_after_${action}`,
    });
    assert.equal(opened.started, true);
  }
});

test("pre-acceptance child failure settles its parent fence", async () => {
  const controls = namespace();
  const engine = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(request: Request) {
          if (request.method === "POST") {
            return Response.json({ error: { message: "provider unavailable" } }, { status: 503 });
          }
          return Response.json([]);
        },
      };
    },
  };
  const env = { FLARY_THREAD_CONTROL: controls, FLUE_CODER_AGENT: engine };
  const service = createCloudflareThreadService({ env, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_fence_spawn_failure",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_fence_spawn_failure",
    agentId: "coder",
    workspace: {
      organizationId: scope.authorization.organizationId,
      appId: scope.appId,
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
  });
  const target = { ...scope, threadId: "thread_fence_spawn_failure" };
  await assert.rejects(
    service.subagentAction!(target, "spawn", {
      requestId: "spawn_provider_failure",
      parentThreadId: target.threadId,
      agentId: "coder",
      task: "This admission fails before active work.",
    }),
    /provider unavailable|direct submission failed/i,
  );
  const storage = controls.stores.get(
    "thread:tenant_fence_spawn_failure:coder:thread_fence_spawn_failure",
  )!;
  const opened = await handleFlaryThreadControlObjectRequest({
    storage,
    request: new Request("https://flary.internal/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "legacyExportBegin",
        tenantId: scope.authorization.organizationId,
        applicationId: scope.appId,
        operationId: "export_after_spawn_failure",
      }),
    }),
  });
  assert.equal(opened.ok, true, await opened.text());
});

test("post-acceptance bookkeeping failure keeps the parent fence active", async () => {
  const controls = namespace();
  const originalGet = controls.get;
  controls.get = (id: unknown) => {
    const stub = originalGet(id);
    return {
      async fetch(request: Request) {
        const body = (await request
          .clone()
          .json()
          .catch(() => ({}))) as Record<string, unknown>;
        if (body.method === "record") {
          return Response.json({ error: { message: "ledger unavailable" } }, { status: 503 });
        }
        return stub.fetch(request);
      },
    };
  };
  const engine = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(request: Request) {
          if (request.method !== "POST") return Response.json([]);
          return Response.json(
            {
              streamUrl: "https://flue.internal/accepted_submission",
              offset: "0",
              submissionId: "submission_post_acceptance",
            },
            { status: 202 },
          );
        },
      };
    },
  };
  const env = { FLARY_THREAD_CONTROL: controls, FLUE_CODER_AGENT: engine };
  const service = createCloudflareThreadService({ env, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_fence_post_acceptance",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_fence_post_acceptance",
    agentId: "coder",
    workspace: {
      organizationId: scope.authorization.organizationId,
      appId: scope.appId,
      projectId: "project",
      workspaceId: "workspace_post_acceptance",
      branch: "main",
    },
  });
  const target = { ...scope, threadId: "thread_fence_post_acceptance" };
  await assert.rejects(
    service.subagentAction!(target, "spawn", {
      requestId: "spawn_post_acceptance",
      parentThreadId: target.threadId,
      agentId: "coder",
      task: "Keep the accepted child fenced.",
      seedTurns: 0,
    }),
    /accepted the submission|ledger unavailable/i,
  );
  const storage = controls.stores.get(
    `thread:${scope.authorization.organizationId}:${scope.appId}:${target.threadId}`,
  )!;
  const blocked = await handleFlaryThreadControlObjectRequest({
    storage,
    request: new Request("https://flary.internal/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "legacyExportBegin",
        tenantId: scope.authorization.organizationId,
        applicationId: scope.appId,
        operationId: "export_while_post_acceptance_child_runs",
      }),
    }),
  });
  assert.equal(blocked.ok, false);
  const listed = await handleFlaryThreadControlObjectRequest({
    storage,
    request: new Request("https://flary.internal/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "subagent",
        action: "list",
        tenantId: scope.authorization.organizationId,
        applicationId: scope.appId,
      }),
    }),
  });
  const child = ((await listed.json()) as { threads: Array<{ threadId: string }> }).threads.find(
    (thread) => thread.threadId !== target.threadId,
  );
  assert.ok(child);
  const completed = await handleFlaryThreadControlObjectRequest({
    storage,
    request: new Request("https://flary.internal/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "subagent",
        action: "complete",
        tenantId: scope.authorization.organizationId,
        applicationId: scope.appId,
        input: {
          requestId: "complete_post_acceptance",
          idempotencyKey: "complete_post_acceptance",
          threadId: child!.threadId,
          output: { summary: "accepted child finished" },
        },
      }),
    }),
  });
  assert.equal(completed.ok, true, await completed.text());
  const opened = await handleFlaryThreadControlObjectRequest({
    storage,
    request: new Request("https://flary.internal/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "legacyExportBegin",
        tenantId: scope.authorization.organizationId,
        applicationId: scope.appId,
        operationId: "export_after_post_acceptance_completion",
      }),
    }),
  });
  assert.equal(opened.ok, true, await opened.text());
});

test("root start failure after acceptance keeps the child fence active", async () => {
  const controls = namespace();
  const originalGet = controls.get;
  controls.get = (id: unknown) => {
    const stub = originalGet(id);
    return {
      async fetch(request: Request) {
        const body = (await request
          .clone()
          .json()
          .catch(() => ({}))) as Record<string, unknown>;
        if (body.method === "subagent" && body.action === "start") {
          return Response.json({ error: { message: "coordinator unavailable" } }, { status: 503 });
        }
        return stub.fetch(request);
      },
    };
  };
  const engine = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(request: Request) {
          if (request.method !== "POST") return Response.json([]);
          return Response.json(
            {
              streamUrl: "https://flue.internal/accepted_start_failure",
              offset: "0",
              submissionId: "submission_start_failure",
            },
            { status: 202 },
          );
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
      organizationId: "tenant_fence_start_failure",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_fence_start_failure",
    agentId: "coder",
    workspace: {
      organizationId: scope.authorization.organizationId,
      appId: scope.appId,
      projectId: "project",
      workspaceId: "workspace_start_failure",
      branch: "main",
    },
  });
  const target = { ...scope, threadId: "thread_fence_start_failure" };
  await assert.rejects(
    service.subagentAction!(target, "spawn", {
      requestId: "spawn_start_failure",
      parentThreadId: target.threadId,
      agentId: "coder",
      task: "Keep the accepted child fenced.",
      seedTurns: 0,
    }),
    /coordinator unavailable/i,
  );
  const storage = controls.stores.get(
    `thread:${scope.authorization.organizationId}:${scope.appId}:${target.threadId}`,
  )!;
  const blocked = await handleFlaryThreadControlObjectRequest({
    storage,
    request: new Request("https://flary.internal/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "legacyExportBegin",
        tenantId: scope.authorization.organizationId,
        applicationId: scope.appId,
        operationId: "export_while_start_failure_child_runs",
      }),
    }),
  });
  assert.equal(blocked.ok, false);
  const listed = await handleFlaryThreadControlObjectRequest({
    storage,
    request: new Request("https://flary.internal/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "subagent",
        action: "list",
        tenantId: scope.authorization.organizationId,
        applicationId: scope.appId,
      }),
    }),
  });
  const child = ((await listed.json()) as { threads: Array<{ threadId: string }> }).threads.find(
    (thread) => thread.threadId !== target.threadId,
  );
  assert.ok(child);
  const completed = await handleFlaryThreadControlObjectRequest({
    storage,
    request: new Request("https://flary.internal/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "subagent",
        action: "complete",
        tenantId: scope.authorization.organizationId,
        applicationId: scope.appId,
        input: {
          requestId: "complete_start_failure",
          idempotencyKey: "complete_start_failure",
          threadId: child!.threadId,
          output: { summary: "accepted child finished" },
        },
      }),
    }),
  });
  assert.equal(completed.ok, true, await completed.text());
  const opened = await handleFlaryThreadControlObjectRequest({
    storage,
    request: new Request("https://flary.internal/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "legacyExportBegin",
        tenantId: scope.authorization.organizationId,
        applicationId: scope.appId,
        operationId: "export_after_start_failure_completion",
      }),
    }),
  });
  assert.equal(opened.ok, true, await opened.text());
});

test("normal nested child cancellation settles only the immediate parent's fence", async () => {
  const controls = namespace();
  let submission = 0;
  const engine = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(request: Request) {
          if (request.method !== "POST") return Response.json([]);
          submission += 1;
          return Response.json(
            {
              streamUrl: `https://flue.internal/submission_${submission}`,
              offset: "0",
              submissionId: `submission_nested_${submission}`,
            },
            { status: 202 },
          );
        },
      };
    },
  };
  const queued: unknown[] = [];
  const env = {
    FLARY_THREAD_CONTROL: controls,
    FLUE_CODER_AGENT: engine,
    FLARY_SESSION_PROJECTION_QUEUE: {
      async send(value: unknown) {
        queued.push(value);
      },
    },
  };
  const service = createCloudflareThreadService({ env, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_fence_nested_normal",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_fence_nested_normal",
    agentId: "coder",
    workspace: {
      organizationId: scope.authorization.organizationId,
      appId: scope.appId,
      projectId: "project",
      workspaceId: "workspace_nested_normal",
      branch: "main",
    },
  });
  const rootTarget = { ...scope, threadId: "thread_fence_nested_normal" };
  const parent = await service.subagentAction!(rootTarget, "spawn", {
    requestId: "spawn_parent_normal",
    parentThreadId: rootTarget.threadId,
    agentId: "coder",
    task: "Review the parent change.",
    seedTurns: 0,
  });
  const parentId = String(parent.thread.threadId);
  const parentTarget = { ...scope, threadId: parentId };
  const nested = await service.subagentAction!(parentTarget, "spawn", {
    requestId: "spawn_nested_normal",
    parentThreadId: parentId,
    agentId: "coder",
    task: "Review the nested change.",
    seedTurns: 0,
  });
  const nestedId = String(nested.thread.threadId);
  await service.subagentAction!(parentTarget, "cancel", {
    requestId: "cancel_nested_normal",
    idempotencyKey: "cancel_nested_normal",
    threadId: nestedId,
  });
  await service.subagentAction!(parentTarget, "close", {
    requestId: "close_nested_normal",
    idempotencyKey: "close_nested_normal",
    threadId: nestedId,
  });

  const parentStorage = controls.stores.get(
    `thread:${scope.authorization.organizationId}:${scope.appId}:${parentId}`,
  )!;
  const parentExport = await handleFlaryThreadControlObjectRequest({
    storage: parentStorage,
    request: new Request("https://flary.internal/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "legacyExportBegin",
        tenantId: scope.authorization.organizationId,
        applicationId: scope.appId,
        operationId: "parent_export_after_nested_cancel",
      }),
    }),
  });
  assert.equal(parentExport.ok, true, await parentExport.text());
  const rootStorage = controls.stores.get(
    `thread:${scope.authorization.organizationId}:${scope.appId}:${rootTarget.threadId}`,
  )!;
  const rootExport = await handleFlaryThreadControlObjectRequest({
    storage: rootStorage,
    request: new Request("https://flary.internal/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "legacyExportBegin",
        tenantId: scope.authorization.organizationId,
        applicationId: scope.appId,
        operationId: "root_export_still_blocked_by_parent",
      }),
    }),
  });
  assert.equal(rootExport.ok, false);
  assert.match(await rootExport.text(), /unsettled submission/i);
  assert.ok(queued.length > 0);
});

test("caller fence metadata cannot redirect terminal settlement", async () => {
  const fixture = await exportFenceFixture("spoofed_owner");
  const spawned = await fixture.call({
    method: "subagent",
    action: "spawn",
    input: {
      requestId: "spawn_spoofed_owner",
      parentThreadId: fixture.rootThreadId,
      agentId: "coder",
      task: "Ignore the spoofed owner.",
      seedTurns: 0,
      metadata: {
        flarySubagentParentExportFenceOwnerThreadId: "thread_attacker",
        flarySubagentParentExportFenceAdmissionId: "subagent_attacker",
        flarySubagentParentExportFenceAttemptToken: "attempt_attacker",
      },
    },
  });
  const spawnedChildId = String(spawned.thread.threadId);
  const spawnedAdmissionId = `subagent_${spawnedChildId}`;
  const metadata = spawned.thread.metadata as Record<string, unknown>;
  assert.equal(metadata.flarySubagentParentExportFenceOwnerThreadId, fixture.rootThreadId);
  assert.equal(metadata.flarySubagentParentExportFenceAdmissionId, spawnedAdmissionId);
  const attemptToken = String(metadata.flarySubagentParentExportFenceAttemptToken);
  await fixture.call({
    method: "admitTurn",
    admissionId: spawnedAdmissionId,
    subagentChildThreadId: spawnedChildId,
    subagentFenceAttemptToken: attemptToken,
  });
  await fixture.call({
    method: "subagent",
    action: "complete",
    input: {
      requestId: "complete_spoofed_owner",
      idempotencyKey: "complete_spoofed_owner",
      threadId: spawnedChildId,
      output: { summary: "done" },
    },
  });
  await fixture.call({
    method: "subagent",
    action: "complete",
    input: {
      requestId: "complete_fixture_child",
      idempotencyKey: "complete_fixture_child",
      threadId: fixture.childId,
      output: { summary: "done" },
    },
  });
  const opened = await fixture.call({
    method: "legacyExportBegin",
    operationId: "export_after_spoofed_owner",
  });
  assert.equal(opened.started, true);
  const attacker = fixture.controls.stores.get(
    `thread:${fixture.scope.authorization.organizationId}:${fixture.scope.appId}:thread_attacker`,
  );
  assert.equal(attacker, undefined);
});

test("duplicate and out-of-order terminal updates settle the same fence idempotently", async () => {
  const fixture = await exportFenceFixture("duplicate");
  await fixture.call({
    method: "subagent",
    action: "complete",
    input: {
      requestId: "complete_first",
      idempotencyKey: "complete_first",
      threadId: fixture.childId,
      output: { summary: "done" },
    },
  });
  await fixture.call({
    method: "subagent",
    action: "fail",
    input: {
      requestId: "fail_late",
      idempotencyKey: "fail_late",
      threadId: fixture.childId,
      error: { code: "late_failure", message: "late", retryable: true },
    },
  });
  const row = fixture.storage.sql
    .exec<{ settled_at: string | null }>(
      "SELECT settled_at FROM flary_legacy_export_submissions WHERE admission_id = ?",
      fixture.admissionId,
    )
    .toArray()[0];
  assert.ok(row?.settled_at);
});

test("out-of-order terminal notifications cannot settle a newer child attempt", async () => {
  const fixture = await exportFenceFixture("attempt_identity");
  const firstAttempt = "attempt_one";
  const secondAttempt = "attempt_two";
  await fixture.call({
    method: "admitTurn",
    admissionId: fixture.admissionId,
    subagentChildThreadId: fixture.childId,
    subagentFenceAttemptToken: firstAttempt,
  });
  await fixture.call({
    method: "legacyExportSubmissionSettle",
    admissionId: fixture.admissionId,
    subagentChildThreadId: fixture.childId,
    subagentFenceAttemptToken: firstAttempt,
    subagentSubmissionId: "submission_one",
  });
  await fixture.call({
    method: "admitTurn",
    admissionId: fixture.admissionId,
    subagentChildThreadId: fixture.childId,
    subagentFenceAttemptToken: secondAttempt,
  });
  await fixture.call({
    method: "legacyExportSubmissionSettle",
    admissionId: fixture.admissionId,
    subagentChildThreadId: fixture.childId,
    subagentFenceAttemptToken: firstAttempt,
    subagentSubmissionId: "submission_one",
  });
  const pending = fixture.storage.sql
    .exec<{ settled_at: string | null }>(
      "SELECT settled_at FROM flary_legacy_export_submissions WHERE admission_id = ?",
      fixture.admissionId,
    )
    .toArray()[0];
  assert.equal(pending?.settled_at, null);
  await fixture.call({
    method: "legacyExportSubmissionSettle",
    admissionId: fixture.admissionId,
    subagentChildThreadId: fixture.childId,
    subagentFenceAttemptToken: secondAttempt,
    subagentSubmissionId: "submission_two",
  });
  const settled = fixture.storage.sql
    .exec<{ settled_at: string | null }>(
      "SELECT settled_at FROM flary_legacy_export_submissions WHERE admission_id = ?",
      fixture.admissionId,
    )
    .toArray()[0];
  assert.ok(settled?.settled_at);
});

test("retrying a pre-acceptance spawn rechecks the parent export lease", async () => {
  const fixture = await exportFenceFixture("retry");
  await fixture.call({
    method: "subagent",
    action: "complete",
    input: {
      requestId: "complete_retry_fixture",
      idempotencyKey: "complete_retry_fixture",
      threadId: fixture.childId,
      output: { summary: "fixture complete" },
    },
  });
  const firstExport = await fixture.call({
    method: "legacyExportBegin",
    operationId: "export_blocks_first_admission",
  });
  assert.equal(firstExport.started, true);
  const blocked = await fixture.call({
    method: "admitTurn",
    admissionId: "pre_acceptance_retry",
  });
  assert.equal(blocked.ok, false);
  await fixture.call({
    method: "legacyExportRelease",
    operationId: "export_blocks_first_admission",
  });
  const admitted = await fixture.call({
    method: "admitTurn",
    admissionId: "pre_acceptance_retry",
  });
  assert.equal(admitted.admitted, true);
  const blockedByNewFence = await fixture.call({
    method: "legacyExportBegin",
    operationId: "export_after_retry_admission",
  });
  assert.equal(blockedByNewFence.ok, false);
  assert.match(String(blockedByNewFence.error), /unsettled submission/i);
});

test("terminal service admissions replay the stored receipt without sending", async () => {
  for (const outcome of ["completed", "failed"] as const) {
    const fixture = await terminalReplayFixture(outcome, `service_${outcome}`);
    const replay = await fixture.service.submit(fixture.target, {
      message: "must not be sent",
      idempotencyKey: fixture.admissionId,
    });
    assert.deepEqual(replay, fixture.admission);
    assert.equal(fixture.getProviderAdmissions(), 0);
  }
});

test("terminal direct realtime admissions replay without sending", async () => {
  for (const outcome of ["completed", "failed"] as const) {
    const fixture = await terminalReplayFixture(outcome, `realtime_direct_${outcome}`);
    const sent: Array<Record<string, unknown>> = [];
    let attachment: Record<string, unknown> = {
      tenantId: fixture.scope.authorization.organizationId,
      applicationId: "coder",
      threadId: fixture.target.threadId,
      includeChildren: false,
      actor: fixture.scope.authorization.actor,
      sent: 0,
      acknowledged: 0,
    };
    const socket = {
      send(value: string) {
        sent.push(JSON.parse(value));
      },
      close() {},
      serializeAttachment(value: unknown) {
        attachment = value as Record<string, unknown>;
      },
      deserializeAttachment() {
        return attachment;
      },
    };
    await handleFlaryThreadControlWebSocketMessage({
      storage: fixture.storage,
      env: fixture.env,
      socket,
      message: JSON.stringify({
        version: 1,
        type: "command",
        requestId: `request_${outcome}`,
        idempotencyKey: fixture.admissionId,
        command: "send",
        input: { message: "must not be sent" },
      }),
      execution: { waitUntil() {} },
    });
    assert.equal(fixture.getProviderAdmissions(), 0);
    assert.equal(sent.filter((frame) => frame.type === "error").length, 0);
    assert.ok(sent.some((frame) => frame.type === "result"));
  }
});

test("terminal queued realtime admissions replay without sending", async () => {
  for (const outcome of ["completed", "failed"] as const) {
    const fixture = await terminalReplayFixture(outcome, `realtime_queued_${outcome}`);
    const queued: unknown[] = [];
    const sent: Array<Record<string, unknown>> = [];
    let attachment: Record<string, unknown> = {
      tenantId: fixture.scope.authorization.organizationId,
      applicationId: "coder",
      threadId: fixture.target.threadId,
      includeChildren: false,
      actor: fixture.scope.authorization.actor,
      sent: 0,
      acknowledged: 0,
    };
    const socket = {
      send(value: string) {
        sent.push(JSON.parse(value));
      },
      close() {},
      serializeAttachment(value: unknown) {
        attachment = value as Record<string, unknown>;
      },
      deserializeAttachment() {
        return attachment;
      },
    };
    await handleFlaryThreadControlWebSocketMessage({
      storage: fixture.storage,
      env: {
        ...fixture.env,
        FLARY_SESSION_PROJECTION_QUEUE: {
          async send(value: unknown) {
            queued.push(value);
          },
        },
      },
      socket,
      message: JSON.stringify({
        version: 1,
        type: "command",
        requestId: `request_${outcome}`,
        idempotencyKey: fixture.admissionId,
        command: "send",
        input: { message: "must not be sent" },
      }),
    });
    assert.equal(queued.length, 1);
    let acknowledged = false;
    await handleFlarySessionProjectionQueue({
      env: fixture.env,
      messages: [
        {
          body: queued[0],
          ack() {
            acknowledged = true;
          },
          retry() {
            assert.fail("The terminal replay should not retry");
          },
        },
      ],
    });
    assert.equal(acknowledged, true);
    assert.equal(fixture.getProviderAdmissions(), 0);
    assert.ok(sent.some((frame) => frame.type === "accepted"));
  }
});

test("provider failures become short safe public messages", () => {
  assert.equal(
    publicAgentFailureMessage(
      new Error("direct failed: <html><body>Unable to load site</body></html> Ray ID: 123"),
    ),
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
  const archiveGate = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView) {
      await archiveGate;
      const bytes =
        value instanceof ArrayBuffer
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
      execution: {
        waitUntil: (work) => {
          background.push(work);
        },
      },
      request: new Request("https://flary.internal/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  assert.equal(
    (
      await call({
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
      })
    ).ok,
    true,
  );
  const instructions = "Organization: Secret Acme\nAPI key: never-public";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(instructions));
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
  const records = ((await recordsResponse.json()) as { records: any[] }).records;
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
  assert.equal(
    (await service.rename!(target, { title: "Rate limits" })).metadata?.title,
    "Rate limits",
  );
  await service.rollback!(target, { turnId: "turn_1" });
  const subagents = await service.subagentAction!(target, "list", {});
  assert.equal((subagents as { threads: unknown[] }).threads.length, 1);
  await service.scheduleAction!(target, "register", {
    id: "daily-review",
    message: "Review the repository.",
    trigger: { kind: "interval", intervalMs: 60_000 },
  });
  const schedules = await service.scheduleAction!(target, "list", {});
  assert.equal((schedules as { schedules: unknown[] }).schedules.length, 1);
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
  const storage = controls.stores.get("thread:tenant_delete:coder:thread_delete")!;
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
  const firstValue = (await first.json()) as { deletion: { id: string; status: string } };
  assert.equal(firstValue.deletion.id, "delete_1");
  assert.equal(firstValue.deletion.status, "accepted");

  const replay = await send({
    method: "beginDelete",
    tenantId: "tenant_delete",
    applicationId: "coder",
    deletionId: "delete_2",
    acceptedAt: "2026-08-06T00:01:00.000Z",
  });
  const replayValue = (await replay.json()) as { deletion: { id: string } };
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

  await service.purge!(
    {
      authorization: {
        organizationId: "tenant_erased",
        actor: { id: "system", kind: "system" },
      },
      appId: "coder",
      threadId: "thread_erased",
    },
    deletionId,
  );

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
  await assert.rejects(service.modelSet!(target, { model: "google/gemini" }), /not allowed/);
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
    idFromName(name: string) {
      return name;
    },
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
          return Response.json(
            {
              streamUrl: "https://flue.test/stream",
              offset: "0",
              submissionId: `submission_${sent.length}`,
            },
            { status: 202 },
          );
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

  await Promise.all(
    ["thread_a", "thread_b"].map((threadId) =>
      service.submit(
        { ...scope, threadId },
        {
          message: "Use my subscription.",
          idempotencyKey: `request_${threadId}`,
        },
      ),
    ),
  );

  assert.deepEqual(resolved.sort(), ["tenant_alias:thread_a", "tenant_alias:thread_b"]);
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
    idFromName(name: string) {
      return controls.idFromName(name);
    },
    get(id: unknown) {
      const delegate = controls.get(id);
      return {
        async fetch(request: Request) {
          const body = (await request
            .clone()
            .json()
            .catch(() => ({}))) as { method?: string };
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
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch() {
          return Response.json(
            {
              streamUrl: "https://flue.test/stream",
              offset: "0",
              submissionId: "submission_direct_projection",
            },
            { status: 202 },
          );
        },
      };
    },
  };
  const service = createCloudflareThreadService({
    env: {
      FLARY_THREAD_CONTROL: directNamespace,
      FLUE_CODER_AGENT: engine,
      FLARY_SESSION_PROJECTION_QUEUE: {
        async send() {
          queuedTracks += 1;
        },
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
  const control = controls.get(controls.idFromName("thread:tenant_fork:coder:thread_parent"));
  const recorded = await control.fetch(
    new Request("https://flary.internal/thread", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "record",
        tenantId: "tenant_fork",
        applicationId: "coder",
        recordType: "turn.completed",
        payload: { turnId: "turn_1" },
      }),
    }),
  );
  assert.equal(recorded.ok, true);
  const child = await service.fork(
    { ...scope, threadId: parent.thread.threadId },
    { threadId: "thread_child", turnId: "turn_1" },
  );
  assert.equal(child.workspace.branch, "main-fork-thread_child");
  assert.deepEqual(
    engineCalls.map(({ action }) => action),
    ["export", "import"],
  );
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
  const control = controls.get(controls.idFromName("thread:tenant_children:coder:thread_root"));
  const call = async (action: string, input: Record<string, unknown>) => {
    const response = await control.fetch(
      new Request("https://flary.internal/subagent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: "subagent",
          tenantId: "tenant_children",
          applicationId: "coder",
          action,
          input,
        }),
      }),
    );
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
  assert.equal(
    (
      await call("wait", {
        requestId: "wait_1",
        threadId: childId,
        threadIds: [childId],
      })
    ).threads[0].status,
    "queued",
  );
  assert.equal(
    (
      await call("start", {
        requestId: "start_1",
        idempotencyKey: "start_1",
        threadId: childId,
      })
    ).thread.status,
    "running",
  );
  assert.equal(
    (
      await call("wait", {
        requestId: "pause_1",
        idempotencyKey: "pause_1",
        threadId: childId,
      })
    ).thread.status,
    "waiting",
  );
  assert.equal(
    (
      await call("resume", {
        requestId: "resume_1",
        idempotencyKey: "resume_1",
        threadId: childId,
      })
    ).thread.status,
    "running",
  );
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
    idFromName(name: string) {
      return name;
    },
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
  const create = (threadId: string) =>
    service.create(scope, {
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
  const sourceControl = controls.get(
    controls.idFromName("thread:tenant_restore:coder:thread_source"),
  );
  await sourceControl.fetch(
    new Request("https://flary.internal/thread", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "record",
        tenantId: "tenant_restore",
        applicationId: "coder",
        recordType: "message.user",
        payload: { text: "hello" },
      }),
    }),
  );
  const archive = await service.exportSession!(source);
  assert.equal(archive.format, "flary-thread-archive");
  assert.deepEqual(archive.canonical, canonical);

  await create("thread_restored");
  const target = { ...scope, threadId: "thread_restored" };
  const result = await service.restore!(target, { archive, replace: true });
  assert.equal((result as { restored: boolean }).restored, true);
  const records = await service.auditList!(target, { after: 0, limit: 100 });
  assert.ok(
    records.some(
      (record: any) =>
        record.recordType === "message.user" &&
        record.publicPayload?._restoredFrom?.sessionId === "thread_source",
    ),
  );
  assert.deepEqual(
    engineCalls.map(({ action }) => action),
    ["export", "import"],
  );
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
  const control = controls.get(controls.idFromName("thread:tenant_limits:coder:thread_limits"));
  const usage = async (
    method: "reserveUsage" | "settleUsage" | "unknownUsage",
    reservationId: string,
  ) =>
    control.fetch(
      new Request("https://flary.internal/usage-reservation", {
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
      }),
    );
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
  const control = controls.get(controls.idFromName("thread:tenant_tools:coder:thread_tools"));
  const record = (state: "started" | "completed" | "failed", extra: Record<string, unknown> = {}) =>
    control.fetch(
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
  const records = await service.auditList!(
    { ...scope, threadId: "thread_tools" },
    {
      after: 0,
      limit: 100,
    },
  );
  const activities = records.filter(
    (item: any) => item.recordType === "tool.call" || item.recordType === "tool.result",
  );
  assert.equal(activities.length, 2);
  assert.equal((activities[0] as any).publicPayload.call.toolId, "stats");
  assert.deepEqual((activities[0] as any).publicPayload.call.arguments, { range: "7d" });
  assert.equal((activities[1] as any).publicPayload.result.status, "succeeded");
  assert.deepEqual((activities[1] as any).publicPayload.result.output, { total: 42 });

  assert.equal(
    (
      await record("failed", {
        toolCallId: "tool_call_2",
        outcome: "failed",
        error: "The analytics date range is invalid",
      })
    ).ok,
    true,
  );
  const failures = await service.auditList!(
    { ...scope, threadId: "thread_tools" },
    {
      after: 0,
      limit: 100,
    },
  );
  const failure = failures.find(
    (item: any) =>
      item.recordType === "tool.result" && item.publicPayload.result.callId === "tool_call_2",
  ) as any;
  assert.equal(failure.publicPayload.result.status, "failed");
  assert.equal(failure.publicPayload.result.error.message, "The analytics date range is invalid");
});

test("the Cloudflare thread host bridges durable interactive user input", async () => {
  const controls = namespace();
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  const runtime = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(request: Request) {
          const method = new URL(request.url).pathname.split("/").at(-1)!;
          const body = await request.json<Record<string, any>>();
          calls.push({ method, body });
          if (method === "listStoredUserInput") {
            return Response.json([
              {
                request: {
                  id: "input_1",
                  threadId: body.runId,
                  questions: [
                    {
                      header: "Delivery",
                      question: "When should we deliver?",
                      options: [{ label: "Tomorrow", description: "Recommended" }],
                      multiSelect: false,
                    },
                  ],
                  requestedBy: { id: "agent", kind: "agent" },
                  requestedAt: new Date(0).toISOString(),
                },
                response: null,
              },
            ]);
          }
          return Response.json({
            request: {
              id: "input_1",
              threadId: body.runId,
              questions: [
                {
                  header: "Delivery",
                  question: "When should we deliver?",
                  options: [{ label: "Tomorrow", description: "Recommended" }],
                  multiSelect: false,
                },
              ],
              requestedBy: { id: "agent", kind: "agent" },
              requestedAt: new Date(0).toISOString(),
            },
            response: {
              requestId: "input_1",
              answers: body.input.answers,
              canceled: false,
              answeredBy: body.answeredBy,
              answeredAt: new Date().toISOString(),
            },
          });
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
  const records = await service.auditList!(target, { after: 0, limit: 100 });
  const resolved = records.find((item) => item.recordType === "input.resolved");
  assert.equal(resolved?.publicPayload.requestId, "input_1");
  assert.deepEqual(resolved?.publicPayload.response, {
    requestId: "input_1",
    answers: { Delivery: "Tomorrow" },
    canceled: false,
    answeredBy: { id: "user_1", kind: "user" },
    answeredAt:
      resolved?.publicPayload.response &&
      (resolved.publicPayload.response as Record<string, unknown>).answeredAt,
  });
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
  const control = controls.get(controls.idFromName("thread:tenant_runtime:coder:thread_runtime"));
  const record = (activityId: string, recordType: string, payload: unknown) =>
    control.fetch(
      new Request("https://flary.internal/usage-reservation", {
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
      }),
    );

  assert.equal(
    (
      await record("exec:start", "codemode.started", {
        executionId: "exec_1",
        code: "return process.env.SECRET",
        codeBytes: 29,
        maxToolCalls: 20,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await record("exec:search:1", "tool.search", {
        executionId: "exec_1",
        query: "find analytics token=secret",
        resultIds: ["stats", "trend"],
        resultCount: 2,
        durationMs: 8.4,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await record("exec:describe:1", "tool.describe", {
        executionId: "exec_1",
        toolId: "stats",
        found: true,
        operation: "read",
        requiresApproval: false,
        schema: { secret: "must not persist" },
        schemaBytes: 512,
        durationMs: 2,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await record("exec:done", "codemode.completed", {
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
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await record("exec:done", "codemode.completed", {
        executionId: "exec_1",
        durationMs: 999,
      })
    ).ok,
    true,
  );

  const records = await service.auditList!(
    { ...scope, threadId: "thread_runtime" },
    {
      after: 0,
      limit: 100,
    },
  );
  const runtime = records.filter(
    (item: any) =>
      item.recordType.startsWith("codemode.") ||
      item.recordType === "tool.search" ||
      item.recordType === "tool.describe",
  ) as any[];
  assert.deepEqual(
    runtime.map((item) => item.recordType),
    ["codemode.started", "tool.search", "tool.describe", "codemode.completed"],
  );
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
  const storage = controls.stores.get("thread:tenant_realtime:coder:thread_realtime")!;
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
    send(value: string) {
      sent.push(JSON.parse(value));
    },
    close() {},
    serializeAttachment(value: unknown) {
      attachment = value as Record<string, unknown>;
    },
    deserializeAttachment() {
      return attachment;
    },
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
    env: {
      FLARY_SESSION_PROJECTION_QUEUE: {
        async send(value: unknown) {
          queued.push(value);
        },
      },
    },
    socket,
    message: frame,
  });
  await handleFlaryThreadControlWebSocketMessage({
    storage,
    env: {
      FLARY_SESSION_PROJECTION_QUEUE: {
        async send(value: unknown) {
          queued.push(value);
        },
      },
    },
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
    send(value: string) {
      sent.push(JSON.parse(value));
    },
    close() {},
    serializeAttachment(value: unknown) {
      attachment = value as Record<string, unknown>;
    },
    deserializeAttachment() {
      return attachment;
    },
  };
  let queued = 0;
  let providerAdmissions = 0;
  const engine = {
    idFromName(value: string) {
      return value;
    },
    get() {
      return {
        async fetch(request: Request) {
          providerAdmissions += 1;
          if (request.method !== "POST") {
            return Response.json(
              [
                {
                  type: "submission-settled",
                  position: { batch: 1, index: 0 },
                  conversationId: "thread_realtime_direct",
                  submissionId: "submission_realtime_direct",
                  outcome: "completed",
                  timestamp: new Date().toISOString(),
                },
              ],
              {
                headers: {
                  "Stream-Next-Offset": "1",
                  "Stream-Up-To-Date": "true",
                  "Stream-Closed": "true",
                },
              },
            );
          }
          return Response.json(
            {
              streamUrl: "https://flue.internal/agents/coder/thread_realtime_direct",
              offset: "0",
              submissionId: "submission_realtime_direct",
            },
            { status: 202 },
          );
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
      FLARY_SESSION_PROJECTION_QUEUE: {
        async send() {
          queued += 1;
        },
      },
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
    execution: {
      waitUntil(work) {
        background.push(work);
      },
    },
    webSockets: {
      acceptWebSocket() {},
      getWebSockets() {
        return [socket];
      },
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
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(request: Request) {
          const body = (await request.json()) as { model: string };
          sentModels.push(body.model);
          return Response.json(
            {
              streamUrl: "https://flue.test/stream",
              offset: "0",
              submissionId: "submission_realtime",
            },
            { status: 202 },
          );
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
    messages: [
      {
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
        ack() {
          acknowledged = true;
        },
        retry() {
          throw new Error("The realtime command was retried");
        },
      },
    ],
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
  const storage = controls.stores.get("thread:tenant_child_stream:coder:thread_root")!;
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
        send(value: string) {
          frames.push(JSON.parse(value));
        },
        close() {},
        serializeAttachment(value: unknown) {
          attachment = value as Record<string, unknown>;
        },
        deserializeAttachment() {
          return attachment;
        },
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
  assert.equal(
    withoutChildren.frames.some((frame) => frame.type === "events"),
    false,
  );
  assert.equal(withoutChildren.attachment().sent, events.cursor);
});

test("legacy export leases recover after expiry and release only their owner", async () => {
  const controls = namespace();
  const service = createCloudflareThreadService({ env: {}, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_export_lease",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_export_lease",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_export_lease",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
  });
  const control = controls.get(
    controls.idFromName("thread:tenant_export_lease:coder:thread_export_lease"),
  );
  const call = (body: Record<string, unknown>) =>
    control.fetch(
      new Request("https://flary.internal/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const first = await call({
    method: "legacyExportBegin",
    tenantId: "tenant_export_lease",
    applicationId: "coder",
    operationId: "owner_one",
  });
  const firstState = (await first.json()) as {
    leaseUntil: string;
    ownerToken: string;
  };
  assert.equal(firstState.ownerToken, "owner_one");
  assert.ok(Date.parse(firstState.leaseUntil) > Date.now());

  const storage = controls.stores.get("thread:tenant_export_lease:coder:thread_export_lease")!;
  storage.sql.exec(
    "UPDATE flary_thread_control SET value_json = ? WHERE key = ?",
    JSON.stringify({
      status: "active",
      operationId: "owner_one",
      ownerToken: "owner_one",
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      leaseUntil: new Date(Date.now() - 1_000).toISOString(),
    }),
    "legacy-export",
  );
  const recovered = await call({
    method: "legacyExportBegin",
    tenantId: "tenant_export_lease",
    applicationId: "coder",
    operationId: "owner_two",
  });
  assert.equal(recovered.ok, true);
  const recoveredState = (await (
    await call({
      method: "legacyExportState",
      tenantId: "tenant_export_lease",
      applicationId: "coder",
    })
  ).json()) as { state: { ownerToken: string } };
  assert.equal(recoveredState.state.ownerToken, "owner_two");

  await call({
    method: "legacyExportRelease",
    tenantId: "tenant_export_lease",
    applicationId: "coder",
    operationId: "owner_one",
    ownerToken: "owner_one",
  });
  const afterOldRelease = (await (
    await call({
      method: "legacyExportState",
      tenantId: "tenant_export_lease",
      applicationId: "coder",
    })
  ).json()) as { state: { ownerToken: string } };
  assert.equal(afterOldRelease.state.ownerToken, "owner_two");

  await call({
    method: "legacyExportRelease",
    tenantId: "tenant_export_lease",
    applicationId: "coder",
    operationId: "owner_two",
    ownerToken: "owner_two",
  });
  const released = (await (
    await call({
      method: "legacyExportState",
      tenantId: "tenant_export_lease",
      applicationId: "coder",
    })
  ).json()) as { state?: unknown };
  assert.equal(released.state, undefined);
});

test("legacy export fence rejects an unsettled admission and a held lease atomically", async () => {
  const controls = namespace();
  const service = createCloudflareThreadService({ env: {}, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_export_fence",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_export_fence",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_export_fence",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
  });
  const name = "thread:tenant_export_fence:coder:thread_export_fence";
  const control = controls.get(controls.idFromName(name));
  const call = (body: Record<string, unknown>) =>
    control.fetch(
      new Request("https://flary.internal/export-fence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const admitted = await call({
    method: "admitTurn",
    tenantId: "tenant_export_fence",
    applicationId: "coder",
    admissionId: "pending_submission",
  });
  assert.equal(admitted.ok, true);
  const blockedBySubmission = await call({
    method: "legacyExportBegin",
    tenantId: "tenant_export_fence",
    applicationId: "coder",
    operationId: "export_one",
  });
  assert.equal(blockedBySubmission.ok, false);
  assert.match(String((await blockedBySubmission.json()).error), /unsettled submission/i);

  const storage = controls.stores.get(name)!;
  storage.sql.exec(
    "UPDATE flary_legacy_export_submissions SET settled_at = ? WHERE admission_id = ?",
    new Date().toISOString(),
    "pending_submission",
  );
  const begun = await call({
    method: "legacyExportBegin",
    tenantId: "tenant_export_fence",
    applicationId: "coder",
    operationId: "export_one",
  });
  assert.equal(begun.ok, true);
  const blockedAdmission = await call({
    method: "admitTurn",
    tenantId: "tenant_export_fence",
    applicationId: "coder",
    admissionId: "new_submission",
  });
  assert.equal(blockedAdmission.ok, false);
  assert.match(String((await blockedAdmission.json()).error), /being exported/i);

  const replayDuringExport = await call({
    method: "admitTurn",
    tenantId: "tenant_export_fence",
    applicationId: "coder",
    admissionId: "pending_submission",
  });
  assert.equal(replayDuringExport.ok, false);
  assert.match(String((await replayDuringExport.json()).error), /being exported/i);
});

test("a failed service send cannot replay through an active export lease", async () => {
  const controls = namespace();
  let providerAdmissions = 0;
  const engine = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(request: Request) {
          if (request.method !== "POST") return Response.json([]);
          providerAdmissions += 1;
          return Response.json({ error: { message: "provider unavailable" } }, { status: 503 });
        },
      };
    },
  };
  const env = { FLARY_THREAD_CONTROL: controls, FLUE_CODER_AGENT: engine };
  const service = createCloudflareThreadService({ env, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_failed_retry",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  const binding = await service.create(scope, {
    threadId: "thread_failed_retry",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_failed_retry",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    model: { provider: "openai", model: "gpt-5.6-luna" },
  });
  const target = { ...scope, threadId: binding.thread.threadId };
  await assert.rejects(
    service.submit(target, { message: "hello", idempotencyKey: "failed_retry" }),
    /provider unavailable|direct submission failed/i,
  );
  const name = "thread:tenant_failed_retry:coder:thread_failed_retry";
  const control = controls.get(controls.idFromName(name));
  const begin = await control.fetch(
    new Request("https://flary.internal/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "legacyExportBegin",
        tenantId: "tenant_failed_retry",
        applicationId: "coder",
        operationId: "export_retry",
      }),
    }),
  );
  assert.equal(begin.ok, true, await begin.text());
  const replay = await control.fetch(
    new Request("https://flary.internal/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "admitTurn",
        tenantId: "tenant_failed_retry",
        applicationId: "coder",
        admissionId: "failed_retry",
      }),
    }),
  );
  assert.equal(replay.ok, false);
  assert.match(String((await replay.json()).error), /being exported/i);
  assert.equal(providerAdmissions, 1);
  const release = await control.fetch(
    new Request("https://flary.internal/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "legacyExportRelease",
        tenantId: "tenant_failed_retry",
        applicationId: "coder",
        operationId: "export_retry",
      }),
    }),
  );
  assert.equal(release.ok, true);
  await assert.rejects(
    service.submit(target, { message: "hello", idempotencyKey: "failed_retry" }),
    /provider unavailable|direct submission failed/i,
  );
  assert.equal(providerAdmissions, 2);
});

test("a failed realtime send rechecks the export lease before retrying", async () => {
  const controls = namespace();
  let providerAdmissions = 0;
  const engine = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(request: Request) {
          if (request.method !== "POST") return Response.json([]);
          providerAdmissions += 1;
          return Response.json({ error: { message: "provider unavailable" } }, { status: 503 });
        },
      };
    },
  };
  const env = { FLARY_THREAD_CONTROL: controls, FLUE_CODER_AGENT: engine };
  const service = createCloudflareThreadService({ env, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_realtime_retry",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  await service.create(scope, {
    threadId: "thread_realtime_retry",
    agentId: "coder",
    workspace: {
      organizationId: "tenant_realtime_retry",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
    model: { provider: "openai", model: "gpt-5.6-luna" },
  });
  const name = "thread:tenant_realtime_retry:coder:thread_realtime_retry";
  const storage = controls.stores.get(name)!;
  let attachment: Record<string, unknown> = {
    tenantId: "tenant_realtime_retry",
    applicationId: "coder",
    threadId: "thread_realtime_retry",
    includeChildren: false,
    actor: { id: "user", kind: "user" },
    sent: 0,
    acknowledged: 0,
  };
  const sent: Array<Record<string, unknown>> = [];
  const socket = {
    send(value: string) {
      sent.push(JSON.parse(value));
    },
    close() {},
    serializeAttachment(value: unknown) {
      attachment = value as Record<string, unknown>;
    },
    deserializeAttachment() {
      return attachment;
    },
  };
  const message = JSON.stringify({
    version: 1,
    type: "command",
    requestId: "request_retry",
    idempotencyKey: "realtime_retry",
    command: "send",
    input: { message: "hello" },
  });
  const execution = { waitUntil() {} };
  await handleFlaryThreadControlWebSocketMessage({
    storage,
    env,
    socket,
    message,
    execution,
  });
  const control = controls.get(controls.idFromName(name));
  const begin = await control.fetch(
    new Request("https://flary.internal/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "legacyExportBegin",
        tenantId: "tenant_realtime_retry",
        applicationId: "coder",
        operationId: "export_realtime_retry",
      }),
    }),
  );
  assert.equal(begin.ok, true, await begin.text());
  await handleFlaryThreadControlWebSocketMessage({
    storage,
    env,
    socket,
    message,
    execution,
  });
  assert.equal(providerAdmissions, 1);
  const release = await control.fetch(
    new Request("https://flary.internal/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "legacyExportRelease",
        tenantId: "tenant_realtime_retry",
        applicationId: "coder",
        operationId: "export_realtime_retry",
      }),
    }),
  );
  assert.equal(release.ok, true);
  await handleFlaryThreadControlWebSocketMessage({
    storage,
    env,
    socket,
    message,
    execution,
  });
  assert.equal(providerAdmissions, 2);
  assert.deepEqual(
    sent.filter((frame) => frame.type === "accepted").map((frame) => frame.duplicate),
    [false, true, true],
  );
  assert.equal(sent.filter((frame) => frame.type === "error").length, 3);
});

test("legacy export retry detects corrupt manifests and missing attachment objects", async () => {
  const controls = namespace();
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView) {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(
              value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
            );
      objects.set(key, bytes.slice());
    },
    async get(key: string) {
      const value = objects.get(key);
      return value ? { arrayBuffer: async () => value.slice().buffer } : null;
    },
  };
  const attachmentBytes = Uint8Array.of(1, 2, 3);
  const attachmentDigest = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
  const canonical = {
    format: "flue-canonical",
    version: 1,
    batches: [
      [
        {
          type: "attachment",
          attachment: {
            id: "image_1",
            mimeType: "image/png",
            size: attachmentBytes.length,
            digest: attachmentDigest,
          },
        },
      ],
    ],
  };
  const engine = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(request: Request) {
          const action = new URL(request.url).searchParams.get("flary");
          if (action === "export") return Response.json(canonical);
          if (action === "export-attachment") {
            return Response.json({
              attachment: {
                id: "image_1",
                mimeType: "image/png",
                size: attachmentBytes.length,
                digest: attachmentDigest,
                conversationId: "conversation_1",
                chunkCount: 1,
              },
              chunks: [{ chunkIndex: 0, base64: "AQID" }],
            });
          }
          return Response.json({ error: "unsupported" }, { status: 400 });
        },
      };
    },
  };
  const env = {
    FLUE_CODER_AGENT: engine,
    FLARY_SESSION_ARCHIVE: bucket,
    FLARY_SESSION_ARCHIVE_KEY: "p".repeat(48),
  };
  const service = createCloudflareThreadService({ env, namespace: controls });
  const scope = {
    authorization: {
      organizationId: "tenant_export_retry",
      actor: { id: "user", kind: "user" as const },
    },
    appId: "coder",
  };
  const target = { ...scope, threadId: "thread_export_retry" };
  await service.create(scope, {
    threadId: target.threadId,
    agentId: "coder",
    workspace: {
      organizationId: "tenant_export_retry",
      appId: "coder",
      projectId: "project",
      workspaceId: "workspace",
      branch: "main",
    },
  });
  const first = await service.legacyExport!(target);
  assert.equal(first.outcome, "exported");
  if (first.outcome !== "exported") return;
  const manifestObject = objects.get(first.manifest.storageKey)!.slice();
  objects.set(first.manifest.storageKey, Uint8Array.of(1, 2, 3));
  const corruptManifest = await service.legacyExport!(target);
  assert.equal(corruptManifest.outcome, "failed");
  assert.equal(corruptManifest.errorCode, "legacy_export_integrity");
  objects.set(first.manifest.storageKey, manifestObject);
  objects.delete(first.manifest.attachments[0].storageKey);
  const missingAttachment = await service.legacyExport!(target);
  assert.equal(missingAttachment.outcome, "failed");
  assert.equal(missingAttachment.errorCode, "legacy_export_missing_attachment");
});
