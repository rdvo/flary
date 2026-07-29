import assert from "node:assert/strict";
import test from "node:test";
import { compilePrompt } from "../../src/harness/prompts/compiler.js";

test("compiles a fixed-model Markdown prompt with strict values", async () => {
  const prompt = await compilePrompt(
    {
      path: "/repo/prompts/support/answer.prompt.md",
      content: `---
model: anthropic/claude-opus-5
thinking: high
tools: [docs.search]
input:
  customer.name: string
  question: string
---
Answer {{customer.name}}:

{{question}}`,
    },
    {
      rootDir: "/repo/prompts",
      callerModel: "openai/gpt-5.6-luna",
      values: {
        customer: { name: "Robert" },
        question: "How do I upgrade?",
      },
    },
  );

  assert.equal(prompt.slug, "support/answer");
  assert.equal(prompt.modelMode, "fixed");
  assert.equal(prompt.resolvedModel, "anthropic/claude-opus-5");
  assert.match(prompt.rendered, /Answer Robert/);
});

test("rejects secret interpolation", async () => {
  await assert.rejects(
    compilePrompt({
      path: "prompts/bad.prompt.md",
      content: "Never print {{secrets.apiKey}}",
    }),
    /Secret-like value/,
  );
});
