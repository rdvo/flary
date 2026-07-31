import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  createModelOperations,
  ModelOperationError,
} from "../../src/harness/providers/operations.ts";

test("model operations validate and parse structured output", async () => {
  const operations = createModelOperations({
    handlers: {
      generateObject: async () => ({ answer: "ok", count: 2 }),
      embed: async () => ({ embeddings: [[0.1, 0.2]], model: "embed" }),
    },
  });
  const value = await operations.generateObject({
    prompt: "Return an object",
    schema: z.object({ answer: z.string(), count: z.number() }),
  });
  assert.deepEqual(value, { answer: "ok", count: 2 });
  assert.deepEqual(
    await operations.embed({ input: "hello", model: "openai/text-embedding" }),
    { embeddings: [[0.1, 0.2]], model: "embed" },
  );
});

test("missing non-chat operation handlers fail closed", async () => {
  const operations = createModelOperations();
  await assert.rejects(
    operations.generateImage({ prompt: "a lighthouse" }),
    (error: unknown) =>
      error instanceof ModelOperationError &&
      error.code === "operation_unavailable" &&
      error.operation === "image",
  );
});
