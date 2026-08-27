import assert from "node:assert/strict";
import test from "node:test";

import {
  createFlaryHostRouter,
  type FlaryThreadHostService,
} from "../../src/harness/host/index.js";
import {
  UserInputRequestSchema,
  UserInputResponseSchema,
} from "../../src/harness/contracts/user-input.js";

test("the OSS host router lists and resolves structured user input", async () => {
  const request = UserInputRequestSchema.parse({
    id: "input_1",
    threadId: "thread_1",
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
  let answered = "";
  const service = {
    async listUserInput() {
      return [{ request, response: null }];
    },
    async respondToUserInput(_target, requestId, response) {
      answered = response.answers.Scope ?? "";
      UserInputResponseSchema.parse({
        requestId,
        ...response,
        answeredBy: { id: "user_1", kind: "user", version: "1" },
        answeredAt: new Date().toISOString(),
      });
      return { live: true };
    },
  } as Pick<
    FlaryThreadHostService,
    "listUserInput" | "respondToUserInput"
  > as FlaryThreadHostService;
  const router = createFlaryHostRouter<object>({
    authorize: () => ({
      organizationId: "tenant_1",
      actor: { id: "user_1", kind: "user", version: "1" },
    }),
    service,
  });

  const pending = await router.request(
    "/apps/relayr/threads/thread_1/user-input",
  );
  const pendingBody = await pending.json() as {
    requests: Array<{ request: { id: string } }>;
  };
  assert.equal(pending.status, 200);
  assert.equal(pendingBody.requests[0]?.request.id, "input_1");

  const response = await router.request(
    "/apps/relayr/threads/thread_1/user-input/input_1",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: { Scope: "API" } }),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(answered, "API");
  assert.deepEqual(await response.json(), { live: true });
});

test("secret requests accept values only at the protected fulfillment route", async () => {
  const request = UserInputRequestSchema.parse({
    id: "secret_1",
    threadId: "thread_1",
    questions: [{
      header: "Secure credential",
      question: "Enter the token in the protected form.",
      options: [],
    }],
    requestedBy: { id: "agent_1", kind: "agent", version: "1" },
    requestedAt: "2026-08-26T12:00:00.000Z",
    metadata: {
      flarySecretRequest: {
        kind: "secret-request",
        connectionId: "github",
        secretName: "api-token",
        label: "GitHub token",
        scope: "organization",
        inputHash: "safe-hash",
      },
    },
  });
  let storedValue = "";
  let safeAnswers: Record<string, string> | undefined;
  const service = {
    async listUserInput() {
      return [{ request, response: null }];
    },
    async respondToUserInput(_target, _requestId, response) {
      safeAnswers = response.answers;
      return { live: true };
    },
  } as Pick<
    FlaryThreadHostService,
    "listUserInput" | "respondToUserInput"
  > as FlaryThreadHostService;
  const router = createFlaryHostRouter<object>({
    authorize: () => ({
      organizationId: "tenant_1",
      actor: { id: "user_1", kind: "user", version: "1" },
    }),
    service,
    secrets: {
      async put(_scope, connectionId, input) {
        storedValue = input.value;
        return {
          id: "secret_metadata_1",
          connectionId,
          name: input.name,
          scope: input.scope,
          version: 1,
          keyId: "kek_1",
          createdAt: "2026-08-26T12:00:00.000Z",
          updatedAt: "2026-08-26T12:00:00.000Z",
        };
      },
      async delete() {},
    },
  });

  const unsafe = await router.request(
    "/apps/relayr/threads/thread_1/user-input/secret_1",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "raw-token-must-not-enter-thread" }),
    },
  );
  assert.equal(unsafe.status, 409);
  assert.equal(storedValue, "");

  const response = await router.request(
    "/apps/relayr/threads/thread_1/secret-requests/secret_1",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "github-secret-value" }),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(storedValue, "github-secret-value");
  assert.deepEqual(safeAnswers, {
    status: "stored",
    connectionId: "github",
    name: "api-token",
    scope: "organization",
    version: "1",
  });
  assert.equal(JSON.stringify(await response.json()).includes("github-secret-value"), false);
});
