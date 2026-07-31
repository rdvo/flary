import assert from "node:assert/strict";
import test from "node:test";

import { FlaryThreadClient } from "../../src/harness/client/flue.js";
import { ModelSelectionSchema } from "../../src/harness/contracts/provider.js";

const baseUrl = process.env.FLARY_E2E_BASE_URL;
const token = process.env.FLARY_E2E_TOKEN;
const appId = process.env.FLARY_E2E_APP_ID;
const organizationId = process.env.FLARY_E2E_ORGANIZATION_ID;
const agentId = process.env.FLARY_E2E_AGENT_ID;
const threadId = process.env.FLARY_E2E_THREAD_ID;
const modelJson = process.env.FLARY_E2E_MODEL_JSON;
const enabled = Boolean(
  baseUrl &&
    token &&
    appId &&
    organizationId &&
    agentId &&
    threadId &&
    modelJson,
);

test(
  "Flary admission through Flue and Pi reuses the provider cache",
  { skip: !enabled, timeout: 240_000 },
  async () => {
    const client = new FlaryThreadClient({
      baseUrl: baseUrl!,
      token: token!,
    });
    const ref = {
      organizationId: organizationId!,
      appId: appId!,
      agentId: agentId!,
      threadId: threadId!,
    };
    const model = ModelSelectionSchema.parse(JSON.parse(modelJson!));
    const stablePrefix = Array.from(
      { length: 2_000 },
      (_, index) => `flary-live-cache-${index}`,
    ).join(" ");

    const first = await client.send(ref, {
      message: `${stablePrefix}\nReturn the single word ready.`,
      model,
      cacheRetention: "short",
      idempotencyKey: `live-cache-first-${crypto.randomUUID()}`,
    });
    await waitForSettlement(client, ref, first.submissionId);

    const second = await client.send(ref, {
      message: "Return the single word ready again.",
      model,
      cacheRetention: "short",
      idempotencyKey: `live-cache-second-${crypto.randomUUID()}`,
    });
    const snapshot = await waitForSettlement(
      client,
      ref,
      second.submissionId,
    );
    const response = snapshot.messages.find(
      (message) =>
        message.role === "assistant" &&
        message.submissionId === second.submissionId,
    );
    assert.ok(response, "The second Flary submission did not produce a response");
    assert.ok(
      (response.metadata?.usage?.cacheRead ?? 0) > 0,
      "The Flary → Flue → Pi request did not report a provider cache read",
    );
  },
);

async function waitForSettlement(
  client: FlaryThreadClient,
  ref: {
    organizationId: string;
    appId: string;
    agentId: string;
    threadId: string;
  },
  submissionId: string,
) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const snapshot = await client.history(ref);
    const settlement = snapshot.settlements.find(
      (candidate) => candidate.submissionId === submissionId,
    );
    if (settlement) {
      assert.equal(
        settlement.outcome,
        "completed",
        `Flary submission settled as ${settlement.outcome}`,
      );
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out while waiting for the durable Flary submission");
}
