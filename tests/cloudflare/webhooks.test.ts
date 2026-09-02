import assert from "node:assert/strict";
import test from "node:test";
import {
  ingestVerifiedChannelEvent,
  type VerifiedChannelEvent,
} from "../../src/harness/cloudflare/webhooks.js";

const event: VerifiedChannelEvent = {
  provider: "github",
  eventId: "delivery-1",
  eventType: "issues.opened",
  tenantId: "tenant",
  appId: "app",
  receivedAt: 100,
  payload: { issue: 42 },
};

test("deduplicates verified webhook events", async () => {
  let first = true;
  const dispatched: string[] = [];
  const receipts = {
    async claim() {
      const accepted = first;
      first = false;
      return accepted;
    },
  };
  const dispatcher = {
    async dispatch(_event: VerifiedChannelEvent, idempotencyKey: string) {
      dispatched.push(idempotencyKey);
    },
  };

  assert.equal(await ingestVerifiedChannelEvent(event, receipts, dispatcher), "accepted");
  assert.equal(await ingestVerifiedChannelEvent(event, receipts, dispatcher), "duplicate");
  assert.deepEqual(dispatched, ["channel:github:delivery-1"]);
});
