import assert from "node:assert/strict";
import test from "node:test";

import {
  flary,
  createOpenApiRuntime,
  loadOpenApiSpec,
  FlaryOpenApiSecurityError,
  FlaryOpenApiValidationError,
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
