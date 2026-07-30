import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { resolveAgentMode } from "../../src/harness/contracts/modes.js";
import { InMemoryToolCatalog } from "../../src/harness/tools/catalog.js";
import { LazyToolRuntime } from "../../src/harness/tools/runtime.js";
import {
  defineFlaryTool,
  defineFlaryToolset,
} from "../../src/harness/tools/sdk.js";

test("Zod tools stay private until search and describe load them", async () => {
  const catalog = new InMemoryToolCatalog();
  defineFlaryToolset([
    defineFlaryTool({
      id: "orders.get",
      description: "Read one order",
      input: z.object({ orderId: z.string() }),
      output: z.object({ id: z.string(), status: z.string() }),
      capabilities: ["orders.read"],
      tags: ["orders"],
      async execute(input) {
        return { id: input.orderId, status: "open" };
      },
    }),
  ]).register(catalog);
  const runtime = new LazyToolRuntime({
    catalog,
    mode: {
      ...resolveAgentMode("ask"),
      allowedCapabilities: ["orders.read"],
    },
  });

  const search = await runtime.search({ query: "order" });
  assert.equal(search[0]?.id, "orders.get");
  assert.equal("inputSchema" in search[0]!, false);

  const described = await runtime.describe("orders.get");
  assert.equal(
    described?.tool.inputSchema?.properties &&
      typeof described.tool.inputSchema.properties === "object",
    true,
  );
  const result = await runtime.call({
    id: "orders.get",
    arguments: { orderId: "order_1" },
  });
  assert.equal(result.status, "fulfilled");
  assert.deepEqual(result.value, { id: "order_1", status: "open" });
});

test("lazy runtime batches reads and serializes writes to one resource", async () => {
  const catalog = new InMemoryToolCatalog();
  let activeReads = 0;
  let peakReads = 0;
  let activeWrites = 0;
  let peakWrites = 0;

  defineFlaryToolset([
    defineFlaryTool({
      id: "data.read",
      input: z.object({ id: z.string() }),
      capabilities: ["data.read"],
      async execute(input) {
        activeReads += 1;
        peakReads = Math.max(peakReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeReads -= 1;
        return input;
      },
    }),
    defineFlaryTool({
      id: "data.write",
      input: z.object({ id: z.string(), value: z.string() }),
      operation: "write",
      capabilities: ["data.write"],
      resourceKey: (input) => `record:${input.id}`,
      async execute(input) {
        activeWrites += 1;
        peakWrites = Math.max(peakWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeWrites -= 1;
        return input;
      },
    }),
  ]).register(catalog);

  const runtime = new LazyToolRuntime({
    catalog,
    mode: resolveAgentMode("build"),
    approve: () => undefined,
  });
  const report = await runtime.batch({
    calls: [
      { id: "data.read", callId: "read_1", arguments: { id: "1" } },
      { id: "data.read", callId: "read_2", arguments: { id: "2" } },
      {
        id: "data.write",
        callId: "write_1",
        idempotencyKey: "write_1",
        arguments: { id: "1", value: "a" },
      },
      {
        id: "data.write",
        callId: "write_2",
        idempotencyKey: "write_2",
        arguments: { id: "1", value: "b" },
      },
    ],
  });

  assert.equal(peakReads, 2);
  assert.equal(peakWrites, 1);
  assert.deepEqual(
    report.results.map((result) => result.status),
    ["fulfilled", "fulfilled", "fulfilled", "fulfilled"],
  );
});

test("approval-required tools fail closed without a host approval handler", async () => {
  const catalog = new InMemoryToolCatalog();
  defineFlaryTool({
    id: "orders.cancel",
    input: z.object({ orderId: z.string() }),
    operation: "write",
    capabilities: ["orders.write"],
    requiresApproval: true,
    resourceKey: (input) => `order:${input.orderId}`,
    async execute() {
      return { canceled: true };
    },
  }).register(catalog);
  const runtime = new LazyToolRuntime({
    catalog,
    mode: resolveAgentMode("build"),
  });

  await assert.rejects(
    runtime.call({
      id: "orders.cancel",
      arguments: { orderId: "order_1" },
      idempotencyKey: "cancel_order_1",
    }),
    /Approval is required/,
  );
});
