import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPublicBrowserUrl,
  browserStateObjectKey,
} from "../../src/harness/functions/browser.ts";

test("Browser Run state keys are tenant and thread scoped", () => {
  assert.equal(
    browserStateObjectKey({
      organizationId: "tenant/a",
      appId: "coder",
      threadId: "thread 1",
    }),
    "tenants/tenant%2Fa/applications/coder/threads/thread%201/browser/state.enc",
  );
});

test("agent and human browser navigation share a fail-closed URL policy", () => {
  const safe = assertPublicBrowserUrl("https://user:secret@example.com/docs");
  assert.equal(safe.toString(), "https://example.com/docs");

  for (const value of [
    "file:///etc/passwd",
    "http://localhost/admin",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/",
    "http://[::1]/",
    "http://[fd00::1]/",
  ]) {
    assert.throws(() => assertPublicBrowserUrl(value), /blocked|supports/);
  }
});
