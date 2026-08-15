import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFlaryCatalogCalls } from "../../src/harness/functions/code-syntax.ts";

test("normalizes Flary positional catalog calls for Codemode connectors", () => {
  const input = `
const matches = await tools.search("workspace actions");
const descriptor = await tools.describe(matches.items[0].id);
const result = await tools.call(descriptor.id, { path: "docs/tools.mdx" });
return tools.batch([{ id: descriptor.id, input: { path: "README.md" } }]);`;

  assert.equal(normalizeFlaryCatalogCalls(input), `
const matches = await tools.search({ query: "workspace actions" });
const descriptor = await tools.describe({ id: matches.items[0].id });
const result = await tools.call({ id: descriptor.id, input: { path: "docs/tools.mdx" } });
return tools.batch({ calls: [{ id: descriptor.id, input: { path: "README.md" } }] });`);
});

test("keeps supported object calls unchanged", () => {
  const input = `return {
  search: await tools.search({ query: "workspace" }),
  describe: await tools.describe({ id: "docs.search" }),
  call: await tools.call({ id: "docs.search", input: { query: "workspace" } }),
  batch: await tools.batch({ calls: [] }),
};`;

  assert.equal(normalizeFlaryCatalogCalls(input), input);
});

test("normalizes nested calls without changing strings, comments, or computed methods", () => {
  const input = `
// tools.search("leave this comment unchanged")
const text = 'tools.call("leave", {})';
const nested = tools.search(tools.describe("docs.search"));
return tools["call"]("docs.search", {});`;

  assert.equal(normalizeFlaryCatalogCalls(input), `
// tools.search("leave this comment unchanged")
const text = 'tools.call("leave", {})';
const nested = tools.search({ query: tools.describe({ id: "docs.search" }) });
return tools["call"]("docs.search", {});`);
});

test("leaves invalid JavaScript unchanged for the isolated runtime", () => {
  const input = `return tools.search("missing close";`;
  assert.equal(normalizeFlaryCatalogCalls(input), input);
});
