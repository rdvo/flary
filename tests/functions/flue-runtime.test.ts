import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  InMemoryFlaryRunRepository,
  createFlueRunService,
  type FlueAgentGateway,
} from "../../src/harness/flue/service.ts";
import {
  defineFlaryFunctionAgent,
  defineFlaryFunctionWorkflow,
  defineFlaryInteractiveAgent,
  flary,
} from "../../src/harness/functions/index.ts";

const identity = {
  tenantId: "tenant_1",
  userId: "user_1",
  applicationId: "test_app",
  roles: ["owner"],
  scopes: ["functions.run"],
} as const;

test("prompt functions use Flue admission and pin their immutable revision", async () => {
  const repository = new InMemoryFlaryRunRepository();
  const sent: string[] = [];
  const gateway: FlueAgentGateway = {
    async send(_agent, _instance, message) {
      sent.push(message);
      return {
        streamUrl: "https://example.com/stream",
        offset: "0",
        submissionId: `submission_${sent.length}`,
      };
    },
    async wait() {
      return { answer: "Use the billing page." };
    },
    async abort() {
      return { aborted: true };
    },
  };
  const service = createFlueRunService({
    repository,
    gateway,
    createRunId: () => "run_function_1",
    pollMs: 1,
  });
  const app = flary({
    applicationId: "test_app",
    defaultIdentity: identity,
    runService: service,
  });
  const support = app.fn({
    name: "support",
    input: z.object({ question: z.string().min(1) }),
    output: z.object({ answer: z.string() }),
    prompt: ({ question }) => `Answer this question: ${question}`,
  });

  const run = await support.start({ question: "How do I upgrade?" });
  assert.deepEqual(await run.result(), {
    answer: "Use the billing page.",
  });
  assert.deepEqual(sent, ["Answer this question: How do I upgrade?"]);

  const stored = await repository.get(run.runId);
  assert.equal(stored?.trusted.tenantId, "tenant_1");
  assert.equal(stored?.trusted.agentId, "support");
  assert.equal(stored?.trusted.revisionId?.length, 64);
  const revision = stored?.request.metadata?.flaryFunction as
    | Record<string, unknown>
    | undefined;
  assert.equal(revision?.functionId, "support");
  assert.equal(typeof revision?.promptHash, "string");
  assert.equal(typeof revision?.inputSchemaHash, "string");
  assert.equal(typeof revision?.outputSchemaHash, "string");
});

test("a new app instance enforces persisted tenant ownership", async () => {
  const repository = new InMemoryFlaryRunRepository();
  const gateway: FlueAgentGateway = {
    async send() {
      return {
        streamUrl: "https://example.com/stream",
        offset: "0",
        submissionId: "submission_restart",
      };
    },
    async wait() {
      return { answer: "done" };
    },
    async abort() {
      return { aborted: true };
    },
  };
  const makeWorker = () => {
    const service = createFlueRunService({
      repository,
      gateway,
      pollMs: 1,
    });
    const app = flary({
      applicationId: "test_app",
      auth: ({ request }) => ({
        tenantId: request!.headers.get("x-tenant") ?? "missing",
        userId: "user_1",
      }),
      runService: service,
    });
    const support = app.fn({
      name: "support",
      input: z.object({ question: z.string() }),
      output: z.object({ answer: z.string() }),
      prompt: ({ question }) => question,
    });
    return app.serve({ support });
  };

  const firstWorker = makeWorker();
  const admitted = await firstWorker.request(
    "http://local/functions/support/runs",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant": "tenant_1",
      },
      body: JSON.stringify({ question: "test" }),
    },
  );
  assert.equal(admitted.status, 202);
  const { runId } = await admitted.json() as { runId: string };

  const restartedWorker = makeWorker();
  const hidden = await restartedWorker.request(
    `http://local/functions/support/runs/${runId}`,
    { headers: { "x-tenant": "tenant_2" } },
  );
  assert.equal(hidden.status, 404);

  const visible = await restartedWorker.request(
    `http://local/functions/support/runs/${runId}`,
    { headers: { "x-tenant": "tenant_1" } },
  );
  assert.equal(visible.status, 200);
});

