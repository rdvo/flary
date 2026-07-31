import assert from "node:assert/strict";
import test from "node:test";

import { toProviderHistory } from "../../src/harness/session/index.ts";

test("portable history keeps text and safe attachment references across providers", () => {
  const history = toProviderHistory([
    {
      kind: "user",
      id: "u1",
      text: "Review this image",
      attachments: [{ id: "file_1", mimeType: "image/png", storageKey: "private/file_1" }],
    },
    { kind: "assistant", id: "a1", text: "I will inspect it." },
    { kind: "tool-call", id: "c1", toolId: "github.create", input: { title: "x" } },
    { kind: "tool-result", id: "r1", toolId: "github.create", output: { ok: true } },
  ], { provider: "anthropic", model: "claude-sonnet" }, {
    supportsVision: false,
    supportsTools: true,
    toolName: (id) => id.replace(".", "__"),
  });
  assert.equal(history[0]?.role, "user");
  assert.match(String(history[0]?.content), /file_1/);
  assert.equal(history.at(-1)?.role, "tool");
  assert.equal((history.at(-1) as { name: string }).name, "github__create");
});

test("portable history removes tool calls for providers without tools", () => {
  const history = toProviderHistory([
    { kind: "tool-call", id: "c1", toolId: "shell.exec", input: {} },
  ], { provider: "openai", model: "gpt-5" }, { supportsTools: false });
  assert.deepEqual(history, [{ role: "assistant", content: "[Tool call: shell.exec]" }]);
});
