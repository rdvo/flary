import assert from "node:assert/strict";
import test from "node:test";

import {
  flary,
  createOpenApiRuntime,
  loadOpenApiSpec,
  FlaryOpenApiSecurityError,
  FlaryOpenApiValidationError,
  createR2FileConnection,
} from "../../src/harness/functions/index.ts";

test("MCP and OpenAPI sources are represented as lazy registry entries", () => {
  const app = flary();
  const mcp = app.mcp({
    namespace: "internal",
    url: "https://mcp.example.com",
    connection: "internal-api",
  });
  const api = app.openapi({
    namespace: "billing",
    spec: {
      openapi: "3.0.0",
      info: { title: "Billing", version: "1" },
      servers: [{ url: "https://billing.example.com" }],
      paths: {},
    },
  });
  const tools = app.tools({ mcp, api });
  assert.deepEqual(tools.names, ["mcp", "api"]);
  assert.equal(tools.entries.mcp.kind, "mcp");
  assert.equal(tools.entries.api.kind, "openapi");
});

test("R2 file sources resolve a tenant prefix and never expose the bucket", async () => {
  type Stored = {
    bytes: Uint8Array;
    contentType: string;
    uploaded: Date;
    customMetadata: Record<string, string>;
  };
  const objects = new Map<string, Stored>();
  const bucket = {
    async get(key: string) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        key,
        size: value.bytes.byteLength,
        uploaded: value.uploaded,
        customMetadata: value.customMetadata,
        httpMetadata: { contentType: value.contentType },
        arrayBuffer: async () => Uint8Array.from(value.bytes).buffer,
      };
    },
    async put(key: string, value: unknown, options?: Record<string, unknown>) {
      const bytes = value instanceof Uint8Array
        ? Uint8Array.from(value)
        : new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
      const httpMetadata = options?.httpMetadata as { contentType?: string } | undefined;
      objects.set(key, {
        bytes,
        contentType: httpMetadata?.contentType ?? "application/octet-stream",
        uploaded: new Date(),
        customMetadata: (options?.customMetadata ?? {}) as Record<string, string>,
      });
    },
    async delete(keys: string | readonly string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list(options?: Record<string, unknown>) {
      const prefix = typeof options?.prefix === "string" ? options.prefix : "";
      return {
        objects: [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({
            key,
            size: value.bytes.byteLength,
            uploaded: value.uploaded,
            customMetadata: value.customMetadata,
            httpMetadata: { contentType: value.contentType },
            arrayBuffer: async () => Uint8Array.from(value.bytes).buffer,
          })),
      };
    },
  };
  objects.set("customers/acme/html/forge/index.html", {
    bytes: new TextEncoder().encode("<h1>Old</h1>"),
    contentType: "text/html",
    uploaded: new Date("2026-01-01T00:00:00.000Z"),
    customMetadata: {},
  });
  objects.set("customers/other/html/forge/private.html", {
    bytes: new TextEncoder().encode("secret"),
    contentType: "text/html",
    uploaded: new Date("2026-01-01T00:00:00.000Z"),
    customMetadata: {},
  });
  const app = flary();
  const source = app.r2({
    namespace: "customerFiles",
    binding: "CUSTOMER_FILES",
    prefix: "customers/{tenantId}/html/forge",
    access: "read-write",
  });
  assert.equal(source.kind, "r2");
  const connection = await createR2FileConnection(
    source,
    { CUSTOMER_FILES: bucket },
    { identity: { tenantId: "acme", userId: "editor" } } as never,
  );
  const listed = await connection.call("list", { prefix: "" });
  assert.deepEqual((listed as { files: Array<{ path: string }> }).files.map((file) => file.path), ["index.html"]);
  const before = await connection.call("read", { path: "index.html", encoding: "utf8" });
  assert.equal((before as { content: string }).content, "<h1>Old</h1>");
  await connection.call("edit", {
    path: "index.html",
    edits: [{ oldText: "Old", newText: "New" }],
  });
  const after = await connection.call("read", { path: "index.html", encoding: "utf8" });
  assert.equal((after as { content: string }).content, "<h1>New</h1>");
  assert.equal(objects.has("customers/other/html/forge/private.html"), true);
  await assert.rejects(() => connection.call("read", { path: "../private.html" }));
});

test("OpenAPI runtime uses a host request closure", async () => {
  const source = flary().openapi({
    namespace: "billing",
    spec: {
      openapi: "3.0.0",
      info: { title: "Billing", version: "1" },
      servers: [{ url: "https://billing.example.com" }],
      paths: {},
    },
  });
  const runtime = await createOpenApiRuntime(source, {
    fetch: async (_request, init) => {
      assert.equal(init?.method, "GET");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(await runtime.request({ path: "/health", method: "GET" }), { ok: true });
});

test("OpenAPI loading rejects Swagger 2 and unsafe external references", async () => {
  await assert.rejects(
    () => loadOpenApiSpec({ swagger: "2.0", info: {}, paths: {} }),
    FlaryOpenApiSecurityError,
  );
  await assert.rejects(
    () => loadOpenApiSpec({
      openapi: "3.1.0",
      info: { title: "Unsafe", version: "1" },
      paths: {},
      components: { schemas: { User: { $ref: "https://evil.example/User" } } },
    }),
    /External OpenAPI references/,
  );
});

test("OpenAPI validates operation requests and JSON responses", async () => {
  const source = flary().openapi({
    namespace: "billing_validation",
    spec: {
      openapi: "3.1.0",
      info: { title: "Billing", version: "1" },
      servers: [{ url: "https://billing-validation.example.com" }],
      paths: {
        "/invoices": {
          post: {
            operationId: "createInvoice",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["amount"],
                    properties: { amount: { type: "integer" } },
                  },
                },
              },
            },
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["id"],
                      properties: { id: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const runtime = await (await import("../../src/harness/functions/openapi.ts")).createOpenApiRuntime(source, {
    fetch: async () => new Response(JSON.stringify({ id: "inv_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    () => runtime.request({ path: "/invoices", method: "POST", body: { amount: "bad" } }),
    FlaryOpenApiValidationError,
  );
  assert.deepEqual(
    await runtime.request({ path: "/invoices", method: "POST", body: { amount: 10 } }),
    { id: "inv_1" },
  );
});

test("remote OpenAPI specifications use ETag revalidation", async () => {
  const url = "https://spec-cache.example.com/openapi.json";
  let requests = 0;
  const fetch = async (_request: Request | URL, init?: RequestInit) => {
    requests += 1;
    if (requests === 1) {
      return new Response(JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Cached", version: "1" },
        paths: {},
      }), { status: 200, headers: { etag: '"rev-1"' } });
    }
    assert.equal(new Headers(init?.headers).get("if-none-match"), '"rev-1"');
    return new Response(null, { status: 304 });
  };
  const first = await loadOpenApiSpec(url, { fetch });
  const second = await loadOpenApiSpec(url, { fetch });
  assert.deepEqual(second, first);
  assert.equal(requests, 2);
});
