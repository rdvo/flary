import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { flary } from "../../src/harness/functions/index.ts";
import {
  createFlaryCodemodeApprovalBridge,
  type FlaryCodemodeApprovalRuntime,
} from "../../src/harness/functions/codemode.ts";
import { flaryInternalRoute } from "../../src/harness/functions/workflow.ts";
import type { ModelAdapter } from "../../src/harness/providers/index.ts";

test("prompt functions expose one execute tool and validate the final output", async () => {
  const requests: unknown[] = [];
  const adapter: ModelAdapter = {
    id: "test-provider",
    provider: "custom",
    supportsStreaming: false,
    async *stream() {
      // The test uses complete().
    },
    async complete(request) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          id: "response-1",
          model: request.model,
          content: "",
          toolCalls: [{
            id: "call-1",
            name: "execute",
            arguments: { code: "return { value: await tools.call({ id: 'lookup', input: { query: 'x' } }) };" },
          }],
          finishReason: "tool_call",
        };
      }
      return {
        id: "response-2",
        model: request.model,
        content: JSON.stringify({ answer: "ok" }),
        toolCalls: [],
        finishReason: "stop",
      };
    },
  };
  const app = flary({ provider: adapter });
  const lookup = app.fn({
    input: z.object({ query: z.string() }),
    output: z.string(),
    run: ({ query }) => query.toUpperCase(),
  });
  const support = app.fn({
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string() }),
    tools: app.tools({ lookup }),
    prompt: ({ question }) => question,
  });
  app.options.code;

  // The code bridge is deliberately supplied as a host closure in this unit
  // test. Production uses app.codemode() and the Cloudflare Worker Loader.
  (app.options as { code?: unknown }).code = {
    execute: async ({ tools, context }: { tools: { entries: Record<string, unknown> }; context: unknown }) => {
      const fn = tools.entries.lookup as (input: unknown) => Promise<unknown>;
      return { value: await fn({ query: "x" }), context: Boolean(context) };
    },
  };

  const result = await support({ question: "find x" });
  assert.deepEqual(result, { answer: "ok" });
  const first = requests[0] as { tools?: readonly { name: string }[] };
  assert.deepEqual(first.tools?.map((tool) => tool.name), ["execute"]);
});

test("Codemode approvals map to Flue continuation and replay", async () => {
  let pending = [{
    executionId: "exec_1",
    seq: 2,
    connector: "github",
    method: "create_pull_request",
    args: { owner: "acme", repo: "api" },
  }];
  let approved = false;
  const runtime: FlaryCodemodeApprovalRuntime = {
    async pending() {
      return pending;
    },
    async approve({ executionId }) {
      assert.equal(executionId, "exec_1");
      approved = true;
      pending = [];
      return { status: "completed", executionId, result: { number: 10 } };
    },
    async reject() {
      pending = [];
      return true;
    },
    async executions() {
      return [{ id: "exec_1", status: approved ? "completed" : "paused", result: { number: 10 } }];
    },
  };
  const bridge = createFlaryCodemodeApprovalBridge({
    runtime,
    runId: "run_1",
  });
  const requests = await bridge.list();
  assert.equal(requests[0]?.id, "codemode_exec_1_2");
  await bridge.decide({
    requestId: requests[0]!.id,
    status: "approved",
    decidedBy: { id: "user_1", kind: "user", version: "1" },
    decidedAt: new Date().toISOString(),
  });
  assert.equal(await bridge.continuation.inspect({
    toolCallId: "execute_1",
    toolName: "execute",
    arguments: {},
  }), "ready");
  const result = await bridge.continuation.resume({
    toolCallId: "execute_1",
    toolName: "execute",
    arguments: {},
  });
  assert.equal(result.output && (result.output as { number: number }).number, 10);
});

test("the protected Flue agent route exposes Codemode approvals", async () => {
  const token = "t".repeat(32);
  let decided: unknown;
  const bridge = {
    async list() {
      return [{
        id: "codemode_exec_1_0",
        runId: "agent-instance",
        action: "tool-call" as const,
        reason: "Approval is required",
        requestedBy: { id: "flary", kind: "agent" as const, version: "1" },
        requestedAt: "2026-01-01T00:00:00.000Z",
        context: {},
      }];
    },
    async decide(value: unknown) {
      decided = value;
    },
    continuation: {
      inspect: async () => "ready" as const,
      resume: async () => ({ content: "ok", output: null }),
    },
  };
  const app = flary({
    code: {
      async execute() {
        return null;
      },
      approvalBridge: () => bridge,
    },
  });
  const fn = app.fn({
    name: "support",
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string() }),
    tools: app.tools({
      lookup: app.fn({
        input: z.object({ query: z.string() }),
        output: z.string(),
        run: ({ query }) => query,
      }),
    }),
    prompt: ({ question }) => question,
  });
  const route = flaryInternalRoute(fn);
  const request = new Request(
    "https://flue.internal/agents/support/agent-instance?flary=approvals",
    { headers: { authorization: `Bearer ${token}` } },
  );
  const context = {
    env: { FLARY_INTERNAL_TOKEN: token },
    req: {
      raw: request,
      header(name: string) {
        return request.headers.get(name) ?? undefined;
      },
    },
    notFound: () => new Response(null, { status: 404 }),
    json(value: unknown) {
      return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  const listed = await bridge.list();
  const response = await route(context, async () => undefined);
  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { approvals: listed });

  const decisionRequest = new Request(
    "https://flue.internal/agents/support/agent-instance?flary=approval",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: "codemode_exec_1_0",
        status: "approved",
        decidedBy: { id: "operator", kind: "user", version: "1" },
        decidedAt: new Date().toISOString(),
      }),
    },
  );
  const decisionContext = {
    ...context,
    req: {
      raw: decisionRequest,
      header(name: string) {
        return decisionRequest.headers.get(name) ?? undefined;
      },
    },
  };
  await route(decisionContext, async () => undefined);
  assert.equal((decided as { status: string }).status, "approved");
});