test("Flue-backed function handles continue approvals and user input", async () => {
  const repository = new InMemoryFlaryRunRepository();
  const decisions: string[] = [];
  const answers: string[] = [];
  let sends = 0;
  const gateway: FlueAgentGateway = {
    async send() {
      sends += 1;
      return {
        streamUrl: "https://example.com/stream",
        offset: String(sends),
        submissionId: `submission_continue_${sends}`,
      };
    },
    async wait() {
      return new Promise(() => undefined);
    },
    async abort() {
      return { aborted: true };
    },
  };
  const service = createFlueRunService({
    repository,
    gateway,
    listApprovals: (record) => [{
      id: "approval_1",
      runId: record.runId,
      action: "tool-call",
      reason: "Create the pull request",
      requestedBy: { id: "support", kind: "agent", version: "1" },
      requestedAt: new Date().toISOString(),
    }],
    decideApproval: (_record, decision) => {
      decisions.push(decision.status);
    },
    listUserInput: () => [{
      request: {
        id: "input_1",
        threadId: "run_continuation",
        questions: [{
          header: "Branch",
          question: "Which branch?",
          options: [{ label: "main", description: "" }],
          multiSelect: false,
        }],
        requestedBy: { id: "support", kind: "agent", version: "1" },
        requestedAt: new Date().toISOString(),
      },
      response: null,
    }],
    respondToUserInput: (_record, requestId) => {
      answers.push(requestId);
    },
    createRunId: () => "run_continuation",
  });
  const app = flary({
    applicationId: "test_app",
    defaultIdentity: identity,
    runService: service,
  });
  const support = app.fn({
    name: "support",
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string() }),
    prompt: ({ question }) => question,
  });

  const run = await support.start({ question: "ship it" });
  assert.equal((await run.approvals())[0]?.id, "approval_1");
  assert.equal(
    (await service.get({ ...identity, agentId: "support" }, run.runId)).status,
    "waiting",
  );
  await run.approve("approval_1");
  assert.deepEqual(decisions, ["approved"]);
  assert.equal((await run.userInput())[0]?.request.id, "input_1");
  await run.respond("input_1", { answers: { Branch: "main" } });
  assert.deepEqual(answers, ["input_1"]);
  await run.sendInput({ message: "continue" });
  assert.equal(sends, 2);
});

test("native functions use durable workflow admission and keep the host run id", async () => {
  const repository = new InMemoryFlaryRunRepository();
  const admitted: unknown[] = [];
  let agentAborts = 0;
  const gateway: FlueAgentGateway = {
    async send() {
      throw new Error("A native function must not use agent admission");
    },
    async wait() {
      throw new Error("A native function must not use agent waiting");
    },
    async abort() {
      agentAborts += 1;
      return { aborted: true };
    },
    async invokeWorkflow(_name, input) {
      admitted.push(input);
      return {
        streamUrl: "https://example.com/runs/workflow_1",
        offset: "-1",
        submissionId: "workflow_1",
      };
    },
    async waitWorkflow(_admission, onEvent) {
      await onEvent({
        v: 3,
        type: "run_end",
        runId: "workflow_1",
        result: { value: 4 },
        isError: false,
        durationMs: 5,
        eventIndex: 1,
        timestamp: new Date().toISOString(),
      });
      return { value: 4 };
    },
  };
  const service = createFlueRunService({
    repository,
    gateway,
    createRunId: () => "run_native_1",
    pollMs: 1,
  });
  const app = flary({
    applicationId: "test_app",
    defaultIdentity: identity,
    runService: service,
  });
  const calculate = app.fn({
    name: "calculate",
    input: z.object({ value: z.number() }),
    output: z.object({ value: z.number() }),
    run: ({ value }) => ({ value: value * 2 }),
  });

  const run = await calculate.start({ value: 2 });
  assert.deepEqual(await run.result(), { value: 4 });
  assert.deepEqual(admitted, [{
    __flary: {
      runId: "run_native_1",
      revisionId: (await repository.get(run.runId))?.trusted.revisionId,
    },
    input: { value: 2 },
  }]);
  assert.equal(agentAborts, 0);
});

test("workflow cancellation fails closed when the host has no workflow abort", async () => {
  const repository = new InMemoryFlaryRunRepository();
  let agentAborts = 0;
  const gateway: FlueAgentGateway = {
    async send() {
      throw new Error("not used");
    },
    async wait() {
      throw new Error("not used");
    },
    async abort() {
      agentAborts += 1;
      return { aborted: true };
    },
    async invokeWorkflow() {
      return {
        streamUrl: "https://example.com/runs/workflow_cancel",
        offset: "-1",
        submissionId: "workflow_cancel",
      };
    },
    async waitWorkflow() {
      return new Promise(() => undefined);
    },
  };
  const service = createFlueRunService({
    repository,
    gateway,
    createRunId: () => "run_native_cancel",
  });
  const app = flary({
    applicationId: "test_app",
    defaultIdentity: identity,
    runService: service,
  });
  const native = app.fn({
    name: "native",
    input: z.object({ value: z.number() }),
    output: z.object({ value: z.number() }),
    run: ({ value }) => ({ value }),
  });

  const run = await native.start({ value: 1 });
  await assert.rejects(
    run.cancel(),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        "workflow_cancel_unavailable",
  );
  assert.equal(agentAborts, 0);
});

