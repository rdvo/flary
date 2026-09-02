import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogBatchInputSchema,
  normalizeCatalogCall,
} from "../../src/harness/functions/code-contract.ts";

test("batch schema describes every catalog call instead of an untyped array", () => {
  const schema = catalogBatchInputSchema(6) as {
    properties: {
      calls: {
        minItems: number;
        maxItems: number;
        items: {
          required: string[];
          properties: Record<string, unknown>;
          additionalProperties: boolean;
        };
      };
    };
  };

  assert.equal(schema.properties.calls.minItems, 1);
  assert.equal(schema.properties.calls.maxItems, 6);
  assert.deepEqual(schema.properties.calls.items.required, ["id", "input"]);
  assert.deepEqual(Object.keys(schema.properties.calls.items.properties), ["id", "input"]);
  assert.equal(schema.properties.calls.items.additionalProperties, false);
});

test("catalog calls normalize common model-generated aliases", () => {
  assert.deepEqual(normalizeCatalogCall({ toolId: "stats", arguments: { range: "today" } }), {
    id: "stats",
    input: { range: "today" },
  });
  assert.deepEqual(
    normalizeCatalogCall({ name: "get_trend", parameters: { granularity: "hourly" } }),
    { id: "get_trend", input: { granularity: "hourly" } },
  );
  assert.deepEqual(normalizeCatalogCall("stats"), { id: "stats", input: {} });
});
