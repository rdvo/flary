import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthorizedOperatorOverrideSchema,
  AuthorizedTestOverrideSchema,
  PromptAssignmentSchema,
  PromptRevisionSchema,
  PromptRolloutSchema,
  PromptVariantListSchema,
} from "../../src/harness/contracts/prompt-revisions.js";
import {
  bucketFromStableHash,
  hashToBasisPoints,
  selectPromptVariant,
  selectPromptVariantWithTelemetry,
  selectVariantAtBucket,
  stableHash,
  stableStringify,
} from "../../src/harness/prompts/rollouts.js";

const revision = {
  id: "revision-1",
  promptId: "support-answer",
  revision: 1,
  sourceHash: "a".repeat(64),
  sourceKey: "prompts/support-answer/aaaaaaaa.prompt.md",
  sourceCommit: "commit-1",
  model: "openai/gpt-5",
  thinking: "medium",
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00+00:00",
};

const variants = [
  { id: "control", revisionId: "revision-1", allocationBasisPoints: 2_500 },
  { id: "candidate", revisionId: "revision-2", allocationBasisPoints: 2_500 },
  { id: "treatment", revisionId: "revision-3", allocationBasisPoints: 5_000 },
] as const;

const rollout = {
  rolloutId: "support-answer-rollout",
  promptId: "support-answer",
  scope: "user" as const,
  variants,
};

test("prompt revisions are strict and parsed revisions are immutable", () => {
  const parsed = PromptRevisionSchema.parse(revision);

  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(parsed.sourceHash, "a".repeat(64));
  assert.equal(PromptRevisionSchema.safeParse({ ...revision, mutable: true }).success, false);
  assert.throws(() => {
    (parsed as { sourceHash: string }).sourceHash = "changed";
  }, TypeError);
});

test("variant allocations require unique IDs and exactly 10,000 basis points", () => {
  const parsed = PromptVariantListSchema.parse(variants);
  assert.equal(
    parsed.reduce((total, variant) => total + variant.allocationBasisPoints, 0),
    10_000,
  );

  assert.equal(
    PromptVariantListSchema.safeParse([
      { id: "control", revisionId: "revision-1", allocationBasisPoints: 2_499 },
      {
        id: "candidate",
        revisionId: "revision-2",
        allocationBasisPoints: 2_500,
      },
      {
        id: "treatment",
        revisionId: "revision-3",
        allocationBasisPoints: 5_000,
      },
    ]).success,
    false,
  );
  assert.equal(
    PromptVariantListSchema.safeParse([
      { id: "control", revisionId: "revision-1", allocationBasisPoints: 2_500 },
      { id: "control", revisionId: "revision-2", allocationBasisPoints: 2_500 },
      {
        id: "treatment",
        revisionId: "revision-3",
        allocationBasisPoints: 5_000,
      },
    ]).success,
    false,
  );
  assert.equal(
    PromptVariantListSchema.safeParse([
      {
        id: "control",
        revisionId: "revision-1",
        allocationBasisPoints: 10_001,
      },
    ]).success,
    false,
  );
});

test("assignment scopes and authorized overrides reject unauthorized shapes", () => {
  assert.deepEqual(
    PromptAssignmentSchema.parse({
      scope: "user",
      subject: "user-42",
    }),
    {
      scope: "user",
      subject: "user-42",
    },
  );
  assert.equal(PromptAssignmentSchema.safeParse({ scope: "user" }).success, false);

  const testOverride = AuthorizedTestOverrideSchema.parse({
    kind: "test",
    authorized: true,
    testId: "checkout-smoke",
    variantId: "candidate",
    scope: "user",
  });
  assert.equal(testOverride.variantId, "candidate");
  assert.equal(
    AuthorizedTestOverrideSchema.safeParse({
      kind: "test",
      authorized: false,
      testId: "checkout-smoke",
      variantId: "candidate",
    }).success,
    false,
  );

  const operatorOverride = AuthorizedOperatorOverrideSchema.parse({
    kind: "operator",
    authorized: true,
    operatorId: "operator-7",
    variantId: "control",
    reason: "Compare the fallback prompt",
  });
  assert.equal(operatorOverride.operatorId, "operator-7");
  assert.equal(
    AuthorizedOperatorOverrideSchema.safeParse({
      kind: "operator",
      authorized: true,
      operatorId: "operator-7",
      variantId: "control",
      reason: "Compare the fallback prompt",
      unexpected: true,
    }).success,
    false,
  );
});