test("generated Flue definitions apply durability and run native code", async () => {
  const app = flary({
    model: "openai/gpt-5",
    defaultBindings: { multiplier: 3 },
  });
  const prompt = app.fn({
    name: "prompt_runtime",
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string() }),
    durable: { timeout: "2h", maxAttempts: 7 },
    thinking: "high",
    prompt: ({ question }) => question,
  });
  const agent = defineFlaryFunctionAgent(prompt);
  const config = await agent.initialize({
    id: "agent_runtime_1",
    env: {},
  });
  assert.deepEqual(config.durability, {
    timeoutMs: 7_200_000,
    maxAttempts: 7,
  });
  assert.equal(config.thinkingLevel, "high");

  const native = app.fn({
    name: "native_runtime",
    input: z.object({ value: z.number() }),
    output: z.object({ value: z.number() }),
    run: ({ value }, { bindings }) => ({
      value: value * (bindings as { multiplier: number }).multiplier,
    }),
  });
  const workflow = defineFlaryFunctionWorkflow(native);
  const result = await workflow.action.run({
    input: {
      __flary: { runId: "run_generated_native" },
      input: { value: 2 },
    },
    harness: {
      env: { multiplier: 4 },
    },
  } as never);
  assert.deepEqual(result, { value: 8 });
});

test("generated prompt agents use the durable request_user_input bridge", async () => {
  const requests = new Map<string, Record<string, unknown>>();
  const namespace = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(request: Request) {
          const method = new URL(request.url).pathname.split("/").at(-1);
          const body = JSON.parse(await request.text()) as Record<string, any>;
          if (method === "createUserInput") {
            requests.set(body.request.id, body.request);
            return Response.json(body.request);
          }
          if (method === "getUserInput") {
            const requestValue = requests.get(body.requestId);
            return Response.json({
              request: requestValue,
              response: {
                requestId: body.requestId,
                answers: { Branch: "main" },
                canceled: false,
                answeredBy: { id: "user_1", kind: "user", version: "1" },
                answeredAt: new Date().toISOString(),
              },
            });
          }
          if (method === "listUserInput") {
            return Response.json([...requests.values()].map((requestValue) => ({
              request: requestValue,
              response: {
                requestId: requestValue.id,
                answers: { Branch: "main" },
                canceled: false,
                answeredBy: { id: "user_1", kind: "user", version: "1" },
                answeredAt: new Date().toISOString(),
              },
            })));
          }
          return Response.json({ error: { message: "unknown method" } }, { status: 404 });
        },
      };
    },
  };
  const app = flary({ model: "openai/gpt-5" });
  const prompt = app.fn({
    name: "needs_input",
    input: z.object({ task: z.string() }),
    output: z.object({ answer: z.string() }),
    prompt: ({ task }) => task,
  });
  const agent = defineFlaryFunctionAgent(prompt);
  const config = await agent.initialize({
    id: "run_input_tool",
    env: {
      FLARY_RUN_SERVICE: namespace,
      FLARY_INTERNAL_TOKEN: "t".repeat(32),
    },
  });
  const tool = config.tools?.find((item) => item.name === "request_user_input");
  assert.ok(tool);
  const questions = [{
    header: "Branch",
    question: "Which branch?",
    options: [{ label: "main", description: "Default" }],
  }];
  const result = await tool.run({ input: { questions } } as never);
  assert.equal((result as { answers: Record<string, string> }).answers.Branch, "main");
  assert.ok(config.approvalContinuation);
  assert.equal(
    await config.approvalContinuation!.inspect({
      toolCallId: "tool_1",
      toolName: "request_user_input",
      arguments: { questions },
    }),
    "ready",
  );
});

