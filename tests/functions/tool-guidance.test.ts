import assert from "node:assert/strict";
import test from "node:test";

import { flary } from "../../src/harness/functions/index.ts";
import {
  coreToolGuidance,
  executeToolDescription,
} from "../../src/harness/functions/tool-guidance.ts";

test("core tool guidance names built-ins but keeps external catalogs lazy", () => {
  const app = flary();
  const registry = app.tools({
    files: app.workspace(),
    shell: app.sandbox(),
    github: app.mcp("github"),
    billing: app.openapi({
      namespace: "billing",
      connection: "billing",
      spec: {
        openapi: "3.1.0",
        info: { title: "Billing", version: "1" },
        paths: {},
      },
    }),
  });

  const guidance = coreToolGuidance(registry);
  assert.match(guidance, /files\.grep/);
  assert.match(guidance, /files\.edit/);
  assert.match(guidance, /files\.git_\*/);
  assert.match(guidance, /shell\.exec/);
  assert.match(guidance, /tools\.describe/);
  assert.match(guidance, /MCP, OpenAPI/);
  assert.doesNotMatch(guidance, /github\./);
  assert.doesNotMatch(guidance, /billing\./);

  const description = executeToolDescription(registry);
  assert.match(description, /one|Run bounded TypeScript/i);
  assert.match(description, /tools\.search/);
  assert.match(description, /files\.read/);
});

test("workspace draft options are retained as typed policy", () => {
  const source = flary().workspace({ mode: "draft", checkpoint: "turn" });
  assert.deepEqual(source.options, { mode: "draft", checkpoint: "turn" });
});

test("core tool guidance gives exact local ids without loading schemas", () => {
  const app = flary();
  const stats = app.fn({
    input: undefined,
    output: undefined,
    run: () => ({ ok: true }),
  });
  const registry = app.tools({ stats });

  const guidance = coreToolGuidance(registry);
  assert.match(guidance, /application tools: stats/);
  assert.match(guidance, /exact catalog id/);
  assert.match(guidance, /selected item's id value/);
});
