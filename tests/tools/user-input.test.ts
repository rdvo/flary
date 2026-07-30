import assert from "node:assert/strict";
import test from "node:test";

import {
  UserInputRequestSchema,
  UserInputResponseSchema,
} from "../../src/harness/contracts/user-input.js";
import { createFlueRequestUserInputTool } from "../../src/harness/flue/tools.js";
import {
  frameRestoredUserInputResponse,
  resolveLiveUserInput,
  waitForUserInput,
} from "../../src/harness/tools/user-input.js";

test("live user input resumes the waiting tool", async () => {
  const waiting = waitForUserInput("thread_1", "input_1");
  const response = UserInputResponseSchema.parse({
    requestId: "input_1",
    answers: { Scope: "Only the API" },
    answeredBy: { id: "user_1", kind: "user", version: "1" },
    answeredAt: new Date().toISOString(),
  });

  assert.equal(resolveLiveUserInput("thread_1", response), true);
  assert.deepEqual(await waiting, response);
  assert.equal(resolveLiveUserInput("thread_1", response), false);
});

test("restored user input creates a bounded continuation message", () => {
  const request = UserInputRequestSchema.parse({
    id: "input_2",
    threadId: "thread_2",
    questions: [
      {
        header: "Scope",
        question: "What should change?",
        options: [{ label: "API", description: "Change the API only." }],
      },
    ],
    requestedBy: { id: "agent_1", kind: "agent", version: "1" },
    requestedAt: new Date().toISOString(),
  });
  const response = UserInputResponseSchema.parse({
    requestId: request.id,
    answers: { Scope: "API" },
    answeredBy: { id: "user_1", kind: "user", version: "1" },
    answeredAt: new Date().toISOString(),
  });

  const framed = frameRestoredUserInputResponse(request, response);
  assert.match(framed, /What should change\?: API/);
  assert.match(framed, /user requirements/);
});

test("the Flue adapter lets a host persist and render user input", async () => {
  let persisted = false;
  const tool = createFlueRequestUserInputTool({
    threadKey: "thread_3",
    createRequest({ questions }) {
      persisted = true;
      return UserInputRequestSchema.parse({
        id: "input_3",
        threadId: "thread_3",
        questions,
        requestedBy: { id: "agent_1", kind: "agent", version: "1" },
        requestedAt: new Date().toISOString(),
      });
    },
    async waitForResponse(request) {
      return UserInputResponseSchema.parse({
        requestId: request.id,
        answers: { Scope: "API" },
        answeredBy: { id: "user_1", kind: "user", version: "1" },
        answeredAt: new Date().toISOString(),
      });
    },
  });

  const run = tool.run as unknown as (input: {
    input: {
      questions: Array<{
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
      }>;
    };
  }) => Promise<unknown>;
  const result = await run({
    input: {
      questions: [
        {
          header: "Scope",
          question: "What should change?",
          options: [{ label: "API", description: "Change the API only." }],
        },
      ],
    },
  });

  assert.equal(persisted, true);
  assert.deepEqual(result, {
    requestId: "input_3",
    answers: { Scope: "API" },
    canceled: false,
    answeredBy: { id: "user_1", kind: "user", version: "1" },
    answeredAt: (result as { answeredAt: string }).answeredAt,
  });
});
