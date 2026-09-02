import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryToolCatalog, ToolCatalogError } from "../../src/harness/tools/index.js";

test("searches catalog metadata and paginates deterministic results", async () => {
  const catalog = new InMemoryToolCatalog();
  catalog.register({
    definition: {
      id: "github.search",
      name: "Search GitHub",
      description: "Find issues and pull requests",
      kind: "function",
      tags: ["code", "search"],
      capabilities: ["network.read"],
    },
    execute: async () => ({ ok: true }),
  });
  catalog.register({
    definition: {
      id: "github.create-issue",
      name: "Create GitHub issue",
      description: "Write an issue to GitHub",
      kind: "function",
      tags: ["code", "write"],
      capabilities: ["network.write"],
      requiresApproval: true,
    },
    execute: async () => ({ ok: true }),
  });

  const search = await catalog.search({ query: "search", limit: 1 });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0]?.tool.id, "github.search");
  assert.deepEqual(search.results[0]?.matchedOn, ["id", "name", "tag"]);
  assert.equal(search.nextCursor, undefined);

  const filtered = await catalog.search({
    capabilities: ["network.write"],
  });
  assert.deepEqual(
    filtered.results.map((result) => result.tool.id),
    ["github.create-issue"],
  );
});

test("load returns a safe descriptor and a private executable handle", async () => {
  const secretValue = "sk-live-only-for-the-provider";
  const catalog = new InMemoryToolCatalog({
    secretProvider: {
      async get(secretRef) {
        assert.equal(secretRef, "github.token");
        return secretValue;
      },
    },
  });

  catalog.register({
    definition: {
      id: "github.comment",
      name: "Comment on GitHub",
      kind: "function",
      secretRefs: ["github.token"],
      capabilities: ["network.write"],
    },
    execute: async (_input, context) =>
      context.useSecret("github.token", async (token) => ({
        authenticated: token === secretValue,
      })),
  });

  const loaded = await catalog.load({ id: "github.comment" });
  assert.ok(loaded);
  assert.deepEqual(loaded.capability.secretRefs, ["github.token"]);
  assert.equal(JSON.stringify(loaded).includes(secretValue), false);

  const handle = await catalog.loadHandle<{ body: string }, { authenticated: boolean }>({
    id: "github.comment",
  });
  assert.ok(handle);
  assert.deepEqual(handle.toJSON(), loaded.capability);
  assert.equal(JSON.stringify(handle).includes(secretValue), false);
  assert.equal("secretProvider" in handle, false);
  assert.deepEqual(await handle.invoke({ body: "hello" }), {
    authenticated: true,
  });
});

test("secret access is declared, callback-scoped, and unavailable without a provider", async () => {
  const catalog = new InMemoryToolCatalog();
  catalog.register({
    definition: {
      id: "private.lookup",
      name: "Private lookup",
      kind: "native",
      secretRefs: ["service.key"],
    },
    execute: async (_input, context) => context.useSecret("undeclared.key", () => ({ ok: true })),
  });

  const handle = await catalog.loadHandle({ id: "private.lookup" });
  assert.ok(handle);
  await assert.rejects(
    handle.invoke({}),
    (error: unknown) => error instanceof ToolCatalogError && error.code === "secret_not_declared",
  );

  const providerlessCatalog = new InMemoryToolCatalog();
  providerlessCatalog.register({
    definition: {
      id: "private.send",
      name: "Private send",
      kind: "native",
      secretRefs: ["service.key"],
    },
    execute: async (_input, context) => context.useSecret("service.key", () => ({ ok: true })),
  });
  const providerlessHandle = await providerlessCatalog.loadHandle({
    id: "private.send",
  });
  assert.ok(providerlessHandle);
  await assert.rejects(
    providerlessHandle.invoke({}),
    (error: unknown) => error instanceof ToolCatalogError && error.code === "secret_unavailable",
  );
});

test("rejects duplicate tools and removes their capability", async () => {
  const catalog = new InMemoryToolCatalog();
  const registration = {
    definition: {
      id: "duplicate",
      name: "Duplicate",
      kind: "function" as const,
    },
    execute: async () => null,
  };
  catalog.register(registration);
  assert.throws(
    () => catalog.register(registration),
    (error: unknown) =>
      error instanceof ToolCatalogError && error.code === "tool_already_registered",
  );
  assert.equal(catalog.unregister("duplicate"), true);
  assert.equal(catalog.unregister("duplicate"), false);
  assert.equal(await catalog.load({ id: "duplicate" }), undefined);
});
