import assert from "node:assert/strict";
import test from "node:test";

import { buildSubagentTaskPrompt } from "../../src/harness/subagents/prompt.js";

test("a subagent prompt contains only the selected complete turns", () => {
  const prompt = buildSubagentTaskPrompt(
    {
      threadId: "thread_child",
      sessionId: "session_1",
      rootThreadId: "thread_root",
      parentThreadId: "thread_root",
      agentId: "reader",
      role: "reader",
      agentPath: "/root/reader",
      depth: 1,
      status: "queued",
      task: "Inspect the render path",
      contextSeed: {
        turns: 1,
        includeSystem: true,
        includeArtifacts: true,
      },
      seededTurnIds: ["turn_2"],
      verbosity: "low",
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:00.000Z",
    },
    [
      {
        id: "turn_1",
        sessionId: "session_1",
        threadId: "thread_root",
        ordinal: 1,
        messages: [{ role: "user", content: "Do not include this." }],
        createdAt: "2026-07-28T11:00:00.000Z",
      },
      {
        id: "turn_2",
        sessionId: "session_1",
        threadId: "thread_root",
        ordinal: 2,
        messages: [{ role: "assistant", content: "Inspect the iframe first." }],
        createdAt: "2026-07-28T11:30:00.000Z",
      },
    ],
  );

  assert.match(prompt, /Inspect the iframe first/);
  assert.doesNotMatch(prompt, /Do not include this/);
  assert.match(prompt, /Be concise/);
});