test("interactive agents use the durable request_user_input bridge", async () => {
  const requests = new Map<string, Record<string, unknown>>();
  const projections: Array<Record<string, any>> = [];
  const namespace = {
    idFromName(name: string) { return name; },
    get() {
      return {
        async fetch(request: Request) {
          const method = new URL(request.url).pathname.split("/").at(-1);
          const body = JSON.parse(await request.text()) as Record<string, any>;
          if (method === "createUserInput") {
            requests.set(body.request.id, body.request);
            return Response.json(body.request);
          }
          if (method === "getUserInput") {
            return Response.json({
              request: requests.get(body.requestId),
              response: {
                requestId: body.requestId,
                answers: { Delivery: "Tomorrow" },
                canceled: false,
                answeredBy: { id: "user_1", kind: "user", version: "1" },
                answeredAt: new Date().toISOString(),
              },
            });
          }
          if (method === "listUserInput") return Response.json([]);
          return Response.json({ error: { message: "unknown method" } }, { status: 404 });
        },
      };
    },
  };
  const controls = {
    idFromName(name: string) { return name; },
    get() {
      return {
        async fetch(request: Request) {
          projections.push(JSON.parse(await request.text()));
          return Response.json({ projected: true });
        },
      };
    },
  };
  const app = flary({ model: "openai/gpt-5" });
  const concierge = app.agent({ name: "concierge", instructions: "Help the shopper." });
  const config = await defineFlaryInteractiveAgent(concierge).initialize({
    id: "tenant:app:concierge:thread_1",
    env: {
      FLARY_RUN_SERVICE: namespace,
      FLARY_THREAD_CONTROL: controls,
      FLARY_INTERNAL_TOKEN: "t".repeat(32),
    },
  });
  const tool = config.tools?.find((item) => item.name === "request_user_input");
  assert.ok(tool);
  const result = await tool.run({
    input: {
      questions: [{
        header: "Delivery",
        question: "When should we deliver?",
        options: [{ label: "Tomorrow", description: "Recommended" }],
      }],
    },
  } as never);
  assert.deepEqual((result as { answers: Record<string, string> }).answers, {
    Delivery: "Tomorrow",
  });
  const requested = projections.find((item) =>
    item.event?.type === "user_input.requested"
  );
  assert.equal(requested?.method, "project");
  assert.equal(requested?.sourceCursor.startsWith("user-input:input_"), true);
  assert.equal(requested?.event.request.questions[0].header, "Delivery");
  assert.match(config.instructions, /request_user_input/);
  assert.ok(config.approvalContinuation);
});

test("interactive agents can disable the built-in user-input tool", async () => {
  const app = flary({ model: "openai/gpt-5" });
  const agent = app.agent({
    name: "non_interactive",
    askUser: false,
    instructions: "Complete the task without asking a question.",
  });
  const config = await defineFlaryInteractiveAgent(agent).initialize({
    id: "tenant:app:non_interactive:thread_1",
    env: {
      FLARY_RUN_SERVICE: {
        idFromName(name: string) { return name; },
        get() {
          return { fetch: async () => Response.json({}) };
        },
      },
      FLARY_INTERNAL_TOKEN: "t".repeat(32),
    },
  });

  assert.equal(
    config.tools?.some((tool) => tool.name === "request_user_input") ?? false,
    false,
  );
  assert.doesNotMatch(config.instructions, /request_user_input/);
});

test("interactive agents request secrets without placing values in the transcript", async () => {
  const requests = new Map<string, Record<string, any>>();
  const namespace = {
    idFromName(name: string) { return name; },
    get() {
      return {
        async fetch(request: Request) {
          const method = new URL(request.url).pathname.split("/").at(-1);
          const body = JSON.parse(await request.text()) as Record<string, any>;
          if (method === "createUserInput") {
            requests.set(body.request.id, body.request);
            return Response.json(body.request);
          }
          if (method === "getUserInput") {
            return Response.json({
              request: requests.get(body.requestId),
              response: {
                requestId: body.requestId,
                answers: {
                  status: "stored",
                  connectionId: "github",
                  name: "api-token",
                  scope: "organization",
                  version: "3",
                },
                canceled: false,
                answeredBy: { id: "user_1", kind: "user", version: "1" },
                answeredAt: "2026-08-26T12:00:00.000Z",
              },
            });
          }
          if (method === "listUserInput") return Response.json([]);
          return Response.json({ error: { message: "unknown method" } }, { status: 404 });
        },
      };
    },
  };
  const app = flary({ model: "openai/gpt-5" });
  const agent = app.agent({ name: "operator" });
  const config = await defineFlaryInteractiveAgent(agent).initialize({
    id: "tenant:app:operator:thread_1",
    env: {
      FLARY_RUN_SERVICE: namespace,
      FLARY_INTERNAL_TOKEN: "t".repeat(32),
    },
  });
  const tool = config.tools?.find((item) => item.name === "request_secret");
  assert.ok(tool);
  const result = await tool.run({
    input: {
      connectionId: "github",
      secretName: "api-token",
      label: "GitHub token",
    },
  } as never);
  assert.deepEqual(result, {
    status: "stored",
    connectionId: "github",
    name: "api-token",
    scope: "organization",
    version: 3,
  });
  const stored = [...requests.values()][0];
  assert.equal(stored.metadata.flarySecretRequest.kind, "secret-request");
  assert.equal(JSON.stringify(stored).includes("secret-value"), false);
  assert.match(config.instructions, /Never ask the user to paste a key/);
});
