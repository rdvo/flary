import assert from "node:assert/strict";
import test from "node:test";

import {
  RealtimeClientFrameSchema,
  RealtimeServerFrameSchema,
  RealtimeTicketRequestSchema,
} from "../../src/harness/contracts/realtime.ts";

test("realtime frames keep commands versioned and idempotent", () => {
  const frame = RealtimeClientFrameSchema.parse({
    version: 1,
    type: "command",
    requestId: "request_1",
    idempotencyKey: "idempotency_1",
    command: "send",
    input: { message: "Continue." },
  });
  assert.equal(frame.command, "send");
  assert.throws(() =>
    RealtimeClientFrameSchema.parse({
      ...frame,
      version: 2,
    }),
  );
  assert.throws(() =>
    RealtimeClientFrameSchema.parse({
      version: 1,
      type: "command",
      requestId: "request_1",
      command: "send",
      input: {},
    }),
  );
});

test("realtime replay frames use durable numeric cursors", () => {
  const ticket = RealtimeTicketRequestSchema.parse({
    after: 42,
    includeChildren: true,
  });
  assert.equal(ticket.after, 42);
  const events = RealtimeServerFrameSchema.parse({
    version: 1,
    type: "events",
    cursor: 44,
    records: [{ sequence: 43 }, { sequence: 44 }],
  });
  assert.equal(events.type, "events");
  assert.equal(events.cursor, 44);
});