test("stable serialization and hashing do not depend on object key order", () => {
  const left = {
    promptId: "support-answer",
    subject: "user-42",
    scope: "user",
  };
  const right = {
    scope: "user",
    subject: "user-42",
    promptId: "support-answer",
  };

  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal(stableHash(left), stableHash(right));
  assert.equal(bucketFromStableHash("0000000000000000"), 0);

  const bucket = hashToBasisPoints(left);
  assert.equal(Number.isInteger(bucket), true);
  assert.equal(bucket >= 0 && bucket < 10_000, true);
});

test("variant selection uses half-open basis-point boundaries", () => {
  assert.equal(selectVariantAtBucket(variants, 0).id, "control");
  assert.equal(selectVariantAtBucket(variants, 2_499).id, "control");
  assert.equal(selectVariantAtBucket(variants, 2_500).id, "candidate");
  assert.equal(selectVariantAtBucket(variants, 4_999).id, "candidate");
  assert.equal(selectVariantAtBucket(variants, 5_000).id, "treatment");
  assert.equal(selectVariantAtBucket(variants, 9_999).id, "treatment");

  assert.throws(() => selectVariantAtBucket(variants, -1));
  assert.throws(() => selectVariantAtBucket(variants, 10_000));
});

test("prompt variant selection is deterministic and supports authorized overrides", () => {
  const parsedRollout = PromptRolloutSchema.parse(rollout);
  assert.equal(Object.isFrozen(parsedRollout), true);
  assert.equal(Object.isFrozen(parsedRollout.variants), true);

  const assignment = { scope: "user" as const, subject: "user-42" };
  const first = selectPromptVariant(parsedRollout, assignment);
  const second = selectPromptVariant(parsedRollout, {
    subject: "user-42",
    scope: "user",
  });
  assert.equal(first.id, second.id);

  assert.equal(
    selectPromptVariant(parsedRollout, assignment, {
      kind: "test",
      authorized: true,
      testId: "checkout-smoke",
      variantId: "candidate",
      scope: "user",
    }).id,
    "candidate",
  );
  assert.equal(
    selectPromptVariant(parsedRollout, assignment, {
      kind: "operator",
      authorized: true,
      operatorId: "operator-7",
      variantId: "control",
      reason: "Inspect control output",
    }).id,
    "control",
  );

  assert.throws(() =>
    selectPromptVariant(parsedRollout, assignment, {
      kind: "test",
      authorized: true,
      testId: "checkout-smoke",
      variantId: "candidate",
      scope: "project",
    }),
  );
  assert.throws(() =>
    selectPromptVariant(parsedRollout, assignment, {
      kind: "operator",
      authorized: true,
      operatorId: "operator-7",
      variantId: "missing",
      reason: "Unknown variant",
    }),
  );
});

test("prompt selection telemetry stores only a hashed assignment key", async () => {
  const result = await selectPromptVariantWithTelemetry(
    rollout,
    { scope: "user", subject: "user-42" },
    {
      traceContext: {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: "01",
      },
      runId: "run-1",
      now: "2026-01-01T00:00:00+00:00",
    },
  );

  assert.equal(result.event.type, "prompt.selection");
  assert.equal(result.event.payload.assignmentKeyHash?.length, 64);
  assert.equal(JSON.stringify(result.event).includes("user-42"), false);
  assert.equal(result.event.runId, "run-1");
});
