import assert from "node:assert/strict";
import test from "node:test";

import { latestFlaryRelease } from "../../apps/docs-agent/src/releases.ts";

test("docs agent resolves npm latest rather than a historical docs version", async () => {
  const release = await latestFlaryRelease(async (url, init) => {
    assert.equal(url, "https://registry.npmjs.org/flary/latest");
    assert.ok(init?.signal);
    return Response.json({ name: "flary", version: "1.8.3", unrelated: "ignored" });
  });
  assert.deepEqual(release, {
    version: "1.8.3",
    tag: "latest",
    url: "https://www.npmjs.com/package/flary/v/1.8.3",
  });
});

test("docs agent refuses failed or invalid registry responses", async () => {
  await assert.rejects(
    latestFlaryRelease(async () => new Response("unavailable", { status: 503 })),
    /Could not check/,
  );
  for (const payload of [
    { name: "another-package", version: "1.0.5" },
    { name: "flary", version: "latest" },
    { name: "flary" },
  ]) {
    await assert.rejects(latestFlaryRelease(async () => Response.json(payload)));
  }
  await assert.rejects(
    latestFlaryRelease(async () => {
      throw new Error("network failed");
    }),
    /network failed/,
  );
});
