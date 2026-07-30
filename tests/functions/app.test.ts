import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { flary } from "../../src/harness/functions/index.ts";

test("app.fn validates input and output and returns a callable", async () => {
  const app = flary();
  const add = app.fn({
    input: z.object({ left: z.number(), right: z.number() }),
    output: z.number().int(),
    run: ({ left, right }) => left + right,
  });

  assert.equal(await add({ left: 2, right: 3 }), 5);
  await assert.rejects(() => add({ left: "2", right: 3 } as never));
});

test("start validates input before admitting a run", async () => {
  const app = flary();
  const fn = app.fn({
    input: z.object({ value: z.number() }),
    output: z.number(),
    run: ({ value }) => value,
  });
  await assert.rejects(() => fn.start({ value: "bad" } as never));
});

test("start fails closed when no durable host is attached", async () => {
  const app = flary();
  const fn = app.fn({
    name: "durable_required",
    input: z.object({ value: z.number() }),
    output: z.number(),
    run: ({ value }) => value,
  });
  await assert.rejects(
    () => fn.start({ value: 1 }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "durable_host_required",
  );
});

test("start allows ephemeral runs only when explicitly selected", async () => {
  const app = flary({ runs: { mode: "ephemeral" } });
  const fn = app.fn({
    name: "ephemeral",
    input: z.object({ value: z.number() }),
    output: z.number(),
    run: ({ value }) => value + 1,
  });
  const run = await fn.start({ value: 1 });
  assert.equal(await run.result(), 2);
});

test("prompt functions can use an application prompt adapter", async () => {
  const app = flary({
    model: "openai/gpt-5",
    prompt: async ({ prompt }) => ({ answer: prompt.toUpperCase() }),
  });
  const answer = app.fn({
    input: z.object({ question: z.string().min(1) }),
    output: z.object({ answer: z.string() }),
    prompt: ({ question }) => question,
  });

  assert.deepEqual(await answer({ question: "hello" }), { answer: "HELLO" });
});

test("named steps reuse a result in one run", async () => {
  const app = flary({ runtime: "local" });
  let calls = 0;
  const child = app.fn({
    input: z.object({ value: z.number() }),
    output: z.number(),
    run: ({ value }) => {
      calls += 1;
      return value * 2;
    },
  });
  const parent = app.fn({
    input: z.object({ value: z.number() }),
    output: z.number(),
    run: async ({ value }, context) => {
      const first = await context.step("double", child, { value });
      const second = await context.step("double", child, { value });
      return first + second;
    },
  });

  assert.equal(await parent({ value: 4 }), 16);
  assert.equal(calls, 1);
});

test("tool registries are lazy and reject unsafe namespaces", () => {
  const app = flary();
  const read = app.fn({
    name: "readDocs",
    input: z.object({ query: z.string() }),
    output: z.array(z.string()),
    run: () => ["ok"],
  });
  const registry = app.tools({ read });
  assert.deepEqual(registry.names, ["read"]);
  assert.equal(registry.entries.read, read);
  assert.throws(() => app.tools({ "not-safe": read }), /safe JavaScript/);
});

test("serve exposes direct and durable-style function routes", async () => {
  const app = flary({ runtime: "local" });
  const greet = app.fn({
    input: z.object({ name: z.string() }),
    output: z.object({ message: z.string() }),
    run: ({ name }) => ({ message: `Hello ${name}` }),
  });
  const worker = app.serve({ greet });

  const direct = await worker.request("http://local/functions/greet", {
    method: "POST",
    body: JSON.stringify({ name: "Ada" }),
  });
  assert.equal(direct.status, 200);
  assert.deepEqual(await direct.json(), { output: { message: "Hello Ada" } });

  const admitted = await worker.request("http://local/functions/greet/runs", {
    method: "POST",
    body: JSON.stringify({ name: "Grace" }),
  });
  assert.equal(admitted.status, 202);
  const handle = (await admitted.json()) as { runId: string };
  const result = await worker.request(`http://local/runs/${handle.runId}`);
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json() as { result: unknown }).result, {
    message: "Hello Grace",
  });
});
