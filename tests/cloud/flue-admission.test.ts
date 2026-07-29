import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFlueThinkingLevel } from "../../apps/cloud/worker/flue-admission.js";

test("maps Flary reasoning values at the Flue boundary", () => {
  assert.equal(normalizeFlueThinkingLevel("none"), "off");
  assert.equal(normalizeFlueThinkingLevel("medium"), "medium");
  assert.equal(normalizeFlueThinkingLevel("max"), "xhigh");
  assert.equal(normalizeFlueThinkingLevel("ultra"), "xhigh");
  assert.equal(normalizeFlueThinkingLevel(undefined), undefined);
});
